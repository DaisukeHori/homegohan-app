import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';

// データベース統計取得
export async function GET(request: Request) {
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('roles')
    .eq('id', user.id)
    .single();

  if (!profile || profile?.roles?.includes('super_admin') !== true) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  try {
    // 主要テーブルのレコード数を取得
    const tables = [
      'user_profiles',
      'user_daily_meals',
      'planned_meals',
      'health_records',
      'ai_consultation_sessions',
      'ai_consultation_messages',
      'recipes',
      'organizations',
      'announcements',
      'inquiries',
      'badges',
      'user_badges',
    ];

    const tableCounts: Record<string, number> = {};
    for (const table of tables) {
      try {
        const { count } = await supabase
          .from(table)
          .select('*', { count: 'exact', head: true });
        tableCounts[table] = count || 0;
      } catch {
        tableCounts[table] = -1; // エラーの場合
      }
    }

    // 今日のデータ
    const today = new Date().toISOString().split('T')[0];
    
    const { count: todayUsers } = await supabase
      .from('user_profiles')
      .select('*', { count: 'exact', head: true })
      .gte('created_at', today);

    const { count: todayMeals } = await supabase
      .from('planned_meals')
      .select('*', { count: 'exact', head: true })
      .gte('created_at', today);

    const { count: todayAISessions } = await supabase
      .from('ai_consultation_sessions')
      .select('*', { count: 'exact', head: true })
      .gte('created_at', today);

    // AI利用統計
    const { data: aiStats } = await supabase
      .from('ai_consultation_messages')
      .select('tokens_used')
      .not('tokens_used', 'is', null);

    const totalTokens = (aiStats || []).reduce((sum, m) => sum + (m.tokens_used || 0), 0);

    return NextResponse.json({
      tableCounts,
      todayStats: {
        newUsers: todayUsers || 0,
        newMeals: todayMeals || 0,
        aiSessions: todayAISessions || 0,
      },
      aiUsage: {
        totalMessages: aiStats?.length || 0,
        totalTokens,
        estimatedCost: (totalTokens / 1000) * 0.002, // GPT-4o-miniの概算
      },
    });

  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

