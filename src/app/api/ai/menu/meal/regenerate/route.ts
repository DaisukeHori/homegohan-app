import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';

export async function POST(request: Request) {
  const supabase = await createClient();

  try {
    const { mealId, dayDate, mealType, preferences, note } = await request.json();

    // 1. ユーザー認証
    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // 2. mealIdが必須
    if (!mealId) {
      return NextResponse.json({ error: 'mealId is required' }, { status: 400 });
    }

    // 3. リクエストをDBに保存（ステータス追跡用）
    const { data: requestData, error: insertError } = await supabase
      .from('weekly_menu_requests')
      .insert({
        user_id: user.id,
        start_date: dayDate,
        target_date: dayDate,
        target_meal_type: mealType,
        target_meal_id: mealId,
        mode: 'regenerate',
        status: 'pending',
        prompt: note || '',
        constraints: preferences || {},
      })
      .select('id')
      .single();

    if (insertError) {
      console.error('Failed to create request record:', insertError);
    }

    // 4. Edge Function を非同期で呼び出し（直接planned_mealsを更新）
    const { error: invokeError } = await supabase.functions.invoke('regenerate-meal-direct', {
      body: {
        mealId,
        dayDate,
        mealType,
        userId: user.id,
        preferences: preferences || {},
        note: note || '',
        requestId: requestData?.id,
      },
    });

    if (invokeError) {
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
      message: 'Meal regeneration started in background',
      status: 'processing',
      requestId: requestData?.id,
    });

  } catch (error: any) {
    console.error("Meal Regeneration Error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
