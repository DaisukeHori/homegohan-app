/**
 * トップ (/。紹介ページ)。画面の本体は src/components/marketing/LandingPage.tsx (Server Component + 小さな client の島)。
 * 文言の正本は src/components/marketing/landing-copy.ts。殻が持つのはメタ情報・viewport・構造化データだけ (docs/design/marketing/01-landing-site.md §9.6)。
 *
 * #1867: 'use client' のファイルは metadata を export できないので、ページを Server Component の殻と画面の本体に分けた
 * (src/app/pricing/page.tsx と PricingPageView.tsx と同じ形)。殻が持つのは次の 3 つだけ:
 *   - トップのメタ情報 (canonical・og:url が「/」。src/lib/seo/public-pages.ts)
 *   - viewport (ルートの layout のピンチの拡大の禁止を、/ だけ外す)
 *   - 構造化データ (JSON-LD の Organization と WebSite。src/components/seo/SiteStructuredData.tsx)
 */
import type { Metadata, Viewport } from 'next';
import { LANDING_VIEWPORT_MAXIMUM_SCALE } from '@/components/marketing/landing-copy';
import { LandingPage } from '@/components/marketing/LandingPage';
import { SiteStructuredData } from '@/components/seo/SiteStructuredData';
import { publicPageMetadata } from '@/lib/seo/public-pages';
import { getCspNonce } from '@/lib/security/csp-nonce';
import { getSiteUrl } from '@/lib/site-config';

export const metadata: Metadata = publicPageMetadata('/');

/**
 * ルートの layout の viewport は maximum-scale=1・user-scalable=no (ピンチで拡大できない)。WCAG 1.4.4 のため、/ だけ拡大を許す。
 * Next は layout → page の順に鍵ごとに上書きするので、書くのはこの 2 つだけ (width・initialScale・themeColor は layout のまま)。
 */
export const viewport: Viewport = {
  maximumScale: LANDING_VIEWPORT_MAXIMUM_SCALE,
  userScalable: true,
};

export default async function HomePage() {
  const nonce = await getCspNonce();
  return (
    <>
      <SiteStructuredData siteUrl={getSiteUrl()} nonce={nonce} />
      <LandingPage />
    </>
  );
}
