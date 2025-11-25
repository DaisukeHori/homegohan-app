import { createClient } from '@/lib/supabase/server';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

export async function GET(request: Request) {
  const supabase = createClient(cookies());

  try {
    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // 1. マスターデータ取得
    const { data: allBadges } = await supabase.from('badges').select('*');
    if (!allBadges) return NextResponse.json({ badges: [] });

    // 2. 獲得済みバッジ取得
    const { data: userBadges } = await supabase
      .from('user_badges')
      .select('badge_id, obtained_at')
      .eq('user_id', user.id);
    
    const earnedBadgeIds = new Set(userBadges?.map(ub => ub.badge_id) || []);

    // 3. 未獲得バッジの判定（簡易ロジック）
    // 本来は専用の判定サービスで行うべきだが、ここではデモ用に一部のみ実装
    const newEarnedBadges: string[] = [];

    // 必要なデータを取得（食事回数など）
    const { count: mealCount } = await supabase
      .from('meals')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', user.id);

    // 判定ループ
    for (const badge of allBadges) {
      if (earnedBadgeIds.has(badge.id)) continue; // 獲得済みはスキップ

      const condition = badge.condition_json;
      let earned = false;

      // 3-1. First Bite (1回記録)
      if (badge.code === 'first_bite' && (mealCount || 0) >= 1) {
        earned = true;
      }
      // 3-2. Shutterbug (写真10回) - 簡易的に全記録＝写真ありとみなす
      else if (badge.code === 'photo_10' && (mealCount || 0) >= 10) {
        earned = true;
      }
      // 3-3. Streak系（簡易実装：3回以上ならOKとする、本来は日付判定が必要）
      else if (badge.code === 'streak_3' && (mealCount || 0) >= 3) {
        earned = true;
      }

      if (earned) {
        // 新規獲得！DBに保存
        await supabase.from('user_badges').insert({
          user_id: user.id,
          badge_id: badge.id
        });
        newEarnedBadges.push(badge.id);
        earnedBadgeIds.add(badge.id); // セットに追加して重複防止
      }
    }

    // 4. レスポンス生成
    // フロントエンドで使いやすい形に整形
    const badges = allBadges.map(badge => ({
      ...badge,
      earned: earnedBadgeIds.has(badge.id),
      obtainedAt: userBadges?.find(ub => ub.badge_id === badge.id)?.obtained_at || 
                  (newEarnedBadges.includes(badge.id) ? new Date().toISOString() : null)
    }));

    return NextResponse.json({ badges, newEarnedCount: newEarnedBadges.length });

  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
