import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';

export async function POST(request: Request) {
  const supabase = await createClient();

  try {
    const { startDate, note, familySize, cheatDay, preferences } = await request.json();

    // 1. ユーザー確認
    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // 2. リクエストをDBに保存（ステータス追跡用）
    const { data: requestData, error: insertError } = await supabase
      .from('weekly_menu_requests')
      .insert({
        user_id: user.id,
        start_date: startDate,
        mode: 'weekly',
        status: 'pending',
        prompt: note || '',
        constraints: preferences || {},
      })
      .select('id')
      .single();

    if (insertError) {
      console.error('Failed to create request record:', insertError);
    }

    // 3. Edge Function の呼び出し（非同期バックグラウンド処理）
    const { error: invokeError } = await supabase.functions.invoke('generate-weekly-menu', {
      body: {
        userId: user.id,
        startDate,
        note,
        familySize,
        cheatDay,
        preferences,
        requestId: requestData?.id,
      },
    });

    if (invokeError) {
      // エラー時はリクエストステータスを更新
      if (requestData?.id) {
        await supabase
          .from('weekly_menu_requests')
          .update({ status: 'failed', error_message: invokeError.message })
          .eq('id', requestData.id);
      }
      throw new Error(`Edge Function invoke failed: ${invokeError.message}`);
    }

    // ステータスを processing に更新
    if (requestData?.id) {
      await supabase
        .from('weekly_menu_requests')
        .update({ status: 'processing' })
        .eq('id', requestData.id);
    }

    return NextResponse.json({ 
      status: 'pending',
      message: 'Generation started in background',
      requestId: requestData?.id,
    });

  } catch (error: any) {
    console.error("API Error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
