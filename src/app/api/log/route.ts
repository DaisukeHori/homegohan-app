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

    // 認証チェック: 未認証リクエストは拒否 (fail-closed)
    const supabase = await createClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const userId = user.id;

    // service_roleでログを保存
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !supabaseServiceKey) {
      return NextResponse.json({ error: 'Server configuration error' }, { status: 500 });
    }

    const supabaseAdmin = createSupabaseClient(supabaseUrl, supabaseServiceKey);

    const { error } = await supabaseAdmin.from('app_logs').insert({
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
