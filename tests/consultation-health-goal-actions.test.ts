/**
 * #1229 AI 相談の set_health_goal / update_health_goal の入力検証 (回帰テスト)
 *
 * 修正前の set_health_goal は、AI が生成した goalType / targetValue / targetUnit を
 * POST /api/health/goals の検証 (sanitizer) を通さずに health_goals へ直接 INSERT していた。
 * プロンプトには goalType: "weight|body_fat|exercise|etc" と書かれていて、"exercise" や自由な文字列、
 * 0 以下や桁外れの目標値が保存できた。update_health_goal は sanitizer を通していたが、goal_type を渡していなかったため
 * 種類ごとの範囲 (体重 20〜300kg など) では検証できなかった。
 * 修正後は API と同じ検証を通し、targetUnit が省略されたら goalType に合う単位を入れる。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// 目標の処理に関係しない重い依存は差し替える (import 時の副作用を避ける)
vi.mock('@/lib/menu-generation-feature-flags', () => ({ loadFeatureFlags: vi.fn(async () => ({})) }));
vi.mock('@/lib/generate-menu-v4-retry', () => ({
  invokeGenerateMenuV4WithRetry: vi.fn(),
  markWeeklyMenuRequestFailed: vi.fn(),
}));
vi.mock('@/lib/meal-image-jobs', () => ({
  buildDishImagePayload: vi.fn(),
  cancelPendingMealImageJobs: vi.fn(),
  enqueueMealImageJobs: vi.fn(),
  triggerMealImageJobProcessing: vi.fn(),
}));
vi.mock('@/lib/v4-target-slots', () => ({ resolveExistingTargetSlots: vi.fn() }));
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: vi.fn() }));
vi.mock('@/lib/db-logger', () => ({ createLogger: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn() }) }));
vi.mock('@/lib/health-streaks', () => ({ updateHealthStreak: vi.fn() }));

import { runConsultationAction } from '@/lib/ai/consultation-action-executor';

// ── Supabase のモック (health_goals だけ) ─────────────────────────────────────
interface FakeState {
  /** update_health_goal が最初に取得する行 (user_id / goal_type) */
  goalRow: { user_id: string; goal_type: string } | null;
  insertError: { message: string } | null;
  inserts: Array<Record<string, unknown>>;
  updates: Array<Record<string, unknown>>;
}

let state: FakeState;

