// @vitest-environment node
/**
 * tests/integration-jst-days.test.ts
 *
 * #1545: 結合テストが DB に入れる「今日」「n 日前」(tests/integration/helpers/jst-days.ts の jstDaysAgo) が、
 * サーバー (API ルート) の JST の今日と同じ暦日になることの回帰テスト。
 *
 * 以前の badges-api.test.ts の dayStr は `new Date()` → `toISOString()` で UTC の暦日を作っていたので、
 * JST の 0〜9 時はテストが「今日」として入れた記録がサーバーにとっては「昨日」になっていた。これをサーバーの暦日に揃える。
 *
 * K-8 の赤 (#1545 で報告された `expected [] to deeply equal ['first_bite']`) は、この日付のずれでは説明できない。
 * GET /api/badges は食事の数を日付で絞らず (src/app/api/badges/route.ts)、連続日数は今日の記録が無ければ昨日から数えるので、
 * badges-api.test.ts が入れる日付がまるごと 1 日前にずれても、返る数とバッジは変わらない。下の
 * 「日付が 1 日ずれても連続日数は変わらない」で確かめている。K-8 の赤の原因はまだ分かっていない。
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
    // JST の 0:30 では、UTC の暦日はサーバーの今日と食い違う (9:30 では一致する)
    expect(CLOCKS[0].utcDay).not.toBe(CLOCKS[0].today);
    expect(CLOCKS[1].utcDay).toBe(CLOCKS[1].today);
  });
});

/**
 * badges-api.test.ts の beforeAll が通常の記録 (is_sandbox = false) を入れる日 (今日から何日前か) と、
 * その形でサーバーが数える連続日数。お試しの日 (is_sandbox = true) は連続日数に入らないので入れていない。
 * 期待値は consecutiveDayStreak の規則 (今日から過去へ途切れずに続く日数。今日が無ければ昨日から) を手で当てた値。
 */
const BADGES_API_NORMAL_DAYS: ReadonlyArray<{ user: string; daysAgo: readonly number[]; streak: number }> = [
  { user: 'A / D (seedMeals 3 日)', daysAgo: [0, 1, 2], streak: 3 },
  { user: 'B (seedMeals 1 日)', daysAgo: [0], streak: 1 },
  { user: 'E (お試しの日だけ)', daysAgo: [], streak: 0 },
  { user: 'F (K-8: 今日と 2 日前。昨日はお試しの日)', daysAgo: [0, 2], streak: 1 },
];

/** 以前の dayStr が JST の 0〜9 時に入れていた日付のずれ (UTC の暦日は JST の暦日の 1 日前) */
const LEGACY_UTC_SHIFT_DAYS = 1;

describe('日付が 1 日ずれても連続日数は変わらない — 日付のずれは K-8 の赤の原因ではない (#1545)', () => {
  for (const clock of CLOCKS) {
    it(`${clock.label}: badges-api.test.ts の各ユーザーの記録の日付をまるごと 1 日前にずらしても、連続日数は同じ`, () => {
      fixClock(clock.at);
      withTimeZone('UTC', () => {
        for (const seed of BADGES_API_NORMAL_DAYS) {
          const aligned = consecutiveDayStreak(seed.daysAgo.map((n) => jstDaysAgo(n)));
          const shifted = consecutiveDayStreak(seed.daysAgo.map((n) => jstDaysAgo(n + LEGACY_UTC_SHIFT_DAYS)));
          expect({ user: seed.user, aligned, shifted }).toEqual({ user: seed.user, aligned: seed.streak, shifted: seed.streak });
        }
      });
    });
  }
});

/**
 * tests/integration の中で、UTC の暦日 (toISOString の日付部分) で日付を作っているファイルと、直さない理由。
 * #1545 で git grep で全部挙げて、サーバーの JST の今日と比べていないことを確かめたもの。
 * ここに無いファイルがこの書き方を使い始めたら下のテストが落ちるので、サーバーの今日と比べるかを見て、
 * 比べるなら jstDaysAgo を使い、比べないならここに理由を足す。
 */
