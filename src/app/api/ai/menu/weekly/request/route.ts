import { createClient } from '@/lib/supabase/server';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

export async function POST(request: Request) {
  const supabase = createClient(cookies());

  try {
    // パラメータ受け取りを更新
    const { startDate, note, familySize, cheatDay, preferences } = await request.json();

    // 1. ユーザー確認
    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // constraints オブジェクトの構築（preferencesを含む）
    const constraints = {
      familySize: familySize || 1,
      cheatDay: cheatDay || null,
      preferences: preferences || {}, // UI選択された条件
    };

    // 2. リクエストレコード作成
    const { data: reqData, error: dbError } = await supabase
      .from('weekly_menu_requests')
      .insert({
        user_id: user.id,
        start_date: startDate,
        status: 'pending',
        prompt: note,
        constraints: constraints // JSONBカラムへ保存
      })
      .select()
      .single();

    if (dbError) throw dbError;

    // 3. Edge Function の呼び出し（非同期バックグラウンド処理）
    const { error: invokeError } = await supabase.functions.invoke('generate-weekly-menu', {
      body: {
        recordId: reqData.id,
        userId: user.id,
        startDate,
        note,
        familySize,
        cheatDay,
        preferences, // UI選択された条件を渡す
      },
    });

    if (invokeError) {
      await supabase
        .from('weekly_menu_requests')
        .update({ status: 'failed', error_message: 'Failed to invoke AI function' })
        .eq('id', reqData.id);
      
      throw new Error(`Edge Function invoke failed: ${invokeError.message}`);
    }

    return NextResponse.json({ 
      id: reqData.id, 
      status: 'pending',
      message: 'Generation started in background' 
    });

  } catch (error: any) {
    console.error("API Error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
