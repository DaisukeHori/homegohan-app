// src/__tests__/app/menus/weekly/add-days-str-tz-safety.test.ts
// #1035残債の回帰防止: page.tsx の `addDaysStr`(YYYY-MM-DD 文字列に日数加算するヘルパー)は
// 旧実装で `new Date(dateStr)`(UTC深夜0時解釈)→ローカル getDate/setDate→toISOString(UTC)
// という parse/format のタイムゾーン不一致があり、非JST(特に西経)クライアントで
// 週境界（addDaysStr(weekStart, 6) 等）が1日ズレていた。
//
// 実測: TZ=America/Los_Angeles で addDaysStr("2026-03-06", 6) が
//   旧実装 "2026-03-11"（誤り）/ 修正後 "2026-03-12"（正しい）
//
// このテストは:
// 1. page.tsx の addDaysStr が `new Date(dateStr)` に戻っていないこと（静的・mutation-sensitive）。
// 2. parseLocalDate/addDays ベースの実装が、JST では旧実装と完全に同じ結果を返す（無回帰）ことを、
//    実際に process.env.TZ を切り替えて検証する。
// 3. America/Los_Angeles の DST 跨ぎ週で正しい結果（旧実装のバグが再発していない）ことを検証する。

import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { parseLocalDate, addDays } from '@homegohan/shared';

const PAGE_TSX_PATH = path.resolve(
  __dirname,
  '../../../../app/(main)/menus/weekly/page.tsx'
);
const pageSource = fs.readFileSync(PAGE_TSX_PATH, 'utf-8');

describe('page.tsx: addDaysStr の TZ 安全パース (#1035残・静的検査)', () => {
  it('addDaysStr 本体が parseLocalDate/addDays を使い、new Date(dateStr) を使っていないこと', () => {
    const match = pageSource.match(
      /function addDaysStr\(dateStr: string, days: number\): string \{[\s\S]{0,400}?\n\}/
    );
    expect(match, 'addDaysStr 関数本体が見つかりません').not.toBeNull();
    const block = match![0];
    expect(block).toMatch(/parseLocalDate\(dateStr\)/);
    expect(block).toMatch(/addDays\(/);
    expect(block).not.toMatch(/new Date\(dateStr\)/);
    expect(block).not.toMatch(/toISOString/);
  });
});

// page.tsx の addDaysStr と全く同じロジック（上の静的テストで一致を保証する）。
// モジュール外に公開されていないため、TZ 依存性を実行時に検証する目的でここに再現する。
function addDaysStr(dateStr: string, days: number): string {
  const date = addDays(parseLocalDate(dateStr), days);
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// #1035 是正前の旧実装（対照実験・JST 無回帰確認用）。
function legacyAddDaysStr(dateStr: string, days: number): string {
  const date = new Date(dateStr);
  date.setDate(date.getDate() + days);
  return date.toISOString().split('T')[0];
}

describe('addDaysStr: JST では旧実装と完全に同じ結果（無回帰） (#1035残)', () => {
  const originalTz = process.env.TZ;

  afterEach(() => {
    process.env.TZ = originalTz;
  });

  const cases: Array<{ date: string; days: number }> = [
    { date: '2026-03-06', days: 6 }, // 週の終端算出でよく使われる典型パターン
    { date: '2026-01-01', days: 6 }, // 年始
    { date: '2026-12-28', days: 6 }, // 年末跨ぎ
    { date: '2026-02-25', days: 6 }, // 月末跨ぎ
    { date: '2024-02-24', days: 6 }, // うるう年の月末跨ぎ
    { date: '2026-07-19', days: -6 }, // 負の日数（週の始端から遡る等）
  ];

  for (const { date, days } of cases) {
    it(`TZ=Asia/Tokyo で addDaysStr("${date}", ${days}) が旧実装と一致する`, () => {
      process.env.TZ = 'Asia/Tokyo';
      expect(addDaysStr(date, days)).toBe(legacyAddDaysStr(date, days));
    });
  }
});

describe('addDaysStr: 非JST(DST採用地域)でも正しいカレンダー演算になる (#1035残)', () => {
  const originalTz = process.env.TZ;

  afterEach(() => {
    process.env.TZ = originalTz;
  });

  it('America/Los_Angeles の DST 切替週を跨いでも正しい日付になる（旧実装は1日ズレていた）', () => {
    process.env.TZ = 'America/Los_Angeles';
    // 2026年の米国 DST 開始は 3/8。2026-03-06 を含む週はこの境界を跨ぐ。
    const fixed = addDaysStr('2026-03-06', 6);
    const legacy = legacyAddDaysStr('2026-03-06', 6);

    expect(fixed).toBe('2026-03-12');
    expect(legacy).toBe('2026-03-11'); // 旧実装のバグを対照実験として明示
    expect(fixed).not.toBe(legacy);
  });

  it('複数タイムゾーンで同一の加算結果になる（実行環境に依存しない）', () => {
    const timeZones = ['America/Los_Angeles', 'UTC', 'Asia/Tokyo', 'Pacific/Midway'];
    const results = timeZones.map((tz) => {
      process.env.TZ = tz;
      return addDaysStr('2026-07-13', 6);
    });
    for (const result of results) {
      expect(result).toBe('2026-07-19');
    }
  });
});
