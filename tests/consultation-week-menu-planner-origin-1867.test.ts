// @vitest-environment node
/**
 * #1867 「計画上手」(planner) は、AI で週の献立を初めて作ったときにも付く。AI 相談のアクションの 1 週間分の生成
 * (generate_week_menu。src/lib/ai/consultation-action-executor.ts) も利用者が AI で週の献立を作る経路なので、
 * 生成のリクエストの行を作るときに generated_data へ週の献立の生成の印 (weeklyRequest: true) を書く
 * (行が completed になった時点で DB のトリガー weekly_menu_requests_award_planner がこの印で planner を付ける)。
 * 1 日分 (generate_day_menu)・1 食 (generate_single_meal) の生成には書かない。
 * 実際に runConsultationAction を動かし、キューに書いた行の generated_data で確かめる。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AI_USAGE_ALLOWED } from './helpers/ai-usage-mock';

const m = vi.hoisted(() => ({
  consumeAiUsage: vi.fn(),
  inserts: [] as Array<{ table: string; payload: Record<string, unknown> }>,
}));

vi.mock('@/lib/plan/entitlements', () => ({
  consumeAiUsage: m.consumeAiUsage,
  refundAiUsage: vi.fn(async () => undefined),
  aiUsageRecordedHeaders: vi.fn(async () => ({ 'x-hg-ai-usage-recorded': 'test-marker' })),
}));
vi.mock('@/lib/ai/consent-guard', () => ({ checkUserAiConsent: vi.fn(async () => ({ allowed: true })) }));
const queue = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@/lib/ai/ai-queue-writer', () => ({ getAiQueueWriter: () => queue.db }));
vi.mock('@/lib/feature-flags', () => ({ isFeatureEnabled: vi.fn(async (key: string) => key === 'ai_chat_enabled') }));
vi.mock('@/lib/generate-menu-v4-retry', () => ({
  invokeGenerateMenuV4WithRetry: vi.fn(async ({ invoke }: { invoke: () => Promise<unknown> }) => {
    await invoke();
    return { ok: true };
  }),
  markWeeklyMenuRequestFailed: vi.fn(),
}));
vi.mock('@/lib/v4-target-slots', () => ({
  resolveExistingTargetSlots: vi.fn(async ({ targetSlots }: { targetSlots: Array<Record<string, unknown>> }) => targetSlots),
}));
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: vi.fn(async () => ({ success: true })) }));
vi.mock('@/lib/db-logger', () => ({ createLogger: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn() }) }));
// 献立の生成の 3 つのアクションは使わないが、tests/consultation-action-usage.test.ts と同じく DB に触れる道具は差し替えておく
vi.mock('@/lib/meal-image-jobs', () => ({
  buildDishImagePayload: vi.fn(),
  cancelPendingMealImageJobs: vi.fn(),
  enqueueMealImageJobs: vi.fn(),
  triggerMealImageJobProcessing: vi.fn(),
}));
vi.mock('@/lib/health-streaks', () => ({ updateHealthStreak: vi.fn() }));

const { runConsultationAction } = await import('@/lib/ai/consultation-action-executor');

const USER = { id: 'user-1' };
const START = '2026-10-19';

/** Supabase の作り物。insert の引数を記録し、どのメソッドを繋いでも同じ作り物を返す */
function makeSupabase() {
  const invoke = vi.fn(async () => ({ data: {}, error: null }));
  const rowOf = (table: string) => {
    if (table === 'weekly_menu_requests') return { id: 'request-1' };
    if (table === 'user_profiles') return { family_size: 2 };
    return null;
  };
  const from = (table: string) => {
    const builder: unknown = new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === 'insert') {
            return (payload: Record<string, unknown>) => {
              m.inserts.push({ table, payload });
              return builder;
            };
          }
          if (prop === 'single' || prop === 'maybeSingle') return async () => ({ data: rowOf(table), error: null });
          if (prop === 'then') return (res: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(res);
          return () => builder;
        },
      },
    );
    return builder;
  };
  return { from, functions: { invoke } };
}

function action(type: string, params: Record<string, unknown>) {
  return { id: `action-${type}`, action_type: type, action_params: params, ai_consultation_sessions: { user_id: USER.id } };
}

/** アクションを動かし、キュー (weekly_menu_requests) に書いた行の generated_data を返す */
async function queuedGeneratedData(type: string, params: Record<string, unknown>) {
  await runConsultationAction(makeSupabase() as never, USER as never, action(type, params) as never);
  const rows = m.inserts.filter((w) => w.table === 'weekly_menu_requests');
  expect(rows).toHaveLength(1);
  return rows[0].payload.generated_data as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  m.inserts.length = 0;
  m.consumeAiUsage.mockResolvedValue(AI_USAGE_ALLOWED);
  queue.db = makeSupabase();
});

describe('AI 相談のアクション: 1 週間分の生成の行にだけ週の献立の生成の印を書く (#1867)', () => {
  it('generate_week_menu (7 日 × 朝昼夕): 印 (weeklyRequest: true) と究極モードの印を書く', async () => {
    expect(await queuedGeneratedData('generate_week_menu', { startDate: START })).toEqual({ ultimateMode: false, weeklyRequest: true });
  });

  it('generate_week_menu を究極モードで: 印を書き、究極モードの印は true', async () => {
    expect(await queuedGeneratedData('generate_week_menu', { startDate: START, ultimateMode: true })).toEqual({
      ultimateMode: true,
      weeklyRequest: true,
    });
  });

  it.each([
    ['generate_day_menu (1 日分)', 'generate_day_menu', { date: START }],
    ['generate_single_meal (1 食)', 'generate_single_meal', { date: START, mealType: 'dinner' }],
  ])('%s: 印を書かない (究極モードの印だけ)', async (_label, type, params) => {
    expect(await queuedGeneratedData(type, params)).toEqual({ ultimateMode: false });
  });
});
