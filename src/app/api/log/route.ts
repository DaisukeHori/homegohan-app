/**
 * クライアントサイドログを受け取ってDBに保存するAPI
 *
 * ログイン済みなら誰でも書ける (source='client' で保存する) ので、利用者ごとに回数を制限する (#1493)。
 * 枠は src/lib/rate-limit.ts の 'client-log' (key = 認証で確定した user.id)。超えたら 429 で断り、保存しない。
 * 送り手 (Web の logToServer、端末の error-report.ts・push-issue-log.ts) はどれも失敗を握りつぶすので、
 * 断っても画面やサインアウトは止まらない。
 * ここで書いた error は、運用のエラー急増メール (#1157) ではサーバーの障害とは別に数える
 * (src/lib/ops-alerts/app-log-error-spike.ts。利用者が書いた error でサーバーの障害の通知を鳴らしたり止めたりできないように)。
 */

import { NextRequest, NextResponse } from 'next/server';
import { createClient, getSupabaseAdmin } from '@/lib/supabase/server';
import { sanitizeLogEntry } from '@/lib/db-logger';
import { checkRateLimit, rateLimitExceededResponse } from '@/lib/rate-limit';
import { rejectNullCharacterBody } from '@/lib/api/reject-null-character';
import { API_INVALID_JSON_MESSAGE, API_INTERNAL_ERROR_MESSAGE, API_UNAUTHENTICATED_MESSAGE } from '@/lib/api/error-responses';

// #1044 (F6-20): level は enum に限定、message は上限文字数を設ける
const ALLOWED_LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
const MAX_MESSAGE_LENGTH = 2000;

// 失敗の本文の文 (#1917。英語の文を返さない。送り手はどれも失敗を握りつぶすが、画面に出ても読める文にする)
/** 400: level / message が無い */
const LOG_FIELDS_REQUIRED_MESSAGE = 'ログの種類 (level) と内容 (message) を指定してください';
/** 400: level が許可された値でない */
const LOG_LEVEL_INVALID_MESSAGE = 'ログの種類 (level) が正しくありません';
/** 400: message が文字列でない・長すぎる */
const LOG_MESSAGE_INVALID_MESSAGE = 'ログの内容 (message) が正しくありません';
/** 400: metadata がオブジェクトでない */
const LOG_METADATA_INVALID_MESSAGE = 'ログの付加情報 (metadata) が正しくありません';
/** 500: 保存に失敗した (原因はサーバーのログにだけ残す) */
const LOG_SAVE_FAILED_MESSAGE = 'ログを保存できませんでした';

export async function POST(request: NextRequest) {
  // 本文の文字列に NULL 文字 (U+0000) があると、DB (text / jsonb) に届いたところで拒まれて 500 になる。本文を読む handler はどれも、認証・DB に触れる前に 400 で断る (#1657。一覧と例外は src/__tests__/api/null-character-routes.test.ts)
  const nullCharacterRejection = await rejectNullCharacterBody(request);
  if (nullCharacterRejection) return nullCharacterRejection;
  try {
    // 本文が JSON として読めない (壊れた JSON・オブジェクトでない) ときは 400。route 全体の catch に流して 500 にしない (#1917)
    const requestBody = await request.json().catch(() => null);
    if (!requestBody || typeof requestBody !== 'object') {
      return NextResponse.json({ error: API_INVALID_JSON_MESSAGE }, { status: 400 });
    }
    const { level, message, metadata } = requestBody;

    if (!message || !level) {
      return NextResponse.json({ error: LOG_FIELDS_REQUIRED_MESSAGE }, { status: 400 });
    }

    if (typeof level !== 'string' || !ALLOWED_LOG_LEVELS.includes(level as (typeof ALLOWED_LOG_LEVELS)[number])) {
      return NextResponse.json({ error: LOG_LEVEL_INVALID_MESSAGE }, { status: 400 });
    }

    if (typeof message !== 'string' || message.length > MAX_MESSAGE_LENGTH) {
      return NextResponse.json({ error: LOG_MESSAGE_INVALID_MESSAGE }, { status: 400 });
    }

    if (metadata !== undefined && metadata !== null && typeof metadata !== 'object') {
      return NextResponse.json({ error: LOG_METADATA_INVALID_MESSAGE }, { status: 400 });
    }

    // 認証チェック: 未認証リクエストは拒否 (fail-closed)
    // #1044 round-2: sanitizeLogEntry (metadata 全体の JSON.stringify を伴う) より前に
    // 認証チェックを行い、未認証者が巨大な metadata を送って CPU を消費させる DoS を軽減する。
    const supabase = await createClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      return NextResponse.json({ error: API_UNAUTHENTICATED_MESSAGE }, { status: 401 });
    }
    const userId = user.id;

    // 利用者ごとの回数制限 (#1493)。認証で確定した user.id で数え、保存 (と sanitizeLogEntry の重い処理) より前に断る。
    // Upstash が例外を投げたときは下の catch で 500 (判定できないなら通さない。src/lib/rate-limit.ts の fail-close)
    const rateLimit = await checkRateLimit(userId, 'client-log');
    if (!rateLimit.success) {
      return rateLimitExceededResponse(rateLimit);
    }

    // service_roleでログを保存。クライアントは canonical の getSupabaseAdmin で作る (#1162。認証と回数制限を通した後)。
    // 接続情報が欠けていれば MissingEnvError (変数名はサーバーのログにだけ残る。#1434) → 下の catch で固定の文の 500
    const supabaseAdmin = getSupabaseAdmin();

    // 秘密情報マスキング + サイズ切り詰め (F6-20)。message もクライアントが自由に書ける文字列なので、
    // metadata と同じく保存前にマスクする (#1171)
    const { error } = await supabaseAdmin.from('app_logs').insert(
      sanitizeLogEntry({
        level,
        source: 'client',
        message,
        metadata: metadata ?? undefined,
        user_id: userId,
      }),
    );

    if (error) {
      console.error('Failed to save client log:', error);
      return NextResponse.json({ error: LOG_SAVE_FAILED_MESSAGE }, { status: 500 });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Log API error:', error);
    return NextResponse.json({ error: API_INTERNAL_ERROR_MESSAGE }, { status: 500 });
  }
}
