/**
 * GET /api/billing/iap/catalog?store=app_store|play_store — アプリの購入の画面が読む、そのストアで買えるプランと商品 ID (billing/03 §9.2)。
 * 公開のプラン (listPublicPlans) と plan_store_products の売る行 (offered = true。RLS の公開の SELECT) だけを読む。鍵も Stripe も RevenueCat も見ない
 * (@/lib/env に届かない)。ログインは要る (アプリの画面からだけ呼ぶ。requireUser)。売る行が無いプランは返さない (R18)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth/helpers';
import { createClient } from '@/lib/supabase/server';
import { billingErrorResponse } from '@/lib/billing/http';
import { listPublicPlans } from '@/lib/billing/public-plans';
import { IAP_ERROR_HTTP_STATUS, IAP_ERROR_MESSAGES, IapCatalogQuerySchema, buildIapCatalog, isIapStore, type PlanStoreProductRow } from '@/lib/billing/iap-core';

export const dynamic = 'force-dynamic';
const ROUTE_NAME = 'GET /api/billing/iap/catalog';
const NO_STORE = { 'Cache-Control': 'no-store' } as const;

export async function GET(request: Request): Promise<NextResponse> {
  try {
    await requireUser();
    const url = new URL(request.url);
    const parsed = IapCatalogQuerySchema.safeParse({ store: url.searchParams.get('store') });
    if (!parsed.success) {
      return NextResponse.json(
        { error: { code: 'BILL_IAP_INVALID_INPUT', message: IAP_ERROR_MESSAGES.BILL_IAP_INVALID_INPUT, details: parsed.error.issues } },
        { status: IAP_ERROR_HTTP_STATUS.BILL_IAP_INVALID_INPUT, headers: NO_STORE },
      );
    }
    const supabase = await createClient();
    const { data, error } = await supabase
      .from('plan_store_products')
      .select('plan_key, store, billing_interval, product_id, offered')
      .eq('store', parsed.data.store)
      .eq('offered', true);
    if (error) throw error;
    const products = (data ?? []).filter((row): row is PlanStoreProductRow => isIapStore(row.store) && (row.billing_interval === 'month' || row.billing_interval === 'year'));
    const plans = await listPublicPlans();
    return NextResponse.json({ data: buildIapCatalog(parsed.data.store, plans, products) }, { status: 200, headers: NO_STORE });
  } catch (error) {
    return billingErrorResponse(ROUTE_NAME, error);
  }
}
