// src/__tests__/app/menus/weekly/date-query-tz-safety.test.ts
// Issue #1054 回帰防止: ?date=YYYY-MM-DD クエリ（meals/new・meals/[id] からの UX2-16/UX2-31
// 遷移で付与される）の解析が `new Date(date)` のままだと UTC 深夜0時解釈になり、
// 非JSTクライアント（西経のタイムゾーン等）で target.getDay() / getWeekStart() が
// 1日ズレる（#1035 で一度直された TZ バグの先祖返り）。
//
// page.tsx はこの `?date=` を受けて parseLocalDate(date) で解析するよう修正済み。
// このテストは:
// 1. page.tsx のソースが該当ブロックで parseLocalDate(date) を使い、new Date(date) に
//    戻っていないことを検査する（静的・mutation-sensitive）。
// 2. parseLocalDate ベースの曜日/週初日計算が、クライアントの実行タイムゾーンに関わらず
//    一貫した結果を返すこと（= TZ 非安全な `new Date(dateStr)` 由来のズレが再発しないこと）を、
//    実際に process.env.TZ を切り替えて検証する。

import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { parseLocalDate } from '@homegohan/shared';

const PAGE_TSX_PATH = path.resolve(
  __dirname,
  '../../../../app/(main)/menus/weekly/page.tsx'
);
const pageSource = fs.readFileSync(PAGE_TSX_PATH, 'utf-8');

describe('page.tsx: ?date= クエリの TZ 安全パース (#1054 / #1035 先祖返り防止・静的検査)', () => {
  it('UX2-16 の対象日初期選択ブロックが parseLocalDate(date) を使い、new Date(date) を使っていないこと', () => {
    const match = pageSource.match(
      /UX2-16: \?date= があれば対象日を含む週・曜日を初期選択する[\s\S]{0,500}/
    );
    expect(match, '?date= 初期選択ブロックのコメントが見つかりません').not.toBeNull();
    const block = match![0];
    expect(block).toMatch(/const target = parseLocalDate\(date\)/);
    expect(block).not.toMatch(/new Date\(date\)/);
  });
});

// page.tsx の該当 useEffect と全く同じロジック（parseLocalDate → getDay → weekStartDay オフセット）。
// page.tsx 側の関数はモジュール外に公開されていないため、TZ 依存性を実行時に検証する目的で
// ロジックのみをここで再現する（このロジック自体は上の静的テストで page.tsx との一致を保証する）。
function computeDayIndexFromDateQuery(dateStr: string, weekStartDay: 'sunday' | 'monday'): number {
  const target = parseLocalDate(dateStr);
  const dayOfWeekRaw = target.getDay();
  const startOffset = weekStartDay === 'sunday' ? 0 : 1;
  let dayIndex = dayOfWeekRaw - startOffset;
  if (dayIndex < 0) dayIndex += 7;
  return dayIndex;
}

describe('parseLocalDate ベースの ?date= 曜日計算: 実行タイムゾーンに依存しない (#1054)', () => {
  const originalTz = process.env.TZ;

  afterEach(() => {
    process.env.TZ = originalTz;
  });

  // UTC からの偏移が正・負・0 の3タイムゾーンで一貫性を検証する
  const timeZones = ['Pacific/Kiritimati', 'UTC', 'Pacific/Midway']; // UTC+14 / UTC+0 / UTC-11

  const cases: Array<{ date: string; weekStartDay: 'sunday' | 'monday'; expectedDayIndex: number }> = [
    { date: '2026-07-13', weekStartDay: 'monday', expectedDayIndex: 0 }, // 月曜
    { date: '2026-07-19', weekStartDay: 'monday', expectedDayIndex: 6 }, // 日曜（月曜起点で週末）
    { date: '2026-07-19', weekStartDay: 'sunday', expectedDayIndex: 0 }, // 日曜（日曜起点で週頭）
    { date: '2026-01-01', weekStartDay: 'monday', expectedDayIndex: 3 }, // 木曜（年初境界）
  ];

  for (const { date, weekStartDay, expectedDayIndex } of cases) {
    it(`${date} (weekStartDay=${weekStartDay}) の dayIndex がどのタイムゾーンでも ${expectedDayIndex} で一致する`, () => {
      const results = timeZones.map((tz) => {
        process.env.TZ = tz;
        return computeDayIndexFromDateQuery(date, weekStartDay);
      });
      // 全タイムゾーンで同一の dayIndex になること（TZ 非安全パースだと UTC+14 と UTC-11 で
      // 1日ズレて隣接曜日にマッピングされてしまう）
      for (const result of results) {
        expect(result).toBe(expectedDayIndex);
      }
    });
  }

  it('（対照実験）TZ 非安全な new Date(dateStr) をそのまま使うと UTC+14 と UTC-11 で dayIndex がズレる', () => {
    // parseLocalDate ではなく旧実装 (`new Date(date)`) を使った場合に何が起きるかを示す対照実験。
    // これにより「なぜ parseLocalDate が必要か」を回帰的に裏付ける。
    const legacyCompute = (dateStr: string, weekStartDay: 'sunday' | 'monday'): number => {
      const target = new Date(dateStr); // UTC 深夜0時解釈（バグの原因）
      const dayOfWeekRaw = target.getDay();
      const startOffset = weekStartDay === 'sunday' ? 0 : 1;
      let dayIndex = dayOfWeekRaw - startOffset;
      if (dayIndex < 0) dayIndex += 7;
      return dayIndex;
    };

    process.env.TZ = 'Pacific/Kiritimati'; // UTC+14
    const plus14 = legacyCompute('2026-07-13', 'monday');
    process.env.TZ = 'Pacific/Midway'; // UTC-11
    const minus11 = legacyCompute('2026-07-13', 'monday');

    // 25時間の差があるタイムゾーン間では、UTC 深夜0時解釈が別カレンダー日に着地し dayIndex がズレる
    expect(plus14).not.toBe(minus11);
  });
});
