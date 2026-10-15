/**
 * POST /api/billing/subscription/resume — 解約の予約を取り消す (billing/01 §9.5)。予約が無ければ 409。本文は読まない。
 * 凍結 (BAN) 中は通さない (利用を続ける操作。middleware が 403、route に届いても requireUser が 403。billing/01 §9.8)。
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth/helpers';
import { checkRateLimit, rateLimitExceededResponse } from '@/lib/rate-limit';
import { createStripeGateway } from '@/lib/billing/stripe-gateway';
import { createBillingRepository } from '@/lib/billing/repository';
import { revokeCancellation } from '@/lib/billing/service';
import { billingErrorResponse } from '@/lib/billing/http';

export const dynamic = 'force-dynamic';
const ROUTE_NAME = 'POST /api/billing/subscription/resume';
const NO_STORE = { 'Cache-Control': 'no-store' } as const;

export async function POST(): Promise<NextResponse> {
  let userId: string | undefined;
  try {
    const user = await requireUser();
    userId = user.id;
    const limit = await checkRateLimit(user.id, 'billing');
    if (!limit.success) return rateLimitExceededResponse(limit);
    const deps = { gateway: createStripeGateway(), repository: createBillingRepository() };
    const summary = await revokeCancellation(deps, user.id);
    return NextResponse.json({ data: summary }, { status: 200, headers: NO_STORE });
  } catch (error) {
    return billingErrorResponse(ROUTE_NAME, error, { userId });
  }
}
