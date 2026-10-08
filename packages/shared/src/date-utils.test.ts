/**
 * date-utils ユニットテスト
 *
 * Refactor E (PR #908) で packages/shared に集約された純粋日付関数の初の unit test。
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  formatLocalDate,
  todayLocal,
  parseLocalDate,
  addDays,
  startOfTodayLocal,
  addDaysToDateString,
  daysBetweenDateStrings,
  daysUntilLocal,
  formatExpiry,
  formatDateJa,
} from './date-utils';

describe('formatLocalDate', () => {
  it('UTC の真夜中直前 (23:59 JST = 14:59 UTC) を JST 当日として返す', () => {
    // 2024-03-15 14:59:59 UTC = 2024-03-15 23:59:59 JST → まだ 3/15
    const date = new Date('2024-03-15T14:59:59Z');
    expect(formatLocalDate(date, 'Asia/Tokyo')).toBe('2024-03-15');
  });

  it('UTC の日付変わり目直前 (23:59 UTC ≠ JST 翌日) を UTC ローカルとして正しく返す', () => {
    // 2024-03-15 00:00:00 UTC = 2024-03-15 09:00:00 JST
    const date = new Date('2024-03-15T00:00:00Z');
    expect(formatLocalDate(date, 'UTC')).toBe('2024-03-15');
  });

  it('JST と UTC でタイムゾーン跨ぎが発生する時刻を正しく区別する', () => {
    // 2024-03-15 15:30:00 UTC = 2024-03-16 00:30:00 JST → JST では翌日
    const date = new Date('2024-03-15T15:30:00Z');
    expect(formatLocalDate(date, 'Asia/Tokyo')).toBe('2024-03-16');
    expect(formatLocalDate(date, 'UTC')).toBe('2024-03-15');
  });

  it('デフォルトタイムゾーンが Asia/Tokyo であること', () => {
    // 明示的に Asia/Tokyo を指定した場合と同じ結果になる
    const date = new Date('2024-06-01T10:00:00Z');
    expect(formatLocalDate(date)).toBe(formatLocalDate(date, 'Asia/Tokyo'));
  });

  // ロケール / タイムゾーンの扱いが弱い実行環境 (モバイルアプリの JS エンジンなど) への備え (#1049 F7-21)
  describe('toLocaleDateString が YYYY-MM-DD を返さない実行環境', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("'sv-SE' が別の書式 (例: 10/8/2026) を返しても、Asia/Tokyo の YYYY-MM-DD を返す", () => {
      vi.spyOn(Date.prototype, 'toLocaleDateString').mockReturnValue('3/16/2024');

      // 2024-03-15 15:30 UTC = 2024-03-16 00:30 JST
      expect(formatLocalDate(new Date('2024-03-15T15:30:00Z'))).toBe('2024-03-16');
      // 年末年始・月またぎ・うるう日も固定オフセットで正しく数える
      expect(formatLocalDate(new Date('2023-12-31T15:00:00Z'))).toBe('2024-01-01');
      expect(formatLocalDate(new Date('2024-02-28T15:00:00Z'))).toBe('2024-02-29');
      expect(formatLocalDate(new Date('2024-02-29T14:59:59Z'))).toBe('2024-02-29');
    });

    it('タイムゾーン名を解釈できず例外になる環境でも、Asia/Tokyo の YYYY-MM-DD を返す', () => {
      vi.spyOn(Date.prototype, 'toLocaleDateString').mockImplementation(() => {
        throw new RangeError('Invalid time zone specified: Asia/Tokyo');
      });

      expect(formatLocalDate(new Date('2024-03-15T15:30:00Z'))).toBe('2024-03-16');
      expect(formatLocalDate(new Date('2024-03-15T14:59:59Z'), 'Asia/Tokyo')).toBe('2024-03-15');
    });

    it('Asia/Tokyo 以外のタイムゾーンは、従来どおりの結果 (例外もそのまま) にする', () => {
      const spy = vi.spyOn(Date.prototype, 'toLocaleDateString');
      spy.mockImplementation(() => {
        throw new RangeError('Invalid time zone specified: America/New_York');
      });

      expect(() => formatLocalDate(new Date('2024-03-15T15:30:00Z'), 'America/New_York')).toThrow(RangeError);
    });

    it('正常な環境では toLocaleDateString の結果をそのまま使う (固定オフセットには頼らない)', () => {
      const spy = vi.spyOn(Date.prototype, 'toLocaleDateString').mockReturnValue('2030-01-02');

      expect(formatLocalDate(new Date('2024-03-15T15:30:00Z'))).toBe('2030-01-02');
      expect(spy).toHaveBeenCalledWith('sv-SE', { timeZone: 'Asia/Tokyo' });
    });
  });
});

describe('todayLocal', () => {
  it('YYYY-MM-DD 形式の文字列を返す', () => {
    const result = todayLocal();
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('UTC タイムゾーンを指定すると UTC 日付を返す', () => {
    const utcResult = todayLocal('UTC');
    // UTC の今日を確認
    const expected = new Date().toLocaleDateString('sv-SE', { timeZone: 'UTC' });
    expect(utcResult).toBe(expected);
  });
});

describe('parseLocalDate', () => {
  it('YYYY-MM-DD 文字列を正しい Date オブジェクトに変換する', () => {
    const result = parseLocalDate('2024-03-15');
    expect(result.getFullYear()).toBe(2024);
    expect(result.getMonth()).toBe(2); // 0-indexed: March = 2
    expect(result.getDate()).toBe(15);
  });

  it('月末日を正しくパースする', () => {
    const result = parseLocalDate('2024-02-29'); // 2024年はうるう年
    expect(result.getFullYear()).toBe(2024);
    expect(result.getMonth()).toBe(1); // February = 1
    expect(result.getDate()).toBe(29);
  });

  it('1月1日をパースする', () => {
    const result = parseLocalDate('2024-01-01');
    expect(result.getFullYear()).toBe(2024);
    expect(result.getMonth()).toBe(0);
    expect(result.getDate()).toBe(1);
  });

  it('年末日 12-31 をパースする', () => {
    const result = parseLocalDate('2023-12-31');
    expect(result.getFullYear()).toBe(2023);
    expect(result.getMonth()).toBe(11); // December = 11
    expect(result.getDate()).toBe(31);
  });
});

describe('addDays', () => {
  it('正の日数を加算する', () => {
    const base = new Date('2024-03-15T00:00:00');
    const result = addDays(base, 5);
    expect(result.getFullYear()).toBe(2024);
    expect(result.getMonth()).toBe(2);
    expect(result.getDate()).toBe(20);
  });

  it('月末を跨ぐ加算が正しく処理される', () => {
    const base = new Date('2024-01-29T00:00:00');
    const result = addDays(base, 3);
    expect(result.getFullYear()).toBe(2024);
    expect(result.getMonth()).toBe(1); // February
    expect(result.getDate()).toBe(1);
  });

  it('年末を跨ぐ加算が正しく処理される', () => {
    const base = new Date('2023-12-30T00:00:00');
    const result = addDays(base, 5);
    expect(result.getFullYear()).toBe(2024);
    expect(result.getMonth()).toBe(0); // January
    expect(result.getDate()).toBe(4);
  });

  it('負の日数（過去方向）の加算が正しく処理される', () => {
    const base = new Date('2024-03-01T00:00:00');
    const result = addDays(base, -1);
    expect(result.getFullYear()).toBe(2024);
    expect(result.getMonth()).toBe(1); // February
    expect(result.getDate()).toBe(29); // 2024はうるう年
  });

  it('0 日加算は元の Date と同じ日付を返す', () => {
    const base = new Date('2024-06-15T00:00:00');
    const result = addDays(base, 0);
    expect(result.getDate()).toBe(base.getDate());
    expect(result.getMonth()).toBe(base.getMonth());
    expect(result.getFullYear()).toBe(base.getFullYear());
  });

  it('元の Date オブジェクトを変更しない（immutable）', () => {
    const base = new Date('2024-03-15T00:00:00');
    const originalTime = base.getTime();
    addDays(base, 10);
    expect(base.getTime()).toBe(originalTime);
  });
});

describe('daysUntilLocal (#1053)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('JST 今日と同じ日付なら 0 を返す', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-08T01:00:00Z')); // JST 2026-07-08 10:00
    expect(daysUntilLocal('2026-07-08')).toBe(0);
  });

  it('未来日は正の残日数を返す', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-08T01:00:00Z'));
    expect(daysUntilLocal('2026-07-11')).toBe(3);
  });

  it('過去日は負の残日数を返す（期限切れ）', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-08T01:00:00Z'));
    expect(daysUntilLocal('2026-07-05')).toBe(-3);
  });

  it('null/undefined は null を返す', () => {
    expect(daysUntilLocal(null)).toBeNull();
    expect(daysUntilLocal(undefined)).toBeNull();
  });

  it('UTC 環境で TZ=UTC ランタイムでも JST 早朝の「今日」を正しく 0 と判定する（#1035 と同種のズレ回帰防止）', () => {
    vi.useFakeTimers();
    // JST 2026-07-08 06:00 = UTC 2026-07-07 21:00。UTC 基準の new Date() 比較だと前日扱いになりうる境界。
    vi.setSystemTime(new Date('2026-07-07T21:00:00Z'));
    expect(daysUntilLocal('2026-07-08', 'Asia/Tokyo')).toBe(0);
  });
});

describe('formatExpiry (#1053)', () => {
  it('null は空文字を返す', () => {
    expect(formatExpiry(null)).toBe('');
  });

  it('負の日数は「期限切れ」を返す', () => {
    expect(formatExpiry(-1)).toBe('期限切れ');
  });

  it('0 は「今日まで」を返す', () => {
    expect(formatExpiry(0)).toBe('今日まで');
  });

  it('1 は「明日まで」を返す', () => {
    expect(formatExpiry(1)).toBe('明日まで');
  });

  it('2以上は「あとN日」を返す', () => {
    expect(formatExpiry(5)).toBe('あと5日');
  });
});

describe('formatDateJa (#1053)', () => {
  it('デフォルト（年なし）で「M月D日」を返す', () => {
    expect(formatDateJa('2026-07-08')).toBe('7月8日');
  });

  it('includeYear: true で「YYYY年M月D日」を返す', () => {
    expect(formatDateJa('2026-07-08', { includeYear: true })).toBe('2026年7月8日');
  });
});

// ---------------------------------------------------------------------------
// #1049 F7-21: 「今日」の基準を Asia/Tokyo に一本化するためのヘルパー
// ---------------------------------------------------------------------------

/** 端末のタイムゾーンを切り替えて fn を実行する (Node は process.env.TZ の変更を実行中の Date に反映する) */
function withDeviceTimeZone<T>(timeZone: string, fn: () => T): T {
  const original = process.env.TZ;
  process.env.TZ = timeZone;
  try {
    return fn();
  } finally {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  }
}

