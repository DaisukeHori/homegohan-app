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

    // 2. Edge Function の呼び出し（非同期バックグラウンド処理）
    // planned_mealsに直接保存するため、recordIdは不要
    const { error: invokeError } = await supabase.functions.invoke('generate-weekly-menu', {
      body: {
        userId: user.id,
        startDate,
        note,
        familySize,
        cheatDay,
        preferences,
      },
    });

    if (invokeError) {
      throw new Error(`Edge Function invoke failed: ${invokeError.message}`);
    }

    return NextResponse.json({ 
      status: 'pending',
      message: 'Generation started in background' 
    });

  } catch (error: any) {
    console.error("API Error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
