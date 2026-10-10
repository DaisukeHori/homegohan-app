// @vitest-environment node
/**
 * #1433: AI 相談のアクション (generate_day_menu / generate_single_meal) の date は、YYYY-MM-DD の実在する日付だけを受け付ける。
 *
 * date は AI が作る値 (信頼できない入力)。以前は「あるか」しか見なかったので、2026/10/10 のような値
 * (DB の date 型は日付として読むが YYYY-MM-DD ではない) がそのまま target_slots と Edge Function の本文に入り、
 * 献立生成 (generate-menu-v4 / v5) の工程 1 が日付を前後にずらすところ (addDays) で RangeError になっていた。
 * generate_week_menu の startDate と同じく、DB にも Edge Function にも触れずに断る。
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

import { runConsultationAction } from '@/lib/ai/consultation-action-executor';
import { resolveExistingTargetSlots } from '@/lib/v4-target-slots';

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

/** 実在しない日付・YYYY-MM-DD ではない日付 */
const INVALID_DATES = ['2026-02-30', '2027-02-29', '2026-13-01', '2026/10/10', '20261010', '2026-10-10T00:00:00Z', 20261010];

const ACTIONS = [
  { actionType: 'generate_day_menu', params: (date: unknown) => ({ date }) },
  { actionType: 'generate_single_meal', params: (date: unknown) => ({ date, mealType: 'lunch' }) },
] as const;

beforeEach(() => {
  vi.clearAllMocks();
});

describe.each(ACTIONS)('$actionType: date は実在する日付だけ (#1433)', ({ actionType, params }) => {
  it.each(INVALID_DATES)('date=%s は、DB にも Edge Function にも触れずに断る', async (date) => {
    const db = makeSupabase();
    const out = await run(db, actionType, params(date));
    expect(out.success).toBe(false);
    expect(out.result).toEqual({ error: 'date must be in YYYY-MM-DD format' });
    expect(resolveExistingTargetSlots).not.toHaveBeenCalled();
    expect(db.from).not.toHaveBeenCalled();
    expect(db.functions.invoke).not.toHaveBeenCalled();
  });

  it('うるう年の 2/29 は受け付け、Edge Function へ渡すスロットにその日付が入る', async () => {
    const db = makeSupabase();
    const out = await run(db, actionType, params('2028-02-29'));
    expect(out.success).toBe(true);
    expect(db.functions.invoke).toHaveBeenCalledTimes(1);
    const body = (db.functions.invoke.mock.calls[0] as unknown[])[1] as { body: { targetSlots: Array<{ date: string }> } };
    const dates = body.body.targetSlots.map((slot) => slot.date);
    expect(dates.length).toBeGreaterThan(0);
    expect(new Set(dates)).toEqual(new Set(['2028-02-29']));
  });
});
