// @vitest-environment node
/**
 * #1482 (#1463 の続き): 存在しない日付が DB まで届いていた入口の残りと、献立生成のサーバー側の日付の幅の上限の回帰テスト。
 *
 * 1. 存在しない日付 (2026-02-30 など)・受け付ける範囲の外の日付は、DB (RPC を含む) に触れる前に 400
 *    - GET  /api/performance/checkins の date / startDate / endDate (averages=true の RPC の p_date を含む)。以前は検査が無かった
 *    - POST /api/performance/checkins の checkinDate。以前は形 (正規表現) だけを見ていた
 *    - GET  /api/meal-plans の date / startDate / endDate。以前は検査が無かった
 *    - GET  /api/health/records の start_date / end_date。以前は検査が無かった
 *    - GET / POST /api/performance/analyze の date は、日付でない値と同じく JST の今日に読み替える (以前は形だけ見て RPC に渡していた)
 * 2. POST /api/ai/menu/v4/generate・v5/generate は、targetSlots の日付の幅 (最も早い日〜最も遅い日) が
 *    MENU_GENERATION_RANGE_MAX_DAYS (31) 日を超えたら、DB・認証に触れる前に 400 (以前は slot の数 (93) だけを見ていた)
 * 4. POST /api/health/records は、前後の空白を除いた日付を upsert・連続記録・プロフィールの体重の判定に使う
 *
 * 空欄 (?date=) は以前どおり「指定なし」として扱う。
 */
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { argsOf, createRecordingSupabase, queriesOf, type Responder } from './helpers/recording-supabase';

const USER_ID = 'user-1';

const h = vi.hoisted(() => ({
  client: null as unknown,
  getUser: null as unknown as ReturnType<typeof vi.fn>,
  rpc: null as unknown as ReturnType<typeof vi.fn>,
  updateHealthStreak: vi.fn(),
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => h.client,
  getSupabaseAdmin: () => h.client,
}));
vi.mock('@/lib/health-streaks', () => ({ updateHealthStreak: h.updateHealthStreak }));
vi.mock('@/lib/ai/consent-guard', () => ({ requireAiConsent: vi.fn(async () => null) }));
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(async () => ({ success: true })),
  rateLimitExceededResponse: vi.fn(),
}));
vi.mock('@/lib/feature-flags', () => ({ isFeatureEnabled: vi.fn(async () => false) }));
vi.mock('@vercel/functions', () => ({ waitUntil: vi.fn() }));
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

import { GET as getCheckins, POST as postCheckin } from '../src/app/api/performance/checkins/route';
import { GET as getAnalyze, POST as postAnalyze } from '../src/app/api/performance/analyze/route';
import { GET as getMealPlans } from '../src/app/api/meal-plans/route';
import { GET as getHealthRecords, POST as postHealthRecord } from '../src/app/api/health/records/route';
import { POST as postV4Generate } from '../src/app/api/ai/menu/v4/generate/route';
import { POST as postV5Generate } from '../src/app/api/ai/menu/v5/generate/route';

/** 実在しない日付・YYYY-MM-DD ではない日付と、実在するが受け付ける範囲 (0101-01-02〜9998-12-30) の外の日付 */
const INVALID_DATES = ['2026-02-30', '2027-02-29', '2026-13-01', '2026/10/10', '9999-12-31', '0100-01-01'] as const;

/** 400 の文の「受け付ける日付」の説明 (手で書いた期待値。CALENDAR_DATE_REQUIREMENT と同じ文) */
const DATE_REQUIREMENT = 'YYYY-MM-DD format (an existing calendar date from 0101-01-02 to 9998-12-30)';
/**
 * 利用者向けの API (/api/performance/checkins・/api/meal-plans) の 400 の日本語の文 (#1917。手で書いた期待値。
 * src/lib/api/user-api-error-messages.ts の invalidCalendarDateMessage と同じ文)
 */
const DATE_REQUIREMENT_JA = 'YYYY-MM-DD の形の、0101-01-02 から 9998-12-30 までの実在する日付';
const DATE_PARAM_LABELS_JA: Record<string, string> = { date: '日付 (date)', startDate: '開始日 (startDate)', endDate: '終了日 (endDate)' };
const invalidDateMessageJa = (label: string) => `${label}は${DATE_REQUIREMENT_JA}で指定してください`;

