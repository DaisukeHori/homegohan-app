// @vitest-environment node
/**
 * #1463 (#1433 の続き): JST の暦日まわりの残りを直したルートの回帰テスト。
 *
 * 5. 存在しない日付 (2026-02-30 など) が DB まで届いて 500 になっていた入口を、isCalendarDate で 400 にする
 *    - GET  /api/export/meals (new Date で確かめていたので 2026-02-30 が 3/2 に繰り上がって通っていた)
 *    - PUT / DELETE /api/health/records/[date] (形だけを見ていた。GET は isCalendarDate を使っていた)
 *    - POST /api/shopping-list/regenerate (new Date で確かめていた)
 *    - POST /api/health/records・POST /api/health/records/quick (同じく形だけを見ていた)
 * 6. POST /api/menu-plans/add の date_offset_days に上限 (既定 366 日。MENU_PLANS_ADD_MAX_DATE_OFFSET_DAYS で上書き) を置く
 *    (巨大な値で addDaysToDate が RangeError を投げ、500 になっていた)
 * 2. 実行環境のタイムゾーンに依存していた日付の計算 (parseLocalDate / new Date(day) + setDate + formatLocalDate) を、
 *    暦の計算 (addDaysToDate・mondayWeekRange) に置き換えたルートが、どのタイムゾーンで動いても同じ日付で DB を引く
 *    - GET  /api/meal-plans (既定の今週 = 月曜〜日曜)
 *    - POST /api/health/records/quick (前日の記録)
 *    - GET  /api/health/streaks (週間の記録の開始日・連続が途切れたかの判定)
 * 書き方そのもの (ローカル時刻で動かした Date を暦日の文字列にする) が戻らないことは tests/jst-today-source-scan.test.ts の規則 J が見る。
 */
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { argsOf, createRecordingSupabase, queriesOf, type RecordedQuery, type Responder } from './helpers/recording-supabase';
import { TEST_TIME_ZONES, withTimeZoneAsync } from './helpers/time-zones';

const USER_ID = 'user-1';

