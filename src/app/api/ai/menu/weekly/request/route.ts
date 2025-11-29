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

    // 3. Edge Function の呼び出し（fire-and-forget with short timeout）
    // Edge Function は完了まで時間がかかるため、短いタイムアウトで呼び出し、
    // レスポンスを待たずにrequestIdを返す
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
    const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || supabaseAnonKey;
    
    // fetchでEdge Functionを呼び出す（タイムアウト: 5秒）
    // Edge Functionが受け取れば処理を開始するので、レスポンスを待つ必要はない
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    
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
      signal: controller.signal,
    })
    .then(res => {
      clearTimeout(timeoutId);
      console.log('Edge Function response status:', res.status);
    })
    .catch(err => {
      clearTimeout(timeoutId);
      // タイムアウトやネットワークエラーは無視（Edge Functionは既に処理を開始している）
      if (err.name === 'AbortError') {
        console.log('Edge Function call timed out (expected - running in background)');
      } else {
        console.error('Edge Function call error:', err.message);
      }
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