const REVIEWED_UTC_DATE_FILES: Record<string, string> = {
  'handson-tour/add-from-photo-sandbox.test.ts': 'dayDate として送り、保存された day_date が同じ値かだけを見る (ルートは今日と比べない)',
  'handson-tour/complete.test.ts': 'meals.eaten_at に入れるだけ。判定は行があるかどうか (日付は比べない)',
  'handson-tour/menu-plans-add.test.ts': 'meals.eaten_at に入れるだけ。判定は行があるかどうか (日付は比べない)',
  'handson-tour/rpc-user-has-non-sandbox-activity.test.ts': 'user_daily_meals.day_date に入れるだけ。RPC は行があるかどうかを見る (日付は比べない)',
  'handson-tour/status.test.ts': 'meals.eaten_at に入れるだけ。判定は行があるかどうか (日付は比べない)',
  'operator/super-admin-coupons-id.test.ts': 'クーポンの valid_from / valid_until に入れるだけ。取得・更新・削除のテストで、有効期間を今日と比べない',
  'security/account-deletion.test.ts': '退会で消える行の日付列に入れるだけ。消えたかどうかを見る (日付は比べない)',
  'security/health-insights-meals.test.ts': '起点はサーバーと同じ JST の今日 (todayLocal)。toISOString は暦日の足し引きの結果を文字列に戻すだけ',
  'security/log-cleanup-and-dau-snapshot.test.ts': '固定の日付 (BASE) からの暦日の足し引き。今日は使わない',
  'security/support-routes.test.ts': '固定の日付 (2026-01-01) からの暦日の足し引き。今日は使わない',
};

/** 行コメントとブロックコメントを外す (コメントに残した以前の書き方の説明を拾わない) */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/** tests からの相対パスのファイルを、コメントを外して読む */
function codeOf(relativePath: string): string {
  return stripComments(fs.readFileSync(path.resolve(__dirname, relativePath), 'utf8'));
}

/** UTC の暦日を作る書き方 (toISOString() の日付部分を split('T')[0] / slice(0, 10) / substring(0, 10) で取る) */
const UTC_DATE_PART = /toISOString\(\)\s*\.\s*(split\(\s*['"]T['"]\s*\)\s*\[0\]|slice\(\s*0\s*,\s*10\s*\)|substring\(\s*0\s*,\s*10\s*\))/;

/** tests/integration の .ts を、tests/integration からの相対パスで全部返す */
function integrationSources(): string[] {
  const root = path.resolve(__dirname, 'integration');
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ts')) found.push(path.relative(root, full).split(path.sep).join('/'));
    }
  };
  walk(root);
  return found.sort();
}

describe('tests/integration で UTC の暦日を使うファイルは、サーバーの今日と比べないことを確かめたものだけ (#1545)', () => {
  it('UTC の暦日の書き方を使うファイルの一覧が、確かめた一覧と一致する', () => {
    const using = integrationSources().filter((file) => UTC_DATE_PART.test(codeOf(`integration/${file}`)));
    expect(using).toEqual(Object.keys(REVIEWED_UTC_DATE_FILES).sort());
  });

  it('検出の正規表現は 3 つの書き方 (split / slice / substring) と、改行をはさんだ書き方を拾い、コメントの中は拾わない', () => {
    expect(UTC_DATE_PART.test("new Date().toISOString().split('T')[0]")).toBe(true);
    expect(UTC_DATE_PART.test('d.toISOString().slice(0, 10)')).toBe(true);
    expect(UTC_DATE_PART.test('d.toISOString().substring(0,10)')).toBe(true);
    expect(UTC_DATE_PART.test("d.toISOString()\n    .split('T')[0]")).toBe(true);
    expect(UTC_DATE_PART.test('d.toISOString()')).toBe(false);
    const commented = "// d.toISOString().split('T')[0]\n/* d.toISOString().slice(0, 10) */\nconst x = 1;";
    expect(UTC_DATE_PART.test(commented)).toBe(true);
    expect(UTC_DATE_PART.test(stripComments(commented))).toBe(false);
  });
});

describe('結合テストの日付の関数が jstDaysAgo を使っている (#1545)', () => {
  it('badges-api.test.ts の dayStr は jstDaysAgo を返し、UTC の暦日 (toISOString の日付部分) で日付を作らない', () => {
    const code = codeOf('integration/security/badges-api.test.ts');
    expect(code).toContain("import { jstDaysAgo } from '../helpers/jst-days';");
    expect(code).toMatch(/function dayStr\(daysAgo: number\): string \{\s*return jstDaysAgo\(daysAgo\);\s*\}/);
    expect(code).not.toMatch(UTC_DATE_PART);
  });

  it('org-challenges-api.test.ts (#1132) は、参加の API がサーバーの JST の今日と比べる終了日を jstDaysAgo で作り、自前の +9 時間や UTC の暦日で作らない', () => {
    const code = codeOf('integration/security/org-challenges-api.test.ts');
    expect(code).toContain("import { jstDaysAgo } from '../helpers/jst-days';");
    expect(code).toContain('const TODAY = jstDaysAgo(0);');
    // 終了日が昨日 (CHALLENGE_ENDED) と、終了日の当日 (まだ参加できる) の境目
    expect(code).toContain('newChallenge({ start: jstDaysAgo(10), end: jstDaysAgo(1) })');
    expect(code).toContain('newChallenge({ start: jstDaysAgo(10), end: TODAY })');
    expect(code).not.toMatch(UTC_DATE_PART);
    expect(code).not.toMatch(/getTime\(\)\s*\+/);
  });
});