const h = vi.hoisted(() => ({
  respond: null as null | ((query: { table: string; calls: Array<{ method: string; args: unknown[] }> }) => unknown),
  queries: [] as Array<{ table: string; calls: Array<{ method: string; args: unknown[] }> }>,
  client: null as unknown,
  fetch: vi.fn(),
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => h.client,
  getSupabaseAdmin: () => h.client,
}));
vi.mock('@/lib/ai/consent-guard', () => ({ requireAiConsent: vi.fn(async () => null) }));
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(async () => ({ success: true })),
  rateLimitExceededResponse: vi.fn(),
}));
// AI の利用回数の上限の判定と記録 (#1149 / #1177)。ここでは常に許可する (判定そのものは src/__tests__/lib/plan/entitlements.test.ts)
vi.mock('@/lib/plan/entitlements', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/plan/entitlements')>()),
  consumeAiUsage: vi.fn(async () => ({ allowed: true, metered: false, usageDate: null, limit: null, used: null })),
  refundAiUsage: vi.fn(async () => undefined),
  recordAiUsage: vi.fn(async () => undefined),
}));
vi.mock('@/lib/env-required', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/env-required')>()),
  getSupabaseServiceConfig: () => ({ url: 'http://supabase.test', serviceRoleKey: 'service-role-key' }),
}));
vi.mock('@/lib/badges/awardBadge', () => ({
  awardBadge: vi.fn(async () => ({ awarded: false, badge_id: null, obtained_at: null, name: null, icon_url: null })),
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

import { GET as exportMeals } from '../src/app/api/export/meals/route';
import { DELETE as deleteHealthRecord, PUT as putHealthRecord } from '../src/app/api/health/records/[date]/route';
import { POST as postHealthRecord } from '../src/app/api/health/records/route';
import { POST as postQuickRecord } from '../src/app/api/health/records/quick/route';
import { GET as getStreaks } from '../src/app/api/health/streaks/route';
import { GET as getMealPlans } from '../src/app/api/meal-plans/route';
import { POST as addMenuPlan } from '../src/app/api/menu-plans/add/route';
import { POST as regenerateShoppingList } from '../src/app/api/shopping-list/regenerate/route';
import {
  MENU_PLANS_ADD_DEFAULT_MAX_DATE_OFFSET_DAYS,
  menuPlansAddMaxDateOffsetDays,
  parseMenuPlanDateOffsetDays,
} from '../src/lib/menu-plan-date-offset';

/** 実在しない日付と、実在するが受け付ける範囲 (0101-01-02〜9998-12-30) の外の日付 */
const INVALID_DATES = ['2026-02-30', '2026-13-01', '9999-12-31', '0100-01-01'] as const;

/** JST 2026-10-14 (水) 0:30。UTC ではまだ 10/13 */
const NOW_JST_WED = '2026-10-13T15:30:00.000Z';

function setup(respond: Responder = () => ({ data: null, error: null })) {
  const { client, queries } = createRecordingSupabase(respond);
  h.queries = queries;
  h.client = {
    ...client,
    auth: { getUser: async () => ({ data: { user: { id: USER_ID } }, error: null }) },
  };
  return queries;
}

function jsonRequest(url: string, method: string, body: unknown): Request {
  return new Request(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

/** クエリが .eq / .gte / .lte で列 column に渡した値 */
function filterValue(query: RecordedQuery, method: string, column: string): unknown {
  return argsOf(query, method).find(([col]) => col === column)?.[1];
}

beforeEach(() => {
  vi.clearAllMocks();
  setup();
  vi.stubGlobal('fetch', h.fetch.mockResolvedValue(new Response('{}')));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('5. 存在しない日付・範囲の外の日付は、DB に触れる前に 400', () => {
  it.each(INVALID_DATES)('GET /api/export/meals?start_date=%s / end_date も 400', async (date) => {
    for (const param of ['start_date', 'end_date']) {
      const res = await exportMeals(new Request(`http://localhost/api/export/meals?${param}=${date}`));
      expect(res.status, param).toBe(400);
    }
    expect(h.queries).toEqual([]);
  });

  it('GET /api/export/meals: 実在する日付は DB へそのまま渡す', async () => {
    const res = await exportMeals(new Request('http://localhost/api/export/meals?start_date=2028-02-29&end_date=2028-03-01'));
    expect(res.status).toBe(200);
    const [query] = queriesOf(h.queries, 'user_daily_meals');
    expect(filterValue(query, 'gte', 'day_date')).toBe('2028-02-29');
    expect(filterValue(query, 'lte', 'day_date')).toBe('2028-03-01');
  });

  it.each(INVALID_DATES)('PUT / DELETE /api/health/records/%s は 400', async (date) => {
    const params = { params: Promise.resolve({ date }) };
    const put = await putHealthRecord(
      new NextRequest(`http://localhost/api/health/records/${date}`, { method: 'PUT', body: JSON.stringify({ weight: 60 }) }),
      params,
    );
    expect(put.status).toBe(400);
    expect(await put.json()).toEqual({ error: 'date must be in YYYY-MM-DD format' });

    const del = await deleteHealthRecord(new NextRequest(`http://localhost/api/health/records/${date}`, { method: 'DELETE' }), {
      params: Promise.resolve({ date }),
    });
    expect(del.status).toBe(400);
    expect(await del.json()).toEqual({ error: 'date must be in YYYY-MM-DD format' });
    expect(h.queries).toEqual([]);
  });

  it('DELETE /api/health/records/[date]: 実在する日付は消す', async () => {
    const res = await deleteHealthRecord(new NextRequest('http://localhost/api/health/records/2028-02-29', { method: 'DELETE' }), {
      params: Promise.resolve({ date: '2028-02-29' }),
    });
    expect(res.status).toBe(200);
    const [query] = queriesOf(h.queries, 'health_records');
    expect(filterValue(query, 'eq', 'record_date')).toBe('2028-02-29');
  });

  it.each(INVALID_DATES)('POST /api/health/records・/api/health/records/quick の record_date=%s は 400', async (date) => {
    const full = await postHealthRecord(
      new NextRequest('http://localhost/api/health/records', { method: 'POST', body: JSON.stringify({ record_date: date, weight: 60 }) }),
    );
    expect(full.status).toBe(400);
    expect(await full.json()).toEqual({ error: 'record_date must be in YYYY-MM-DD format' });

    const quick = await postQuickRecord(
      new NextRequest('http://localhost/api/health/records/quick', {
        method: 'POST',
        body: JSON.stringify({ record_date: date, weight: 60 }),
      }),
    );
    expect(quick.status).toBe(400);
    expect(await quick.json()).toEqual({ error: 'record_date must be in YYYY-MM-DD format' });
    expect(h.queries).toEqual([]);
  });

  it.each(INVALID_DATES)('POST /api/shopping-list/regenerate の startDate / endDate=%s は 400 (リクエストの行を作らない)', async (date) => {
    for (const body of [
      { startDate: date, endDate: '2026-10-14' },
      { startDate: '2026-10-14', endDate: date },
    ]) {
      const res = await regenerateShoppingList(jsonRequest('http://localhost/api/shopping-list/regenerate', 'POST', body));
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(await res.json()).toEqual({
        error: '開始日 (startDate) と終了日 (endDate) はYYYY-MM-DD の形の、0101-01-02 から 9998-12-30 までの実在する日付で指定してください',
      });
    }
    expect(h.queries).toEqual([]);
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it('POST /api/shopping-list/regenerate: 期間は 14 日まで (月・年をまたいでも暦の日数で数える)', async () => {
    const tooLong = await regenerateShoppingList(
      jsonRequest('http://localhost/api/shopping-list/regenerate', 'POST', { startDate: '2026-12-20', endDate: '2027-01-04' }),
    );
    expect(tooLong.status).toBe(400);
    expect(await tooLong.json()).toEqual({ error: '期間は 14 日以内にしてください' });

    const reversed = await regenerateShoppingList(
      jsonRequest('http://localhost/api/shopping-list/regenerate', 'POST', { startDate: '2026-10-15', endDate: '2026-10-14' }),
    );
    expect(reversed.status).toBe(400);
    expect(await reversed.json()).toEqual({ error: '開始日 (startDate) は終了日 (endDate) 以前の日付にしてください' });
    expect(h.queries).toEqual([]);

    setup((query) => (query.table === 'shopping_list_requests' ? { data: { id: 'req-1' } } : {}));
    const ok = await regenerateShoppingList(
      jsonRequest('http://localhost/api/shopping-list/regenerate', 'POST', { startDate: '2026-12-21', endDate: '2027-01-04' }),
    );
    expect(ok.status).toBe(200);
    const [insert] = queriesOf(h.queries, 'shopping_list_requests');
    expect(argsOf(insert, 'insert')[0][0]).toMatchObject({ start_date: '2026-12-21', end_date: '2027-01-04' });
  });
});

describe('6. POST /api/menu-plans/add の date_offset_days の上限', () => {
  function menuDb() {
    return setup((query) => {
      if (query.table === 'weekly_menu_requests') return { data: { id: 'req-1' } };
      if (query.table === 'weekly_menus') return { data: { id: 'menu-1' } };
      return {};
    });
  }

  function startDateWritten(): unknown {
    const [requestInsert] = queriesOf(h.queries, 'weekly_menu_requests');
    return (argsOf(requestInsert, 'insert')[0][0] as { start_date: unknown }).start_date;
  }

  it.each([1e9, -1e9, MENU_PLANS_ADD_DEFAULT_MAX_DATE_OFFSET_DAYS + 1, -(MENU_PLANS_ADD_DEFAULT_MAX_DATE_OFFSET_DAYS + 1), Number.MAX_SAFE_INTEGER])(
    'date_offset_days=%s は 400 で、DB に書かない (以前は addDaysToDate の RangeError で 500)',
    async (offset) => {
      menuDb();
      const res = await addMenuPlan(jsonRequest('http://localhost/api/menu-plans/add', 'POST', { dish_name: 'x', date_offset_days: offset }));
      expect(res.status).toBe(400);
      expect((await res.json()).error.code).toBe('invalid_date_offset_days');
      expect(h.queries).toEqual([]);
    },
  );

  it.each([
    [MENU_PLANS_ADD_DEFAULT_MAX_DATE_OFFSET_DAYS, '2027-10-15'],
    [-MENU_PLANS_ADD_DEFAULT_MAX_DATE_OFFSET_DAYS, '2025-10-13'],
    [1, '2026-10-15'], // ハンズオンツアーの見本の献立 (明日)
    [1.9, '2026-10-15'], // 小数は 0 の方向へ切り捨て (以前と同じ)
    ['3', '2026-10-14'], // 数値でなければ今日 (以前と同じ)
  ] as const)('date_offset_days=%s は受け付け、開始日は JST の今日 (10/14) からずらした %s', async (offset, expected) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(NOW_JST_WED));
    menuDb();
    const res = await addMenuPlan(jsonRequest('http://localhost/api/menu-plans/add', 'POST', { dish_name: 'x', date_offset_days: offset }));
    expect(res.status).toBe(200);
    expect(startDateWritten()).toBe(expected);
  });

  it('上限は環境変数 MENU_PLANS_ADD_MAX_DATE_OFFSET_DAYS で上書きできる', async () => {
    vi.stubEnv('MENU_PLANS_ADD_MAX_DATE_OFFSET_DAYS', '10');
    menuDb();
    const over = await addMenuPlan(jsonRequest('http://localhost/api/menu-plans/add', 'POST', { dish_name: 'x', date_offset_days: 11 }));
    expect(over.status).toBe(400);
    expect((await over.json()).error.message).toContain('-10〜10');

    menuDb();
    const ok = await addMenuPlan(jsonRequest('http://localhost/api/menu-plans/add', 'POST', { dish_name: 'x', date_offset_days: 10 }));
    expect(ok.status).toBe(200);
  });

  it('上限を大きく上書きしても、開始日が暦の計算で扱える範囲の外に出る値は 400 (500 にしない)', async () => {
    vi.stubEnv('MENU_PLANS_ADD_MAX_DATE_OFFSET_DAYS', String(Number.MAX_SAFE_INTEGER));
    menuDb();
    const res = await addMenuPlan(jsonRequest('http://localhost/api/menu-plans/add', 'POST', { dish_name: 'x', date_offset_days: 1e9 }));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('invalid_date_offset_days');
    expect(h.queries).toEqual([]);
  });

  it('menuPlansAddMaxDateOffsetDays: 正の整数でなければ既定値 (366)', () => {
    expect(MENU_PLANS_ADD_DEFAULT_MAX_DATE_OFFSET_DAYS).toBe(366);
    expect(menuPlansAddMaxDateOffsetDays(undefined)).toBe(366);
    for (const invalid of ['', '  ', '0', '-5', '1.5', 'abc', '1e400']) {
      expect(menuPlansAddMaxDateOffsetDays(invalid), invalid).toBe(366);
    }
    expect(menuPlansAddMaxDateOffsetDays('30')).toBe(30);
  });

  it('parseMenuPlanDateOffsetDays: 数でない・有限でない値は 0、上限の外は null', () => {
    expect(parseMenuPlanDateOffsetDays(undefined, 10)).toBe(0);
    expect(parseMenuPlanDateOffsetDays(Number.NaN, 10)).toBe(0);
    expect(parseMenuPlanDateOffsetDays(Number.POSITIVE_INFINITY, 10)).toBe(0);
    expect(parseMenuPlanDateOffsetDays(-2.7, 10)).toBe(-2);
    expect(parseMenuPlanDateOffsetDays(10, 10)).toBe(10);
    expect(parseMenuPlanDateOffsetDays(-10, 10)).toBe(-10);
    expect(parseMenuPlanDateOffsetDays(10.9, 10)).toBe(10);
    expect(parseMenuPlanDateOffsetDays(11, 10)).toBeNull();
    expect(parseMenuPlanDateOffsetDays(-11, 10)).toBeNull();
  });
});

describe('2. 実行環境のタイムゾーンによらず、同じ暦日で DB を引く (JST 2026-10-14 (水) 0:30)', () => {
  it.each(TEST_TIME_ZONES)('GET /api/meal-plans の既定の今週は 10/12 (月) 〜 10/18 (日) (TZ=%s)', async (tz) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(NOW_JST_WED));
    await withTimeZoneAsync(tz, async () => {
      setup((query) => ({ data: query.table === 'user_daily_meals' ? [] : null }));
      const res = await getMealPlans(new Request('http://localhost/api/meal-plans'));
      expect(res.status).toBe(200);
      const [query] = queriesOf(h.queries, 'user_daily_meals');
      expect(filterValue(query, 'gte', 'day_date')).toBe('2026-10-12');
      expect(filterValue(query, 'lte', 'day_date')).toBe('2026-10-18');
    });
  });

  it.each(TEST_TIME_ZONES)('POST /api/health/records/quick は、記録日の前日 (2026-03-01 → 2026-02-28) と比べる (TZ=%s)', async (tz) => {
    await withTimeZoneAsync(tz, async () => {
      setup((query) => (query.table === 'health_records' ? { data: { id: 'rec-1', weight: 60 } } : {}));
      const res = await postQuickRecord(
        new NextRequest('http://localhost/api/health/records/quick', {
          method: 'POST',
          body: JSON.stringify({ record_date: '2026-03-01', weight: 60 }),
        }),
      );
      expect(res.status).toBe(200);
      const previous = queriesOf(h.queries, 'health_records').find((q) => argsOf(q, 'select')[0]?.[0] === 'weight, mood_score, sleep_quality');
      expect(previous, '前日の記録を読んでいない').toBeDefined();
      expect(filterValue(previous!, 'eq', 'record_date')).toBe('2026-02-28');
    });
  });

  it.each(TEST_TIME_ZONES)('GET /api/health/streaks: 週間の記録は今日を含む 7 日 (10/8 から)、最後の記録が一昨日なら連続は 0 (TZ=%s)', async (tz) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(NOW_JST_WED));
    await withTimeZoneAsync(tz, async () => {
      const streakRow = (lastActivity: string) => ({
        streak_type: 'daily_record',
        current_streak: 5,
        longest_streak: 5,
        last_activity_date: lastActivity,
        streak_start_date: '2026-10-01',
        achieved_badges: [],
        total_records: 5,
      });
      const run = async (lastActivity: string) => {
        setup((query) => (query.table === 'health_streaks' ? { data: streakRow(lastActivity) } : { data: [] }));
        const res = await getStreaks(new NextRequest('http://localhost/api/health/streaks'));
        expect(res.status).toBe(200);
        const [weekly] = queriesOf(h.queries, 'health_records');
        expect(filterValue(weekly, 'gte', 'record_date')).toBe('2026-10-08');
        return (await res.json()).streak.current_streak as number;
      };
      // 昨日 (10/13) までの記録は、まだ続いている
      expect(await run('2026-10-13')).toBe(5);
      expect(await run('2026-10-14')).toBe(5);
      // 一昨日 (10/12) で止まっていれば、途切れている
      expect(await run('2026-10-12')).toBe(0);
    });
  });

  it.each(TEST_TIME_ZONES)('GET /api/health/streaks: 夏時間の切り替え (米国 3/8) をまたいでも、一昨日で止まった連続は 0 (TZ=%s)', async (tz) => {
    // JST 2026-03-10 12:00。以前のミリ秒の差の計算は、Los Angeles では 3/8 → 3/10 を 1 日 23 時間と数え、「1 日」として連続を続けていた
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-03-10T03:00:00.000Z'));
    await withTimeZoneAsync(tz, async () => {
      setup((query) =>
        query.table === 'health_streaks'
          ? {
              data: {
                streak_type: 'daily_record',
                current_streak: 5,
                longest_streak: 5,
                last_activity_date: '2026-03-08',
                streak_start_date: '2026-03-04',
                achieved_badges: [],
                total_records: 5,
              },
            }
          : { data: [] },
      );
      const res = await getStreaks(new NextRequest('http://localhost/api/health/streaks'));
      expect((await res.json()).streak.current_streak).toBe(0);
    });
  });
});
