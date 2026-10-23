/** 課金の route 共通の応答 (billing/01 §8.7)。固定の文だけを本文にする */
import { NextResponse } from 'next/server';
import type { z } from 'zod';
import { internalError } from '@/lib/api/errors';
import { createLogger } from '@/lib/db-logger';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';
import { BILLING_ERROR_HTTP_STATUS, BILLING_ERROR_MESSAGES, BillingError, StripeApiError, StripeNotConfiguredError } from '@/lib/billing/core';
import { IAP_ERROR_HTTP_STATUS, IAP_ERROR_MESSAGES, IapError, RevenueCatApiError, RevenueCatNotConfiguredError } from '@/lib/billing/iap-core';

const NO_STORE = { 'Cache-Control': 'no-store' } as const;

/**
 * 400 の本文。message は日本語の固定の文 (BILLING_ERROR_MESSAGES.BILL_INVALID_INPUT)、details は issues の全件。
 * 課金の schema の issue の文は Zod の既定の英語なので、最初の issue の文を message に入れない (#1917)
 */
export function billingInvalidInputResponse(issues: readonly z.core.$ZodIssue[]): NextResponse {
  return NextResponse.json(
    { error: { code: 'BILL_INVALID_INPUT', message: BILLING_ERROR_MESSAGES.BILL_INVALID_INPUT, details: issues } },
    { status: BILLING_ERROR_HTTP_STATUS.BILL_INVALID_INPUT, headers: NO_STORE },
  );
}

/**
 * route の catch で使う。固定の文だけを本文にする (生のエラー文は internalError が app_logs にだけ残す)。
 * AuthError → 401、ForbiddenError (凍結など) → 403 (code はそのまま)、BillingError → 表のステータス、
 * StripeNotConfiguredError → 503、StripeApiError → 502、それ以外 → internalError (500, nested)
 */
export function billingErrorResponse(routeName: string, error: unknown, ctx: { userId?: string } = {}): NextResponse {
  if (error instanceof AuthError) {
    return NextResponse.json({ error: { code: 'AUTH_UNAUTHENTICATED', message: '認証が必要です' } }, { status: 401, headers: NO_STORE });
  }
  if (error instanceof ForbiddenError) {
    return NextResponse.json({ error: { code: error.code, message: '権限がありません' } }, { status: 403, headers: NO_STORE });
  }
  if (error instanceof BillingError) {
    return NextResponse.json({ error: { code: error.code, message: BILLING_ERROR_MESSAGES[error.code] } }, { status: BILLING_ERROR_HTTP_STATUS[error.code], headers: NO_STORE });
  }
  if (error instanceof StripeNotConfiguredError) {
    return NextResponse.json(
      { error: { code: 'EXT_STRIPE_NOT_CONFIGURED', message: BILLING_ERROR_MESSAGES.EXT_STRIPE_NOT_CONFIGURED } },
      { status: BILLING_ERROR_HTTP_STATUS.EXT_STRIPE_NOT_CONFIGURED, headers: NO_STORE },
    );
  }
  if (error instanceof StripeApiError) {
    return NextResponse.json(
      { error: { code: 'EXT_STRIPE_API_FAILED', message: BILLING_ERROR_MESSAGES.EXT_STRIPE_API_FAILED } },
      { status: BILLING_ERROR_HTTP_STATUS.EXT_STRIPE_API_FAILED, headers: NO_STORE },
    );
  }
  return internalError(routeName, error, ctx, { shape: 'nested' });
}

/**
 * アプリ内課金 (billing/03 §8.5) の route の catch で、billingErrorResponse より先に使う。固定の文だけを本文にする。
 * IapError → 表のステータス、RevenueCatNotConfiguredError → 503 EXT_REVENUECAT_NOT_CONFIGURED、RevenueCatApiError → 502 EXT_REVENUECAT_API_FAILED。
 * それ以外は null (呼び出し側が billingErrorResponse に渡す)。RevenueCat の生の文 (RevenueCatApiError.rawMessage) は本文に入れない
 */
export function iapErrorResponse(routeName: string, error: unknown, ctx: { userId?: string } = {}): NextResponse | null {
  if (error instanceof IapError) {
    // 422 (対応の行が無い商品) と 409 (別の契約と衝突) は運営の対応が要るので、コードだけを構造化ログに残す (§13.3 の運営の処置)
    createLogger(routeName).warn('アプリ内課金の同期を止めました', { code: error.code, user_id: ctx.userId ?? null });
    return NextResponse.json(
      { error: { code: error.code, message: IAP_ERROR_MESSAGES[error.code] } },
      { status: IAP_ERROR_HTTP_STATUS[error.code], headers: NO_STORE },
    );
  }
  if (error instanceof RevenueCatNotConfiguredError) {
    return NextResponse.json(
      { error: { code: 'EXT_REVENUECAT_NOT_CONFIGURED', message: IAP_ERROR_MESSAGES.EXT_REVENUECAT_NOT_CONFIGURED } },
      { status: IAP_ERROR_HTTP_STATUS.EXT_REVENUECAT_NOT_CONFIGURED, headers: NO_STORE },
    );
  }
  if (error instanceof RevenueCatApiError) {
    return NextResponse.json(
      { error: { code: 'EXT_REVENUECAT_API_FAILED', message: IAP_ERROR_MESSAGES.EXT_REVENUECAT_API_FAILED } },
      { status: IAP_ERROR_HTTP_STATUS.EXT_REVENUECAT_API_FAILED, headers: NO_STORE },
    );
  }
  return null;
}
