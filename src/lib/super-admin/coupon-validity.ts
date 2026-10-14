/**
 * クーポンの有効開始日・有効期限を、JST の暦日と DB の時刻 (timestamptz) のあいだで変換する (#1483)。
 *
 * 運営の画面は日付 (YYYY-MM-DD。JST の暦日) で入力し、API (POST / PATCH /api/super-admin/coupons) も日付で受け取る。
 * DB (coupons.valid_from / valid_until。timestamptz) には、その日の JST の境目の時刻にして書く:
 *   - valid_from  : 開始日の JST 0:00                       (例: "2026-10-10" → "2026-10-09T15:00:00.000Z")
 *   - valid_until : 期限の日の JST 23:59:59.999999 (その日の最後の瞬間) (例: "2026-10-20" → "2026-10-20T14:59:59.999999Z")
 * 以前は画面で `new Date(日付).toISOString()` (UTC の 0 時 = JST 9 時) にして送っていたので、
 * 開始日は JST の 9 時まで使えず、期限の日は JST の 9 時で切れていた。
 *
 * 使えるかどうかの判定は DB の関数 apply_coupon (supabase/migrations/20261007160700_apply_coupon_rpc.sql) が持つ:
 *   `now() < valid_from` なら OP_COUPON_NOT_YET_VALID、`now() > valid_until` なら OP_COUPON_EXPIRED (どちらの端も含めて有効)。
 * valid_until を「期限の日の翌日の JST 0 時」にすると、その瞬間ちょうどがまだ有効になるので、
 * timestamptz の精度 (1 マイクロ秒) での最後の瞬間 (jstDayEndInclusiveTimestamp) にする。
 *
 * 画面に出すときは、どちらの時刻も jstDayOfTimestamp で JST の暦日に戻す。
 * この変更より前に書いた行 (UTC の 0 時 = JST の同じ日の 9 時) も、JST の暦日にすれば入力した日付のまま読める。
 */

import { jstDayStartTimestamp } from '@/lib/date-utils';
import { jstDayEndInclusiveTimestamp, jstDayOfTimestamp } from '@/lib/jst-day-ranges';

/**
 * 有効開始日 (JST の暦日) を、valid_from に書く時刻 (その日の JST 0:00) にする。
 * 形の違う日付・存在しない日付は RangeError (入口を CalendarDateSchema にしておけば来ない)。
 */
export function couponValidFromTimestamp(validFromDay: string): string {
  return jstDayStartTimestamp(validFromDay);
}

/**
 * 有効期限の日 (JST の暦日) を、valid_until に書く時刻 (その日の JST 23:59:59.999999) にする。
 * 形の違う日付・存在しない日付は RangeError (入口を CalendarDateSchema にしておけば来ない)。
 */
export function couponValidUntilTimestamp(validUntilDay: string): string {
  return jstDayEndInclusiveTimestamp(validUntilDay);
}

/**
 * valid_from / valid_until (DB から読んだ時刻) を、画面に出す・編集欄に入れる JST の暦日 (YYYY-MM-DD) にする。
 * 例: "2026-10-20T14:59:59.999999+00:00" → "2026-10-20" / 以前の行の "2026-10-20T00:00:00+00:00" → "2026-10-20"
 */
export function couponValidityDay(timestamp: string): string {
  return jstDayOfTimestamp(timestamp);
}

/**
 * その時刻に、クーポンの有効期限が過ぎているか。apply_coupon の `now() > valid_until` と同じ比べ方 (期限の時刻ちょうどは有効)。
 * 運営の一覧で期限切れの色を付けるのに使う。
 */
export function isCouponExpiredAt(validUntil: string, at: Date): boolean {
  return at.getTime() > Date.parse(validUntil);
}

/**
 * 詳細の画面で保存するときに PATCH で送る valid_until (JST の暦日)。編集欄の日付が、いま DB にある期限の JST の暦日と同じなら
 * undefined (送らない = 期限を変えない)。
 * 表示名などだけを直したときに、この変更より前に書いた行 (UTC の 0 時 = JST 9 時で切れる時刻) の期限を黙って書き換えないため。
 * 例: ("2026-10-20", "2026-10-20T00:00:00+00:00") → undefined / ("2026-10-21", 同じ) → "2026-10-21"
 */
export function couponValidUntilPatchValue(editedDay: string, storedValidUntil: string): string | undefined {
  return editedDay === couponValidityDay(storedValidUntil) ? undefined : editedDay;
}
