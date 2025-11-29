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

    // 2. リクエストをDBに保存（ステータス追跡用）- 最初から processing に設定
    const { data: requestData, error: insertError } = await supabase
      .from('weekly_menu_requests')
      .insert({
        user_id: user.id,
        start_date: startDate,
        mode: 'weekly',
        status: 'processing', // 最初から processing に設定
        prompt: note || '',
        constraints: preferences || {},
      })
      .select('id')
      .single();

    if (insertError) {
      console.error('Failed to create request record:', insertError);
      throw new Error(`Failed to create request: ${insertError.message}`);
    }

    // 3. Edge Function の呼び出し（fire-and-forget）
    // Edge Function は完了まで時間がかかるため、レスポンスを待たずにrequestIdを返す
    // AbortControllerは使用しない（リクエスト自体がキャンセルされる可能性があるため）
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
    
    console.log('🚀 Calling Edge Function generate-weekly-menu...');
    
    // fetchでEdge Functionを呼び出す（レスポンスは無視）
    fetch(`${supabaseUrl}/functions/v1/generate-weekly-menu`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${supabaseServiceKey}`,
      },
      body: JSON.stringify({
        userId: user.id,
        startDate,
        note,
        familySize,
        cheatDay,
        preferences,
        requestId: requestData.id,
      }),
    })
    .then(res => {
      console.log('✅ Edge Function response received, status:', res.status);
    })
    .catch(err => {
      console.error('❌ Edge Function call error:', err.message);
      // エラーが発生してもrequestIdは既に返しているので、ここでは何もしない
      // DBのステータスはEdge Function側で更新される
    });

    // requestIdを即座に返す（Edge Functionの完了を待たない）
    return NextResponse.json({ 
      status: 'processing',
      message: 'Generation started',
      requestId: requestData.id,
    });

  } catch (error: any) {
    console.error("API Error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
