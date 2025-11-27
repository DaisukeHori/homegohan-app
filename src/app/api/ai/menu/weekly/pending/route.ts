import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';

// 生成中のリクエストがあるか確認
export async function GET(request: Request) {
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const date = searchParams.get('date');

  if (!date) {
    return NextResponse.json({ error: 'date is required' }, { status: 400 });
  }

  try {
    // 週の開始日を計算
    const targetDate = new Date(date);
    const dayOfWeek = targetDate.getDay();
    const weekStart = new Date(targetDate);
    weekStart.setDate(weekStart.getDate() - dayOfWeek);
    const weekStartStr = weekStart.toISOString().split('T')[0];

    // pending または processing のリクエストを確認
    const { data: pendingRequest, error } = await supabase
      .from('weekly_menu_requests')
      .select('id, status, mode, created_at')
      .eq('user_id', user.id)
      .eq('start_date', weekStartStr)
      .in('status', ['pending', 'processing'])
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    if (error && error.code !== 'PGRST116') {
      // PGRST116 = no rows returned
      throw error;
    }

    if (pendingRequest) {
      return NextResponse.json({
        hasPending: true,
        requestId: pendingRequest.id,
        status: pendingRequest.status,
        mode: pendingRequest.mode,
        createdAt: pendingRequest.created_at,
      });
    }

    return NextResponse.json({ hasPending: false });

  } catch (error: any) {
    console.error('Pending check error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

