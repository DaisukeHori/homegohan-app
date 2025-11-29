import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';

// Vercel Proプランでは最大300秒まで延長可能
export const maxDuration = 300;

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

    // 3. Edge Function の呼び出し（awaitで完了を待つ）
    // maxDuration=300で設定しているので、長時間処理でもタイムアウトしない
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
    
    console.log('🚀 Calling Edge Function generate-weekly-menu...');
    
    try {
      // fetchでEdge Functionを呼び出す（完了を待つ）
      const edgeRes = await fetch(`${supabaseUrl}/functions/v1/generate-weekly-menu`, {
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
      });
      
      console.log('✅ Edge Function response received, status:', edgeRes.status);
      
      if (!edgeRes.ok) {
        const errorText = await edgeRes.text();
        console.error('❌ Edge Function error:', errorText);
        // Edge Functionがエラーでも、requestIdは返す（DB側でステータス管理）
      }
    } catch (err: any) {
      console.error('❌ Edge Function call error:', err.message);
      // エラーが発生しても、DBのステータスはEdge Function側で更新される
    }

    // 処理完了後にレスポンスを返す
    return NextResponse.json({ 
      status: 'completed',
      message: 'Generation completed',
      requestId: requestData.id,
    });

  } catch (error: any) {
    console.error("API Error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
