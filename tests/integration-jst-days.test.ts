// @vitest-environment node
/**
 * tests/integration-jst-days.test.ts
 *
 * #1545: 結合テストが DB に入れる「今日」「n 日前」(tests/integration/helpers/jst-days.ts の jstDaysAgo) が、
 * サーバー (API ルート) の JST の今日と同じ暦日になることの回帰テスト。
 *
 * 回帰: tests/integration/security/badges-api.test.ts の K-8 が、JST の 0〜9 時に流すと
 * `expected [] to deeply equal ['first_bite']` で落ちた (#1474 の検証で 4 周続けて同じ赤)。
 * テストの日付の関数 dayStr が `new Date()` → `toISOString()` で UTC の暦日を作っており、
 * JST の 0〜9 時は UTC の日付が 1 日前なので、テストが「今日」として入れた記録がサーバーにとっては「昨日」になっていた。
 *
 * 結合テストはサーバー (next dev) の時計を固定できないので、ここで時計 (Date) を JST の 0:30 (UTC の前日の 15:30) と
 * 9:30 に固定し、テストの「今日」とサーバーの「今日」(jstToday) と連続日数 (consecutiveDayStreak。GET /api/badges が使う) が
 * 一致することを確かめる。実行環境のタイムゾーン (process.env.TZ) を変えても同じ結果になることも確かめる
 * (結合テストは TZ=UTC で流れるが、開発機は Asia/Tokyo のこともある)。
 * 期待値の暦日は実装とは別に、JST の暦 (UTC + 9 時間) を手で引いた固定値。
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { consecutiveDayStreak, jstToday } from '../src/lib/jst-day-ranges';
import { jstDaysAgo } from './integration/helpers/jst-days';
import { inEachTimeZone, withTimeZone } from './helpers/time-zones';

afterEach(() => {
  vi.useRealTimers();
});

/**
 * 固定する時計と、その時刻の JST の暦日 (today: 今日 / d1: 1 日前 / d2: 2 日前) と UTC の暦日。
 *   - JST 0:30 : UTC では前日の 15:30。以前の dayStr (UTC の暦日) が「今日」を 1 日前にしていた時間帯
 *   - JST 9:30 : UTC でも同じ日の 0:30。以前の dayStr でもたまたま一致していた時間帯 (対照)
 */
const CLOCKS = [
  { label: 'JST 0:30 (UTC の前日の 15:30)', at: '2026-10-13T15:30:00.000Z', today: '2026-10-14', d1: '2026-10-13', d2: '2026-10-12', utcDay: '2026-10-13' },
  { label: 'JST 9:30 (UTC の同じ日の 0:30)', at: '2026-10-14T00:30:00.000Z', today: '2026-10-14', d1: '2026-10-13', d2: '2026-10-12', utcDay: '2026-10-14' },
] as const;

/** Date だけ固定する (setTimeout などは本物のまま) */
function fixClock(at: string): void {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(at));
}

/** 以前の badges-api.test.ts の dayStr (UTC の暦日)。この時間帯にずれていたことを示す対照にだけ使う */
function legacyUtcDayStr(daysAgo: number): string {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return d.toISOString().split('T')[0];
}

describe('jstDaysAgo: 時計を JST の 0:30 / 9:30 に固定しても、テストの「今日」がサーバーの JST の今日と一致する (#1545)', () => {
  for (const clock of CLOCKS) {
    it(`${clock.label}: 今日・1 日前・2 日前が JST の暦日になり、0 日前はサーバーの jstToday と同じ (どのタイムゾーンでも)`, () => {
      fixClock(clock.at);
      const results = inEachTimeZone(() => ({
        today: jstDaysAgo(0),
        d1: jstDaysAgo(1),
        d2: jstDaysAgo(2),
        serverToday: jstToday(),
      }));
      for (const { tz, value } of results) {
        expect({ tz, ...value }).toEqual({ tz, today: clock.today, d1: clock.d1, d2: clock.d2, serverToday: clock.today });
      }
    });

    it(`${clock.label}: 時計の代わりに now を渡しても同じ暦日になる`, () => {
      const now = new Date(clock.at);
      expect([jstDaysAgo(0, now), jstDaysAgo(1, now), jstDaysAgo(2, now)]).toEqual([clock.today, clock.d1, clock.d2]);
      expect(jstDaysAgo(0, now)).toBe(jstToday(now));
    });

    it(`${clock.label}: テストが入れた日付から、サーバーの連続日数 (consecutiveDayStreak) が期待どおりに数える`, () => {
      fixClock(clock.at);
      withTimeZone('UTC', () => {
        // seedMeals と同じ形: 今日から 3 日連続 → 3 日 (今日を今日として数える)
        expect(consecutiveDayStreak([jstDaysAgo(0), jstDaysAgo(1), jstDaysAgo(2)])).toBe(3);
        // K-8 と同じ形: 通常の記録は今日と 2 日前 (昨日はお試しの日なので数えない) → 今日の 1 日で止まる
        expect(consecutiveDayStreak([jstDaysAgo(0), jstDaysAgo(2)])).toBe(1);
        // 今日の記録が無く、昨日だけ → 昨日から数えて 1 日 (今日の記録が「昨日」にずれると、この形と区別できない)
        expect(consecutiveDayStreak([jstDaysAgo(1)])).toBe(1);
      });
    });
  }

  it('対照: 以前の dayStr (UTC の暦日) は、JST の 0:30 にサーバーの今日より 1 日前を「今日」にしていた (9:30 は一致)', () => {
    for (const clock of CLOCKS) {
      fixClock(clock.at);
      const legacyToday = withTimeZone('UTC', () => legacyUtcDayStr(0));
      expect({ label: clock.label, legacyToday }).toEqual({ label: clock.label, legacyToday: clock.utcDay });
    }
    // JST の 0:30 では、UTC の暦日はサーバーの今日と食い違う (この時間帯に K-8 が落ちていた理由)
    expect(CLOCKS[0].utcDay).not.toBe(CLOCKS[0].today);
    expect(CLOCKS[1].utcDay).toBe(CLOCKS[1].today);
  });
});

describe('結合テストの日付の関数が jstDaysAgo を使っている (#1545)', () => {
  /** 行コメントとブロックコメントを外したソース (コメントに残した以前の書き方の説明を拾わない) */
  function codeOf(relativePath: string): string {
    const source = fs.readFileSync(path.resolve(__dirname, relativePath), 'utf8');
    return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  }

  it('badges-api.test.ts の dayStr は jstDaysAgo を返し、UTC の暦日 (toISOString の日付部分) で日付を作らない', () => {
    const code = codeOf('integration/security/badges-api.test.ts');
    expect(code).toContain("import { jstDaysAgo } from '../helpers/jst-days';");
    expect(code).toMatch(/function dayStr\(daysAgo: number\): string \{\s*return jstDaysAgo\(daysAgo\);\s*\}/);
    expect(code).not.toMatch(/toISOString\(\)\s*\.\s*(split\(\s*['"]T['"]\s*\)\s*\[0\]|slice\(\s*0\s*,\s*10\s*\))/);
  });
});
