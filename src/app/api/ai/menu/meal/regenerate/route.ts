import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';

// Vercel Proプランでは最大300秒まで延長可能
export const maxDuration = 300;

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

    console.log(`📝 Regenerating meal: ${mealId}`);

    // 3. リクエストをDBに保存（ステータス追跡用）
    // is_generating フラグは使用しない（ポーリングで状態を監視）
    const { data: requestData, error: insertError } = await supabase
      .from('weekly_menu_requests')
      .insert({
        user_id: user.id,
        start_date: dayDate,
        target_date: dayDate,
        target_meal_type: mealType,
        target_meal_id: mealId,
        mode: 'regenerate',
        status: 'processing',
        prompt: note || '',
        constraints: preferences || {},
      })
      .select('id')
      .single();

    if (insertError) {
      console.error('Failed to create request record:', insertError);
    }

    // NOTE:
    // - Edge Function名の `*-v2` は「献立生成ロジックの世代（dataset駆動）」を表します。
    // - `/functions/v1/...` の "v1" は Supabase側のHTTPパスのバージョンで、ロジックのv1/v2とは別です。
    //
    // 5. Edge Function を非同期で呼び出し（完了を待たない）
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

    console.log('🚀 Calling Edge Function regenerate-meal-direct-v3...');

    fetch(`${supabaseUrl}/functions/v1/regenerate-meal-direct-v3`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${supabaseServiceKey}`,
      },
      body: JSON.stringify({
        mealId,
        dayDate,
        mealType,
        userId: user.id,
        preferences: preferences || {},
        note: note || '',
        requestId: requestData?.id,
      }),
    }).catch(err => {
      console.error('❌ Edge Function call error:', err.message);
    });

    return NextResponse.json({ 
      success: true,
      message: 'Meal regeneration started in background',
      status: 'processing',
      requestId: requestData?.id,
      regeneratingMealId: mealId,
    });

  } catch (error: any) {
    console.error("Meal Regeneration Error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
