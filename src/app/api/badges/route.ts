import { createClient, getSupabaseAdmin } from '@/lib/supabase/server';
import { createLogger, generateRequestId } from '@/lib/db-logger';
import { isAwardableBadgeCode } from '@/lib/badges/awardable';
import { NextResponse } from 'next/server';

export async function GET(request: Request) {
  const supabase = await createClient();
  const logger = createLogger('GET /api/badges', generateRequestId());

  try {
    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // 1〜3. 互いに独立な 5 クエリを並列に取得する (#1215)。
    // どれも user.id だけに依存し、結果同士に依存関係は無い。直列 await だと DB 往復 5 回分が
    // そのままレスポンス時間に乗るため Promise.all でまとめる。
    //   badges: マスターデータ / user_badges: 獲得済みバッジ
    //   planned_meals: 完了した食事の数・自炊の数（日付ベースモデル）
    //   user_daily_meals: 連続日数計算用の完了日
    // planned_meals には user_id 列が無い（所有者は daily_meal_id → user_daily_meals.user_id）。
    // `.eq('user_id', ...)` は PostgREST が 42703 で拒否し、error を見ていなかったため count が
    // 常に null（= 0 扱い）になっていた。他の API と同じく user_daily_meals!inner で本人の行に絞る。
    //
    // #1314: ハンズオンツアーが入れるお試しの記録 (user_daily_meals.is_sandbox = true) は、実際の食事の記録では
    // ないので、食事の数にも自炊の数にも連続日数にも数えない (src/lib/health-insight-meals.ts と同じ規則)。
    // 数えると、ダミーの献立を「完了」にしただけで first_bite などが付いてしまう。
    const [badgesRes, userBadgesRes, mealCountRes, cookCountRes, completedDaysRes] = await Promise.all([
      supabase.from('badges').select('*'),
      supabase
        .from('user_badges')
        .select('badge_id, obtained_at')
        .eq('user_id', user.id),
      // 完了した食事の数
      supabase
        .from('planned_meals')
        .select('id, user_daily_meals!inner(user_id)', { count: 'exact', head: true })
        .eq('user_daily_meals.user_id', user.id)
        .eq('user_daily_meals.is_sandbox', false)
        .eq('is_completed', true),
      // 自炊の数
      supabase
        .from('planned_meals')
        .select('id, user_daily_meals!inner(user_id)', { count: 'exact', head: true })
        .eq('user_daily_meals.user_id', user.id)
        .eq('user_daily_meals.is_sandbox', false)
        .eq('is_completed', true)
        .in('mode', ['cook', 'quick']),
      // 連続日数計算（日付ベースモデル）
      supabase
        .from('user_daily_meals')
        .select(`
          day_date,
          planned_meals!inner(is_completed)
        `)
        .eq('user_id', user.id)
        .eq('is_sandbox', false)
        .eq('planned_meals.is_completed', true)
        .order('day_date', { ascending: false })
        .limit(30),
    ]);

    // 1 本でも失敗したまま続行すると、獲得済みバッジや統計が欠けた状態で「未獲得」「0 回」として
    // 判定・返却してしまう（誤った結果を返す）。握りつぶさずエラーとして記録し 500 を返す。
    const failedQueries = [
      { query: 'badges', error: badgesRes.error },
      { query: 'user_badges', error: userBadgesRes.error },
      { query: 'planned_meals (completed count)', error: mealCountRes.error },
      { query: 'planned_meals (cook count)', error: cookCountRes.error },
      { query: 'user_daily_meals (completed days)', error: completedDaysRes.error },
    ].filter((q) => q.error);
    if (failedQueries.length > 0) {
      logger.withUser(user.id).error('badges API query failed', failedQueries[0].error, {
        failed_queries: failedQueries.map((q) => q.query),
      });
      return NextResponse.json({ error: 'Failed to load badges' }, { status: 500 });
    }

    const allBadges = badgesRes.data ?? [];
    const userBadges = userBadgesRes.data ?? [];
    const earnedBadgeIds = new Set(userBadges.map(ub => ub.badge_id));
    const obtainedAtByBadgeId = new Map<string, string | null>(
      userBadges.map(ub => [ub.badge_id, ub.obtained_at]),
    );
    const mealCount = mealCountRes.count ?? 0;
    const cookCount = cookCountRes.count ?? 0;

    // ユニークな日付を取得
    const uniqueDates = [...new Set(completedDaysRes.data?.map(d => d.day_date) || [])];
    
    // 連続日数を計算
    let streak = 0;
    const today = new Date();
    for (let i = 0; i < uniqueDates.length; i++) {
      const checkDate = new Date(today);
      checkDate.setDate(checkDate.getDate() - i);
      const checkDateStr = checkDate.toISOString().split('T')[0];
      
      if (uniqueDates.includes(checkDateStr)) {
        streak++;
      } else if (i > 0) {
        break;
      }
    }

    // 4. 未獲得バッジの判定
    const earnedCandidates: typeof allBadges = [];

    for (const badge of allBadges) {
      if (earnedBadgeIds.has(badge.id)) continue;

      let earned = false;

      // First Bite (1回記録)
      if (badge.code === 'first_bite' && mealCount >= 1) {
        earned = true;
      }
      // Shutterbug (写真10回) → 10食完了で代替
      else if (badge.code === 'photo_10' && mealCount >= 10) {
        earned = true;
      }
      // Streak 3日連続
      else if (badge.code === 'streak_3' && streak >= 3) {
        earned = true;
      }
      // Streak 7日連続
      else if (badge.code === 'streak_7' && streak >= 7) {
        earned = true;
      }
      // 以下の 3 つ (home_chef / master_chef / century) は、いまのマスターに行が無く、一覧に出すかどうかは
      // オーナーの判断待ち (#1314)。判定は今のままにしてあり、src/lib/badges/awardable.ts のリストにも入れていない。
      // Home Chef (自炊10回)
      else if (badge.code === 'home_chef' && cookCount >= 10) {
        earned = true;
      }
      // Master Chef (自炊50回)
      else if (badge.code === 'master_chef' && cookCount >= 50) {
        earned = true;
      }
      // Century (100食達成)
      else if (badge.code === 'century' && mealCount >= 100) {
        earned = true;
      }

      if (earned) {
        earnedCandidates.push(badge);
      }
    }

    // 5. 新規獲得バッジを 1 回の upsert でまとめて保存する (#1215)。
    // 以前はバッジ 1 件ごとにループ内で await insert していた。
    const newEarnedBadgeIds = new Set<string>();
    if (earnedCandidates.length > 0) {
      try {
        // user_badges には SELECT ポリシーしか無く INSERT ポリシーが無いため、セッションの client での
        // insert は常に RLS 違反 (42501) になる。以前は戻り値の error を見ていなかったので、保存されない
        // まま「新規獲得」を返し、毎回お祝い表示が出ていた (#1215)。
        // user_id は認証済みの user.id 固定、badge_id は上で本人の統計から判定したマスターの id だけなので、
        // この保存のみ service_role を使う（menu-plans/add と同じ流儀）。自己 INSERT ポリシーを足すと
        // 任意のバッジを自己付与できてしまうため、ポリシー追加では対応しない。
        const supabaseAdmin = getSupabaseAdmin();
        const { data: inserted, error: insertError } = await supabaseAdmin
          .from('user_badges')
          .upsert(
            earnedCandidates.map(badge => ({ user_id: user.id, badge_id: badge.id })),
            // ON CONFLICT DO NOTHING: 同時リクエストが先に保存していても、1 件の重複で全件失敗させない
            { onConflict: 'user_id,badge_id', ignoreDuplicates: true },
          )
          .select('badge_id, obtained_at');
        if (insertError) throw insertError;

        // 返るのは今回実際に挿入できた行だけ。別リクエストが先に保存した分は返らないが、
        // 獲得済みには違いないので earned は true、「新規獲得」には含めない。
        for (const row of inserted ?? []) {
          newEarnedBadgeIds.add(row.badge_id);
          obtainedAtByBadgeId.set(row.badge_id, row.obtained_at);
        }
        for (const badge of earnedCandidates) {
          earnedBadgeIds.add(badge.id);
        }
      } catch (insertErr) {
        // 保存できなかったバッジは獲得済み・新規獲得のどちらでも返さない（次回アクセス時に再判定される）。
        // 一覧自体は返せるので 500 にはせず、原因を構造化ログに残す。
        logger.withUser(user.id).error('user_badges upsert failed (newly earned badges not persisted)', insertErr, {
          badge_codes: earnedCandidates.map(badge => badge.code),
        });
      }
    }

    // 6. レスポンス生成
    // #1314: 付与処理の無いバッジ (health_streak_* など。src/lib/badges/awardable.ts に無いコード) は、
    // 獲得のしようが無いので、未獲得のうちは一覧に出さない。獲得済みのバッジは、リストに無くても必ず返す。
    // マスター (badges テーブル) の行は変えず、返すときに絞るだけにしている。
    const badges = allBadges
      .map(badge => ({
        ...badge,
        earned: earnedBadgeIds.has(badge.id),
        obtainedAt: obtainedAtByBadgeId.get(badge.id) ?? null,
      }))
      .filter(badge => badge.earned || isAwardableBadgeCode(badge.code));

    // #1055 (wave-3b): 新規獲得バッジの匿名性を解消するため、
    // 件数だけでなくどのバッジを獲得したか (code) をレスポンスに含める
    const newEarnedBadgeCodes = allBadges
      .filter(badge => newEarnedBadgeIds.has(badge.id))
      .map(badge => badge.code);

    return NextResponse.json({
      badges,
      newEarnedCount: newEarnedBadgeIds.size,
      newEarnedBadgeCodes,
      stats: {
        completedMeals: mealCount,
        cookMeals: cookCount,
        streak: streak,
      }
    });

  } catch (error: any) {
    logger.error('Badge API error', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
