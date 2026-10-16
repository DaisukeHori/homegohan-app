/**
 * Web の request からログインの文脈 (国) を読む。設計の正典 docs/design/cross/16-auth-history-sessions.md §13.5。
 * 国は Vercel が付けるヘッダ x-vercel-ip-country だけから取る (GeoIP の外部サービスは使わない §0.3)。
 */

/** Vercel が利用者の国 (ISO 3166-1 alpha-2) を入れるヘッダ */
export const VERCEL_IP_COUNTRY_HEADER = 'x-vercel-ip-country';
/** user_sessions_metadata.country_code (character(2)) に入れてよい形 */
const COUNTRY_CODE_PATTERN = /^[A-Z]{2}$/;

/** x-vercel-ip-country が大文字 2 文字ならその値、無い・形が違えば null */
export function countryCodeOf(headers: Pick<Headers, 'get'>): string | null {
  const value = headers.get(VERCEL_IP_COUNTRY_HEADER);
  return value !== null && COUNTRY_CODE_PATTERN.test(value) ? value : null;
}
