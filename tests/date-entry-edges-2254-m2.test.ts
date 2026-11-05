// @vitest-environment node
/**
 * #2254 M2 日付の入口の端と、運営の画面の datetime-local の回帰テスト。
 *
 * 問題 (直す前):
 *   - formatLocalDate (packages/shared) は toLocaleDateString('sv-SE') のままで、1000 年より前の年を "101-01-02" と書いた。
 *     isCalendarDate を通る CALENDAR_DATE_MIN (0101-01-02) 〜 0999 年の日付の週の格子 (/menus/weekly) が YYYY-MM-DD にならず、
 *     /api/meal-plans が 400 を返した。formatCalendarDate も年を 0 埋めしなかった
 *   - GET /api/meals は ?date= を確かめずに DB に渡し、2026-02-30 などは DB の date 型への変換の失敗から 500 になった
 *   - 運営の価格の変更の画面は、適用開始日時の既定値を UTC の壁時計 (toISOString().slice(0, 16)) で作り、送るときは端末のローカル時刻で
 *     読んだので、日本の端末では既定のままの適用開始が押した時刻の 9 時間前になった (画面の描画は tests/price-change-effective-at-2254-m2.test.tsx)
 *
 * 直したあと:
 *   - formatLocalDate / formatCalendarDate は年を 0 埋めの 4 桁で書く (4 桁で書けない年は Date#toISOString と同じ符号つきの 6 桁。
 *     Edge Functions の formatJstDate と同じ形)
 *   - GET /api/meals は ?date= を isCalendarDate で確かめ、外れたら DB に触れずに 400 (GET /api/meal-plans と同じ文)
 *   - 運営の datetime-local は日本時間で読み書きする (src/lib/admin/jst-datetime-local.ts)
 *
 * どれも直す前の形で赤になる。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { argsOf, createRecordingSupabase, queriesOf, type Responder } from './helpers/recording-supabase';
import { TEST_TIME_ZONES, localOffsetMinutesOn20260101, withTimeZone } from './helpers/time-zones';

const h = vi.hoisted(() => ({
  client: null as unknown,
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => h.client,
  getSupabaseAdmin: () => h.client,
}));
vi.mock('@/lib/db-logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    withUser: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  }),
  generateRequestId: () => 'req_test',
}));

const { CALENDAR_DATE_MIN, addDaysToDate, formatCalendarDate, formatLocalDate, isCalendarDate, parseLocalDate } = await import(
  '@homegohan/shared'
);
const { formatJstDate } = await import('../supabase/functions/_shared/jst-date.ts');
const { jstDateTimeLocalToIso, jstDateTimeLocalValue } = await import('@/lib/admin/jst-datetime-local');
const { GET: getMeals } = await import('../src/app/api/meals/route');

const USER_ID = 'user-2254-m2';

/** 時刻 (ISO 8601) → Date */
const at = (iso: string) => new Date(iso);

