import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';

// 単一食事の生成中リクエストがあるか確認
export async function GET(request: Request) {
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const weekStartDate = searchParams.get('date'); // 週の開始日
  const mealType = searchParams.get('mealType');
  const now = new Date();
  const staleMinutes = 20;
  const staleBefore = new Date(now.getTime() - staleMinutes * 60 * 1000);

  try {
    // 週の日付範囲を計算
    let startDate: string | null = null;
    let endDate: string | null = null;
    
    if (weekStartDate) {
      const start = new Date(weekStartDate);
      const dayOfWeek = start.getDay();
      const weekStart = new Date(start);
      weekStart.setDate(weekStart.getDate() - dayOfWeek);
      const weekEnd = new Date(weekStart);
      weekEnd.setDate(weekEnd.getDate() + 6);
      
      startDate = weekStart.toISOString().split('T')[0];
      endDate = weekEnd.toISOString().split('T')[0];
    }

    // pending または processing の単一食事リクエストを確認
    let query = supabase
      .from('weekly_menu_requests')
      .select('id, status, target_date, target_meal_type, target_meal_id, mode, created_at, updated_at')
      .eq('user_id', user.id)
      .in('mode', ['single', 'regenerate'])
      .in('status', ['pending', 'processing'])
      .order('created_at', { ascending: false });

    // 週の範囲でフィルタ
    if (startDate && endDate) {
      query = query.gte('target_date', startDate).lte('target_date', endDate);
    }
    if (mealType) {
      query = query.eq('target_meal_type', mealType);
    }

    const { data: pendingRequests, error } = await query.limit(10);

    if (error) throw error;

    if (pendingRequests && pendingRequests.length > 0) {
      const staleIds: string[] = [];
      const active = pendingRequests.filter((r) => {
        const updatedAt = r.updated_at ? new Date(r.updated_at) : null;
        const createdAt = r.created_at ? new Date(r.created_at) : null;
        const lastTouched = updatedAt ?? createdAt ?? null;
        const isStale = lastTouched ? lastTouched < staleBefore : true;
        if (isStale && r.id) staleIds.push(r.id);
        return !isStale;
      });

      if (staleIds.length > 0) {
        // stale リクエストを failed に更新
        const { error: staleError } = await supabase
          .from('weekly_menu_requests')
          .update({
            status: 'failed',
            error_message: 'stale_request_timeout',
            updated_at: new Date().toISOString(),
          })
          .in('id', staleIds)
          .eq('user_id', user.id);
        if (staleError) {
          console.error('Failed to mark stale meal requests as failed:', staleError);
        }
        
        // プレースホルダーは使用しないので、is_generating のクリアは不要
      }

      if (active.length === 0) {
        return NextResponse.json({ hasPending: false, requests: [] });
      }

      return NextResponse.json({
        hasPending: true,
        requests: active.map(r => ({
          requestId: r.id,
          status: r.status,
          targetDate: r.target_date,
          targetMealType: r.target_meal_type,
          targetMealId: r.target_meal_id,
          mode: r.mode,
          createdAt: r.created_at,
        })),
      });
    }

    return NextResponse.json({ hasPending: false, requests: [] });

  } catch (error: any) {
    console.error('Pending meal check error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
