import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';

export async function GET(request: Request) {
  const supabase = await createClient();

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

    // 3. 統計データを取得（planned_mealsベース、日付ベースモデル）
    // 完了した食事の数
    const { count: completedMealCount } = await supabase
      .from('planned_meals')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', user.id)
      .eq('is_completed', true);

    // 自炊の数
    const { count: cookCount } = await supabase
      .from('planned_meals')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', user.id)
      .eq('is_completed', true)
      .in('mode', ['cook', 'quick']);

    // 連続日数計算（日付ベースモデル）
    const { data: completedDays } = await supabase
      .from('user_daily_meals')
      .select(`
        day_date,
        planned_meals!inner(is_completed)
      `)
      .eq('user_id', user.id)
      .eq('planned_meals.is_completed', true)
      .order('day_date', { ascending: false })
      .limit(30);

    // ユニークな日付を取得
    const uniqueDates = [...new Set(completedDays?.map(d => d.day_date) || [])];
    
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
    const newEarnedBadges: string[] = [];
    const mealCount = completedMealCount || 0;

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
      // Home Chef (自炊10回)
      else if (badge.code === 'home_chef' && (cookCount || 0) >= 10) {
        earned = true;
      }
      // Master Chef (自炊50回)
      else if (badge.code === 'master_chef' && (cookCount || 0) >= 50) {
        earned = true;
      }
      // Century (100食達成)
      else if (badge.code === 'century' && mealCount >= 100) {
        earned = true;
      }

      if (earned) {
        await supabase.from('user_badges').insert({
          user_id: user.id,
          badge_id: badge.id
        });
        newEarnedBadges.push(badge.id);
        earnedBadgeIds.add(badge.id);
      }
    }

    // 5. レスポンス生成
    const badges = allBadges.map(badge => ({
      ...badge,
      earned: earnedBadgeIds.has(badge.id),
      obtainedAt: userBadges?.find(ub => ub.badge_id === badge.id)?.obtained_at || 
                  (newEarnedBadges.includes(badge.id) ? new Date().toISOString() : null)
    }));

    return NextResponse.json({ 
      badges, 
      newEarnedCount: newEarnedBadges.length,
      stats: {
        completedMeals: mealCount,
        cookMeals: cookCount || 0,
        streak: streak,
      }
    });

  } catch (error: any) {
    console.error('Badge API error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
