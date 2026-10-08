/**
 * 日付ユーティリティ（純粋関数）
 *
 * Web / Mobile 共通で使用するタイムゾーン対応の日付ヘルパー。
 * DOM / React Native に依存しない純粋関数のみを置く。
 */

/** YYYY-MM-DD */
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Asia/Tokyo は夏時間が無く、UTC+9 で固定 */
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/**
 * 現地時刻（デフォルト Asia/Tokyo）の YYYY-MM-DD を返す。
 * UTC 偏移によるズレを防ぐためにロケール 'sv-SE' を使用する。
 *
 * 'sv-SE' が YYYY-MM-DD を返すことに頼っているので、ロケールやタイムゾーンの扱いが弱い実行環境
 * (モバイルアプリの JS エンジンなど。#1049 F7-21 でモバイルもこの関数を使うようになった) で
 * 別の書式が返っても、壊れた日付文字列を API やクエリに渡さないよう、形を確かめる。
 * 形が違う場合、既定の Asia/Tokyo は UTC+9 の固定オフセットで求める (夏時間が無いので正確)。
 */
export function formatLocalDate(date: Date = new Date(), timeZone = 'Asia/Tokyo'): string {
  let formatted: string | null = null;
  try {
    formatted = date.toLocaleDateString('sv-SE', { timeZone });
  } catch {
    // タイムゾーン名を解釈できない実行環境。下で扱う
  }
  if (formatted !== null && ISO_DATE_PATTERN.test(formatted)) return formatted;

  if (timeZone === 'Asia/Tokyo') {
    const shifted = new Date(date.getTime() + JST_OFFSET_MS);
    const year = String(shifted.getUTCFullYear()).padStart(4, '0');
    const month = String(shifted.getUTCMonth() + 1).padStart(2, '0');
    const day = String(shifted.getUTCDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }
  // それ以外のタイムゾーンは、従来どおりの結果 (例外もそのまま) にする
  return date.toLocaleDateString('sv-SE', { timeZone });
}

/**
 * 現地時刻の今日（YYYY-MM-DD）を返す。
 */
export function todayLocal(timeZone = 'Asia/Tokyo'): string {
  return formatLocalDate(new Date(), timeZone);
}

/**
 * YYYY-MM-DD 形式の文字列を Date に変換する（ローカルタイムとして解釈）。
 */
export function parseLocalDate(dateStr: string): Date {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d);
}

/**
 * 現地時刻（デフォルト Asia/Tokyo）の今日の 0 時を表す Date を返す。
 *
 * 週の開始日の計算や setDate による日付の加減算など、カレンダー上の計算の起点にする。
 * `new Date()` を起点にすると、端末のタイムゾーンの「今日」になり、Web・サーバー (Asia/Tokyo) とずれる (#1049 F7-21)。
 *
 * 返す Date は parseLocalDate と同じく端末のタイムゾーンの 0 時。年・月・日は getFullYear / getMonth / getDate で読む。
 * formatLocalDate(date) は「ある瞬間」を Asia/Tokyo の日付にする関数なので、この Date には使わない。
 */
export function startOfTodayLocal(timeZone = 'Asia/Tokyo'): Date {
  return parseLocalDate(todayLocal(timeZone));
}

/**
 * YYYY-MM-DD の日付文字列に days 日を足した YYYY-MM-DD を返す（負の値で過去方向）。
 *
 * カレンダー上の計算だけで行うので、端末のタイムゾーンや夏時間に影響されない。
 * 「今日から N 日前 / 後」は `addDaysToDateString(todayLocal(), n)` で求める。
 */
export function addDaysToDateString(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const shifted = new Date(Date.UTC(y, m - 1, d + days));
  const year = String(shifted.getUTCFullYear()).padStart(4, '0');
  const month = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const day = String(shifted.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * 2 つの YYYY-MM-DD の間の日数 (to - from) を返す。to が後なら正、前なら負、同じ日なら 0。
 * カレンダー上の計算だけで行うので、端末のタイムゾーンや夏時間に影響されない。
 * (`new Date('YYYY-MM-DD')` は UTC の 0 時として解釈されるため、Date 同士の差は端末のタイムゾーンでずれることがある。)
 */
export function daysBetweenDateStrings(from: string, to: string): number {
  const [fy, fm, fd] = from.split('-').map(Number);
  const [ty, tm, td] = to.split('-').map(Number);
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / (1000 * 60 * 60 * 24));
}

/**
 * 指定した日付に days 日加算した Date を返す。
 */
export function addDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

/**
 * 現地時刻（デフォルト Asia/Tokyo）の「今日」から dateStr (YYYY-MM-DD) までの残日数。
 * `new Date(dateStr)` の UTC 解釈によるタイムゾーンずれを避けるため parseLocalDate/todayLocal を使用する。
 * 過去日は負の値、当日は 0 を返す。
 */
export function daysUntilLocal(dateStr: string | null | undefined, timeZone = 'Asia/Tokyo'): number | null {
  if (!dateStr) return null;
  const target = parseLocalDate(dateStr);
  const now = parseLocalDate(todayLocal(timeZone));
  return Math.ceil((target.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
}

/**
 * 賞味期限などの残日数を統一文言に変換する（UI 一貫性 #1053）。
 * 「(0日)」「今日まで」「期限間近」等の混在を解消し、常にこの表記に揃える。
 */
export function formatExpiry(daysLeft: number | null): string {
  if (daysLeft === null) return '';
  if (daysLeft < 0) return '期限切れ';
  if (daysLeft === 0) return '今日まで';
  if (daysLeft === 1) return '明日まで';
  return `あと${daysLeft}日`;
}

/**
 * YYYY-MM-DD を日本語の日付表記に整形する（UI 一貫性 #1053）。
 * `includeYear: false`（デフォルト）では「7月8日」、true では「2026年7月8日」。
 */
export function formatDateJa(dateStr: string, opts: { includeYear?: boolean } = {}): string {
  const { includeYear = false } = opts;
  const d = parseLocalDate(dateStr);
  return includeYear
    ? `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`
    : `${d.getMonth() + 1}月${d.getDate()}日`;
}
