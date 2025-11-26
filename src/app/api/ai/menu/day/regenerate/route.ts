import { createClient } from '@/lib/supabase/server';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

export async function POST(request: Request) {
  const supabase = createClient(cookies());

  try {
    const { weeklyMenuRequestId, dayIndex, preferences } = await request.json();

    if (dayIndex === undefined || !weeklyMenuRequestId) {
      return NextResponse.json({ error: 'Missing required parameters' }, { status: 400 });
    }

    // 1. ユーザー認証
    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // 2. 週献立リクエストの所有権確認
    const { data: menuRequest, error: menuError } = await supabase
      .from('weekly_menu_requests')
      .select('id, user_id, status')
      .eq('id', weeklyMenuRequestId)
      .eq('user_id', user.id)
      .single();

    if (menuError || !menuRequest) {
      return NextResponse.json({ error: 'Weekly menu request not found' }, { status: 404 });
    }

    if (menuRequest.status !== 'completed') {
      return NextResponse.json({ error: 'Weekly menu must be completed before regenerating days' }, { status: 400 });
    }

    // 3. Edge Function を非同期で呼び出し
    const { error: invokeError } = await supabase.functions.invoke('regenerate-day', {
      body: {
        weeklyMenuRequestId,
        dayIndex,
        userId: user.id,
        preferences: preferences || {},
      },
    });

    if (invokeError) {
      throw new Error(`Edge Function invoke failed: ${invokeError.message}`);
    }

    return NextResponse.json({ 
      success: true,
      message: 'Day regeneration started in background',
      status: 'processing'
    });

  } catch (error: any) {
    console.error("Day Regeneration Error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

