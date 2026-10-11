// @vitest-environment node
//
// 書き換えた写し (一時ディレクトリのファイル) を import するので node 環境で動かす
/**
 * #1177 (T26) / #1149 (T40) AI 相談のアクション (src/lib/ai/consultation-action-executor.ts) の AI 利用回数の上限の判定と記録
 *
 * 実行の API (execute) と会話の中での自動実行 (messages) は、AI を使うアクションの記録をこのライブラリに任せる
 * (tests/helpers/ai-consent-enforced-paths.ts の LIBRARY_RECORDERS)。ここでは実際に runConsultationAction を動かし、
 * 呼ばれた順番で次を確かめる (ソースの文字ではなく、呼ばれた順で見る)。
 *
 *   1. 献立の生成 3 種 (generate_day_menu / generate_week_menu / generate_single_meal): menu_generation を 1 回記録し、
 *      それが Edge Function (generate-menu-v4 / v5。AI へ送る) の呼び出しより前。呼び出しには記録済みの印を付ける (二重に記録しない)
 *   2. update_meal が付ける料理画像: 同意済みなら image_generation を 1 回、画像のジョブを積む前に記録する。
 *      未同意・判定の失敗なら記録しない (ジョブを積むかどうかは変えない。止めるのは処理する Edge Function)
 *   3. 回帰 (R3 指摘 5): 記録を Edge Function の呼び出しのあとへ動かした写しでは、1 の順番の検査が落ちる
 *   4. 回帰 (R3 指摘 2): 同意の判定の結果を見ずに記録する写しでは、2 の「未同意なら記録しない」が落ちる
 *   5. (#1149) 上限に達していたら: 献立の生成は、生成のリクエストの行を作らず・Edge Function を呼ばずに aiDailyLimit を返す
 *      (execute の route が 429 にする)。update_meal の料理画像は、献立の更新はして、画像のジョブだけ積まない
 *   6. (#1149) 生成のリクエストの行を作れなかったときは、数えた 1 回を戻す (AI へは何も送っていない)
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { removeMutants, writeMutant } from './helpers/mutant-module';
import { AI_USAGE_ALLOWED, AI_USAGE_DENIED } from './helpers/ai-usage-mock';
import { AI_DAILY_LIMIT_CODE, aiDailyLimitMessage, type AiUsageResult } from '../supabase/functions/_shared/ai-daily-limit';

const m = vi.hoisted(() => ({
  consumeAiUsage: vi.fn(async (_userId: string, _feature: string): Promise<AiUsageResult> => ({
    allowed: true,
    metered: true,
    usageDate: '2026-10-11',
    limit: 10,
    used: 1,
  })),
  refundAiUsage: vi.fn(async () => undefined),
  aiUsageRecordedHeaders: vi.fn(async (_userId: string) => ({ 'x-hg-ai-usage-recorded': 'test-marker' })),
  checkUserAiConsent: vi.fn(async (_db: unknown, _userId: string) => ({ allowed: true }) as { allowed: boolean; reason?: string }),
  enqueueMealImageJobs: vi.fn(async () => undefined),
}));

vi.mock('@/lib/plan/entitlements', () => ({
  consumeAiUsage: m.consumeAiUsage,
  refundAiUsage: m.refundAiUsage,
  aiUsageRecordedHeaders: m.aiUsageRecordedHeaders,
}));
vi.mock('@/lib/ai/consent-guard', () => ({ checkUserAiConsent: m.checkUserAiConsent }));
// AI のキューへは service role のクライアント (getAiQueueWriter) で書く (#1465)。利用者のクライアントとは別の作り物にする
const queue = vi.hoisted(() => ({ db: null as unknown, proxy: null as unknown }));
vi.mock('@/lib/ai/ai-queue-writer', () => ({ getAiQueueWriter: () => queue.db }));
// 献立のエンジンは v4 (menu_generation_v5_wrapped は OFF)
vi.mock('@/lib/feature-flags', () => ({ isFeatureEnabled: vi.fn(async (key: string) => key === 'ai_chat_enabled') }));
vi.mock('@/lib/generate-menu-v4-retry', () => ({
  // 本物と同じく、渡された invoke を呼ぶ (Edge Function への呼び出しの順番を確かめるため)
  invokeGenerateMenuV4WithRetry: vi.fn(async ({ invoke }: { invoke: () => Promise<unknown> }) => {
    await invoke();
    return { ok: true };
  }),
  markWeeklyMenuRequestFailed: vi.fn(),
}));
vi.mock('@/lib/meal-image-jobs', () => ({
  buildDishImagePayload: vi.fn(async ({ nextDishes }: { nextDishes?: unknown[] }) => ({
    dishes: nextDishes ?? [],
    jobs: [{ dishIndex: 0, subjectHash: 'h', prompt: 'p', model: 'm', referenceImageUrls: [] }],
    mealCoverImageUrl: null,
  })),
  cancelPendingMealImageJobs: vi.fn(),
  enqueueMealImageJobs: m.enqueueMealImageJobs,
  triggerMealImageJobProcessing: vi.fn(async () => undefined),
}));
vi.mock('@/lib/v4-target-slots', () => ({
  resolveExistingTargetSlots: vi.fn(async ({ targetSlots }: { targetSlots: Array<Record<string, unknown>> }) => targetSlots),
}));
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: vi.fn(async () => ({ success: true })) }));
vi.mock('@/lib/db-logger', () => ({ createLogger: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn() }) }));
vi.mock('@/lib/health-streaks', () => ({ updateHealthStreak: vi.fn() }));

import { runConsultationAction } from '@/lib/ai/consultation-action-executor';

type Run = typeof runConsultationAction;
const USER = { id: 'user-1' };
const MEAL_ID = 'meal-1';

/** Supabase の作り物。どのメソッドを繋いでも同じ作り物を返し、single / maybeSingle で表ごとの行を返す */
function makeSupabase() {
  const invoke = vi.fn(async (_name: string, _options: { headers?: Record<string, string> }) => ({ data: {}, error: null }));
  const rowOf = (table: string) => {
    if (table === 'weekly_menu_requests') return { id: 'request-1' };
    if (table === 'user_profiles') return { family_size: 2 };
    if (table === 'planned_meals') return { id: MEAL_ID, dish_name: '肉じゃが', dishes: [{ name: '肉じゃが' }], image_url: null };
    return null;
  };
  const from = (table: string) => {
    const builder: unknown = new Proxy(
      {},
      {
        get(_t, prop) {
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

const MENU_ACTIONS: Array<{ type: string; params: Record<string, unknown> }> = [
  { type: 'generate_day_menu', params: { date: '2026-10-10' } },
  { type: 'generate_week_menu', params: { startDate: '2026-10-10', ultimateMode: true } },
  { type: 'generate_single_meal', params: { date: '2026-10-10', mealType: 'dinner' } },
];

function action(type: string, params: Record<string, unknown>) {
  return { id: `action-${type}`, action_type: type, action_params: params, ai_consultation_sessions: { user_id: USER.id } };
}

async function runMenu(run: Run, type: string, params: Record<string, unknown>) {
  const db = makeSupabase();
  const out = await run(db, USER, action(type, params));
  return { db, out };
}

async function runUpdateMeal(run: Run) {
  const db = makeSupabase();
  const out = await run(db, USER, action('update_meal', { mealId: MEAL_ID, updates: { dishes: [{ name: '筑前煮' }] } }));
  return { db, out };
}

beforeEach(() => {
  vi.clearAllMocks();
  m.consumeAiUsage.mockResolvedValue(AI_USAGE_ALLOWED);
  m.checkUserAiConsent.mockResolvedValue({ allowed: true });
  queue.db = makeSupabase();
});

afterAll(() => {
  removeMutants();
});

describe('献立の生成のアクション: menu_generation を 1 回、AI へ送る (Edge Function を呼ぶ) より前に記録する', () => {
  it.each(MENU_ACTIONS)('$type', async ({ type, params }) => {
    const { db, out } = await runMenu(runConsultationAction, type, params);
    expect(out.success).toBe(true);
    expect(m.consumeAiUsage).toHaveBeenCalledTimes(1);
    expect(m.consumeAiUsage).toHaveBeenCalledWith(USER.id, 'menu_generation');
    expect(db.functions.invoke).toHaveBeenCalledTimes(1);
    expect(m.consumeAiUsage.mock.invocationCallOrder[0]).toBeLessThan(db.functions.invoke.mock.invocationCallOrder[0]);
    // Edge Function がユーザーの JWT で記録し直さないよう、記録済みの印を付ける
    expect(db.functions.invoke.mock.calls[0][1].headers).toEqual({ 'x-hg-ai-usage-recorded': 'test-marker' });
  });
});

describe('update_meal の料理画像: 同意の判定 → 記録 → 画像のジョブを積む', () => {
  it('同意済み: image_generation を 1 回、同意の判定のあと・ジョブを積む前に記録する', async () => {
    const { out } = await runUpdateMeal(runConsultationAction);
    expect(out.success).toBe(true);
    expect(m.consumeAiUsage).toHaveBeenCalledTimes(1);
    expect(m.consumeAiUsage).toHaveBeenCalledWith(USER.id, 'image_generation');
    expect(m.checkUserAiConsent.mock.invocationCallOrder[0]).toBeLessThan(m.consumeAiUsage.mock.invocationCallOrder[0]);
    expect(m.consumeAiUsage.mock.invocationCallOrder[0]).toBeLessThan(m.enqueueMealImageJobs.mock.invocationCallOrder[0]);
    // ジョブは service role のクライアントで積む (利用者のクライアントでは権限で拒まれる。#1465)
    expect((m.enqueueMealImageJobs.mock.calls[0] as unknown as [{ supabase: unknown }])[0].supabase).toBe(queue.db);
  });

  it.each([
    ['未同意', { allowed: false, reason: 'not_consented' }],
    ['同意の判定に失敗', { allowed: false, reason: 'check_failed' }],
  ])('%s: 記録しない。ジョブは積む (AI へ送らずに止めるのは、ジョブを処理する Edge Function)', async (_label, decision) => {
    m.checkUserAiConsent.mockResolvedValue(decision);
    const { out } = await runUpdateMeal(runConsultationAction);
    expect(out.success).toBe(true);
    expect(m.consumeAiUsage).not.toHaveBeenCalled();
    expect(m.enqueueMealImageJobs).toHaveBeenCalledTimes(1);
  });
});

describe('(#1149) 上限に達していたら', () => {
  it.each(MENU_ACTIONS)('$type: リクエストの行を作らず、Edge Function を呼ばず、aiDailyLimit と人向けの文の結果を返す', async ({ type, params }) => {
    m.consumeAiUsage.mockResolvedValue(AI_USAGE_DENIED);
    const insert = vi.fn();
    queue.db = { ...makeSupabase(), from: (table: string) => (table === 'weekly_menu_requests' ? (insert(table), makeSupabase().from(table)) : makeSupabase().from(table)) };

    const { db, out } = await runMenu(runConsultationAction, type, params);

    expect(out.success).toBe(false);
    expect(out.aiDailyLimit).toEqual(AI_USAGE_DENIED);
    expect(out.result).toEqual({ error: aiDailyLimitMessage(AI_USAGE_DENIED.limit), code: AI_DAILY_LIMIT_CODE });
    expect(insert).not.toHaveBeenCalled();
    expect(db.functions.invoke).not.toHaveBeenCalled();
    expect(m.refundAiUsage).not.toHaveBeenCalled();
  });

  it('update_meal: 献立は更新し (success)、画像のジョブだけ積まない。結果の aiSkipped で知らせる (レート制限の印は付けない)', async () => {
    m.consumeAiUsage.mockResolvedValue(AI_USAGE_DENIED);

    const { out } = await runUpdateMeal(runConsultationAction);

    expect(out.success).toBe(true);
    expect(out.aiDailyLimit).toBeUndefined();
    expect(m.consumeAiUsage).toHaveBeenCalledWith(USER.id, 'image_generation');
    expect(m.enqueueMealImageJobs).not.toHaveBeenCalled();
    expect(out.result).toMatchObject({ updated: true, aiSkipped: AI_DAILY_LIMIT_CODE });
    expect(out.result).not.toHaveProperty('imageGenerationThrottled');
  });
});

describe('(#1149) 生成のリクエストの行を作れなかったら、数えた 1 回を戻す', () => {
  it.each(MENU_ACTIONS)('$type', async ({ type, params }) => {
    const failing = makeSupabase();
    queue.db = {
      ...failing,
      from: (table: string) =>
        table === 'weekly_menu_requests'
          ? new Proxy({}, { get: (_t, prop) => (prop === 'single' ? async () => ({ data: null, error: { message: 'insert failed' } }) : () => queue.proxy) })
          : failing.from(table),
    };
    queue.proxy = (queue.db as { from: (t: string) => unknown }).from('weekly_menu_requests');

    const { db, out } = await runMenu(runConsultationAction, type, params);

    expect(out.success).toBe(false);
    expect(db.functions.invoke).not.toHaveBeenCalled();
    expect(m.refundAiUsage).toHaveBeenCalledTimes(1);
    expect(m.refundAiUsage).toHaveBeenCalledWith(USER.id, 'menu_generation', AI_USAGE_ALLOWED);
  });
});

describe('回帰: 実際のソースを壊した写しで、上の検査が落ちる', () => {
  it('R3 指摘 5: generate_day_menu の記録を Edge Function の呼び出しのあとへ動かすと、記録より先に AI へ送っている', async () => {
    const mutant = writeMutant('src/lib/ai/consultation-action-executor.ts', (source) => {
      const start = source.indexOf("case 'generate_day_menu': {");
      const end = source.indexOf("case 'generate_week_menu': {");
      const block = source.slice(start, end);
      const moved = block
        .replace("      const aiUsage = await consumeAiUsage(user.id, 'menu_generation');\n", "      const aiUsage = AI_USAGE_PLACEHOLDER;\n")
        .replace(/(\n\s*const invokeResult = await invokeGenerateMenuV4WithRetry\(\{[\s\S]*?\n\s*\}\);\n)/, "$1      await consumeAiUsage(user.id, 'menu_generation');\n");
      if (moved === block) throw new Error('変異が起きていない');
      return (
        source.slice(0, start).replace('let aiDailyLimit: AiUsageDenied | undefined;', "let aiDailyLimit: AiUsageDenied | undefined;\n  const AI_USAGE_PLACEHOLDER = { allowed: true as const, metered: false, usageDate: null, limit: null, used: null };") +
        moved +
        source.slice(end)
      );
    });
    const { runConsultationAction: run } = (await import(/* @vite-ignore */ mutant)) as { runConsultationAction: Run };
    const { db } = await runMenu(run, 'generate_day_menu', { date: '2026-10-10' });
    expect(m.consumeAiUsage).toHaveBeenCalledTimes(1);
    expect(m.consumeAiUsage.mock.invocationCallOrder[0]).toBeGreaterThan(db.functions.invoke.mock.invocationCallOrder[0]);
  });

  it('R3 指摘 2: update_meal で同意の判定の結果を見ずに記録すると、未同意でも記録してしまう', async () => {
    const mutant = writeMutant('src/lib/ai/consultation-action-executor.ts', (source) =>
      source.replace('if (imageConsent.allowed) {', 'if (imageConsent.allowed || true) {'),
    );
    const { runConsultationAction: run } = (await import(/* @vite-ignore */ mutant)) as { runConsultationAction: Run };
    m.checkUserAiConsent.mockResolvedValue({ allowed: false, reason: 'not_consented' });
    await runUpdateMeal(run);
    expect(m.consumeAiUsage).toHaveBeenCalledTimes(1);
  });
});