// 端末のタイムゾーンが何であっても、Asia/Tokyo の同じ日付になることを確かめる代表的な地域
const DEVICE_TIME_ZONES = [
  'Asia/Tokyo',
  'UTC',
  'America/Los_Angeles', // 日本より西 (夏時間あり)
  'Europe/London', // 夏時間あり
  'Pacific/Auckland', // 日本より東 (夏時間あり)
  'Pacific/Kiritimati', // UTC+14 (最も東)
  'Pacific/Pago_Pago', // UTC-11 (最も西)
] as const;

describe('startOfTodayLocal (#1049 F7-21)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('JST の早朝 (UTC ではまだ前日) でも、JST の今日の 0 時を返す', () => {
    vi.useFakeTimers();
    // 2026-10-08 08:30 JST = 2026-10-07 23:30 UTC
    vi.setSystemTime(new Date('2026-10-07T23:30:00Z'));

    const today = startOfTodayLocal();

    expect([today.getFullYear(), today.getMonth() + 1, today.getDate()]).toEqual([2026, 10, 8]);
    expect([today.getHours(), today.getMinutes(), today.getSeconds()]).toEqual([0, 0, 0]);
  });

  it('JST の深夜 (UTC では日付が変わる前) でも、JST の今日を返す', () => {
    vi.useFakeTimers();
    // 2026-10-08 23:59 JST = 2026-10-08 14:59 UTC
    vi.setSystemTime(new Date('2026-10-08T14:59:00Z'));

    const today = startOfTodayLocal();

    expect([today.getFullYear(), today.getMonth() + 1, today.getDate()]).toEqual([2026, 10, 8]);
  });

  it.each(DEVICE_TIME_ZONES)('端末のタイムゾーンが %s でも、Asia/Tokyo の今日の年月日になる', (timeZone) => {
    vi.useFakeTimers();
    // 2026-10-08 08:30 JST / 2026-10-07 23:30 UTC。端末のタイムゾーンによってローカルの日付は 10/7 〜 10/8 以降に割れる
    vi.setSystemTime(new Date('2026-10-07T23:30:00Z'));

    const parts = withDeviceTimeZone(timeZone, () => {
      const today = startOfTodayLocal();
      return [today.getFullYear(), today.getMonth() + 1, today.getDate(), today.getHours()];
    });

    expect(parts).toEqual([2026, 10, 8, 0]);
  });

  it('別のタイムゾーンを指定すれば、その地域の今日になる', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-07T23:30:00Z'));

    const utcToday = startOfTodayLocal('UTC');

    expect([utcToday.getFullYear(), utcToday.getMonth() + 1, utcToday.getDate()]).toEqual([2026, 10, 7]);
  });
});

