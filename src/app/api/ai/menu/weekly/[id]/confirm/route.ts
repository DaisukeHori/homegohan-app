import { createClient } from '@/lib/supabase/server';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

export async function POST(
  request: Request,
  { params }: { params: { id: string } }
) {
  const supabase = createClient(cookies());

  try {
    const { days } = await request.json();
    const requestId = params.id;

    // 1. ユーザー確認
    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // 2. 元データの取得と検証
    const { data: currentRequest, error: fetchError } = await supabase
      .from('weekly_menu_requests')
      .select('*')
      .eq('id', requestId)
      .eq('user_id', user.id)
      .single();

    if (fetchError || !currentRequest) {
      return NextResponse.json({ error: 'Request not found' }, { status: 404 });
    }

    // 3. result_json の更新とステータス変更
    const updatedResultJson = {
      ...currentRequest.result_json,
      days: days // ユーザーが編集（スキップ等）したdays配列で上書き
    };

    const { error: updateError } = await supabase
      .from('weekly_menu_requests')
      .update({
        status: 'confirmed',
        result_json: updatedResultJson,
        updated_at: new Date().toISOString()
      })
      .eq('id', requestId);

    if (updateError) throw updateError;

    return NextResponse.json({ success: true });

  } catch (error: any) {
    console.error("API Error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

