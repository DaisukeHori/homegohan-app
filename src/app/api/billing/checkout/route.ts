/**
 * POST /api/billing/checkout — 有料プランの Stripe Checkout Session を作り、その URL を返す (billing/01 §9.1)。
 * 顧客 (billing_customers) が無ければ作る。live な契約 (手動付与を含む) があれば 409。
 */
import { NextResponse } from 'next/server';
import { rejectNullCharacterBody } from '@/lib/api/reject-null-character';
import { requireUser } from '@/lib/auth/helpers';
import { checkRateLimit, rateLimitExceededResponse } from '@/lib/rate-limit';
import { CheckoutRequestSchema } from '@/lib/billing/core';
import { createStripeGateway } from '@/lib/billing/stripe-gateway';
import { createBillingRepository } from '@/lib/billing/repository';
import { startCheckout } from '@/lib/billing/service';
import { billingErrorResponse, billingInvalidInputResponse } from '@/lib/billing/http';

export const dynamic = 'force-dynamic';
const ROUTE_NAME = 'POST /api/billing/checkout';
const NO_STORE = { 'Cache-Control': 'no-store' } as const;

export async function POST(request: Request): Promise<NextResponse> {
  // 本文の NULL 文字 (U+0000) は認証・DB に触れる前に 400 で断る (#1657。一覧と例外は src/__tests__/api/null-character-routes.test.ts)。
  // null-character-routes は handler の最初の 2 行がこの形であることを見る (本文を読む checkout と sync だけに置く)
  const nullCharacterRejection = await rejectNullCharacterBody(request, { shape: 'nested' });
  if (nullCharacterRejection) return nullCharacterRejection;
  let userId: string | undefined;
  try {
    const user = await requireUser();
    userId = user.id;
    const limit = await checkRateLimit(user.id, 'billing');
    if (!limit.success) return rateLimitExceededResponse(limit);
    const body: unknown = await request.json().catch(() => null);
    const parsed = CheckoutRequestSchema.safeParse(body);
    if (!parsed.success) return billingInvalidInputResponse(parsed.error.issues);
    const deps = { gateway: createStripeGateway(), repository: createBillingRepository() };
    const result = await startCheckout(deps, { id: user.id, email: user.email ?? null }, parsed.data.plan_key, parsed.data.interval);
    return NextResponse.json({ data: result }, { status: 200, headers: NO_STORE });
  } catch (error) {
    return billingErrorResponse(ROUTE_NAME, error, { userId });
  }
}
