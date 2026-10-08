import { createClient } from "@supabase/supabase-js";
import { corsHeaders } from '../_shared/cors.ts';
import { requireServiceRole } from '../_shared/auth.ts';
import { chunkArray, embeddedOne, fetchAllRows, throwIfError } from '../_shared/bulk-query.ts';
import { createLogger, generateRequestId } from '../_shared/db-logger.ts';
import { todayJst } from '../_shared/jst-date.ts';

const supabaseAdmin = createClient(
  Deno.env.get('SUPABASE_URL') ?? '',
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
);

// .in('user_daily_meals.user_id', ids) の ids は URL に載る。UUID は 36 文字で、API ゲートウェイの URL の長さの上限は
// 約 200 件で超える (ローカルのスタックでは 200 件は通り、250 件は 414 URI too long になった)。
// メンバーの多い組織でも収まるよう、1 回の問い合わせを 100 人までに分ける。
const USER_ID_CHUNK = 100;

// planned_meals の 1 行。所有者 (user_id) と日付 (day_date) は、daily_meal_id でつながる user_daily_meals にある。
// (以前の meal_plan_days / meal_plans は date-based model への移行で削除済み。本番にも無い #1306)
// 実際の応答は多対一なのでオブジェクトだが、型の上では配列になり得る。embeddedOne で 1 件に揃えて読む。
interface DailyMealRef {
  user_id: string;
  day_date: string;
}

