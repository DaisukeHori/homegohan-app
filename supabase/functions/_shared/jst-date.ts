/**
 * JST (Asia/Tokyo, UTC+9) の日付ヘルパー - Edge Functions 用の純粋関数
 *
 * Edge Runtime (Deno) のタイムゾーンは UTC。そのため
 * `new Date().toISOString().split('T')[0]` は UTC の暦日になり、
 * JST 00:00〜08:59 の間は「前日」を返してしまう (#1210)。
 * DB の日付列 (meal_plan_days.day_date など) は JST の暦日で入っているので、
 * 「今日」や「ある時刻が属する日」を求めるときは、このファイルの関数を使う。
 *
 * Web / Mobile 側の同等ヘルパーは packages/shared/src/date-utils.ts の
 * formatLocalDate / todayLocal (src/lib/date-utils.ts から import できる)。
 * Edge Functions は packages/shared (workspace パッケージ) を import していないため、
 * 同じ結果を返す実装をここに置く。こちらは Intl やタイムゾーンデータに頼らず、
 * 固定オフセットで求める (日本は夏時間が無く、JST は常に UTC+9 なので結果は同じ)。
 * 2 つの実装が一致することは tests/jst-date.test.ts で確認している。
 */

/** JST の UTC からのオフセット (ミリ秒)。日本は夏時間が無いので常に +9 時間。 */
export const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/**
 * その時刻が属する JST の暦日を YYYY-MM-DD で返す。
 * 例: 2026-07-12T16:00:00Z (JST 7/13 01:00) → "2026-07-13"
 *
 * 不正な Date (Invalid Date) を渡すと RangeError になる (変な日付を黙って返さない)。
 */
export function formatJstDate(date: Date): string {
  // 9 時間進めた時刻の「UTC の暦日」が、元の時刻の「JST の暦日」になる
  return new Date(date.getTime() + JST_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * JST の「今日」を YYYY-MM-DD で返す。
 * now はテスト用に差し替えられる (省略時は現在時刻)。
 */
export function todayJst(now: Date = new Date()): string {
  return formatJstDate(now);
}
