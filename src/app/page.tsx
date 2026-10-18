/**
 * トップ (/。紹介ページ)。画面の本体は LandingPageView.tsx (クライアントコンポーネント)。
 *
 * #1867: 'use client' のファイルは metadata を export できないので、ページを Server Component の殻と画面の本体に分けた
 * (src/app/pricing/page.tsx と PricingPageView.tsx と同じ形)。殻が持つのは次の 2 つだけ:
 *   - トップのメタ情報 (canonical・og:url が「/」。src/lib/seo/public-pages.ts)
 *   - 構造化データ (JSON-LD の Organization と WebSite。src/components/seo/SiteStructuredData.tsx)
 * 画面の文言・動きは LandingPageView.tsx のまま変えていない。
 */
import type { Metadata } from 'next';
import { SiteStructuredData } from '@/components/seo/SiteStructuredData';
import { publicPageMetadata } from '@/lib/seo/public-pages';
import { getCspNonce } from '@/lib/security/csp-nonce';
import { getSiteUrl } from '@/lib/site-config';
import LandingPageView from './LandingPageView';

export const metadata: Metadata = publicPageMetadata('/');

export default async function HomePage() {
  const nonce = await getCspNonce();
  return (
    <>
      <SiteStructuredData siteUrl={getSiteUrl()} nonce={nonce} />
      <LandingPageView />
    </>
  );
}
