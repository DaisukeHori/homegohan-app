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

    // 2. Edge Function を非同期で呼び出し
    const { error: invokeError } = await supabase.functions.invoke('generate-single-meal', {
      body: {
        dayDate,
        mealType,
        userId: user.id,
        preferences: preferences || {},
        note: note || '',
      },
    });

    if (invokeError) {
      throw new Error(`Edge Function invoke failed: ${invokeError.message}`);
    }

    return NextResponse.json({ 
      success: true,
      message: 'Meal generation started in background',
      status: 'processing'
    });

  } catch (error: any) {
    console.error("Single Meal Generation Error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