describe('addDaysToDateString (#1049 F7-21)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('日数を足した日付を返す', () => {
    expect(addDaysToDateString('2026-10-08', 0)).toBe('2026-10-08');
    expect(addDaysToDateString('2026-10-08', 1)).toBe('2026-10-09');
    expect(addDaysToDateString('2026-10-08', 6)).toBe('2026-10-14');
  });

  it('負の日数で過去方向に動く', () => {
    expect(addDaysToDateString('2026-10-08', -1)).toBe('2026-10-07');
    expect(addDaysToDateString('2026-10-08', -30)).toBe('2026-09-08');
  });

  it('月末・年末・うるう日を正しく跨ぐ', () => {
    expect(addDaysToDateString('2026-01-31', 1)).toBe('2026-02-01');
    expect(addDaysToDateString('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDaysToDateString('2027-01-01', -1)).toBe('2026-12-31');
    expect(addDaysToDateString('2024-02-28', 1)).toBe('2024-02-29'); // 2024 はうるう年
    expect(addDaysToDateString('2024-02-29', 1)).toBe('2024-03-01');
    expect(addDaysToDateString('2026-02-28', 1)).toBe('2026-03-01'); // 2026 は平年
  });

  it('365 日以上でも日付がずれない', () => {
    expect(addDaysToDateString('2026-10-08', 365)).toBe('2027-10-08');
    expect(addDaysToDateString('2026-10-08', -365)).toBe('2025-10-08');
  });

  it('1 桁の月・日はゼロ埋めする', () => {
    expect(addDaysToDateString('2026-01-01', 0)).toBe('2026-01-01');
    expect(addDaysToDateString('2026-09-30', 1)).toBe('2026-10-01');
  });

  it.each(DEVICE_TIME_ZONES)('端末のタイムゾーンが %s でも、夏時間の切り替え日を含めて同じ結果になる', (timeZone) => {
    const results = withDeviceTimeZone(timeZone, () => ({
      // 米国の夏時間の開始 (3/8)・終了 (11/1)、欧州の開始 (3/29)・終了 (10/25)、NZ の開始 (9/27)・終了 (4/5) 付近
      usSpring: addDaysToDateString('2026-03-07', 2),
      usFall: addDaysToDateString('2026-10-31', 2),
      euSpring: addDaysToDateString('2026-03-28', 2),
      euFall: addDaysToDateString('2026-10-24', 2),
      nzSpring: addDaysToDateString('2026-09-26', 2),
      nzFall: addDaysToDateString('2026-04-04', 2),
      back: addDaysToDateString('2026-11-02', -2),
    }));

    expect(results).toEqual({
      usSpring: '2026-03-09',
      usFall: '2026-11-02',
      euSpring: '2026-03-30',
      euFall: '2026-10-26',
      nzSpring: '2026-09-28',
      nzFall: '2026-04-06',
      back: '2026-10-31',
    });
  });

  it('今日から数えた「N 日前」が JST の日付を基準にそろう (UTC の日付とは 1 日違う時刻)', () => {
    vi.useFakeTimers();
    // 2026-10-08 08:30 JST。UTC ではまだ 10/7
    vi.setSystemTime(new Date('2026-10-07T23:30:00Z'));

    expect(todayLocal()).toBe('2026-10-08');
    expect(addDaysToDateString(todayLocal(), -6)).toBe('2026-10-02');
    // new Date().toISOString().slice(0, 10) は UTC の日付なので、JST の朝は前日になる (これを「今日」に使ってはいけない理由)
    expect(new Date().toISOString().slice(0, 10)).toBe('2026-10-07');
  });
});

