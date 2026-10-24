// @vitest-environment node
/**
 * #1433: AI 相談のアクション (generate_day_menu / generate_single_meal) の date は、YYYY-MM-DD の実在する日付だけを受け付ける。
 *
 * date は AI が作る値 (信頼できない入力)。以前は「あるか」しか見なかったので、2026/10/10 のような値
 * (DB の date 型は日付として読むが YYYY-MM-DD ではない) がそのまま target_slots と Edge Function の本文に入り、
 * 献立生成 (generate-menu-v4 / v5) の工程 1 が日付を前後にずらすところ (addDays) で RangeError になっていた。
 * generate_week_menu の startDate と同じく、DB にも Edge Function にも触れずに断る。
 *
 * 受け付けた日付のリクエストの行 (weekly_menu_requests) は、AI のキューなので service role のクライアント
 * (getAiQueueWriter) で積む (#1465。利用者のクライアントでは権限で拒まれる)。ここでは作り物に替えて、行がそちらに届くことも見る。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/feature-flags', () => ({ isFeatureEnabled: vi.fn(async () => false) }));
vi.mock('@/lib/generate-menu-v4-retry', () => ({
  invokeGenerateMenuV4WithRetry: vi.fn(async ({ invoke }: { invoke: () => Promise<unknown> }) => {
    await invoke();
    return { ok: true };
  }),
  markWeeklyMenuRequestFailed: vi.fn(),
}));
vi.mock('@/lib/meal-image-jobs', () => ({
  buildDishImagePayload: vi.fn(),
  cancelPendingMealImageJobs: vi.fn(),
  enqueueMealImageJobs: vi.fn(),
  triggerMealImageJobProcessing: vi.fn(),
}));
vi.mock('@/lib/v4-target-slots', () => ({
  resolveExistingTargetSlots: vi.fn(async ({ targetSlots }: { targetSlots: unknown[] }) => targetSlots),
}));
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: vi.fn() }));
vi.mock('@/lib/db-logger', () => ({ createLogger: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn() }) }));
vi.mock('@/lib/health-streaks', () => ({ updateHealthStreak: vi.fn() }));
// 献立生成のリクエストの行 (weekly_menu_requests) は service role のクライアント (getAiQueueWriter) で書く (#1465)。
// 利用者のクライアントとは別の作り物にして、INSERT がそちらに届き、利用者のクライアントでは書かないことを見る
const queue = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@/lib/ai/ai-queue-writer', () => ({ getAiQueueWriter: () => queue.db }));

import { runConsultationAction } from '@/lib/ai/consultation-action-executor';
import { updateHealthStreak } from '@/lib/health-streaks';
import { resolveExistingTargetSlots } from '@/lib/v4-target-slots';
import { argsOf, createRecordingSupabase } from './helpers/recording-supabase';

const USER = { id: 'user-1' };

function makeSupabase() {
  const requestInserts: Array<Record<string, unknown>> = [];
  const from = vi.fn((table: string) => {
    const builder: Record<string, unknown> = {};
    builder.insert = vi.fn((payload: Record<string, unknown>) => {
      if (table === 'weekly_menu_requests') requestInserts.push(payload);
      return builder;
    });
    builder.select = vi.fn(() => builder);
    builder.eq = vi.fn(() => builder);
    builder.single = vi.fn(async () => {
      if (table === 'weekly_menu_requests') return { data: { id: 'request-1' }, error: null };
      if (table === 'user_profiles') return { data: { family_size: 2 }, error: null };
      throw new Error(`想定外の表: ${table}`);
    });
    return builder;
  });
  return { from, functions: { invoke: vi.fn(async () => ({ data: {}, error: null })) }, requestInserts };
}

function run(db: ReturnType<typeof makeSupabase>, actionType: string, params: Record<string, unknown>) {
  return runConsultationAction(db, USER, {
    id: 'action-1',
    action_type: actionType,
    action_params: params,
    ai_consultation_sessions: { user_id: USER.id },
  });
}

/**
 * 実在しない日付・YYYY-MM-DD ではない日付と、実在するが受け付ける範囲 (0101-01-02〜9998-12-30) の外の日付
 * (端の日付は、献立生成が前後 7 日の文脈の期間を求めると暦の計算で扱える範囲の外に出る)
 */