interface PlannedMealRow {
  id: string;
  meal_type: string;
  is_completed: boolean | null;
  completed_at: string | null;
  veg_score: number | null;
  user_daily_meals: DailyMealRef | DailyMealRef[] | null;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  // バッチ専用: CRON_SECRET 認証
  const authErr = requireServiceRole(req);
  if (authErr) {
    return new Response(authErr.body, {
      status: authErr.status,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const requestId = generateRequestId();
  const logger = createLogger('aggregate-org-stats', requestId);

  try {
    const { date, organizationId } = await req.json().catch(() => ({}));
    
    // 対象日付（指定なければ JST の今日）
    // この関数の「日」は、すべて JST の暦日 (YYYY-MM-DD) で扱う。
    //   - 食事の日付 user_daily_meals.day_date は date 型で、JST の暦日が入っている (タイムゾーンを持たない)
    //   - UTC の暦日だと JST 00:00〜08:59 に前日となり、day_date とズレる (#1210)
    //   - date を指定したときも、その日付を JST の暦日として day_date と突き合わせ、org_daily_stats.date にも同じ値を保存する
    //   - 深夜食 (22:00〜04:00) の判定は、完了時刻 completed_at (UTC) を JST の時刻に直して行う (下の lateNightCount)
    const targetDateStr = date || todayJst();

    logger.info(`Aggregating stats for date: ${targetDateStr}`);

    // 1. 集計対象の組織を取得
    const orgs = await fetchAllRows<{ id: string }>('organizations の取得', () => {
      const orgQuery = supabaseAdmin.from('organizations').select('id');
      return organizationId ? orgQuery.eq('id', organizationId) : orgQuery;
    });

    const results: OrgStatsResult[] = [];
    const failed: Array<{ orgId: string; error: string }> = [];

    // 2. 各組織ごとに集計を実行
    for (const org of orgs) {
      try {
        results.push(await aggregateOrganization(org.id, targetDateStr));
      } catch (error) {
        // 1 つの組織の失敗で、ほかの組織の集計を止めない。
        // 失敗した組織の行は書かない (取得に失敗したまま 0 埋めの行を保存すると、本当の値に見えてしまう)。
        // 失敗は db-logger に残し、応答にも載せて、呼び出し元から成功に見えないようにする。
        logger.error(`Failed to aggregate stats for org ${org.id}`, error, {
          organizationId: org.id,
          date: targetDateStr,
        });
        failed.push({ orgId: org.id, error: error instanceof Error ? error.message : String(error) });
      }
    }

    return new Response(JSON.stringify({ success: failed.length === 0, processed: results, failed }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: failed.length === 0 ? 200 : 500,
    });

  } catch (error: any) {
    logger.error('Aggregation error', error);
    return new Response(JSON.stringify({ error: error.message }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 500,
    });
  }
});

interface OrgStatsResult {
  orgId: string;
  memberCount: number;
  totalCompletedMeals: number;
}

/**
 * 1 つの組織の、対象日の統計を計算して org_daily_stats に保存する。
 * 取得や保存に失敗したら例外を投げる (呼び出し側で組織ごとに記録する)。
 */
async function aggregateOrganization(orgId: string, targetDateStr: string): Promise<OrgStatsResult> {
  // メンバー取得
  const members = await fetchAllRows<{ id: string }>(`user_profiles の取得 (org ${orgId})`, () =>
    supabaseAdmin.from('user_profiles').select('id').eq('organization_id', orgId),
  );

  const memberIds = members.map((m) => m.id);
  const memberCount = memberIds.length;

  if (memberCount === 0) {
    // メンバー0の場合は0埋めでレコード作成
    await upsertStats(orgId, targetDateStr, 0, 0, 0, 0, 0);
    return { orgId, memberCount, totalCompletedMeals: 0 };
  }

  const meals = await fetchPlannedMeals(orgId, memberIds, targetDateStr);

  // --- 指標計算 ---

  // アクティブ人数（完了した食事があるユーザー）
  const activeUserIds = new Set(
    meals
      .filter(m => m.is_completed)
      .map(m => embeddedOne(m.user_daily_meals)?.user_id)
      .filter(Boolean)
  );
  const activeMemberCount = activeUserIds.size;

  // 完了した食事数
  const completedMeals = meals.filter(m => m.is_completed);
  const totalCompletedMeals = completedMeals.length;

  // 朝食率（完了した朝食 / 完了した食事総数）
  const breakfastCount = completedMeals.filter(m => m.meal_type === 'breakfast').length;
  const breakfastRate = totalCompletedMeals > 0 ? Math.round((breakfastCount / totalCompletedMeals) * 100) : 0;

  // 深夜食率 (22:00-04:00に完了した食事)
  const lateNightCount = completedMeals.filter(m => {
    if (!m.completed_at) return false;
    const d = new Date(m.completed_at);
    // UTC時間に9時間足してJSTの時間を取得
    const jstHour = (d.getUTCHours() + 9) % 24;
    return jstHour >= 22 || jstHour < 4;
  }).length;
  const lateNightRate = totalCompletedMeals > 0 ? Math.round((lateNightCount / totalCompletedMeals) * 100) : 0;

  // 平均スコア（veg_scoreを使用）
  const scores = meals
    .filter(m => m.veg_score !== null && m.veg_score !== undefined)
    .map(m => m.veg_score as number);

  const totalScore = scores.reduce((sum, score) => sum + score, 0);
  // veg_score(0-5) -> 100点満点換算 (*20)
  const avgScore = scores.length > 0 ? Math.round((totalScore / scores.length) * 20) : 0;

  // DB保存
  await upsertStats(
    orgId,
    targetDateStr,
    memberCount,
    activeMemberCount,
    breakfastRate,
    lateNightRate,
    avgScore
  );

  return { orgId, memberCount, totalCompletedMeals };
}

/**
 * メンバーの、対象日の planned_meals を取得する。
 *
 * planned_meals に user_id / 日付の列は無い。所有者と日付は daily_meal_id でつながる
 * user_daily_meals (user_id, day_date) にあるため、user_daily_meals!inner で結合して絞り込む。
 * day_date は date 型 (JST の暦日。タイムゾーンを持たない) なので、対象日の文字列とそのまま比較する。
 * ハンズオン (チュートリアル) 用の仮データ (is_sandbox = true) は、実際の食事ではないので集計から除く。
 */
async function fetchPlannedMeals(orgId: string, memberIds: string[], targetDateStr: string): Promise<PlannedMealRow[]> {
  const meals: PlannedMealRow[] = [];
  for (const userIds of chunkArray(memberIds, USER_ID_CHUNK)) {
    const rows = await fetchAllRows<PlannedMealRow>(`planned_meals の取得 (org ${orgId}, ${targetDateStr})`, () =>
      supabaseAdmin
        .from('planned_meals')
        .select('id, meal_type, is_completed, completed_at, veg_score, user_daily_meals!inner(user_id, day_date)')
        .eq('user_daily_meals.day_date', targetDateStr)
        .eq('user_daily_meals.is_sandbox', false)
        .in('user_daily_meals.user_id', userIds),
    );
    meals.push(...rows);
  }
  return meals;
}

async function upsertStats(
  orgId: string,
  date: string,
  memberCount: number,
  activeCount: number,
  breakfastRate: number,
  lateNightRate: number,
  avgScore: number
) {
  const { error } = await supabaseAdmin
    .from('org_daily_stats')
    .upsert({
      organization_id: orgId,
      date: date,
      member_count: memberCount,
      active_member_count: activeCount,
      breakfast_rate: breakfastRate,
      late_night_rate: lateNightRate,
      avg_score: avgScore,
      updated_at: new Date().toISOString()
    }, {
      onConflict: 'organization_id, date'
    });

  throwIfError(`org_daily_stats の保存 (org ${orgId}, ${date})`, error);
}
