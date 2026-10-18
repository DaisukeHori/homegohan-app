/**
 * トップ (/) の構造化データ (JSON-LD の Organization と WebSite) を出す (#1867)。中身は src/lib/seo/json-ld.ts。
 *
 * <script type="application/ld+json"> は実行されないデータの塊だが、アプリのインラインスクリプトの見張り
 * (tests/csp-no-inline-script.test.ts の ALLOWED_INLINE_SCRIPTS・tests/inner-html-contract.test.ts の ALLOWED_HTML_SINKS) の
 * 規則どおり、このリクエストの CSP の nonce (getCspNonce()) を付け、中身は serializeJsonLd の戻り値だけを差し込む。
 * nonce は呼ぶ側 (src/app/page.tsx) が読んで渡す (この部品は同期にして、テストで renderToStaticMarkup で描けるようにする)。
 */
import { buildSiteJsonLd, serializeJsonLd } from '@/lib/seo/json-ld';

interface SiteStructuredDataProps {
  /** サイトの URL (末尾の / なし。getSiteUrl() の戻り値) */
  siteUrl: string;
  /** このリクエストの CSP の nonce (getCspNonce())。proxy の外 (ビルド時など) は null */
  nonce: string | null;
}

export function SiteStructuredData({ siteUrl, nonce }: SiteStructuredDataProps) {
  return (
    <script
      type="application/ld+json"
      nonce={nonce ?? undefined}
      dangerouslySetInnerHTML={{ __html: serializeJsonLd(buildSiteJsonLd(siteUrl)) }}
    />
  );
}