const INVALID_DATES = [
  '2026-02-30',
  '2027-02-29',
  '2026-13-01',
  '2026/10/10',
  '20261010',
  '2026-10-10T00:00:00Z',
  20261010,
  '9999-12-31',
  '9998-12-31',
  '0100-01-01',
  '0101-01-01',
];

const ACTIONS = [
  { actionType: 'generate_day_menu', params: (date: unknown) => ({ date }) },
  { actionType: 'generate_single_meal', params: (date: unknown) => ({ date, mealType: 'lunch' }) },
] as const;

/** service role のクライアント (AI のキューへ書く。#1465) */
let queueDb: ReturnType<typeof makeSupabase>;

beforeEach(() => {
  vi.clearAllMocks();
  queueDb = makeSupabase();
  queue.db = queueDb;
});

/** リクエストの行は service role のクライアントで 1 行だけ積み、利用者のクライアントでは書かない (#1465) */
function expectRequestRowOnQueueSide(db: ReturnType<typeof makeSupabase>, startDate: string) {
  expect(db.requestInserts).toEqual([]);
  expect(db.from).not.toHaveBeenCalledWith('weekly_menu_requests');
  expect(queueDb.requestInserts).toHaveLength(1);
  expect(queueDb.requestInserts[0]).toMatchObject({ user_id: USER.id, start_date: startDate, status: 'processing' });
  // 家族の人数 (user_profiles) は利用者のクライアントで読む。service role のクライアントで読まない
  expect(queueDb.from).not.toHaveBeenCalledWith('user_profiles');
}

describe.each(ACTIONS)('$actionType: date は実在する日付だけ (#1433)', ({ actionType, params }) => {
  it.each(INVALID_DATES)('date=%s は、DB (利用者・キューの service role のどちらのクライアントも) にも Edge Function にも触れずに断る', async (date) => {
    const db = makeSupabase();
    const out = await run(db, actionType, params(date));
    expect(out.success).toBe(false);
    expect(out.result).toEqual({ error: '日付はYYYY-MM-DD の形の、0101-01-02 から 9998-12-30 までの実在する日付で指定してください' });
    expect(resolveExistingTargetSlots).not.toHaveBeenCalled();
    expect(db.from).not.toHaveBeenCalled();
    expect(queueDb.from).not.toHaveBeenCalled();
    expect(db.functions.invoke).not.toHaveBeenCalled();
  });

  it('うるう年の 2/29 は受け付け、Edge Function へ渡すスロットにその日付が入る', async () => {
    const db = makeSupabase();
    const out = await run(db, actionType, params('2028-02-29'));
    expect(out.success).toBe(true);
    expectRequestRowOnQueueSide(db, '2028-02-29');
    expect(db.functions.invoke).toHaveBeenCalledTimes(1);
    const body = (db.functions.invoke.mock.calls[0] as unknown[])[1] as { body: { targetSlots: Array<{ date: string }> } };
    const dates = body.body.targetSlots.map((slot) => slot.date);
    expect(dates.length).toBeGreaterThan(0);
    expect(new Set(dates)).toEqual(new Set(['2028-02-29']));
  });
});

describe('generate_week_menu: startDate は実在する日付で、受け付ける範囲 (0101-01-02〜9998-12-30) の中だけ (#1433)', () => {
  it.each(INVALID_DATES)('startDate=%s は、DB (利用者・キューの service role のどちらのクライアントも) にも Edge Function にも触れずに断る', async (startDate) => {
    const db = makeSupabase();
    const out = await run(db, 'generate_week_menu', { startDate });
    expect(out.success).toBe(false);
    expect(out.result).toEqual({ error: '開始日はYYYY-MM-DD の形の、0101-01-02 から 9998-12-30 までの実在する日付で指定してください' });
    expect(resolveExistingTargetSlots).not.toHaveBeenCalled();
    expect(db.from).not.toHaveBeenCalled();
    expect(queueDb.from).not.toHaveBeenCalled();
    expect(db.functions.invoke).not.toHaveBeenCalled();
  });

  it('受け付ける最後の日 (9998-12-30) から始まる週は、年をまたいだ 7 日分のスロットを作る (暦の計算で扱える範囲の中)', async () => {
    const db = makeSupabase();
    const out = await run(db, 'generate_week_menu', { startDate: '9998-12-30' });
    expect(out.success).toBe(true);
    expectRequestRowOnQueueSide(db, '9998-12-30');
    expect(db.functions.invoke).toHaveBeenCalledTimes(1);
    const body = (db.functions.invoke.mock.calls[0] as unknown[])[1] as { body: { targetSlots: Array<{ date: string }> } };
    expect([...new Set(body.body.targetSlots.map((slot) => slot.date))]).toEqual([
      '9998-12-30',
      '9998-12-31',
      '9999-01-01',
      '9999-01-02',
      '9999-01-03',
      '9999-01-04',
      '9999-01-05',
    ]);
  });
});

