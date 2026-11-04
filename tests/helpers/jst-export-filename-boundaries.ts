// #2245 K3: 書き出しのファイル名の日付 (JST の今日) を確かめるための、今の時刻と JST の今日の組。
//
// 以前は `new Date().toISOString().slice(0, 10)` (UTC の暦日) で、JST の 0:00〜8:59 は前日の日付になっていた。
// JST 0:00 ちょうど・8:59:59.999 (UTC ではまだ前日) の 2 つが、以前の書き方で赤になる境界。
// 前日の JST 23:59:59.999 と JST 9:00 (UTC と JST の暦日が同じ) は、日付を 1 日進めすぎていないことを見る。

export interface JstExportFilenameBoundary {
  /** 今の時刻 (vi.setSystemTime に渡す) */
  readonly now: string;
  /** そのときの JST の今日 (ファイル名に入る日付) */
  readonly jstToday: string;
  /** UTC の暦日 (以前の書き方で入っていた日付) */
  readonly utcDay: string;
}

export const JST_EXPORT_FILENAME_BOUNDARIES: readonly JstExportFilenameBoundary[] = [
  { now: '2026-10-07T14:59:59.999Z', jstToday: '2026-10-07', utcDay: '2026-10-07' }, // JST 10/7 23:59:59.999
  { now: '2026-10-07T15:00:00.000Z', jstToday: '2026-10-08', utcDay: '2026-10-07' }, // JST 10/8 0:00 (UTC はまだ 10/7)
  { now: '2026-10-07T23:59:59.999Z', jstToday: '2026-10-08', utcDay: '2026-10-07' }, // JST 10/8 8:59:59.999 (UTC はまだ 10/7)
  { now: '2026-10-08T00:00:00.000Z', jstToday: '2026-10-08', utcDay: '2026-10-08' }, // JST 10/8 9:00
];