describe('formatLocalDate は年を 0 埋めの 4 桁で書く (#2254 M2)', () => {
  // [時刻, Asia/Tokyo の日付]。直す前は 1000 年より前の年を 4 桁で書かなかった ("101-01-02")
  const CASES: readonly [string, string][] = [
    ['0101-01-01T15:00:00.000Z', '0101-01-02'], // CALENDAR_DATE_MIN の JST 0 時
    ['0999-12-31T14:00:00.000Z', '0999-12-31'],
    ['0100-12-27T03:00:00.000Z', '0100-12-27'],
    ['0005-06-01T03:00:00.000Z', '0005-06-01'],
    ['1000-01-01T03:00:00.000Z', '1000-01-01'],
    ['2026-11-04T15:00:00.000Z', '2026-11-05'],
    ['9999-12-31T03:00:00.000Z', '9999-12-31'],
  ];
  for (const [iso, expected] of CASES) {
    it(`${iso} → ${expected}`, () => {
      expect(formatLocalDate(at(iso))).toBe(expected);
    });
  }

  it('CALENDAR_DATE_MIN の日の時刻を書いた日付は isCalendarDate を通り、parseLocalDate で読み直すと同じ日になる', () => {
    const minDay = formatLocalDate(at('0101-01-02T03:00:00.000Z'));
    expect(minDay).toBe(CALENDAR_DATE_MIN);
    expect(isCalendarDate(minDay)).toBe(true);
    // 週の格子 (端末の 0 時の Date を formatLocalDate で読む) と同じ読み方で、UTC の実行環境の 101 年の日付が YYYY-MM-DD になる
    withTimeZone('UTC', () => {
      expect(localOffsetMinutesOn20260101()).toBe(0);
      expect(formatLocalDate(parseLocalDate('0101-01-10'))).toBe('0101-01-10');
      expect(formatLocalDate(parseLocalDate(addDaysToDate('0101-01-10', 6)))).toBe('0101-01-16');
    });
  });

  it('4 桁で書けない年は、Date#toISOString と同じ符号つきの 6 桁 (YYYY-MM-DD にならず isCalendarDate を通らない)', () => {
    // 10000 年 (JST の 9999-12-31 の翌日)
    expect(formatLocalDate(at('9999-12-31T15:00:00.000Z'))).toBe('+010000-01-01');
    // 紀元前 6 年 (天文学的な年 -5)。toLocaleDateString('sv-SE') は紀元の印を付けず "6-06-01" と書く
    expect(formatLocalDate(at('-000005-06-01T00:00:00.000Z'), 'UTC')).toBe('-000005-06-01');
    for (const iso of ['9999-12-31T15:00:00.000Z', '-000005-06-01T00:00:00.000Z']) {
      expect(isCalendarDate(formatLocalDate(at(iso), 'UTC'))).toBe(false);
    }
  });

  it('紀元 1 年 1 月 1 日の前後は、現地の月で紀元前 1 年 (0 年) と紀元 1 年を分ける (UTC)', () => {
    expect(formatLocalDate(at('0000-12-31T23:59:59.000Z'), 'UTC')).toBe('0000-12-31');
    expect(formatLocalDate(at('0001-01-01T00:00:00.000Z'), 'UTC')).toBe('0001-01-01');
    expect(formatLocalDate(at('0000-12-30T12:00:00.000Z'), 'UTC')).toBe('0000-12-30');
    expect(formatLocalDate(at('0001-01-02T12:00:00.000Z'), 'UTC')).toBe('0001-01-02');
  });

  it('不正な Date (Invalid Date) は以前どおり "Invalid Date" を返す (投げない)', () => {
    expect(formatLocalDate(new Date(Number.NaN))).toBe('Invalid Date');
  });

  it('どの実行環境のタイムゾーンでも、Edge Functions の formatJstDate (固定のオフセット) と同じ日付 (1 年おきの 0 時の前後)', () => {
    // 1888 年より前の Asia/Tokyo は地方時 (+9:18:59) なので、JST (+9:00) が決まってからの年を比べる
    const YEARS = [1900, 1999, 2026, 2099, 9998] as const;
    const OFFSETS_MS = [0, 1, -1] as const;
    for (const tz of TEST_TIME_ZONES) {
      withTimeZone(tz, () => {
        for (const year of YEARS) {
          const midnightJst = Date.parse(`${String(year).padStart(4, '0')}-01-01T00:00:00+09:00`);
          for (const offset of OFFSETS_MS) {
            const date = new Date(midnightJst + offset);
            expect(formatLocalDate(date), `${tz} ${date.toISOString()}`).toBe(formatJstDate(date));
          }
        }
      });
    }
  });
});

describe('formatCalendarDate は年を 0 埋めの 4 桁で書く (#2254 M2)', () => {
  it('101 年 1 月 2 日の 0 時 → "0101-01-02" (直す前は "101-01-02")', () => {
    for (const tz of TEST_TIME_ZONES) {
      withTimeZone(tz, () => {
        expect(formatCalendarDate(parseLocalDate(CALENDAR_DATE_MIN)), tz).toBe(CALENDAR_DATE_MIN);
        expect(formatCalendarDate(parseLocalDate('2026-11-05')), tz).toBe('2026-11-05');
      });
    }
  });
});

