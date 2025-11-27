import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';

// リクエストのステータスを確認
export async function GET(request: Request) {
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const requestId = searchParams.get('requestId');

  if (!requestId) {
    return NextResponse.json({ error: 'requestId is required' }, { status: 400 });
  }

  try {
    const { data: request, error } = await supabase
      .from('weekly_menu_requests')
      .select('id, status, error_message, updated_at')
      .eq('id', requestId)
      .eq('user_id', user.id)
      .single();

    if (error) throw error;

    if (!request) {
      return NextResponse.json({ error: 'Request not found' }, { status: 404 });
    }

    return NextResponse.json({
      status: request.status,
      errorMessage: request.error_message,
      updatedAt: request.updated_at,
    });

  } catch (error: any) {
    console.error('Status check error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