/** JST 2026-10-14 (水) 0:30。UTC ではまだ 10/13 */
const NOW_JST = '2026-10-13T15:30:00.000Z';
const TODAY_JST = '2026-10-14';

function setup(respond: Responder = () => ({ data: null, error: null })) {
  const { client, queries } = createRecordingSupabase(respond);
  h.getUser = vi.fn(async () => ({ data: { user: { id: USER_ID } }, error: null }));
  h.rpc = vi.fn(async () => ({ data: [], error: null }));
  h.client = { ...client, rpc: h.rpc, auth: { getUser: h.getUser } };
  return queries;
}

function jsonRequest(url: string, method: string, body: unknown): NextRequest {
  return new NextRequest(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

let queries: ReturnType<typeof setup>;

beforeEach(() => {
  vi.clearAllMocks();
  queries = setup();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('1. GET /api/performance/checkins: date / startDate / endDate は実在する日付だけ', () => {
  it.each(INVALID_DATES)('%s は、DB にも RPC (get_7d_checkin_averages) にも触れずに 400', async (date) => {
    for (const query of [`date=${date}`, `date=${date}&averages=true`, `startDate=${date}`, `endDate=${date}`]) {
      const res = await getCheckins(new NextRequest(`http://localhost/api/performance/checkins?${query}`));
      expect(res.status, query).toBe(400);
      const name = query.split('=')[0];
      expect(await res.json(), query).toEqual({ error: invalidDateMessageJa(DATE_PARAM_LABELS_JA[name]) });
    }
    expect(queries).toEqual([]);
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it('実在する日付は、そのまま DB と RPC に渡す', async () => {
    const one = await getCheckins(new NextRequest('http://localhost/api/performance/checkins?date=2028-02-29'));
    expect(one.status).toBe(200);
    expect(argsOf(queriesOf(queries, 'user_performance_checkins')[0], 'eq')).toContainEqual(['checkin_date', '2028-02-29']);

    const avg = await getCheckins(new NextRequest('http://localhost/api/performance/checkins?date=2028-02-29&averages=true'));
    expect(avg.status).toBe(200);
    expect(h.rpc).toHaveBeenCalledWith('get_7d_checkin_averages', { p_user_id: USER_ID, p_date: '2028-02-29' });

    queries = setup(() => ({ data: [] }));
    const range = await getCheckins(
      new NextRequest('http://localhost/api/performance/checkins?startDate=2026-10-01&endDate=2026-10-31'),
    );
    expect(range.status).toBe(200);
    const [rangeQuery] = queriesOf(queries, 'user_performance_checkins');
    expect(argsOf(rangeQuery, 'gte')).toEqual([['checkin_date', '2026-10-01']]);
    expect(argsOf(rangeQuery, 'lte')).toEqual([['checkin_date', '2026-10-31']]);
  });

  it('空欄 (?date=&startDate=&endDate=) は以前どおり「指定なし」(直近 30 日)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(NOW_JST));
    queries = setup(() => ({ data: [] }));
    const res = await getCheckins(new NextRequest('http://localhost/api/performance/checkins?date=&startDate=&endDate='));
    expect(res.status).toBe(200);
    const [query] = queriesOf(queries, 'user_performance_checkins');
    expect(argsOf(query, 'gte')).toEqual([['checkin_date', '2026-09-14']]);
  });
});

describe('1. POST /api/performance/checkins: checkinDate は実在する日付だけ', () => {
  it.each(INVALID_DATES)('checkinDate=%s は、DB に触れずに 400', async (checkinDate) => {
    const res = await postCheckin(
      jsonRequest('http://localhost/api/performance/checkins', 'POST', { checkinDate, sleepHours: 7 }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: invalidDateMessageJa('記録日 (checkinDate)') });
    expect(queries).toEqual([]);
  });

  it('前後に空白のある実在する日付は、空白を除いて保存する', async () => {
    queries = setup(() => ({ data: { user_id: USER_ID, checkin_date: '2028-02-29' }, error: null }));
    const res = await postCheckin(
      jsonRequest('http://localhost/api/performance/checkins', 'POST', { checkinDate: ' 2028-02-29 ', sleepHours: 7 }),
    );
    expect(res.status).toBe(200);
    const [upsert] = queriesOf(queries, 'user_performance_checkins');
    expect(argsOf(upsert, 'upsert')[0][0]).toMatchObject({ user_id: USER_ID, checkin_date: '2028-02-29' });
  });
});

describe('1. /api/performance/analyze: 存在しない日付は、日付でない値と同じく JST の今日に読み替える', () => {
  function respondWithProfile(): Responder {
    return (query) => {
      if (query.table === 'user_profiles') return { data: { weight: 60, nutrition_goal: 'maintain', performance_profile: null } };
      if (query.table === 'nutrition_targets') return { data: { daily_calories: 2000, protein_g: 80, fat_g: 60, carbs_g: 250 } };
      return { data: null };
    };
  }

  it.each(INVALID_DATES)('GET ?date=%s は RPC に今日を渡す (存在しない日付を DB に渡さない)', async (date) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(NOW_JST));
    queries = setup(respondWithProfile());
    const res = await getAnalyze(new NextRequest(`http://localhost/api/performance/analyze?date=${date}`));
    expect(res.status).toBe(200);
    expect((await res.json()).date).toBe(TODAY_JST);
    expect(h.rpc).toHaveBeenCalledWith('get_7d_checkin_averages', { p_user_id: USER_ID, p_date: TODAY_JST });
  });

  it('POST の date も同じ (存在しない日付は今日に読み替えて RPC に渡す)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(NOW_JST));
    queries = setup(respondWithProfile());
    await postAnalyze(jsonRequest('http://localhost/api/performance/analyze', 'POST', { date: '2026-02-30' }));
    expect(h.rpc).toHaveBeenCalledWith('get_7d_checkin_averages', { p_user_id: USER_ID, p_date: TODAY_JST });
  });

  it('実在する日付は、そのまま RPC に渡す', async () => {
    queries = setup(respondWithProfile());
    const res = await getAnalyze(new NextRequest('http://localhost/api/performance/analyze?date=2028-02-29'));
    expect((await res.json()).date).toBe('2028-02-29');
    expect(h.rpc).toHaveBeenCalledWith('get_7d_checkin_averages', { p_user_id: USER_ID, p_date: '2028-02-29' });
  });
});

describe('1. GET /api/meal-plans: date / startDate / endDate は実在する日付だけ', () => {
  it.each(INVALID_DATES)('%s は、DB に触れずに 400', async (date) => {
    for (const name of ['date', 'startDate', 'endDate']) {
      const res = await getMealPlans(new Request(`http://localhost/api/meal-plans?${name}=${date}`));
      expect(res.status, name).toBe(400);
      expect(await res.json(), name).toEqual({ error: invalidDateMessageJa(DATE_PARAM_LABELS_JA[name]) });
    }
    expect(queries).toEqual([]);
  });

  it('実在する日付は、そのまま DB に渡す', async () => {
    const res = await getMealPlans(new Request('http://localhost/api/meal-plans?startDate=2028-02-29&endDate=2028-03-06'));
    expect(res.status).toBe(200);
    const [query] = queriesOf(queries, 'user_daily_meals');
    expect(argsOf(query, 'gte')).toEqual([['day_date', '2028-02-29']]);
    expect(argsOf(query, 'lte')).toEqual([['day_date', '2028-03-06']]);
  });
});

describe('1. GET /api/health/records: start_date / end_date は実在する日付だけ', () => {
  it.each(INVALID_DATES)('%s は、DB に触れずに 400', async (date) => {
    for (const name of ['start_date', 'end_date']) {
      const res = await getHealthRecords(new NextRequest(`http://localhost/api/health/records?${name}=${date}`));
      expect(res.status, name).toBe(400);
      expect(await res.json(), name).toEqual({ error: `${name} must be ${DATE_REQUIREMENT}` });
    }
    expect(queries).toEqual([]);
  });

  it('実在する日付は、そのまま DB に渡す。空欄は「指定なし」', async () => {
    const res = await getHealthRecords(
      new NextRequest('http://localhost/api/health/records?start_date=2028-02-29&end_date='),
    );
    expect(res.status).toBe(200);
    const [query] = queriesOf(queries, 'health_records');
    expect(argsOf(query, 'gte')).toEqual([['record_date', '2028-02-29']]);
    expect(argsOf(query, 'lte')).toEqual([]);
  });
});

describe('4. POST /api/health/records: 前後の空白を除いた日付を、upsert・連続記録・プロフィールの体重に使う', () => {
  it('" <今日> " で送っても、upsert と連続記録には空白を除いた日付を渡し、今日の体重をプロフィールに写す', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(NOW_JST));
    queries = setup((query) => (query.table === 'health_records' ? { data: { id: 'record-1' } } : { data: null }));

    const res = await postHealthRecord(
      jsonRequest('http://localhost/api/health/records', 'POST', { record_date: ` ${TODAY_JST} `, weight: 60 }),
    );

    expect(res.status).toBe(200);
    const [upsert] = queriesOf(queries, 'health_records');
    expect(argsOf(upsert, 'upsert')[0][0]).toMatchObject({ user_id: USER_ID, record_date: TODAY_JST, weight: 60 });
    expect(h.updateHealthStreak).toHaveBeenCalledWith(h.client, USER_ID, TODAY_JST);
    const [profile] = queriesOf(queries, 'user_profiles');
    expect(argsOf(profile, 'update')).toEqual([[{ weight: 60 }]]);
  });
});

