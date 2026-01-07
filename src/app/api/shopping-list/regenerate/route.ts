import { createClient } from '@/lib/supabase/server';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

/**
 * 買い物リスト再生成API（非同期版）
 * - リクエストレコードを作成して即座にrequestIdを返す
 * - Edge Functionで非同期処理
 * - クライアントはSupabase Realtimeで進捗を購読
 */
export async function POST(request: Request) {
  const supabase = createClient(cookies());
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const { mealPlanId, startDate, endDate, mealTypes } = await request.json();
    
    if (!mealPlanId) {
      return NextResponse.json({ error: 'mealPlanId is required' }, { status: 400 });
    }

    // リクエストレコードを作成
    const { data: requestData, error: insertError } = await supabase
      .from('shopping_list_requests')
      .insert({
        user_id: user.id,
        meal_plan_id: mealPlanId,
        status: 'processing',
        progress: {
          phase: 'starting',
          message: '開始中...',
          percentage: 0,
        },
      })
      .select('id')
      .single();

    if (insertError) {
      console.error('Failed to create request record:', insertError);
      throw new Error(`Failed to create request: ${insertError.message}`);
    }

    const requestId = requestData.id;

    // Edge Functionを非同期で呼び出し（fire-and-forget）
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseServiceKey = process.env.SERVICE_ROLE_JWT || process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !supabaseServiceKey) {
      throw new Error('Missing Supabase configuration');
    }

    // Edge Functionに処理を委譲（レスポンスを待たない）
    fetch(`${supabaseUrl}/functions/v1/regenerate-shopping-list-v2`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${supabaseServiceKey}`,
      },
      body: JSON.stringify({
        requestId,
        mealPlanId,
        userId: user.id,
        // 範囲フィルタ
        startDate: startDate || null,
        endDate: endDate || null,
        mealTypes: mealTypes || null,
      }),
    }).catch((err) => {
      console.error('Edge Function call failed:', err);
    });

    // 即座にrequestIdを返す
    return NextResponse.json({ 
      requestId,
      message: '再生成を開始しました',
    });
  } catch (error: any) {
    console.error('Regenerate shopping list error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
