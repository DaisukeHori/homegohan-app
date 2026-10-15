/**
 * POST /api/webhooks/stripe — Stripe の Webhook の受け口 (billing/01 §9.6)。
 *
 * イベントは「何かが変わった合図」として扱い、契約は必ず Stripe から取り直してから写す (§4.1)。
 * 冪等キーは Stripe の event.id。billing_claim_stripe_event で処理の権利を取ってから処理する。
 *
 * 応答 (§13.2):
 *   - 200: 処理した ({ received, action, detail }) / 処理済み ({ received, duplicate }) / 対象外・モード不一致 ({ received, ignored })
 *   - 409: 同じ event.id をほかが処理中 (15 分以内)。2xx でないので Stripe が後で再送する
 *   - 400: JSON でない・外形が違う。401: 署名が無い・合わない・時刻が古い。413: 本文が大きすぎる
 *   - 500: 処理の失敗 (Stripe が再送する)。503: 署名の秘密 (STRIPE_WEBHOOK_SECRET) が無い / 鍵 (STRIPE_SECRET_KEY) が無い
 *
 * 認証はログインのセッションではなく署名で行う (docs/design/cross/04-api-conventions.md §10)。
 * stripe_webhook_events.payload にはイベントの JSON 全体を残さず、minimizeStripeEventPayload の写しだけを渡す
 * (氏名・メールアドレス・住所を DB に残さない)。本文に Stripe の生のエラー文・イベントの中身を入れない。
 */
import { NextResponse } from 'next/server';
import { internalError } from '@/lib/api/errors';
import { createLogger, generateRequestId } from '@/lib/db-logger';
import {
  STRIPE_SIGNATURE_HEADER,
  STRIPE_WEBHOOK_MAX_BODY_BYTES,
  StripeApiError,
  StripeEventEnvelopeSchema,
  StripeNotConfiguredError,
  minimizeStripeEventPayload,
  type StripeGateway,
} from '@/lib/billing/core';
import { createStripeGateway } from '@/lib/billing/stripe-gateway';
import { BillingRpcError, createBillingRepository } from '@/lib/billing/repository';
import { handleStripeEvent, recordStripeEventFailure } from '@/lib/billing/service';
import { verifyStripeWebhook, WebhookSecretMissingError } from '@/lib/webhook/verify';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// 根拠は STRIPE_WEBHOOK_MAX_DURATION_SECONDS (src/lib/billing/core.ts): Stripe の取り直し 1 回 + RPC 1 回が収まる秒数。
// route segment config は静的解析できるリテラルに限られるので、定数を import せず同じ値をここに書く (一致はテスト 86)
export const maxDuration = 30;

const ROUTE_NAME = 'POST /api/webhooks/stripe';
const NO_STORE = { 'Cache-Control': 'no-store' } as const;
/** 想定外の失敗 (業務エラーでも Stripe の API の失敗でもない) のとき stripe_webhook_events.error_message に残す固定のコード */
const UNEXPECTED_ERROR_CODE = 'SYS_INTERNAL_ERROR';
/** Stripe の API の失敗のとき error_message に残す固定のコード */
const STRIPE_API_FAILED_CODE = 'EXT_STRIPE_API_FAILED';

/** 処理の失敗を、stripe_webhook_events.error_message に残す固定のコードにする (生のエラー文・秘密を入れない) */
function errorCodeOf(error: unknown): string {
  if (error instanceof BillingRpcError) return error.code;
  if (error instanceof StripeApiError) return STRIPE_API_FAILED_CODE;
  return UNEXPECTED_ERROR_CODE;
}

