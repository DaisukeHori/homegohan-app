/**
 * POST /api/billing/checkout/sync — 戻り画面 (/account/billing?checkout=success&session_id=…) からの同期 (billing/01 §9.3)。
 * Session の持ち主が本人でなければ 403。Session が complete なら契約を Stripe から取り直して写し、要約を返す。
 */
import { NextResponse } from 'next/server';
import { rejectNullCharacterBody } from '@/lib/api/reject-null-character';
import { requireUser } from '@/lib/auth/helpers';
import { checkRateLimit, rateLimitExceededResponse } from '@/lib/rate-limit';
import { CheckoutSyncRequestSchema } from '@/lib/billing/core';
import { createStripeGateway } from '@/lib/billing/stripe-gateway';
import { createBillingRepository } from '@/lib/billing/repository';
import { syncCheckoutSession } from '@/lib/billing/service';
import { billingErrorResponse, billingInvalidInputResponse } from '@/lib/billing/http';

export const dynamic = 'force-dynamic';
const ROUTE_NAME = 'POST /api/billing/checkout/sync';
const NO_STORE = { 'Cache-Control': 'no-store' } as const;

export async function POST(request: Request): Promise<NextResponse> {
  // 本文の NULL 文字 (U+0000) は認証・DB に触れる前に 400 で断る (#1657。一覧と例外は src/__tests__/api/null-character-routes.test.ts)
  const nullCharacterRejection = await rejectNullCharacterBody(request, { shape: 'nested' });
  if (nullCharacterRejection) return nullCharacterRejection;
  let userId: string | undefined;
  try {
    const user = await requireUser();
    userId = user.id;
    const limit = await checkRateLimit(user.id, 'billing');
    if (!limit.success) return rateLimitExceededResponse(limit);
    const body: unknown = await request.json().catch(() => null);
    const parsed = CheckoutSyncRequestSchema.safeParse(body);
    if (!parsed.success) return billingInvalidInputResponse(parsed.error.issues);
    const deps = { gateway: createStripeGateway(), repository: createBillingRepository() };
    const summary = await syncCheckoutSession(deps, user.id, parsed.data.session_id);
    return NextResponse.json({ data: summary }, { status: 200, headers: NO_STORE });
  } catch (error) {
    return billingErrorResponse(ROUTE_NAME, error, { userId });
  }
}
