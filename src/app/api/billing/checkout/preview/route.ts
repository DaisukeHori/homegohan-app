/**
 * GET /api/billing/checkout/preview?plan_key=&interval= — 特商法の最終確認画面に出す内容 (billing/01 §9.2)。
 * Stripe を呼ばない (gateway を作らない・@/lib/billing/stripe-gateway を import しない) ので、鍵が無くても 200 (S11)。
 * レート制限は掛けない (読み取りだけ)。
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth/helpers';
import { CheckoutRequestSchema } from '@/lib/billing/core';
import { createBillingRepository } from '@/lib/billing/repository';
import { previewCheckout } from '@/lib/billing/service';
import { billingErrorResponse, billingInvalidInputResponse } from '@/lib/billing/http';

export const dynamic = 'force-dynamic';
const ROUTE_NAME = 'GET /api/billing/checkout/preview';
const NO_STORE = { 'Cache-Control': 'no-store' } as const;

export async function GET(request: Request): Promise<NextResponse> {
  let userId: string | undefined;
  try {
    const user = await requireUser();
    userId = user.id;
    const query = new URL(request.url).searchParams;
    const parsed = CheckoutRequestSchema.safeParse({ plan_key: query.get('plan_key'), interval: query.get('interval') });
    if (!parsed.success) return billingInvalidInputResponse(parsed.error.issues);
    const deps = { repository: createBillingRepository() };
    const preview = await previewCheckout(deps, user.id, parsed.data.plan_key, parsed.data.interval);
    return NextResponse.json({ data: preview }, { status: 200, headers: NO_STORE });
  } catch (error) {
    return billingErrorResponse(ROUTE_NAME, error, { userId });
  }
}