describe('運営の datetime-local の値は日本時間で読み書きする (#2254 M2)', () => {
  it('既定値 (jstDateTimeLocalValue) は、どの端末のタイムゾーンでも今の時刻の日本時間の壁時計', () => {
    for (const tz of TEST_TIME_ZONES) {
      withTimeZone(tz, () => {
        // JST 2026-11-05 15:07 (UTC 06:07)
        expect(jstDateTimeLocalValue(at('2026-11-05T06:07:42.000Z')), tz).toBe('2026-11-05T15:07');
        // JST 0 時 (UTC では前の日の 15 時)。日付も時刻も日本時間
        expect(jstDateTimeLocalValue(at('2026-11-04T15:00:00.000Z')), tz).toBe('2026-11-05T00:00');
        // JST 23:59 (直す前の toISOString().slice(0, 16) は UTC の "2026-11-05T14:59")
        expect(jstDateTimeLocalValue(at('2026-11-05T14:59:59.000Z')), tz).toBe('2026-11-05T23:59');
      });
    }
  });

  it('送る値 (jstDateTimeLocalToIso) は、どの端末のタイムゾーンでも日本時間として読んだ時刻で、既定値を送り返すと今の時刻 (分まで) になる', () => {
    for (const tz of TEST_TIME_ZONES) {
      withTimeZone(tz, () => {
        expect(jstDateTimeLocalToIso('2026-11-05T15:07'), tz).toBe('2026-11-05T06:07:00.000Z');
        expect(jstDateTimeLocalToIso('2026-11-05T00:00:30'), tz).toBe('2026-11-04T15:00:30.000Z');
        const now = at('2026-11-05T06:07:42.000Z');
        expect(jstDateTimeLocalToIso(jstDateTimeLocalValue(now)), tz).toBe('2026-11-05T06:07:00.000Z');
      });
    }
  });

  it('空欄・形の違う値は null (送らない)', () => {
    for (const value of ['', '   ', '2026-11-05', '2026/11/05T15:00', '2026-11-05T25:00', '2026-11-05T15:00Z']) {
      expect(jstDateTimeLocalToIso(value), JSON.stringify(value)).toBeNull();
    }
  });
});

describe('GET /api/meals の ?date= は実在する日付だけ (#2254 M2)', () => {
  /** 実在しない日付・YYYY-MM-DD ではない日付と、実在するが受け付ける範囲 (0101-01-02〜9998-12-30) の外の日付 */
  const INVALID_DATES = ['2026-02-30', '2027-02-29', '2026-13-01', '2026/10/10', 'abc', '9999-12-31', '0100-01-01'] as const;
  /** 400 の文 (手で書いた期待値。src/lib/api/user-api-error-messages.ts の invalidCalendarDateMessage と同じ文・GET /api/meal-plans と同じ) */
  const INVALID_DATE_MESSAGE = '日付 (date)はYYYY-MM-DD の形の、0101-01-02 から 9998-12-30 までの実在する日付で指定してください';

  let queries: ReturnType<typeof createRecordingSupabase>['queries'];

  function setup(respond: Responder = () => ({ data: null, error: null })) {
    const recording = createRecordingSupabase(respond);
    h.client = { ...recording.client, auth: { getUser: vi.fn(async () => ({ data: { user: { id: USER_ID } }, error: null })) } };
    queries = recording.queries;
  }

  beforeEach(() => {
    setup();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each(INVALID_DATES)('?date=%s は、DB に触れずに 400 (直す前は確かめずに DB に渡し、date 型への変換の失敗で 500)', async (date) => {
    const res = await getMeals(new Request(`http://localhost/api/meals?date=${encodeURIComponent(date)}`));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: INVALID_DATE_MESSAGE });
    expect(queriesOf(queries, 'user_daily_meals')).toEqual([]);
  });

  it('実在する日付 (うるう日・CALENDAR_DATE_MIN) は、そのまま day_date で読む', async () => {
    for (const date of ['2028-02-29', CALENDAR_DATE_MIN]) {
      setup();
      const res = await getMeals(new Request(`http://localhost/api/meals?date=${date}`));
      expect(res.status, date).toBe(200);
      const [dayQuery] = queriesOf(queries, 'user_daily_meals');
      expect(dayQuery, date).toBeDefined();
      expect(argsOf(dayQuery!, 'eq'), date).toContainEqual(['day_date', date]);
    }
  });

  it('?date= が無い・空欄のときは、以前どおり JST の今日を読む', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    // JST 2026-11-05 0:30 (UTC ではまだ 11/4)
    vi.setSystemTime(at('2026-11-04T15:30:00.000Z'));
    for (const query of ['', '?date=']) {
      setup();
      const res = await getMeals(new Request(`http://localhost/api/meals${query}`));
      expect(res.status, query).toBe(200);
      const [dayQuery] = queriesOf(queries, 'user_daily_meals');
      expect(argsOf(dayQuery!, 'eq'), query).toContainEqual(['day_date', '2026-11-05']);
    }
  });
});
