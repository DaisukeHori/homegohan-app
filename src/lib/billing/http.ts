/** 課金の route 共通の応答 (billing/01 §8.7)。固定の文だけを本文にする */
import { NextResponse } from 'next/server';
import type { z } from 'zod';
import { internalError } from '@/lib/api/errors';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';
import { BILLING_ERROR_HTTP_STATUS, BILLING_ERROR_MESSAGES, BillingError, StripeApiError, StripeNotConfiguredError } from '@/lib/billing/core';

const NO_STORE = { 'Cache-Control': 'no-store' } as const;

/** 400 の本文 (super-admin の validation-errors と同じ形: message は最初の issue の文、details は issues の全件) */
export function billingInvalidInputResponse(issues: readonly z.core.$ZodIssue[]): NextResponse {
  return NextResponse.json(
    { error: { code: 'BILL_INVALID_INPUT', message: issues[0]?.message ?? BILLING_ERROR_MESSAGES.BILL_INVALID_INPUT, details: issues } },
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