/**
 * #1482: 健康記録のアクション (add_health_record / update_health_record) の date も、実在する日付だけを受け付ける。
 * 以前は add_health_record が形 (正規表現) だけを見ていて 2026-02-30 が通り、update_health_record は何も見ずに
 * DB の条件 (.eq('record_date', date)) に渡していた。どちらも DB の date 型への変換で失敗する。
 * HTTP の 400 ではなく、ほかのアクションと同じく action の error で断る。
 */
describe.each([
  // add_health_record は、date が文字列でない・空のときは以前から JST の今日として記録する (数値の 20261010 は今日になる) ので、文字列だけを見る
  {
    actionType: 'add_health_record',
    params: (date: unknown) => ({ date, weight: 60 }),
    invalidDates: INVALID_DATES.filter((date) => typeof date === 'string'),
  },
  { actionType: 'update_health_record', params: (date: unknown) => ({ date, updates: { weight: 60 } }), invalidDates: INVALID_DATES },
])('$actionType: date は実在する日付だけ (#1482)', ({ actionType, params, invalidDates }) => {
  it.each(invalidDates)('date=%s は、DB に触れずに action の error で断る', async (date) => {
    const { client, queries } = createRecordingSupabase(() => ({ data: null, error: null }));
    const out = await runConsultationAction(client, USER, {
      id: 'action-1',
      action_type: actionType,
      action_params: params(date),
      ai_consultation_sessions: { user_id: USER.id },
    });
    expect(out.success).toBe(false);
    expect(out.result).toEqual({ error: '日付はYYYY-MM-DD の形の、0101-01-02 から 9998-12-30 までの実在する日付で指定してください' });
    expect(queries).toEqual([]);
    expect(updateHealthStreak).not.toHaveBeenCalled();
  });

  it('前後に空白のある、うるう年の 2/29 は受け付け、空白を除いた日付で DB に書く', async () => {
    const { client, queries } = createRecordingSupabase(() => ({ data: null, error: null }));
    const out = await runConsultationAction(client, USER, {
      id: 'action-1',
      action_type: actionType,
      action_params: params(' 2028-02-29 '),
      ai_consultation_sessions: { user_id: USER.id },
    });
    expect(out.success).toBe(true);
    const [query] = queries.filter((q) => q.table === 'health_records');
    if (actionType === 'add_health_record') {
      expect(argsOf(query, 'upsert')[0][0]).toMatchObject({ user_id: USER.id, record_date: '2028-02-29', weight: 60 });
      expect(updateHealthStreak).toHaveBeenCalledWith(client, USER.id, '2028-02-29');
    } else {
      expect(argsOf(query, 'update')).toEqual([[{ weight: 60 }]]);
      expect(argsOf(query, 'eq')).toEqual([
        ['user_id', USER.id],
        ['record_date', '2028-02-29'],
      ]);
    }
    expect(out.result).toMatchObject({ date: '2028-02-29' });
  });
});

it('update_health_record: date が無いときも DB に触れずに断る (#1482。以前は .eq(record_date, undefined) で DB に問い合わせていた)', async () => {
  const { client, queries } = createRecordingSupabase(() => ({ data: null, error: null }));
  const out = await runConsultationAction(client, USER, {
    id: 'action-1',
    action_type: 'update_health_record',
    action_params: { updates: { weight: 60 } },
    ai_consultation_sessions: { user_id: USER.id },
  });
  expect(out.success).toBe(false);
  expect(out.result).toEqual({ error: '日付はYYYY-MM-DD の形の、0101-01-02 から 9998-12-30 までの実在する日付で指定してください' });
  expect(queries).toEqual([]);
});
