/**
 * 運営の画面の <input type="datetime-local"> の値 (YYYY-MM-DDTHH:mm) を日本時間で読み書きする (#2254 M2)。
 *
 * 運営の画面の日時は、端末のタイムゾーンに任せず日本時間に固定する (src/lib/admin/format-datetime.ts・super-admin の運用ログ・
 * バックアップの画面と同じ方針)。datetime-local はタイムゾーンを持たない壁時計の値なので、既定値を作るときも送るときも
 * 日本時間として扱う。
 *
 * 以前の価格の変更の画面は、既定値を `new Date().toISOString().slice(0, 16)` (UTC の壁時計) で作り、送るときは
 * `new Date(value).toISOString()` (端末のローカル時刻として読む) にしていたので、日本の端末では既定のままの適用開始が
 * 押した時刻の 9 時間前になっていた。
 */
import { formatLocalDate } from '@/lib/date-utils';

/** 運営の画面の日時のタイムゾーン */
const ADMIN_TIME_ZONE = 'Asia/Tokyo';
/** 日本時間の UTC からのオフセット (ISO 8601 の表記)。日本は夏時間が無いので常に +09:00 */
const JST_ISO_OFFSET = '+09:00';
/** 秒の無い datetime-local の値に足す秒 */
const ZERO_SECONDS = '00';

/** 日本時間の時・分 (24 時間制・2 桁) */
const JST_HOUR_MINUTE = new Intl.DateTimeFormat('ja-JP', {
  timeZone: ADMIN_TIME_ZONE,
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** datetime-local の値 (YYYY-MM-DDTHH:mm と、秒つきの YYYY-MM-DDTHH:mm:ss) */
const DATETIME_LOCAL_PATTERN = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(?::(\d{2}))?$/;

/**
 * 時刻 now の日本時間の壁時計を、datetime-local の値 (YYYY-MM-DDTHH:mm) にする。
 * 例: 2026-11-05T06:00:00Z → "2026-11-05T15:00"
 */
export function jstDateTimeLocalValue(now: Date): string {
  // ja-JP の 2 桁・24 時間制は "15:00" の形 (時と分を ':' でつなぐ)
  return `${formatLocalDate(now, ADMIN_TIME_ZONE)}T${JST_HOUR_MINUTE.format(now)}`;
}

/**
 * 日本時間の datetime-local の値を、API に送る ISO 8601 (UTC) の時刻にする。形が違う (空欄を含む) ときは null。
 * 例: "2026-11-05T15:00" → "2026-11-05T06:00:00.000Z"
 */
export function jstDateTimeLocalToIso(value: string): string | null {
  const match = DATETIME_LOCAL_PATTERN.exec(value.trim());
  if (!match) return null;
  const date = new Date(`${match[1]}:${match[2] ?? ZERO_SECONDS}${JST_ISO_OFFSET}`);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
