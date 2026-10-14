/**
 * 外国の AI 事業者への提供の同意: Next.js 側の「送る手前で止める」部品 (T15 / #1154)
 *
 * 利用者のデータを外国の AI 事業者へ送る API Route・cron は、送る手前で requireAiConsent() (または checkUserAiConsent()) を呼ぶ。
 * 判定の本体は Edge Functions と共用の supabase/functions/_shared/ai-consent.ts (runAiConsentCheck / decideAiConsent) で、
 * ここはクエリの実行と、止めたときの応答 (NextResponse) を作るだけ。
 *
 *   - 未同意 (一度も同意していない・撤回した・古い版の文面に同意した): 403 { error, code: 'AI_CONSENT_REQUIRED' }
 *   - 判定の読み取りに失敗した: 503 { error, code: 'AI_CONSENT_CHECK_FAILED' } (送らない。fail-closed)
 * 本文は固定の文 (#1172: 変数名・DB のエラー文は出さない)。
 *
 * このファイルは next/headers や node: の API を使わない (runtime = 'edge' の cron からも使うため)。
 * 一覧 (どの経路がどこで止めるか) と、未同意なら送らないことの実際の route での確かめは tests/ai-consent-enforcement.test.ts と
 * tests/ai-consent-enforcement-routes.test.ts にある。
 */
import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createLogger } from '@/lib/db-logger';
import {
  AI_CONSENT_DECISION_COLUMNS,
  aiConsentSkippedField,
  AI_CONSENT_TABLE,
  aiConsentDeniedPayload,
  aiConsentDeniedStoredMessage,
  aiConsentDeniedStoredMessageOfResponse,
  runAiConsentCheck,
  type AiConsentDecision,
} from '../../../supabase/functions/_shared/ai-consent';

export { aiConsentDeniedPayload, aiConsentDeniedStoredMessage, aiConsentDeniedStoredMessageOfResponse, aiConsentSkippedField };

/** 判定に使うクライアント (本人のセッションのクライアントか、service role のクライアント) */
export type AiConsentGuardDb = Pick<SupabaseClient, 'from'>;

/**
 * 利用者のデータを AI へ送ってよいかを判定する。例外は投げない (失敗は check_failed)。
 * userId は認証で確定した本人の ID (cron ではキューの行の user_id) を渡す。
 */
export async function checkUserAiConsent(
  db: AiConsentGuardDb,
  userId: string | null | undefined,
): Promise<AiConsentDecision> {
  const decision = await runAiConsentCheck(userId, (id) =>
    db.from(AI_CONSENT_TABLE).select(AI_CONSENT_DECISION_COLUMNS).eq('user_id', id).is('revoked_at', null),
  );
  if (!decision.allowed && decision.reason === 'check_failed') {
    // 読めずに止めたことは運用で気づけるよう残す (未同意で止めたのは利用者の選択なので残さない)
    const logger = createLogger('ai-consent-guard');
    (typeof userId === 'string' && userId ? logger.withUser(userId) : logger).warn(
      '外国の AI 事業者への提供の同意を読めなかったため、AI へ送らずに止めました',
      { reason: decision.reason },
    );
  }
  return decision;
}

/** 止めたときの応答を作る */
export function aiConsentDeniedResponse(
  decision: Extract<AiConsentDecision, { allowed: false }>,
  headers?: HeadersInit,
): NextResponse {
  const { status, body } = aiConsentDeniedPayload(decision);
  return NextResponse.json(body, { status, headers });
}

/**
 * 送る手前で呼ぶ。送ってよければ null、止めるなら応答 (403 / 503) を返す。
 *
 *   const denied = await requireAiConsent(supabase, user.id);
 *   if (denied) return denied;
 */
export async function requireAiConsent(
  db: AiConsentGuardDb,
  userId: string | null | undefined,
  headers?: HeadersInit,
): Promise<NextResponse | null> {
  const decision = await checkUserAiConsent(db, userId);
  return decision.allowed ? null : aiConsentDeniedResponse(decision, headers);
}
