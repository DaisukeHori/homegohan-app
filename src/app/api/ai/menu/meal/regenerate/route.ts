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

    // 3. Edge Function を非同期で呼び出し（直接planned_mealsを更新）
    const { error: invokeError } = await supabase.functions.invoke('regenerate-meal-direct', {
      body: {
        mealId,
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
      message: 'Meal regeneration started in background',
      status: 'processing'
    });

  } catch (error: any) {
    console.error("Meal Regeneration Error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
