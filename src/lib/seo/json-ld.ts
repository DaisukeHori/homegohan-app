/**
 * トップ (/) に載せる構造化データ (JSON-LD) の Organization と WebSite (#1867)。
 *
 * 事業者名は src/lib/business-info.ts、サービス名は src/lib/site-config.ts の SITE_NAME、URL は getSiteUrl()
 * (= NEXT_PUBLIC_APP_URL) から作る。ドメインを直接書かない (ドメインを切り替えれば自動で新しい URL を指す)。
 * 描画は src/components/seo/SiteStructuredData.tsx (script type="application/ld+json")。
 */
import { APP_ICON_512_PATH } from '@/lib/brand-asset-paths';
import { BUSINESS_NAME } from '@/lib/business-info';
import { SITE_DESCRIPTION } from '@/lib/seo/public-pages';
import { SITE_NAME } from '@/lib/site-config';

/** schema.org の語彙の URL (JSON-LD の @context) */
export const SCHEMA_ORG_CONTEXT = 'https://schema.org';

/** サイトの言語 (WebSite の inLanguage。ルートの layout の <html lang="ja"> と同じ) */
export const SITE_LANGUAGE = 'ja';

/** Organization の @id の後ろに付ける断片 (同じページの中で WebSite の publisher から指す) */
const ORGANIZATION_ID_FRAGMENT = '#organization';
/** WebSite の @id の後ろに付ける断片 */
const WEBSITE_ID_FRAGMENT = '#website';

/** JSON-LD の値 (JSON にできるものだけ) */
export type JsonLdValue = string | number | boolean | null | JsonLdValue[] | { [key: string]: JsonLdValue };

/** JSON-LD の文書 (最上位は object) */
export type JsonLdDocument = { [key: string]: JsonLdValue };

/**
 * トップの JSON-LD (@graph に Organization と WebSite)。
 * siteUrl は末尾の / なし (getSiteUrl() の戻り値の形)。
 */
export function buildSiteJsonLd(siteUrl: string): JsonLdDocument {
  const homeUrl = `${siteUrl}/`;
  const organizationId = `${homeUrl}${ORGANIZATION_ID_FRAGMENT}`;
  return {
    '@context': SCHEMA_ORG_CONTEXT,
    '@graph': [
      {
        '@type': 'Organization',
        '@id': organizationId,
        name: BUSINESS_NAME,
        url: homeUrl,
        logo: `${siteUrl}${APP_ICON_512_PATH}`,
      },
      {
        '@type': 'WebSite',
        '@id': `${homeUrl}${WEBSITE_ID_FRAGMENT}`,
        name: SITE_NAME,
        description: SITE_DESCRIPTION,
        url: homeUrl,
        inLanguage: SITE_LANGUAGE,
        publisher: { '@id': organizationId },
      },
    ],
  };
}

/**
 * script 要素の中に置く JSON の文字列。HTML として解釈されうる文字 (< > &) と、JavaScript の行の終わりとみなされる
 * U+2028 / U+2029 を \uXXXX にする (値に `</script>` が入っても script 要素が途中で閉じない。Next 公式の JSON-LD の例と同じ考え)。
 * \uXXXX は JSON の文字列の中で元の文字に戻るので、検索エンジンが読む値は変わらない。
 */
export function serializeJsonLd(document: JsonLdDocument): string {
  return JSON.stringify(document)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}
