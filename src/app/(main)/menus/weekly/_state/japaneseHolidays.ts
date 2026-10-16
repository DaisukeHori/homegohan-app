// #1769: 週間献立の月カレンダーに出す日本の祝日の一覧を取る URL。
// オリジンは CSP の connect-src と同じ定数 (src/lib/security/csp.ts の HOLIDAYS_API_ORIGIN) から組み立てる。
// 以前は page.tsx に URL を文字どおりに書いていて、CSP の connect-src に無いオリジンだったためブラウザに止められていた。
import { HOLIDAYS_API_ORIGIN } from '@/lib/security/csp';

/** holidays-jp の API の、その年の祝日 ({ "YYYY-MM-DD": 祝日名 }) を返す URL */
export function japaneseHolidaysUrl(year: number): string {
  return `${HOLIDAYS_API_ORIGIN}/api/v1/${year}/date.json`;
}
