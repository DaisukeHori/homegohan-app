/**
 * #1229 POST /api/health/goals と PUT /api/health/goals/[id] の入力検証 (route レベルの回帰テスト)
 *
 * 修正前:
 *   - POST は goal_type を trim するだけで何でも通し、target_value は符号も範囲も見なかった
 *     (体重の目標 -50 や goal_type "x y" がそのまま health_goals に入り、体重なら user_profiles.target_weight にもコピーされた)
 *   - PUT は target_value / current_value の符号も範囲も見なかった
 * 修正後: goal_type は受け付ける種類 (weight / body_fat / steps / step_count / sleep_hours) だけ、
 *   値はその種類の範囲だけを通す。現行モバイルが送る step_count / sleep_hours は引き続き作れる。
 * DB 側の検査 (トリガー) は tests/integration/rls/health-goals-constraints.test.ts で確かめる。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ── Supabase のモック ─────────────────────────────────────────────────────────
// from(table) が返すビルダーは、insert / update の中身を記録し、テーブルと操作ごとに決めた結果を返す。
interface FakeState {
  user: { id: string } | null;
  profile: Record<string, unknown> | null;
  existing: Record<string, unknown> | null;
  insertError: { message: string } | null;
  inserts: Array<{ table: string; payload: Record<string, unknown> }>;
  updates: Array<{ table: string; payload: Record<string, unknown> }>;
  fromCalls: string[];
}

let state: FakeState;

function resolveResult(table: string, op: 'select' | 'insert' | 'update', payload?: Record<string, unknown>) {
  if (table === 'user_profiles') {
    return op === 'select' ? { data: state.profile, error: null } : { data: null, error: null };
  }
  // health_goals
  if (op === 'select') {
    return { data: state.existing, error: state.existing ? null : { message: 'no rows' } };
  }
  if (op === 'insert') {
    return state.insertError
      ? { data: null, error: state.insertError }
      : { data: { id: 'goal-new', ...payload }, error: null };
  }
  return { data: { ...(state.existing ?? {}), ...payload }, error: null };
}

function makeBuilder(table: string) {
  let op: 'select' | 'insert' | 'update' = 'select';
  let payload: Record<string, unknown> | undefined;
  const builder: Record<string, unknown> = {};
  builder.select = vi.fn(() => builder);
  builder.eq = vi.fn(() => builder);
  builder.insert = vi.fn((p: Record<string, unknown>) => {
    op = 'insert';
    payload = p;
    state.inserts.push({ table, payload: p });
    return builder;
  });
  builder.update = vi.fn((p: Record<string, unknown>) => {
    op = 'update';
    payload = p;
    state.updates.push({ table, payload: p });
    return builder;
  });
  builder.single = vi.fn(() => Promise.resolve(resolveResult(table, op, payload)));
  // await supabase.from(...).update(...).eq(...) のように single() 無しで待たれる場合
  builder.then = (onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
    Promise.resolve(resolveResult(table, op, payload)).then(onFulfilled, onRejected);
  return builder;
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: state.user }, error: null }) },
    from: (table: string) => {
      state.fromCalls.push(table);
      return makeBuilder(table);
    },
  }),
}));

// 構造化ログ (#1172): DB エラーのとき internalError() が app_logs へ記録する。このテストでは DB へ書かない
vi.mock('@/lib/db-logger', () => {
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return {
    createLogger: vi.fn(() => ({ ...logger, withUser: vi.fn(() => logger) })),
    generateRequestId: vi.fn(() => 'req_test'),
  };
});

import { POST } from '@/app/api/health/goals/route';
import { PUT } from '@/app/api/health/goals/[id]/route';

function jsonRequest(method: string, body: unknown): never {
  return new Request('http://localhost/api/health/goals', {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  }) as never;
}

const ctx = { params: Promise.resolve({ id: 'goal-1' }) };

beforeEach(() => {
  state = {
    user: { id: 'user-1' },
    profile: { weight: 70, body_fat_percentage: 25 },
    existing: null,
    insertError: null,
    inserts: [],
    updates: [],
    fromCalls: [],
  };
});

/** health_goals への INSERT の中身 */
function insertedGoal(): Record<string, unknown> | undefined {
  return state.inserts.find((i) => i.table === 'health_goals')?.payload;
}

