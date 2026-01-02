import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';

// リクエストのステータスを確認
export async function GET(request: Request) {
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const requestId = searchParams.get('requestId');
  const now = new Date();
  const staleMinutes = 20;
  const staleBefore = new Date(now.getTime() - staleMinutes * 60 * 1000);

  if (!requestId) {
    return NextResponse.json({ error: 'requestId is required' }, { status: 400 });
  }

  try {
    const { data: request, error } = await supabase
      .from('weekly_menu_requests')
      .select('id, status, error_message, updated_at, mode, start_date, target_meal_id, progress')
      .eq('id', requestId)
      .eq('user_id', user.id)
      .single();

    if (error) throw error;

    if (!request) {
      return NextResponse.json({
        status: 'failed',
        errorMessage: 'Request not found',
        updatedAt: new Date().toISOString(),
      });
    }

    const updatedAt = request.updated_at ? new Date(request.updated_at) : null;
    const isStale = (request.status === 'pending' || request.status === 'processing')
      && updatedAt
      && updatedAt < staleBefore;
    if (isStale) {
      // stale リクエストを failed に更新
      const { error: staleError } = await supabase
        .from('weekly_menu_requests')
        .update({
          status: 'failed',
          error_message: 'stale_request_timeout',
          updated_at: new Date().toISOString(),
        })
        .eq('id', requestId)
        .eq('user_id', user.id);
      if (staleError) {
        console.error('Failed to mark stale request as failed:', staleError);
      }
      
      // プレースホルダーは使用しないので、is_generating のクリアは不要
      
      return NextResponse.json({
        status: 'failed',
        errorMessage: 'stale_request_timeout',
        updatedAt: new Date().toISOString(),
      });
    }

    return NextResponse.json({
      status: request.status,
      errorMessage: request.error_message,
      updatedAt: request.updated_at,
      progress: request.progress,
    });

  } catch (error: any) {
    console.error('Status check error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