describe('daysBetweenDateStrings (#1049 F7-21)', () => {
  it('後の日付までの日数は正、前の日付なら負、同じ日なら 0', () => {
    expect(daysBetweenDateStrings('2026-10-08', '2026-10-15')).toBe(7);
    expect(daysBetweenDateStrings('2026-10-15', '2026-10-08')).toBe(-7);
    expect(daysBetweenDateStrings('2026-10-08', '2026-10-08')).toBe(0);
  });

  it('月末・年末・うるう日を跨いでも日数が合う', () => {
    expect(daysBetweenDateStrings('2026-01-31', '2026-03-01')).toBe(29);
    expect(daysBetweenDateStrings('2024-01-31', '2024-03-01')).toBe(30); // 2024 はうるう年
    expect(daysBetweenDateStrings('2026-12-31', '2027-01-01')).toBe(1);
    expect(daysBetweenDateStrings('2026-10-08', '2027-10-08')).toBe(365);
  });

  it('addDaysToDateString と対になる', () => {
    for (const days of [-400, -31, -1, 0, 1, 7, 30, 365]) {
      expect(daysBetweenDateStrings('2026-10-08', addDaysToDateString('2026-10-08', days))).toBe(days);
    }
  });

  it.each(DEVICE_TIME_ZONES)('端末のタイムゾーンが %s でも、夏時間の切り替え日をまたいで日数が整数で合う', (timeZone) => {
    const results = withDeviceTimeZone(timeZone, () => ({
      usFall: daysBetweenDateStrings('2026-10-31', '2026-11-02'), // 米国の夏時間の終了 (11/1) をまたぐ
      usSpring: daysBetweenDateStrings('2026-03-07', '2026-03-09'), // 米国の夏時間の開始 (3/8) をまたぐ
      nzSpring: daysBetweenDateStrings('2026-09-26', '2026-09-28'), // NZ の夏時間の開始 (9/27) をまたぐ
      euFall: daysBetweenDateStrings('2026-10-24', '2026-10-26'), // 欧州の夏時間の終了 (10/25) をまたぐ
    }));

    expect(results).toEqual({ usFall: 2, usSpring: 2, nzSpring: 2, euFall: 2 });
  });
});

