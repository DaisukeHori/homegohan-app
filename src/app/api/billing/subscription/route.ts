/**
 * GET /api/billing/subscription — 契約の要約 (billing/01 §9.4)。
 * Stripe を呼ばない (gateway を作らない・@/lib/billing/stripe-gateway を import しない) ので、鍵が無くても 200 (S11)。
 * RevenueCat は、期限を過ぎたストアの行のときだけ取り直す (鍵が無い・失敗のときは取り直さずに要約を返す。billing/03 §9.4)。
 * 凍結 (BAN) 中も通す (FROZEN_ALLOWED_API_PATHS。/frozen/billing が読む。billing/01 §9.8) ので、認証は requireUserAllowingFrozen。
 */
import { NextResponse } from 'next/server';
import { requireUserAllowingFrozen } from '@/lib/billing/auth';
import { createBillingRepository } from '@/lib/billing/repository';
import { getBillingSummary } from '@/lib/billing/service';
import { billingErrorResponse } from '@/lib/billing/http';
import { RevenueCatNotConfiguredError, needsLazyResync, type RevenueCatGateway } from '@/lib/billing/iap-core';
import { createRevenueCatGateway } from '@/lib/billing/revenuecat-gateway';
import { createIapRepository } from '@/lib/billing/iap-repository';
import { lazyResyncStoreSubscription } from '@/lib/billing/iap-service';

export const dynamic = 'force-dynamic';
const ROUTE_NAME = 'GET /api/billing/subscription';
const NO_STORE = { 'Cache-Control': 'no-store' } as const;

export async function GET(): Promise<NextResponse> {
  let userId: string | undefined;
  try {
    const user = await requireUserAllowingFrozen();
    userId = user.id;
    const deps = { repository: createBillingRepository() };
    // 遅延の再同期 (billing/03 §8.4・Q-11): 期限を過ぎたストアの行で、5 分より古い取り直しのときだけ RevenueCat から取り直す
    const row = await deps.repository.findLiveSubscription(user.id);
    if (needsLazyResync(row, Date.now())) {
      let gateway: RevenueCatGateway | null = null;
      try {
        gateway = createRevenueCatGateway();
      } catch (error) {
        // 鍵が無いときは取り直さずに、いまの行で要約を返す (S30)
        if (!(error instanceof RevenueCatNotConfiguredError)) throw error;
      }
      if (gateway !== null) {
        await lazyResyncStoreSubscription({ gateway, repository: createIapRepository() }, user.id, row);
      }
    }
    const summary = await getBillingSummary(deps, user.id);
    return NextResponse.json({ data: summary }, { status: 200, headers: NO_STORE });
  } catch (error) {
    return billingErrorResponse(ROUTE_NAME, error, { userId });
  }
}