describe('POST /api/health/goals (#1229)', () => {
  it('creates a weight goal from the web body, starting from the profile weight, and syncs user_profiles.target_weight', async () => {
    const res = await POST(
      jsonRequest('POST', { goal_type: 'weight', target_value: 60, target_unit: 'kg', target_date: '2026-12-31' }),
    );
    expect(res.status).toBe(200);
    expect(insertedGoal()).toMatchObject({
      user_id: 'user-1',
      goal_type: 'weight',
      target_value: 60,
      target_unit: 'kg',
      target_date: '2026-12-31',
      start_value: 70,
      current_value: 70,
      status: 'active',
    });
    expect(state.updates).toEqual([
      { table: 'user_profiles', payload: { target_weight: 60, target_date: '2026-12-31' } },
    ]);
  });

  it.each([
    ['step_count', 8000, '歩'],
    ['sleep_hours', 7.5, '時間'],
    ['steps', 10000, '歩'],
  ])('still accepts %s (current mobile app / web) with no profile lookup', async (goalType, value, unit) => {
    const res = await POST(
      jsonRequest('POST', { goal_type: goalType, target_value: value, target_unit: unit, target_date: null }),
    );
    expect(res.status).toBe(200);
    expect(insertedGoal()).toMatchObject({
      goal_type: goalType,
      target_value: value,
      target_unit: unit,
      target_date: null,
      start_value: null,
      current_value: null,
      progress_percentage: 0,
    });
    expect(state.fromCalls).not.toContain('user_profiles');
  });

  it.each([
    ['unknown goal_type "exercise" (the old AI prompt suggested it)', { goal_type: 'exercise', target_value: 3, target_unit: '回' }],
    ['goal_type with spaces', { goal_type: 'x y', target_value: 3, target_unit: 'kg' }],
    ['goal_type in upper case', { goal_type: 'Weight', target_value: 60, target_unit: 'kg' }],
    ['prototype key as goal_type', { goal_type: 'constructor', target_value: 60, target_unit: 'kg' }],
    ['negative weight target (the issue example)', { goal_type: 'weight', target_value: -50, target_unit: 'kg' }],
    ['zero weight target', { goal_type: 'weight', target_value: 0, target_unit: 'kg' }],
    ['weight target above 300kg', { goal_type: 'weight', target_value: 500, target_unit: 'kg' }],
    ['body fat above 70%', { goal_type: 'body_fat', target_value: 80, target_unit: '%' }],
    ['zero steps', { goal_type: 'steps', target_value: 0, target_unit: '歩' }],
    ['steps above 100000', { goal_type: 'step_count', target_value: 100001, target_unit: '歩' }],
    ['sleep above 24h', { goal_type: 'sleep_hours', target_value: 25, target_unit: '時間' }],
    ['numeric overflow for numeric(10,2)', { goal_type: 'weight', target_value: 1e12, target_unit: 'kg' }],
    ['non-numeric target', { goal_type: 'weight', target_value: 'abc', target_unit: 'kg' }],
  ])('400: %s -> nothing is written', async (_label, body) => {
    const res = await POST(jsonRequest('POST', body));
    expect(res.status).toBe(400);
    expect(typeof (await res.json()).error).toBe('string');
    expect(state.inserts).toEqual([]);
    expect(state.updates).toEqual([]);
  });

  it('400 with the legacy message when a required field is missing', async () => {
    const res = await POST(jsonRequest('POST', { goal_type: 'weight', target_value: 60 }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'goal_type, target_value, and target_unit are required' });
  });

  it('tells the user what is wrong with the value (shown in the web modal as-is)', async () => {
    const res = await POST(jsonRequest('POST', { goal_type: 'weight', target_value: 500, target_unit: 'kg' }));
    expect(await res.json()).toEqual({ error: '体重の目標値 (kg) は 300 以下の値を入力してください' });
  });

  it('ignores user_id / status / current_value sent in the body', async () => {
    const res = await POST(
      jsonRequest('POST', {
        goal_type: 'weight',
        target_value: 60,
        target_unit: 'kg',
        user_id: 'attacker',
        status: 'achieved',
        current_value: 55,
        start_value: 99,
      }),
    );
    expect(res.status).toBe(200);
    expect(insertedGoal()).toMatchObject({ user_id: 'user-1', status: 'active', start_value: 70, current_value: 70 });
  });

  it.each([
    ['negative', -5],
    ['zero', 0],
    ['above the weight range', 1000],
    ['missing', undefined],
  ])('does not use an abnormal profile weight (%s) as the start value, so the goal can still be created', async (_label, weight) => {
    state.profile = { weight };
    const res = await POST(jsonRequest('POST', { goal_type: 'weight', target_value: 60, target_unit: 'kg' }));
    expect(res.status).toBe(200);
    expect(insertedGoal()).toMatchObject({ start_value: null, current_value: null, progress_percentage: 0 });
  });

  it('starts a body_fat goal from the profile body fat percentage and syncs target_body_fat', async () => {
    const res = await POST(jsonRequest('POST', { goal_type: 'body_fat', target_value: 18, target_unit: '%' }));
    expect(res.status).toBe(200);
    expect(insertedGoal()).toMatchObject({ goal_type: 'body_fat', start_value: 25, current_value: 25 });
    expect(state.updates).toEqual([
      { table: 'user_profiles', payload: { target_body_fat: 18, target_date: null } },
    ]);
  });

  it('does not touch user_profiles when the database rejects the insert', async () => {
    state.insertError = { message: 'boom' };
    const res = await POST(jsonRequest('POST', { goal_type: 'weight', target_value: 60, target_unit: 'kg' }));
    expect(res.status).toBe(500);
    // #1172: DB の生のエラー文 ('boom') は返さず、汎用メッセージだけを返す
    expect(await res.json()).toEqual({ error: '処理中にエラーが発生しました', code: 'INTERNAL_ERROR' });
    expect(state.updates).toEqual([]);
  });

  it('401 without a session, 400 for a body that is not a JSON object', async () => {
    state.user = null;
    expect((await POST(jsonRequest('POST', { goal_type: 'weight', target_value: 60, target_unit: 'kg' }))).status).toBe(401);
    expect(state.inserts).toEqual([]);

    state.user = { id: 'user-1' };
    expect((await POST(jsonRequest('POST', 'not json'))).status).toBe(400);
    expect((await POST(jsonRequest('POST', 'null'))).status).toBe(400);
  });
});