export async function POST(request: Request): Promise<NextResponse> {
  const logger = createLogger(ROUTE_NAME, generateRequestId());

  // 1. 大きさの上限 (署名を確かめる前に、巨大な本文で HMAC・JSON の処理をさせない)
  const declaredLength = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declaredLength) && declaredLength > STRIPE_WEBHOOK_MAX_BODY_BYTES) {
    return NextResponse.json({ error: 'payload_too_large' }, { status: 413, headers: NO_STORE });
  }
  // 2. 署名は受け取ったバイト列そのままに対して付いているので、JSON として読む前の文字列で確かめる
  const payload = await request.text();
  if (Buffer.byteLength(payload, 'utf8') > STRIPE_WEBHOOK_MAX_BODY_BYTES) {
    return NextResponse.json({ error: 'payload_too_large' }, { status: 413, headers: NO_STORE });
  }

  let verification: ReturnType<typeof verifyStripeWebhook>;
  try {
    verification = verifyStripeWebhook(payload, request.headers.get(STRIPE_SIGNATURE_HEADER));
  } catch (error) {
    if (error instanceof WebhookSecretMissingError) {
      // 変数名は getOptionalEnv の警告のログに残る。本文には出さない
      logger.error('Stripe の Webhook の署名の秘密が未設定のため、受け付けませんでした', error);
      return NextResponse.json({ error: 'webhook_not_configured' }, { status: 503, headers: NO_STORE });
    }
    return internalError(ROUTE_NAME, error);
  }
  if (!verification.ok) {
    logger.warn('Stripe の Webhook の署名を確かめられなかったため、受け付けませんでした', { reason: verification.reason });
    return NextResponse.json({ error: 'unauthorized' }, { status: 401, headers: NO_STORE });
  }

  // 3. 外形の確認
  let json: unknown;
  try {
    json = JSON.parse(payload);
  } catch {
    logger.warn('Stripe の Webhook の本文を JSON として読めませんでした');
    return NextResponse.json({ error: 'invalid_payload' }, { status: 400, headers: NO_STORE });
  }
  const parsed = StripeEventEnvelopeSchema.safeParse(json);
  if (!parsed.success) {
    logger.warn('Stripe の Webhook の本文の形が想定と違いました', {
      issues: parsed.error.issues.map((issue) => issue.path.join('.') || '(root)'),
    });
    return NextResponse.json({ error: 'invalid_payload' }, { status: 400, headers: NO_STORE });
  }
  const event = parsed.data;
  const eventLog = { event_id: event.id, event_type: event.type };

  // 4. 鍵が無ければ取り直せないので受け付けない (Stripe は 2xx 以外を再送するので、設定後に届き直す)
  let gateway: StripeGateway;
  try {
    gateway = createStripeGateway();
  } catch (error) {
    if (error instanceof StripeNotConfiguredError) {
      logger.error('Stripe の鍵が未設定のため、Webhook を処理できませんでした', error, eventLog);
      return NextResponse.json({ error: 'stripe_not_configured' }, { status: 503, headers: NO_STORE });
    }
    return internalError(ROUTE_NAME, error, eventLog);
  }

  // 5. テストのイベントを本番で (またはその逆を) 処理しない。鍵のモードが読めないときは不一致扱いにしない
  const eventMode = event.livemode ? 'live' : 'test';
  if (gateway.mode !== null && gateway.mode !== eventMode) {
    logger.warn('Stripe の Webhook のモードが鍵のモードと違うため、何もしませんでした', { ...eventLog, event_mode: eventMode, key_mode: gateway.mode });
    return NextResponse.json({ received: true, ignored: true }, { status: 200, headers: NO_STORE });
  }

  const deps = { gateway, repository: createBillingRepository() };

  // 6. 処理の権利を取る。DB に残すのは最小化した写しだけ
  let claim: Awaited<ReturnType<typeof deps.repository.claimStripeEvent>>;
  try {
    claim = await deps.repository.claimStripeEvent(minimizeStripeEventPayload(event));
  } catch (error) {
    return internalError(ROUTE_NAME, error, eventLog);
  }
  if (claim === 'completed') {
    return NextResponse.json({ received: true, duplicate: true }, { status: 200, headers: NO_STORE });
  }
  if (claim === 'in_progress') {
    // 2xx を返さないので Stripe は後で再送する。そのときには completed (200) か、15 分を過ぎた processing を取り直して処理する
    logger.info('同じ Stripe のイベントをほかが処理中のため、再送を待ちます', eventLog);
    return NextResponse.json({ error: 'event_in_progress' }, { status: 409, headers: NO_STORE });
  }

  // 7. 処理する。8. 失敗したら failed を記録して 500 (Stripe が再送する)
  let outcome: Awaited<ReturnType<typeof handleStripeEvent>>;
  try {
    outcome = await handleStripeEvent(deps, event);
  } catch (error) {
    try {
      await recordStripeEventFailure(deps, event, errorCodeOf(error));
    } catch (finishError) {
      // finish(ok=false) も失敗した: 行は processing のまま残り、15 分を過ぎた再送で取り直す
      logger.error('Stripe のイベントの失敗の記録に失敗しました', finishError, eventLog);
    }
    return internalError(ROUTE_NAME, error, eventLog);
  }
  // 完了を記録する。これに失敗したら 500 (行は processing のまま残り、15 分以内の再送は 409、過ぎた再送で再処理する。§9.6)
  try {
    await deps.repository.finishStripeEvent(event.id, { ok: true });
  } catch (error) {
    return internalError(ROUTE_NAME, error, eventLog);
  }
  logger.info('Stripe のイベントを処理しました', { ...eventLog, action: outcome.action, detail: outcome.detail });
  return NextResponse.json({ received: true, action: outcome.action, detail: outcome.detail }, { status: 200, headers: NO_STORE });
}
