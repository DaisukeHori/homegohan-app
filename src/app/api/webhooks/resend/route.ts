/**
 * POST /api/webhooks/resend — Resend の Webhook の受け口。#1184
 *
 * ハードバウンス (email.bounced のうち bounce.type が Permanent) と苦情 (email.complained) の宛先を、
 * 宛先停止リスト (email_blacklist) に入れる。sendEmail (src/lib/emails/send.ts) は、載っている宛先へは送らない。
 * ソフトバウンス (一時的な不達) と、それ以外の種類のイベントは何もせずに 200 を返す。
 *
 * 応答:
 *   - 200: 受け付けた (停止リストに入れた / 入れるものが無かった)。同じイベントが何度届いても結果は同じ (冪等)
 *   - 401: 署名が無い・合わない・時刻が古い (送り手が Resend だと確かめられない)
 *   - 503: 署名の秘密 (RESEND_WEBHOOK_SECRET) が未設定。確かめられないので受け付けない (fail-closed)
 *   - 413: 本文が大きすぎる。400: 署名は合ったが本文が JSON として読めない
 *   - 500: 停止リストへの書き込みに失敗した。Resend は 2xx 以外を時間をおいて送り直すので、取りこぼさない
 *
 * 認証はログインのセッションではなく署名で行う (docs/design/cross/04-api-conventions.md §10)。
 * Resend の管理画面での Webhook の登録と、署名の秘密の本番への設定は、このコードの外の作業 (ENV_SETUP.md)。
 */
import { NextResponse } from 'next/server';
import { internalError } from '@/lib/api/errors';
import { createLogger, generateRequestId } from '@/lib/db-logger';
import { maskEmailAddress } from '@/lib/emails/send';
import { addToEmailBlacklist } from '@/lib/emails/suppression';
import { classifyResendEvent, ResendWebhookEventSchema } from '@/lib/emails/resend-webhook-event';
import { readSvixHeaders, verifyResendWebhook, WebhookSecretMissingError } from '@/lib/webhook/verify';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ROUTE_NAME = 'POST /api/webhooks/resend';

/**
 * 受け付ける本文の上限 (バイト)。Resend のメールのイベントの本文は数 KB で、これより大きいものは届かない。
 * 署名を確かめる前に、大きな本文で HMAC の計算や JSON の読み込みをさせないための上限。
 */
const MAX_WEBHOOK_BODY_BYTES = 256 * 1024;

const NO_STORE = { 'Cache-Control': 'no-store' } as const;

export async function POST(request: Request): Promise<NextResponse> {
  const logger = createLogger(ROUTE_NAME, generateRequestId());

  const declaredLength = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declaredLength) && declaredLength > MAX_WEBHOOK_BODY_BYTES) {
    return NextResponse.json({ error: 'payload_too_large' }, { status: 413, headers: NO_STORE });
  }
  // 署名は受け取ったバイト列そのままに対して付いているので、JSON として読む前の文字列で確かめる
  const payload = await request.text();
  if (Buffer.byteLength(payload, 'utf8') > MAX_WEBHOOK_BODY_BYTES) {
    return NextResponse.json({ error: 'payload_too_large' }, { status: 413, headers: NO_STORE });
  }

  let verification: ReturnType<typeof verifyResendWebhook>;
  try {
    verification = verifyResendWebhook(payload, readSvixHeaders(request.headers));
  } catch (error) {
    if (error instanceof WebhookSecretMissingError) {
      // 変数名は getOptionalEnv の警告のログに残る。本文には出さない
      logger.error('Resend の Webhook の署名の秘密が未設定のため、受け付けませんでした', error);
      return NextResponse.json({ error: 'webhook_not_configured' }, { status: 503, headers: NO_STORE });
    }
    return internalError(ROUTE_NAME, error);
  }
  if (!verification.ok) {
    logger.warn('Resend の Webhook の署名を確かめられなかったため、受け付けませんでした', { reason: verification.reason });
    return NextResponse.json({ error: 'unauthorized' }, { status: 401, headers: NO_STORE });
  }

  let json: unknown;
  try {
    json = JSON.parse(payload);
  } catch {
    logger.warn('Resend の Webhook の本文を JSON として読めませんでした');
    return NextResponse.json({ error: 'invalid_payload' }, { status: 400, headers: NO_STORE });
  }
  const parsed = ResendWebhookEventSchema.safeParse(json);
  if (!parsed.success) {
    logger.warn('Resend の Webhook の本文の形が想定と違いました', {
      issues: parsed.error.issues.map((issue) => issue.path.join('.') || '(root)'),
    });
    return NextResponse.json({ error: 'invalid_payload' }, { status: 400, headers: NO_STORE });
  }
  const event = parsed.data;

  const action = classifyResendEvent(event);
  if (action.action === 'ignore') {
    return NextResponse.json({ received: true }, { status: 200, headers: NO_STORE });
  }

  // 受けた時刻 (このサーバーの今) を残す。既に載っている宛先は、最初に載った時刻のまま変わらない
  const receivedAt = new Date().toISOString();
  const result = await addToEmailBlacklist(action.addresses, action.reason, receivedAt);
  const logMeta = {
    event_type: event.type,
    reason: action.reason,
    recipients: action.addresses.map(maskEmailAddress),
    email_id: event.data?.email_id ?? null,
  };
  if (!result.ok) {
    // Resend に送り直してもらう (500)。元のエラーは構造化ログにだけ残す
    return internalError(ROUTE_NAME, result.error, { ...logMeta, table: 'email_blacklist' });
  }
  logger.info('宛先停止リストに入れました (既に載っていた宛先はそのまま)', logMeta);
  return NextResponse.json({ received: true }, { status: 200, headers: NO_STORE });
}
