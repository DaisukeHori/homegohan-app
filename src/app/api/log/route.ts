/**
 * クライアントサイドログを受け取ってDBに保存するAPI
 */

import { NextRequest, NextResponse } from 'next/server';
import { createClient as createSupabaseClient } from '@supabase/supabase-js';
import { createClient } from '@/lib/supabase/server';
import { sanitizeMetadata } from '@/lib/db-logger';

// #1044 (F6-20): level は enum に限定、message は上限文字数を設ける
const ALLOWED_LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
const MAX_MESSAGE_LENGTH = 2000;

export async function POST(request: NextRequest) {
  try {
    const { level, message, metadata } = await request.json();

    if (!message || !level) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    if (typeof level !== 'string' || !ALLOWED_LOG_LEVELS.includes(level as (typeof ALLOWED_LOG_LEVELS)[number])) {
      return NextResponse.json({ error: 'Invalid level' }, { status: 400 });
    }

    if (typeof message !== 'string' || message.length > MAX_MESSAGE_LENGTH) {
      return NextResponse.json({ error: 'Invalid message' }, { status: 400 });
    }

    if (metadata !== undefined && metadata !== null && typeof metadata !== 'object') {
      return NextResponse.json({ error: 'Invalid metadata' }, { status: 400 });
    }

    // 秘密情報マスキング + サイズ切り詰め (F6-20)
    const sanitizedMetadata = sanitizeMetadata(metadata ?? undefined);

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
      metadata: sanitizedMetadata,
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