describe.each([
  { name: 'POST /api/ai/menu/v4/generate', post: postV4Generate },
  { name: 'POST /api/ai/menu/v5/generate', post: postV5Generate },
])('2. $name: 日付の幅は最大 31 日', ({ post }) => {
  function generateRequest(dates: string[]) {
    return new Request('http://localhost/api/ai/menu/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetSlots: dates.map((date) => ({ date, mealType: 'dinner' })) }),
    });
  }

  it.each([
    ['開始日 + 31 日 (32 日間)', ['2026-10-01', '2026-11-01']],
    ['年をまたいで 32 日間', ['2026-12-15', '2027-01-15']],
    ['遠く離れた 2 日 (数千年)', ['0101-01-02', '9998-12-30']],
    ['並び順によらない (遅い日が先)', ['2026-11-01', '2026-10-15', '2026-10-01']],
  ])('%s は、DB・認証に触れる前に 400', async (_label, dates) => {
    const res = await post(generateRequest(dates));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'targetSlots dates must span at most 31 days (from the earliest date to the latest date, inclusive)',
    });
    expect(h.getUser).not.toHaveBeenCalled();
    expect(queries).toEqual([]);
  });

  it.each([
    ['開始日 + 30 日 (31 日間・上限ちょうど)', ['2026-10-01', '2026-10-31']],
    ['うるう年の 2 月をまたぐ 31 日間', ['2028-02-10', '2028-03-11']],
    ['1 日だけ', ['2026-10-01']],
  ])('%s は、日付の幅の確認を通る (次の認証へ進む)', async (_label, dates) => {
    h.getUser.mockResolvedValue({ data: { user: null }, error: null });
    const res = await post(generateRequest(dates));
    // 日付の確認を通ったので認証まで進み、未ログインの 401 になる
    expect(res.status).toBe(401);
    expect(h.getUser).toHaveBeenCalledTimes(1);
  });

  it('slot の数の上限 (93 = 31 日 × 3 食) の文は以前のまま', async () => {
    const dates = Array.from({ length: 94 }, (_, i) => `2026-10-${String((i % 31) + 1).padStart(2, '0')}`);
    const res = await post(
      new Request('http://localhost/api/ai/menu/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetSlots: dates.map((date, i) => ({ date, mealType: ['breakfast', 'lunch', 'dinner', 'snack'][i % 4] })) }),
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'targetSlots exceeds maximum of 93 (31 days × 3 meals)' });
  });
});
