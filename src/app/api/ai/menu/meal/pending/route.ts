import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';

// 単一食事の生成中リクエストがあるか確認
export async function GET(request: Request) {
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const date = searchParams.get('date');
  const mealType = searchParams.get('mealType');

  try {
    // pending または processing の単一食事リクエストを確認
    let query = supabase
      .from('weekly_menu_requests')
      .select('id, status, target_date, target_meal_type, target_meal_id, mode, created_at')
      .eq('user_id', user.id)
      .in('mode', ['single', 'regenerate'])
      .in('status', ['pending', 'processing'])
      .order('created_at', { ascending: false });

    if (date) {
      query = query.eq('target_date', date);
    }
    if (mealType) {
      query = query.eq('target_meal_type', mealType);
    }

    const { data: pendingRequests, error } = await query.limit(10);

    if (error) throw error;

    if (pendingRequests && pendingRequests.length > 0) {
      return NextResponse.json({
        hasPending: true,
        requests: pendingRequests.map(r => ({
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

