/**
 * POST /api/billing/iap/sync — 本人のストアの契約を RevenueCat から取り直して写す (billing/03 §9.3)。
 * 本文は読まない (本人 = ログインの利用者。app_user_id は user.id)。購入・復元・画面を開いたとき・前面復帰にアプリが呼ぶ。
 * 応答は同期後の BillingSummary (GET /api/billing/subscription と同じ形)。
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth/helpers';
import { checkRateLimit, rateLimitExceededResponse } from '@/lib/rate-limit';
import { createRevenueCatGateway } from '@/lib/billing/revenuecat-gateway';
import { createIapRepository } from '@/lib/billing/iap-repository';
import { createBillingRepository, BillingRpcError } from '@/lib/billing/repository';
import { getBillingSummary } from '@/lib/billing/service';
import { syncStoreSubscriber } from '@/lib/billing/iap-service';
import { IAP_SYNC_SOURCE, IapError } from '@/lib/billing/iap-core';
import { billingErrorResponse, iapErrorResponse } from '@/lib/billing/http';

export const dynamic = 'force-dynamic';
const ROUTE_NAME = 'POST /api/billing/iap/sync';
const NO_STORE = { 'Cache-Control': 'no-store' } as const;

export async function POST(): Promise<NextResponse> {
  let userId: string | undefined;
  try {
    const user = await requireUser();
    userId = user.id;
    const limit = await checkRateLimit(user.id, 'billing');
    if (!limit.success) return rateLimitExceededResponse(limit);
    const deps = { gateway: createRevenueCatGateway(), repository: createIapRepository() };
    try {
      await syncStoreSubscriber(deps, user.id, IAP_SYNC_SOURCE);
    } catch (error) {
      // 別の live 行 (Stripe / 手動付与 / 別のストア) と衝突 → 409 (S13)。それ以外は下の catch
      if (error instanceof BillingRpcError && error.code === 'BILL_LIVE_ROW_CONFLICT') throw new IapError('BILL_IAP_SYNC_CONFLICT');
      throw error;
    }
    const summary = await getBillingSummary({ repository: createBillingRepository() }, user.id);
    return NextResponse.json({ data: summary }, { status: 200, headers: NO_STORE });
  } catch (error) {
    return iapErrorResponse(ROUTE_NAME, error, { userId }) ?? billingErrorResponse(ROUTE_NAME, error, { userId });
  }
}
