import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';

// 週間生成中のリクエストがあるか確認
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
    console.log('🔍 Pending check - input date:', date);
    console.log('🔍 Pending check - user_id:', user.id);

    // ユーザーの最新の pending または processing の週間生成リクエストを確認
    // start_date に関係なく、最新のリクエストを返す（リロード時の復元を確実にするため）
    const { data: pendingRequest, error } = await supabase
      .from('weekly_menu_requests')
      .select('id, status, mode, start_date, created_at')
      .eq('user_id', user.id)
      .or('mode.eq.weekly,mode.is.null')
      .in('status', ['pending', 'processing'])
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    console.log('🔍 Pending check - query result:', pendingRequest);
    console.log('🔍 Pending check - query error:', error);
    
    if (error && error.code !== 'PGRST116') {
      // PGRST116 = no rows returned
      throw error;
    }

    if (pendingRequest) {
      console.log('✅ Found pending request:', pendingRequest.id, pendingRequest.status, 'for start_date:', pendingRequest.start_date);
      return NextResponse.json({
        hasPending: true,
        requestId: pendingRequest.id,
        status: pendingRequest.status,
        mode: pendingRequest.mode,
        startDate: pendingRequest.start_date,
        createdAt: pendingRequest.created_at,
      });
    }

    console.log('❌ No pending request found for user');
    return NextResponse.json({ hasPending: false });

  } catch (error: any) {
    console.error('Pending check error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
