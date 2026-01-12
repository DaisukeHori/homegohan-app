import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';
import { waitUntil } from '@vercel/functions';

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

    if (insertError || !requestData?.id) {
      console.error('Failed to create request record:', insertError);
      return NextResponse.json({ error: insertError?.message || 'Failed to create request' }, { status: 500 });
    }

    // 4. target_slotsを生成（再生成用: plannedMealId付き）
    const targetSlots = [{ date: dayDate, mealType, plannedMealId: mealId }];

    // target_slotsをリクエストに保存
    await supabase
      .from('weekly_menu_requests')
      .update({
        target_slots: targetSlots,
        mode: 'v4',
        current_step: 1,
      })
      .eq('id', requestData.id);

    // 5. Edge Function generate-menu-v4 を非同期で呼び出し
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
    const supabaseServiceKey = process.env.SERVICE_ROLE_JWT || process.env.SUPABASE_SERVICE_ROLE_KEY!;

    console.log('🚀 Calling Edge Function generate-menu-v4...');

    const edgeFunctionPromise = fetch(`${supabaseUrl}/functions/v1/generate-menu-v4`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${supabaseServiceKey}`,
        'apikey': supabaseServiceKey,
      },
      body: JSON.stringify({
        userId: user.id,
        requestId: requestData.id,
        targetSlots,
        note: note || '',
        constraints: preferences || {},
      }),
    }).then(async (res) => {
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        console.error('❌ Edge Function error:', res.status, text);
        await supabase
          .from('weekly_menu_requests')
          .update({
            status: 'failed',
            error_message: `edge_function_error:${res.status}`,
            updated_at: new Date().toISOString(),
          })
          .eq('id', requestData.id);
      }
    }).catch(async (err) => {
      console.error('❌ Edge Function call error:', err.message);
      await supabase
        .from('weekly_menu_requests')
        .update({
          status: 'failed',
          error_message: err.message,
          updated_at: new Date().toISOString(),
        })
        .eq('id', requestData.id);
    });

    waitUntil(edgeFunctionPromise);

    return NextResponse.json({ 
      success: true,
      message: 'Meal regeneration started in background',
      status: 'processing',
      requestId: requestData.id,
      regeneratingMealId: mealId,
    });

  } catch (error: any) {
    console.error("Meal Regeneration Error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
