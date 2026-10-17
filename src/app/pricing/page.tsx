/**
 * /pricing (公開ページ) — データ駆動で「買えるプランだけ」を描く (billing/01 §10.1)
 *
 * subscription_plans から買えるプラン (public・個人/家族・free でない・月額の Price がある) を読み、
 * アプリの WebView で開いたか (Cookie is_native_app) と一緒に、見た目 (PricingPageView) に渡す。
 * 出すか出さないかは Price の登録 (stripe_price_id) だけで決まり、Stripe の鍵は見ない (@/lib/env に届くものを import しない)。
 */
import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { listPurchasablePlans } from '@/lib/billing/public-plans';
import { publicPageMetadata } from '@/lib/seo/public-pages';
import PricingPageView from './PricingPageView';

// #1867: title・description・canonical・OGP は src/lib/seo/public-pages.ts が正本
export const metadata: Metadata = publicPageMetadata('/pricing');

/** ネイティブアプリの WebView が付ける Cookie (src/app/(main)/layout.tsx・src/hooks/useNativeAppMode.ts と同じ) */
const NATIVE_APP_COOKIE = 'is_native_app';
const NATIVE_APP_COOKIE_ON = '1';

export default async function PricingPage() {
  const plans = await listPurchasablePlans();
  const isNativeApp = (await cookies()).get(NATIVE_APP_COOKIE)?.value === NATIVE_APP_COOKIE_ON;
  return <PricingPageView plans={plans} isNativeApp={isNativeApp} />;
}