describe('PUT /api/health/goals/[id] (#1229)', () => {
  function existingGoal(overrides: Record<string, unknown> = {}) {
    return {
      id: 'goal-1',
      user_id: 'user-1',
      goal_type: 'weight',
      target_value: 70,
      target_unit: 'kg',
      start_value: 80,
      current_value: 80,
      progress_percentage: 0,
      milestones: [],
      status: 'active',
      achieved_at: null,
      ...overrides,
    };
  }

  it('updates a goal and recalculates progress / achievement as before the validation was added', async () => {
    state.existing = existingGoal();
    const res = await PUT(jsonRequest('PUT', { current_value: 70 }), ctx);
    expect(res.status).toBe(200);
    expect(state.updates).toHaveLength(1);
    expect(state.updates[0].payload).toMatchObject({
      current_value: 70,
      progress_percentage: 100,
      status: 'achieved',
    });
  });

  it('validates against the goal_type of the stored goal, not anything in the body', async () => {
    state.existing = existingGoal({ goal_type: 'steps', target_unit: '歩', target_value: 8000, start_value: null, current_value: null });
    // 体重の範囲 (20〜300) なら通る値でも、歩数の目標としては有効 (1〜100000)
    expect((await PUT(jsonRequest('PUT', { target_value: 50, goal_type: 'weight' }), ctx)).status).toBe(200);
    expect(state.updates[0].payload).not.toHaveProperty('goal_type');
    // 歩数の範囲外
    state.updates = [];
    expect((await PUT(jsonRequest('PUT', { target_value: 0 }), ctx)).status).toBe(400);
    expect((await PUT(jsonRequest('PUT', { target_value: 100001 }), ctx)).status).toBe(400);
    expect(state.updates).toEqual([]);
  });

  it.each([
    ['weight', { target_value: -50 }],
    ['weight', { target_value: 500 }],
    ['weight', { current_value: -1 }],
    ['weight', { current_value: 0 }],
    ['body_fat', { target_value: 71 }],
    ['sleep_hours', { target_value: 25 }],
    ['sleep_hours', { current_value: -1 }],
    ['step_count', { current_value: 100001 }],
    ['exercise', { target_value: -3 }], // 種類を決める前に作られた既存データでも、符号は守る
    ['exercise', { target_value: 1e12 }],
  ])('400: %s goal rejects %j -> nothing is written', async (goalType, body) => {
    state.existing = existingGoal({ goal_type: goalType });
    const res = await PUT(jsonRequest('PUT', body), ctx);
    expect(res.status).toBe(400);
    expect(state.updates).toEqual([]);
  });

  it.each([
    ['sleep_hours', { current_value: 0 }],
    ['sleep_hours', { current_value: 7.5 }],
    ['step_count', { current_value: 0 }],
    ['steps', { current_value: 12345 }],
    ['weight', { current_value: null }], // 現在値を空に戻すのは可能
    ['exercise', { target_value: 5 }], // 種類が分からない既存データも、正の値なら更新できる
  ])('200: %s goal accepts %j', async (goalType, body) => {
    state.existing = existingGoal({ goal_type: goalType, start_value: null });
    const res = await PUT(jsonRequest('PUT', body), ctx);
    expect(res.status).toBe(200);
    expect(state.updates).toHaveLength(1);
  });

  it('tells the user what is wrong with the value (shown in the web edit modal as-is)', async () => {
    state.existing = existingGoal();
    const res = await PUT(jsonRequest('PUT', { target_value: 500 }), ctx);
    expect(await res.json()).toEqual({ error: '体重の目標値 (kg) は 300 以下の値を入力してください' });
  });

  it('404 for a goal that is not found or not owned, before looking at the body', async () => {
    state.existing = null;
    const res = await PUT(jsonRequest('PUT', { target_value: -50 }), ctx);
    expect(res.status).toBe(404);
    expect(state.updates).toEqual([]);
  });

  it('keeps the existing guards: empty update, null target_value, null target_unit', async () => {
    state.existing = existingGoal();
    const empty = await PUT(jsonRequest('PUT', { status: 'achieved', user_id: 'x' }), ctx);
    expect(empty.status).toBe(400);
    expect(await empty.json()).toEqual({ error: 'No valid goal fields were provided' });

    const nullTarget = await PUT(jsonRequest('PUT', { target_value: null }), ctx);
    expect(nullTarget.status).toBe(400);
    expect(await nullTarget.json()).toEqual({ error: 'target_value cannot be null' });

    const nullUnit = await PUT(jsonRequest('PUT', { target_unit: null }), ctx);
    expect(nullUnit.status).toBe(400);
    expect(await nullUnit.json()).toEqual({ error: 'target_unit cannot be null' });
    expect(state.updates).toEqual([]);
  });

  it('400 for a body that is not a JSON object, 401 without a session', async () => {
    state.existing = existingGoal();
    const notObject = await PUT(jsonRequest('PUT', 'null'), ctx);
    expect(notObject.status).toBe(400);
    expect(await notObject.json()).toEqual({ error: 'Body must be a JSON object' });

    state.user = null;
    expect((await PUT(jsonRequest('PUT', { target_value: 60 }), ctx)).status).toBe(401);
    expect(state.updates).toEqual([]);
  });
});
