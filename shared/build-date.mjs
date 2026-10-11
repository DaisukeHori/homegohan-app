/**
 * ビルド日 (YYYYMMDD) を JST (Asia/Tokyo) の暦日で求める (#1467)
 *
 * next.config.mjs が NEXT_PUBLIC_BUILD_DATE の既定値に使う。以前は `new Date().toISOString()` (UTC の暦日) だったため、
 * JST の 0:00〜8:59 にビルドすると前日の日付になっていた (#1433 の「日付は JST の暦日で決める」方針と食い違う)。
 *
 * next.config.mjs は Node.js がそのまま読むので、TypeScript の packages/shared (formatLocalDate) や
 * supabase/functions/_shared/jst-date.ts (formatJstDate) は import できない。同じ結果を返す実装をここに置く。
 * jst-date.ts と同じく、Intl やタイムゾーンデータに頼らず固定のオフセットで求める
 * (日本は夏時間が無く、JST は常に UTC+9 なので結果は同じ)。
 * packages/shared の formatLocalDate と一致することは src/__tests__/config/next-config-build-info.test.ts で確かめる。
 */

/** JST の UTC からのオフセット (ミリ秒)。日本は夏時間が無いので常に +9 時間 */
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/**
 * その時刻が属する JST の暦日を YYYYMMDD で返す。
 * 例: 2026-10-10T16:00:00Z (JST 10/11 01:00) → "20261011"
 * 不正な Date (Invalid Date) を渡すと RangeError になる (変な日付を黙って返さない)。
 *
 * @param {Date} [now] 省略時は現在時刻
 * @returns {string}
 */
export function formatBuildDateJst(now = new Date()) {
  // 9 時間進めた時刻の「UTC の暦日」が、元の時刻の「JST の暦日」になる
  return new Date(now.getTime() + JST_OFFSET_MS).toISOString().slice(0, 10).replace(/-/g, '');
}
