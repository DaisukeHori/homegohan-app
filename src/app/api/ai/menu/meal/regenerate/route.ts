import { createClient } from '@/lib/supabase/server';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

export async function POST(request: Request) {
  const supabase = createClient(cookies());

  try {
    const { mealId, dayDate, mealType, preferences, note, weeklyMenuRequestId } = await request.json();

    // 1. ユーザー認証
    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // 2. mealIdが指定されている場合は直接そのmealを再生成
    if (mealId) {
      // Edge Function を非同期で呼び出し（直接planned_mealsを更新）
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
    }

    // 3. weeklyMenuRequestIdが指定されている場合は従来の方法
    if (!weeklyMenuRequestId) {
      return NextResponse.json({ error: 'Either mealId or weeklyMenuRequestId is required' }, { status: 400 });
    }

    // 週献立リクエストの所有権確認
    const { data: menuRequest, error: menuError } = await supabase
      .from('weekly_menu_requests')
      .select('id, user_id, status')
      .eq('id', weeklyMenuRequestId)
      .eq('user_id', user.id)
      .single();

    if (menuError || !menuRequest) {
      return NextResponse.json({ error: 'Weekly menu request not found' }, { status: 404 });
    }

    // Edge Function を非同期で呼び出し
    const { error: invokeError } = await supabase.functions.invoke('regenerate-meal', {
      body: {
        weeklyMenuRequestId,
        dayIndex: 0, // Will be calculated from dayDate
        mealType,
        userId: user.id,
        preferences: preferences || {},
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
