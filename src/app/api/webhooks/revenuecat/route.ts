/**
 * POST /api/webhooks/revenuecat — RevenueCat の Webhook の受け口 (billing/03 §9.1)。核の Stripe の受け口 (billing/01 §9.6) と同じ骨格。
 * イベントは合図として扱い、契約は必ず RevenueCat から取り直してから写す。冪等キーは event.id (billing_claim_revenuecat_event)。
 * 応答 (§13.2): 200 処理した / 処理済み / 対象外、409 ほかが処理中、400 外形、401 署名、413 大きさ、500 処理の失敗 (RevenueCat が再送)、
 * 503 署名の秘密か鍵が無い。認証はログインではなく署名 (cross/04 §10)。本文に RevenueCat の生のエラー文・イベントの中身を入れない。
 */
import { NextResponse } from 'next/server';
import { internalError } from '@/lib/api/errors';
import { createLogger, generateRequestId } from '@/lib/db-logger';
import {
  REVENUECAT_SIGNATURE_HEADER,
  REVENUECAT_WEBHOOK_API_VERSION,
  REVENUECAT_WEBHOOK_MAX_BODY_BYTES,
  IapError,
  RevenueCatApiError,
  RevenueCatNotConfiguredError,
  RevenueCatWebhookEnvelopeSchema,
  minimizeRevenueCatEventPayload,
  type RevenueCatGateway,
} from '@/lib/billing/iap-core';
import { createRevenueCatGateway } from '@/lib/billing/revenuecat-gateway';
import { createIapRepository } from '@/lib/billing/iap-repository';
import { BillingRpcError } from '@/lib/billing/repository';
import { handleRevenueCatEvent, recordRevenueCatEventFailure } from '@/lib/billing/iap-service';
import { verifyRevenueCatWebhook, WebhookSecretMissingError } from '@/lib/webhook/verify';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// 根拠は REVENUECAT_WEBHOOK_MAX_DURATION_SECONDS (src/lib/billing/iap-core.ts)。route segment config はリテラルだけ (一致はテスト 30)
export const maxDuration = 30;

const ROUTE_NAME = 'POST /api/webhooks/revenuecat';
const NO_STORE = { 'Cache-Control': 'no-store' } as const;
const UNEXPECTED_ERROR_CODE = 'SYS_INTERNAL_ERROR';
const REVENUECAT_API_FAILED_CODE = 'EXT_REVENUECAT_API_FAILED';

function errorCodeOf(error: unknown): string {
  if (error instanceof BillingRpcError) return error.code;
  if (error instanceof IapError) return error.code;
  if (error instanceof RevenueCatApiError) return REVENUECAT_API_FAILED_CODE;
  return UNEXPECTED_ERROR_CODE;
}

export async function POST(request: Request): Promise<NextResponse> {
  const logger = createLogger(ROUTE_NAME, generateRequestId());
  const declaredLength = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declaredLength) && declaredLength > REVENUECAT_WEBHOOK_MAX_BODY_BYTES) {
    return NextResponse.json({ error: 'payload_too_large' }, { status: 413, headers: NO_STORE });
  }
  const payload = await request.text();
  if (Buffer.byteLength(payload, 'utf8') > REVENUECAT_WEBHOOK_MAX_BODY_BYTES) {
    return NextResponse.json({ error: 'payload_too_large' }, { status: 413, headers: NO_STORE });
  }
  let verification: ReturnType<typeof verifyRevenueCatWebhook>;
  try {
    verification = verifyRevenueCatWebhook(payload, request.headers.get(REVENUECAT_SIGNATURE_HEADER));
  } catch (error) {
    if (error instanceof WebhookSecretMissingError) {
      logger.error('RevenueCat の Webhook の署名の秘密が未設定のため、受け付けませんでした', error);
      return NextResponse.json({ error: 'webhook_not_configured' }, { status: 503, headers: NO_STORE });
    }
    return internalError(ROUTE_NAME, error);
  }
  if (!verification.ok) {
    logger.warn('RevenueCat の Webhook の署名を確かめられなかったため、受け付けませんでした', { reason: verification.reason });
    return NextResponse.json({ error: 'unauthorized' }, { status: 401, headers: NO_STORE });
  }
  let json: unknown;
  try {
    json = JSON.parse(payload);
  } catch {
    return NextResponse.json({ error: 'invalid_payload' }, { status: 400, headers: NO_STORE });
  }
  const parsed = RevenueCatWebhookEnvelopeSchema.safeParse(json);
  if (!parsed.success) {
    logger.warn('RevenueCat の Webhook の本文の形が想定と違いました', { issues: parsed.error.issues.map((issue) => issue.path.join('.') || '(root)') });
    return NextResponse.json({ error: 'invalid_payload' }, { status: 400, headers: NO_STORE });
  }
  const envelope = parsed.data;
  const event = envelope.event;
  const eventLog = { event_id: event.id, event_type: event.type };
  if (envelope.api_version !== REVENUECAT_WEBHOOK_API_VERSION) {
    logger.warn('RevenueCat の Webhook の api_version が想定と違います (処理は続けます)', { ...eventLog, api_version: envelope.api_version });
  }
  let gateway: RevenueCatGateway;
  try {
    gateway = createRevenueCatGateway();
  } catch (error) {
    if (error instanceof RevenueCatNotConfiguredError) {
      logger.error('RevenueCat の鍵が未設定のため、Webhook を処理できませんでした', error, eventLog);
      return NextResponse.json({ error: 'revenuecat_not_configured' }, { status: 503, headers: NO_STORE });
    }
    return internalError(ROUTE_NAME, error, eventLog);
  }
  const deps = { gateway, repository: createIapRepository() };
  let claim: Awaited<ReturnType<typeof deps.repository.claimRevenueCatEvent>>;
  try {
    claim = await deps.repository.claimRevenueCatEvent(minimizeRevenueCatEventPayload(envelope));
  } catch (error) {
    return internalError(ROUTE_NAME, error, eventLog);
  }
  if (claim === 'completed') return NextResponse.json({ received: true, duplicate: true }, { status: 200, headers: NO_STORE });
  if (claim === 'in_progress') {
    logger.info('同じ RevenueCat のイベントをほかが処理中のため、再送を待ちます', eventLog);
    return NextResponse.json({ error: 'event_in_progress' }, { status: 409, headers: NO_STORE });
  }
  let outcome: Awaited<ReturnType<typeof handleRevenueCatEvent>>;
  try {
    outcome = await handleRevenueCatEvent(deps, event);
  } catch (error) {
    try {
      await recordRevenueCatEventFailure(deps, event, errorCodeOf(error));
    } catch (finishError) {
      logger.error('RevenueCat のイベントの失敗の記録に失敗しました', finishError, eventLog);
    }
    return internalError(ROUTE_NAME, error, eventLog);
  }
  try {
    await deps.repository.finishRevenueCatEvent(event.id, { ok: true });
  } catch (error) {
    return internalError(ROUTE_NAME, error, eventLog);
  }
  logger.info('RevenueCat のイベントを処理しました', { ...eventLog, action: outcome.action, detail: outcome.detail });
  return NextResponse.json({ received: true, action: outcome.action, detail: outcome.detail }, { status: 200, headers: NO_STORE });
}
