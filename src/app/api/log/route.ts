/**
 * クライアントサイドログを受け取ってDBに保存するAPI
 */

import { NextRequest, NextResponse } from 'next/server';
import { createClient as createSupabaseClient } from '@supabase/supabase-js';
import { createClient } from '@/lib/supabase/server';

export async function POST(request: NextRequest) {
  try {
    const { level, message, metadata } = await request.json();

    if (!message || !level) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    // ユーザーIDを取得（認証済みの場合）
    let userId: string | undefined;
    try {
      const supabase = await createClient();
      const { data: { user } } = await supabase.auth.getUser();
      userId = user?.id;
    } catch {
      // 認証エラーは無視
    }

    // service_roleでログを保存
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !supabaseServiceKey) {
      return NextResponse.json({ error: 'Server configuration error' }, { status: 500 });
    }

    const supabase = createSupabaseClient(supabaseUrl, supabaseServiceKey);

    const { error } = await supabase.from('app_logs').insert({
      level,
      source: 'client',
      message,
      metadata,
      user_id: userId,
    });

    if (error) {
      console.error('Failed to save client log:', error);
      return NextResponse.json({ error: 'Failed to save log' }, { status: 500 });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Log API error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
