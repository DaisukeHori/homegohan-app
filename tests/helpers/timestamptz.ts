// #1433: テストの中で、timestamptz (PostgreSQL) の比較をマイクロ秒の精度で再現するためのヘルパー。
//
// timestamptz の時刻の精度は 1 マイクロ秒 (小数点以下 6 桁) だが、Date はミリ秒までしか持たない。
// DB の関数 (get_nps_summary など) の `列 <= p_to` に「翌日の JST 0 時の 1 マイクロ秒前」(jstDayEndInclusiveTimestamp) を
// 渡したときに選ばれる行を、Date の比較 (ミリ秒) で確かめると、.999 ミリ秒の中の行の扱いが DB と食い違う。
// ここでは時刻をマイクロ秒の整数 (bigint) にして比べる。

/** 秒の小数点以下の桁数: ミリ秒まで 3 桁・マイクロ秒まで 6 桁 */
const MILLISECOND_DIGITS = 3;
const MICROSECOND_DIGITS = 6;
/** 1 ミリ秒 = 1000 マイクロ秒 */
const MICROS_PER_MS = 1000n;

/** ISO 8601 の時刻 (Z か ±HH:MM のオフセット付き。小数点以下は 0〜6 桁) を、1970-01-01T00:00:00Z からのマイクロ秒にする */
export function microsOf(iso: string): bigint {
  const match = /^(.*T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:\d{2})$/.exec(iso);
  if (!match) throw new Error(`ISO 8601 の時刻 (オフセット付き) ではない: ${iso}`);
  const fraction = (match[2] ?? '').padEnd(MICROSECOND_DIGITS, '0');
  const ms = Date.parse(`${match[1]}.${fraction.slice(0, MILLISECOND_DIGITS)}${match[3]}`);
  if (Number.isNaN(ms)) throw new Error(`時刻として読めない: ${iso}`);
  return BigInt(ms) * MICROS_PER_MS + BigInt(fraction.slice(MILLISECOND_DIGITS));
}

/** PostgREST の範囲の絞り込み (.gte / .gt / .lte / .lt) 1 つ */
export interface RangeFilter {
  method: 'gte' | 'gt' | 'lte' | 'lt';
  value: string;
}

/** 時刻 at が、範囲の絞り込みをすべて満たすか (DB の timestamptz の比較と同じく、マイクロ秒の精度で比べる) */
export function satisfiesRangeFilters(at: string, filters: readonly RangeFilter[]): boolean {
  const t = microsOf(at);
  return filters.every(({ method, value }) => {
    const v = microsOf(value);
    switch (method) {
      case 'gte':
        return t >= v;
      case 'gt':
        return t > v;
      case 'lte':
        return t <= v;
      case 'lt':
        return t < v;
    }
  });
}

/**
 * JST の暦日 2026-10-10 の前後の境界の時刻 (UTC の ISO 表記)。id は JST の暦日と時刻。
 * from = to = 2026-10-10 で絞ったときに入るのは inJst1010 が true の行
 */
export const JST_1010_BOUNDARY_TIMES = [
  { id: 'jst-10-09-23:59:59.999999', at: '2026-10-09T14:59:59.999999Z', inJst1010: false },
  { id: 'jst-10-10-00:00', at: '2026-10-09T15:00:00Z', inJst1010: true }, // 日付の文字列のまま絞ると落ちていた
  { id: 'jst-10-10-08:59:59', at: '2026-10-09T23:59:59Z', inJst1010: true }, // 同上
  { id: 'jst-10-10-09:00', at: '2026-10-10T00:00:00Z', inJst1010: true },
  { id: 'jst-10-10-23:59:59.999', at: '2026-10-10T14:59:59.999Z', inJst1010: true }, // 日付の文字列のまま絞ると落ちていた
  { id: 'jst-10-10-23:59:59.999999', at: '2026-10-10T14:59:59.999999Z', inJst1010: true }, // その日の最後の値
  { id: 'jst-10-11-00:00', at: '2026-10-10T15:00:00Z', inJst1010: false },
  { id: 'jst-10-11-08:59:59', at: '2026-10-10T23:59:59Z', inJst1010: false },
] as const;
