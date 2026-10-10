// #1433: 実行環境のタイムゾーン (process.env.TZ) を切り替えて、同じ結果になることを確かめるためのヘルパー。
//
// Node は process.env.TZ を書き換えると、以後の Date のローカル時刻の計算 (getDate / setDate / getMonth など) に反映する。
// JST の暦日を求める関数は、どのタイムゾーンで動いても同じ結果になる必要がある
// (Vercel / Edge は UTC、開発機は Asia/Tokyo、利用者の端末は任意)。

/**
 * 切り替えるタイムゾーン。
 *   - UTC                 : Vercel / Supabase Edge の実行環境
 *   - Asia/Tokyo          : 開発機・利用者の端末
 *   - America/Los_Angeles : UTC より西で、夏時間がある (setDate がローカル時刻であることの差が出る)
 *   - Pacific/Kiritimati  : UTC+14 (JST より東。暦日が JST より先に進む)
 *   - Pacific/Pago_Pago   : UTC-11 (暦日が JST より 20 時間遅れる)
 */
export const TEST_TIME_ZONES = [
  'UTC',
  'Asia/Tokyo',
  'America/Los_Angeles',
  'Pacific/Kiritimati',
  'Pacific/Pago_Pago',
] as const;

export type TestTimeZone = (typeof TEST_TIME_ZONES)[number];

/** process.env.TZ を tz にして fn を呼び、終わったら元に戻す */
export function withTimeZone<T>(tz: string, fn: () => T): T {
  const saved = process.env.TZ;
  process.env.TZ = tz;
  try {
    return fn();
  } finally {
    if (saved === undefined) {
      delete process.env.TZ;
    } else {
      process.env.TZ = saved;
    }
  }
}

/** TEST_TIME_ZONES のそれぞれで fn を呼び、タイムゾーンごとの結果を返す */
export function inEachTimeZone<T>(fn: (tz: TestTimeZone) => T): Array<{ tz: TestTimeZone; value: T }> {
  return TEST_TIME_ZONES.map((tz) => ({ tz, value: withTimeZone(tz, () => fn(tz)) }));
}

/**
 * タイムゾーンの切り替えが実際に効いていることを確かめる (効いていなければ、上のテストは何も確かめていないことになる)。
 * 2026-01-01 のローカル 0 時の UTC からのずれ (分) を返す。UTC は 0、Asia/Tokyo は -540。
 */
export function localOffsetMinutesOn20260101(): number {
  return new Date(2026, 0, 1).getTimezoneOffset();
}
