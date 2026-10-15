/**
 * GET /api/billing/subscription — 契約の要約 (billing/01 §9.4)。
 * Stripe を呼ばない (gateway を作らない・@/lib/billing/stripe-gateway を import しない) ので、鍵が無くても 200 (S11)。
 * 凍結 (BAN) 中も通す (FROZEN_ALLOWED_API_PATHS。/frozen/billing が読む。billing/01 §9.8) ので、認証は requireUserAllowingFrozen。
 */
import { NextResponse } from 'next/server';
import { requireUserAllowingFrozen } from '@/lib/billing/auth';
import { createBillingRepository } from '@/lib/billing/repository';
import { getBillingSummary } from '@/lib/billing/service';
import { billingErrorResponse } from '@/lib/billing/http';

export const dynamic = 'force-dynamic';
const ROUTE_NAME = 'GET /api/billing/subscription';
const NO_STORE = { 'Cache-Control': 'no-store' } as const;

export async function GET(): Promise<NextResponse> {
  let userId: string | undefined;
  try {
    const user = await requireUserAllowingFrozen();
    userId = user.id;
    const deps = { repository: createBillingRepository() };
    const summary = await getBillingSummary(deps, user.id);
    return NextResponse.json({ data: summary }, { status: 200, headers: NO_STORE });
  } catch (error) {
    return billingErrorResponse(ROUTE_NAME, error, { userId });
  }
}
