/**
 * /pricing (公開ページ) — 公開のプランの価格と内容を DB の値で描き、CTA は買える間隔だけに置く (billing/01 §10.1・billing/03 §10.1)
 *
 * subscription_plans から公開のプラン (public・個人/家族・free でない・月額の金額が正。billing/03 §8.6 の listPublicPlans) を読み、
 * アプリの WebView で開いたか (Cookie is_native_app) と一緒に、見た目 (PricingPageView) に渡す。
 * 買えるかどうかは Price の登録 (stripe_price_id) で間隔ごとに決まり (isPurchasable)、Stripe の鍵は見ない (@/lib/env に届くものを import しない)。
 */
import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { listPublicPlans } from '@/lib/billing/public-plans';
import { publicPageMetadata } from '@/lib/seo/public-pages';
import PricingPageView from './PricingPageView';

// #1867: title・description・canonical・OGP は src/lib/seo/public-pages.ts が正本
export const metadata: Metadata = publicPageMetadata('/pricing');

/** ネイティブアプリの WebView が付ける Cookie (src/app/(main)/layout.tsx・src/hooks/useNativeAppMode.ts と同じ) */
const NATIVE_APP_COOKIE = 'is_native_app';
const NATIVE_APP_COOKIE_ON = '1';

export default async function PricingPage() {
  const plans = await listPublicPlans();
  const isNativeApp = (await cookies()).get(NATIVE_APP_COOKIE)?.value === NATIVE_APP_COOKIE_ON;
  return <PricingPageView plans={plans} isNativeApp={isNativeApp} />;
}
