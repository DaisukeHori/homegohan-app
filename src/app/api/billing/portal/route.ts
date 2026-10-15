/**
 * POST /api/billing/portal — Stripe の Billing Portal を開く (billing/01 §9.4)。戻り先は /account/billing。本文は読まない。
 * 顧客がまだ無ければ 404。凍結 (BAN) 中も通す (FROZEN_ALLOWED_API_PATHS。billing/01 §9.8) ので、認証は requireUserAllowingFrozen。
 */
import { NextResponse } from 'next/server';
import { requireUserAllowingFrozen } from '@/lib/billing/auth';
import { checkRateLimit, rateLimitExceededResponse } from '@/lib/rate-limit';
import { createStripeGateway } from '@/lib/billing/stripe-gateway';
import { createBillingRepository } from '@/lib/billing/repository';
import { createPortalSession } from '@/lib/billing/service';
import { billingErrorResponse } from '@/lib/billing/http';

export const dynamic = 'force-dynamic';
const ROUTE_NAME = 'POST /api/billing/portal';
const NO_STORE = { 'Cache-Control': 'no-store' } as const;

export async function POST(): Promise<NextResponse> {
  let userId: string | undefined;
  try {
    const user = await requireUserAllowingFrozen();
    userId = user.id;
    const limit = await checkRateLimit(user.id, 'billing');
    if (!limit.success) return rateLimitExceededResponse(limit);
    const deps = { gateway: createStripeGateway(), repository: createBillingRepository() };
    const portal = await createPortalSession(deps, user.id);
    return NextResponse.json({ data: portal }, { status: 200, headers: NO_STORE });
  } catch (error) {
    return billingErrorResponse(ROUTE_NAME, error, { userId });
  }
}