describe('formatDateJa — 日付だけの文字列は端末のタイムゾーンに左右されない (#1049 F7-21)', () => {
  it.each(DEVICE_TIME_ZONES)('端末のタイムゾーンが %s でも、月日は書いたとおりになる', (timeZone) => {
    const results = withDeviceTimeZone(timeZone, () => ({
      monthDay: formatDateJa('2026-10-08'),
      withYear: formatDateJa('2026-01-01', { includeYear: true }),
      monthEnd: formatDateJa('2026-03-31'),
    }));

    expect(results).toEqual({ monthDay: '10月8日', withYear: '2026年1月1日', monthEnd: '3月31日' });
  });

  it('(対照) new Date("YYYY-MM-DD") は UTC の 0 時として読まれ、UTC より西の端末では前日になる', () => {
    // アプリの画面で `new Date(selectedDate).getDate()` のように読むと、この 1 日のずれが出る。
    // tests/mobile-date-basis-contract.test.ts が、そう書いたコードが戻ってこないことを確かめている
    const day = (timeZone: string) => withDeviceTimeZone(timeZone, () => new Date('2026-10-08').getDate());

    expect(day('Asia/Tokyo')).toBe(8);
    expect(day('America/Los_Angeles')).toBe(7);
    expect(day('Pacific/Pago_Pago')).toBe(7);
  });
});
