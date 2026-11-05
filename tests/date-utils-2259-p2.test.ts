// @vitest-environment node
/**
 * #2259 P2 packages/shared の日付の関数 2 つの回帰テスト。
 *
 * 問題 (直す前):
 *   - daysUntilFrom は端末の 0 時どうし (parseLocalDate) の差を 1 日の長さで割って Math.ceil していたので、端末に夏時間がある地域で、
 *     今日と期限の間に夏時間の終わり (25 時間の日) があると 1 日多かった (America/Los_Angeles で 2026-10-31 から 2026-11-05 が 6 日)
 *   - formatLocalDate の紀元の境目 (COMMON_ERA_START_MS) を Date.parse('0001-01-01T00:00:00Z') で作っていたので、その文字列を読めない
 *     エンジンでは NaN になり、境目との比較が両方 false になって、12 月の日付が全部紀元前の形 ("-002024-12-15") になった
 *     (Node では起きない。読めないエンジンを Date.parse の置き換えで作る)
 *
 * 直したあと:
 *   - daysUntilFrom は暦の差 (年月日の UTC の 0 時どうしの差) で数える
 *   - 境目の時刻は文字列を読まずに setUTCFullYear で作り、それでも求まらない (NaN) ときは紀元前と決めない
 *
 * どれも直す前の形で赤になる。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { daysUntilFrom } from '../packages/shared/src/date-utils';

/** 夏時間の切り替えがある実行環境のタイムゾーンと、その切り替えをまたぐ期間 (どれも暦の差が正しい日数) */
const DST_CASES: readonly { timeZone: string; today: string; target: string; days: number; why: string }[] = [
  { timeZone: 'America/Los_Angeles', today: '2026-10-31', target: '2026-11-05', days: 5, why: '夏時間の終わり (2026-11-01・25 時間の日) をまたぐ (直す前は 6)' },
  { timeZone: 'Europe/London', today: '2026-10-24', target: '2026-10-27', days: 3, why: '夏時間の終わり (2026-10-25) をまたぐ (直す前は 4)' },
  { timeZone: 'Australia/Sydney', today: '2026-04-04', target: '2026-04-06', days: 2, why: '南半球の夏時間の終わり (2026-04-05) をまたぐ (直す前は 3)' },
  { timeZone: 'America/Los_Angeles', today: '2026-03-07', target: '2026-03-10', days: 3, why: '夏時間の始まり (2026-03-08・23 時間の日) をまたぐ (対照。直す前も Math.ceil で 3)' },
  { timeZone: 'America/Los_Angeles', today: '2026-03-10', target: '2026-03-07', days: -3, why: '過去の期限で夏時間の始まりをまたぐ (直す前は Math.ceil で -2)' },
  { timeZone: 'America/Los_Angeles', today: '2026-11-05', target: '2026-10-31', days: -5, why: '過去の期限で夏時間の終わりをまたぐ (対照。直す前も -5)' },
  { timeZone: 'Asia/Tokyo', today: '2026-10-31', target: '2026-11-05', days: 5, why: '夏時間の無い地域 (対照)' },
];

describe('daysUntilFrom は、実行環境のタイムゾーンの夏時間に左右されず暦の差で数える (#2259 P2)', () => {
  const originalTimeZone = process.env.TZ;
  afterEach(() => {
    // 元が未設定なら消す (undefined を入れると文字列 "undefined" になる)
    if (originalTimeZone === undefined) delete process.env.TZ;
    else process.env.TZ = originalTimeZone;
  });

  for (const c of DST_CASES) {
    it(`${c.timeZone}: ${c.today} から ${c.target} は ${c.days} 日 (${c.why})`, () => {
      process.env.TZ = c.timeZone;
      expect(daysUntilFrom(c.target, c.today)).toBe(c.days);
    });
  }

  it('当日は 0 (夏時間の終わりの日そのものでも)', () => {
    process.env.TZ = 'America/Los_Angeles';
    expect(daysUntilFrom('2026-11-01', '2026-11-01')).toBe(0);
    expect(daysUntilFrom('2026-11-02', '2026-11-01')).toBe(1);
  });

  it('月末・年末・うるう日をまたいでも暦の差 (対照)', () => {
    process.env.TZ = 'America/Los_Angeles';
    expect(daysUntilFrom('2027-01-02', '2026-12-30')).toBe(3);
    expect(daysUntilFrom('2028-03-01', '2028-02-28')).toBe(2);
  });
});

describe('formatLocalDate は、紀元の境目の文字列を読めないエンジンでも 12 月の日付を紀元前にしない (#2259 P2)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  /**
   * 置き換えを入れた状態で packages/shared の date-utils を読み直し (紀元の境目はモジュールを読んだときに作る)、置き換えを戻して返す。
   * 置き換えは読み込みの間だけ (それより後の Date の動きは変えない)
   */
  async function importDateUtilsWith(install: () => void) {
    vi.resetModules();
    install();
    try {
      return await import('../packages/shared/src/date-utils');
    } finally {
      vi.restoreAllMocks();
    }
  }

  /** 2025-12-15 12:00 (JST) の時刻 (文字列を読まずに作る) */
  const DECEMBER_NOON_JST = new Date(Date.UTC(2025, 11, 15, 3));
  /** 2026-01-15 12:00 (JST) の時刻 (対照) */
  const JANUARY_NOON_JST = new Date(Date.UTC(2026, 0, 15, 3));

  it('Date.parse が ISO 8601 を読めず NaN を返すエンジン (直す前は "-002024-12-15")', async () => {
    const { formatLocalDate } = await importDateUtilsWith(() => {
      vi.spyOn(Date, 'parse').mockReturnValue(Number.NaN);
    });
    expect(formatLocalDate(DECEMBER_NOON_JST, 'Asia/Tokyo')).toBe('2025-12-15');
    expect(formatLocalDate(JANUARY_NOON_JST, 'Asia/Tokyo')).toBe('2026-01-15');
  });

  it('境目の時刻がどう作っても NaN になるエンジンでも、紀元前と決めない (守り)', async () => {
    const { formatLocalDate } = await importDateUtilsWith(() => {
      vi.spyOn(Date, 'parse').mockReturnValue(Number.NaN);
      vi.spyOn(Date.prototype, 'setUTCFullYear').mockReturnValue(Number.NaN);
    });
    expect(formatLocalDate(DECEMBER_NOON_JST, 'Asia/Tokyo')).toBe('2025-12-15');
    expect(formatLocalDate(JANUARY_NOON_JST, 'Asia/Tokyo')).toBe('2026-01-15');
  });

  it('置き換えの無いエンジンでは、紀元前の日付は今までどおり紀元前の形 (対照)', async () => {
    const { formatLocalDate } = await importDateUtilsWith(() => undefined);
    // 紀元前 1 年 (天文学的な年の 0 年) 12 月 31 日 12:00 (UTC)。Date.UTC は 0〜99 年を 1900 年代に読み替えるので setUTCFullYear で作る
    const lastDayBeforeCommonEra = new Date(new Date(0).setUTCFullYear(0, 11, 31));
    lastDayBeforeCommonEra.setUTCHours(12);
    expect(formatLocalDate(lastDayBeforeCommonEra, 'UTC')).toBe('0000-12-31');
    expect(formatLocalDate(DECEMBER_NOON_JST, 'Asia/Tokyo')).toBe('2025-12-15');
  });
});