function makeSupabase() {
  return {
    from(table: string) {
      expect(table).toBe('health_goals');
      let op: 'select' | 'insert' | 'update' = 'select';
      const result = () => {
        if (op === 'select') return { data: state.goalRow, error: null };
        if (op === 'insert') return state.insertError ? { data: null, error: state.insertError } : { data: { id: 'goal-new' }, error: null };
        return { data: null, error: null };
      };
      const builder: Record<string, unknown> = {};
      builder.select = vi.fn(() => builder);
      builder.eq = vi.fn(() => builder);
      builder.insert = vi.fn((payload: Record<string, unknown>) => {
        op = 'insert';
        state.inserts.push(payload);
        return builder;
      });
      builder.update = vi.fn((payload: Record<string, unknown>) => {
        op = 'update';
        state.updates.push(payload);
        return builder;
      });
      builder.single = vi.fn(() => Promise.resolve(result()));
      builder.then = (onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
        Promise.resolve(result()).then(onFulfilled, onRejected);
      return builder;
    },
  };
}

const USER = { id: 'user-1' };

function run(actionType: string, params: Record<string, unknown>) {
  return runConsultationAction(makeSupabase(), USER, {
    id: 'action-1',
    action_type: actionType,
    action_params: params,
    ai_consultation_sessions: { user_id: USER.id },
  });
}

beforeEach(() => {
  state = { goalRow: { user_id: USER.id, goal_type: 'weight' }, insertError: null, inserts: [], updates: [] };
});

describe('set_health_goal (#1229)', () => {
  it('saves a valid goal for the logged-in user, active', async () => {
    const out = await run('set_health_goal', {
      goalType: 'weight',
      targetValue: 60,
      targetUnit: 'kg',
      targetDate: '2026-12-31',
      note: '夏までに',
    });
    expect(out.success).toBe(true);
    expect(out.result).toEqual({ goalId: 'goal-new', created: true });
    expect(state.inserts).toEqual([
      {
        goal_type: 'weight',
        target_value: 60,
        target_unit: 'kg',
        target_date: '2026-12-31',
        note: '夏までに',
        user_id: USER.id,
        status: 'active',
      },
    ]);
  });

  it.each([
    ['weight', 60, 'kg'],
    ['body_fat', 18, '%'],
    ['steps', 8000, '歩'],
    ['sleep_hours', 7, '時間'],
  ])('fills in the unit for %s when the AI omits targetUnit (it is optional in the prompt)', async (goalType, value, unit) => {
    const out = await run('set_health_goal', { goalType, targetValue: value });
    expect(out.success).toBe(true);
    expect(state.inserts[0]).toMatchObject({ goal_type: goalType, target_value: value, target_unit: unit, target_date: null, note: null });
  });

  it('keeps a unit the AI did give, and falls back to description when note is missing', async () => {
    await run('set_health_goal', { goalType: 'weight', targetValue: 60, targetUnit: 'キロ', description: 'メモ' });
    expect(state.inserts[0]).toMatchObject({ target_unit: 'キロ', note: 'メモ' });
  });

  it('accepts a numeric string for targetValue', async () => {
    await run('set_health_goal', { goalType: 'body_fat', targetValue: '18.5', targetUnit: '%' });
    expect(state.inserts[0]).toMatchObject({ target_value: 18.5 });
  });

  it.each([
    ['"exercise" (the old prompt suggested it)', { goalType: 'exercise', targetValue: 3, targetUnit: '回' }],
    ['"etc"', { goalType: 'etc', targetValue: 3, targetUnit: 'x' }],
    ['free text', { goalType: '体重を減らす', targetValue: 60, targetUnit: 'kg' }],
    ['missing goalType', { targetValue: 60, targetUnit: 'kg' }],
    ['negative target', { goalType: 'weight', targetValue: -50, targetUnit: 'kg' }],
    ['zero target', { goalType: 'body_fat', targetValue: 0, targetUnit: '%' }],
    ['weight above 300kg', { goalType: 'weight', targetValue: 500, targetUnit: 'kg' }],
    ['steps above 100000', { goalType: 'steps', targetValue: 1000000, targetUnit: '歩' }],
    ['sleep above 24h', { goalType: 'sleep_hours', targetValue: 30, targetUnit: '時間' }],
    ['non-numeric target', { goalType: 'weight', targetValue: 'ほどほど', targetUnit: 'kg' }],
    ['missing target', { goalType: 'weight', targetUnit: 'kg' }],
    ['malformed date', { goalType: 'weight', targetValue: 60, targetUnit: 'kg', targetDate: '来月' }],
  ])('rejects %s without touching the database', async (_label, params) => {
    const out = await run('set_health_goal', params);
    expect(out.success).toBe(false);
    expect(typeof out.result.error).toBe('string');
    expect(out.result.error.length).toBeGreaterThan(0);
    expect(state.inserts).toEqual([]);
  });

  it('explains the allowed goal types when the AI picks another one', async () => {
    const out = await run('set_health_goal', { goalType: 'exercise', targetValue: 3 });
    expect(out.result.error).toBe('goal_type は weight, body_fat, steps, step_count, sleep_hours のいずれかを指定してください');
  });

  it('never lets the AI choose user_id or status', async () => {
    await run('set_health_goal', {
      goalType: 'weight',
      targetValue: 60,
      targetUnit: 'kg',
      user_id: 'someone-else',
      userId: 'someone-else',
      status: 'achieved',
      current_value: 1,
    });
    expect(state.inserts).toHaveLength(1);
    expect(state.inserts[0]).toMatchObject({ user_id: USER.id, status: 'active' });
    expect(state.inserts[0]).not.toHaveProperty('current_value');
    expect(state.inserts[0]).not.toHaveProperty('userId');
  });

  it('reports a database failure as an error result', async () => {
    state.insertError = { message: 'boom' };
    const out = await run('set_health_goal', { goalType: 'weight', targetValue: 60, targetUnit: 'kg' });
    expect(out.success).toBe(false);
    expect(out.result).toEqual({ error: 'boom' });
  });
});

describe('update_health_goal (#1229)', () => {
  it('validates against the goal_type of the stored goal', async () => {
    state.goalRow = { user_id: USER.id, goal_type: 'sleep_hours' };
    const bad = await run('update_health_goal', { goalId: 'goal-1', updates: { target_value: 25 } });
    expect(bad.success).toBe(false);
    expect(bad.result.error).toBe('睡眠時間の目標値 (時間) は 24 以下の値を入力してください');
    expect(state.updates).toEqual([]);

    const ok = await run('update_health_goal', { goalId: 'goal-1', updates: { target_value: 7.5, current_value: 0 } });
    expect(ok.success).toBe(true);
    expect(ok.result).toEqual({ goalId: 'goal-1', updated: true });
    expect(state.updates).toEqual([{ target_value: 7.5, current_value: 0 }]);
  });

  it.each([
    ['weight', { target_value: -50 }],
    ['weight', { target_value: 500 }],
    ['weight', { current_value: -1 }],
    ['weight', { current_value: 0 }],
    ['steps', { target_value: 0 }],
    ['exercise', { target_value: -3 }], // 種類を決める前に作られた既存データでも、符号は守る
  ])('%s goal rejects %j', async (goalType, updates) => {
    state.goalRow = { user_id: USER.id, goal_type: goalType };
    const out = await run('update_health_goal', { goalId: 'goal-1', updates });
    expect(out.success).toBe(false);
    expect(typeof out.result.error).toBe('string');
    expect(state.updates).toEqual([]);
  });

  it('rejects null for the NOT NULL columns before reaching the database', async () => {
    for (const updates of [{ target_value: null }, { target_unit: null }]) {
      const out = await run('update_health_goal', { goalId: 'goal-1', updates });
      expect(out.success).toBe(false);
      expect(out.result.error).toBe('target_value と target_unit は空にできません');
    }
    expect(state.updates).toEqual([]);
  });

  it('can still clear current_value, and ignores fields it does not own', async () => {
    const out = await run('update_health_goal', {
      goalId: 'goal-1',
      updates: { current_value: null, status: 'achieved', goal_type: 'steps', user_id: 'x' },
    });
    expect(out.success).toBe(true);
    expect(state.updates).toEqual([{ current_value: null }]);
  });

  it('refuses a goal that belongs to someone else (unchanged)', async () => {
    state.goalRow = { user_id: 'someone-else', goal_type: 'weight' };
    const out = await run('update_health_goal', { goalId: 'goal-1', updates: { target_value: 60 } });
    expect(out.success).toBe(false);
    expect(out.result).toEqual({ error: '権限がありません' });
    expect(state.updates).toEqual([]);
  });
});
