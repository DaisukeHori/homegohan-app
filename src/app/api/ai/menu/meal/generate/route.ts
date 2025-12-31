import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';

// 1食分だけをAIで生成するAPI（新規追加用）
export async function POST(request: Request) {
  const supabase = await createClient();

  try {
    const { dayDate, mealType, preferences, note } = await request.json();

    if (!dayDate || !mealType) {
      return NextResponse.json({ error: 'dayDate and mealType are required' }, { status: 400 });
    }

    // 1. ユーザー認証
    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // 2. リクエストをDBに保存（ステータス追跡用）
    const { data: requestData, error: insertError } = await supabase
      .from('weekly_menu_requests')
      .insert({
        user_id: user.id,
        start_date: dayDate,
        target_date: dayDate,
        target_meal_type: mealType,
        mode: 'single',
        status: 'pending',
        prompt: note || '',
        constraints: preferences || {},
      })
      .select('id')
      .single();

    if (insertError) {
      console.error('Failed to create request record:', insertError);
      // エラーでも続行（後方互換性のため）
    }

    // NOTE:
    // - Edge Function名の `*-v2` は「献立生成ロジックの世代（dataset駆動）」を表します。
    // - `/functions/v1/...` の "v1" は Supabase側のHTTPパスのバージョンで、ロジックのv1/v2とは別です。
    //
    // 3. Edge Function を非同期で呼び出し
    const { error: invokeError } = await supabase.functions.invoke('generate-single-meal-v2', {
      body: {
        dayDate,
        mealType,
        userId: user.id,
        preferences: preferences || {},
        note: note || '',
        requestId: requestData?.id, // リクエストIDを渡す
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
      success: true,
      message: 'Meal generation started in background',
      status: 'processing',
      requestId: requestData?.id,
    });

  } catch (error: any) {
    console.error("Single Meal Generation Error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
