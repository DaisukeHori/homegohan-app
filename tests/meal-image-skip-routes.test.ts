// @vitest-environment node
/**
 * #1487 料理画像を付ける 5 つの入口 (POST /api/meals・PATCH /api/meals/[id]・POST /api/meal-plans/meals・
 * PATCH /api/meal-plans/meals/[id]・AI 相談の update_meal) の、見送り・積み直し・数え戻し
 *
 * 料理の画像の組み立て (buildDishImagePayload → reconcileDishImages) とジョブの積み方 (enqueueMealImageJobs) は本物を使い、
 * DB (利用者のクライアント・service role のクライアント)・レート制限・同意の判定・上限の判定と数え戻しだけを作り物にする。
 *
 *   A. 料理画像の安全弁で止められた (consumeAiUsage が不許可): 料理は 'failed' + skipped_ai_limit で保存され ('pending' のまま残らない)、
 *      ジョブを積まない。応答に aiSkipped
 *   B. レート制限で止められた・判定が例外: 'failed' + skipped_rate_limit で保存し、上限を数えない。応答に imageGenerationThrottled
 *   C. 許可: 'pending' で保存してからジョブを積む (行ごとの insert)。数え戻さない
 *   D. ジョブの書き込みに失敗・すべて重複: 数えた 1 回を戻す
 *   E. 献立の保存に失敗: 数えた 1 回を戻し、ジョブを積まない
 *   F. (更新の入口) 前回見送った・失敗した・待ちの同じ料理を保存し直す: ジョブを積み直す。画像のある料理は積まない
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiUsageResult } from '../supabase/functions/_shared/ai-daily-limit';
import { buildDishImageSubjectHash, type MealImageDish } from '../supabase/functions/_shared/meal-image';
import { AI_USAGE_ALLOWED, AI_USAGE_DENIED } from './helpers/ai-usage-mock';

const USER_ID = 'user-1';
const MEAL_ID = 'meal-1';
const DAY_ID = 'day-1';
const CURRY = { name: 'カレー', role: 'main' };

interface DbError {
  code: string;
  message: string;
}
interface Write {
  table: string;
  op: 'insert' | 'update' | 'upsert';
  payload: unknown;
}

const h = vi.hoisted(() => ({
  state: {
    /** 献立 (planned_meals) の今の行 (更新の入口が読む) */
    existingDishes: [] as MealImageDish[],
    /** planned_meals の insert / update の失敗 */
    saveError: null as { code: string; message: string } | null,
    /** meal_image_jobs の insert の結果 */
    queueError: null as { code: string; message: string } | null,
    writes: [] as Array<{ table: string; op: 'insert' | 'update' | 'upsert'; payload: unknown }>,
    queueInserts: [] as Array<Record<string, unknown>>,
  },
  checkRateLimit: vi.fn(),
  checkUserAiConsent: vi.fn(),
  consumeAiUsage: vi.fn(),
  refundAiUsage: vi.fn(async () => undefined),
  trigger: vi.fn(async () => undefined),
}));

/** 利用者のクライアントの作り物。どのメソッドを繋いでも同じものを返し、single / maybeSingle / await で表ごとの結果を返す */
function makeUserDb() {
  const from = (table: string) => {
    let op: Write['op'] | 'select' = 'select';
    let payload: unknown = null;
    const result = (): { data: unknown; error: DbError | null } => {
      if (table === 'user_daily_meals') return { data: { id: DAY_ID }, error: null };
      if (table === 'planned_meals') {
        if (op === 'select') {
          return {
            data: {
              id: MEAL_ID,
              dish_name: 'カレー',
              mode: 'cook',
              catalog_product_id: null,
              generation_metadata: null,
              dishes: h.state.existingDishes,
              image_url: null,
              user_daily_meals: { user_id: USER_ID },
            },
            error: null,
          };
        }
        if (h.state.saveError) return { data: null, error: h.state.saveError };
        return { data: { id: MEAL_ID, daily_meal_id: DAY_ID, ...(payload as Record<string, unknown>) }, error: null };
      }
      return { data: null, error: null };
    };
    const builder: Record<string, unknown> = {};
    const chain = () => builder;
    for (const name of ['select', 'eq', 'in', 'is', 'order', 'limit']) builder[name] = chain;
    for (const name of ['insert', 'update', 'upsert'] as const) {
      builder[name] = (value: unknown) => {
        op = name;
        payload = value;
        h.state.writes.push({ table, op: name, payload: value });
        return builder;
      };
    }
    builder.single = async () => result();
    builder.maybeSingle = async () => result();
    builder.then = (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
      Promise.resolve(result()).then(resolve, reject);
    return builder;
  };
  return { from, auth: { getUser: async () => ({ data: { user: { id: USER_ID } }, error: null }) } };
}

/** service role のクライアントの作り物 (meal_image_jobs への行ごとの insert) */
function makeQueueDb() {
  return {
    from: (table: string) => ({
      insert: async (row: Record<string, unknown>) => {
        if (table !== 'meal_image_jobs') throw new Error(`unexpected queue table ${table}`);
        if (h.state.queueError) return { data: null, error: h.state.queueError };
        h.state.queueInserts.push(row);
        return { data: null, error: null };
      },
      upsert: () => {
        throw new Error('meal_image_jobs は upsert (ON CONFLICT) で積まない (#1487)');
      },
    }),
  };
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => makeUserDb(),
  getSupabaseAdmin: () => makeQueueDb(),
}));
vi.mock('@/lib/ai/ai-queue-writer', () => ({ getAiQueueWriter: () => makeQueueDb() }));
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: h.checkRateLimit, rateLimitExceededResponse: vi.fn() }));
vi.mock('@/lib/ai/consent-guard', () => ({ checkUserAiConsent: h.checkUserAiConsent }));
vi.mock('@/lib/plan/entitlements', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/plan/entitlements')>()),
  consumeAiUsage: h.consumeAiUsage,
  refundAiUsage: h.refundAiUsage,
}));
vi.mock('../lib/meal-image-jobs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/meal-image-jobs')>()),
  triggerMealImageJobProcessing: h.trigger,
}));
vi.mock('@/lib/db-logger', () => {
  const logger = () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn() });
  return { createLogger: () => ({ ...logger(), withUser: () => logger() }) };
});
// AI 相談のアクションの実行部が読むもの (update_meal では使わない)
vi.mock('@/lib/feature-flags', () => ({ isFeatureEnabled: vi.fn(async () => false) }));
vi.mock('@/lib/generate-menu-v4-retry', () => ({ invokeGenerateMenuV4WithRetry: vi.fn(), markWeeklyMenuRequestFailed: vi.fn() }));
vi.mock('@/lib/v4-target-slots', () => ({ resolveExistingTargetSlots: vi.fn() }));
vi.mock('@/lib/health-streaks', () => ({ updateHealthStreak: vi.fn() }));

import { POST as mealsPost } from '../src/app/api/meals/route';
import { PATCH as mealsPatch } from '../src/app/api/meals/[id]/route';
import { POST as mealPlansPost } from '../src/app/api/meal-plans/meals/route';
import { PATCH as mealPlansPatch } from '../src/app/api/meal-plans/meals/[id]/route';
import { runConsultationAction } from '../src/lib/ai/consultation-action-executor';

/** 入口を 1 回動かした結果 (応答の本文 / アクションの結果) */
type Outcome = Record<string, unknown>;

interface Entry {
  name: string;
  /** 前回の料理を読んで更新する入口か (同じ料理の保存し直しを確かめる) */
  updates: boolean;
  run: () => Promise<Outcome>;
}

const json = (url: string, method: string, body: unknown) =>
  new Request(url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

const ENTRIES: Entry[] = [
  {
    name: 'POST /api/meals',
    updates: false,
    run: async () => {
      const res = await mealsPost(json('http://localhost/api/meals', 'POST', { date: '2026-10-11', mealType: 'dinner', dishName: 'カレー', dishes: [CURRY] }));
      return { status: res.status, ...((await res.json()) as Outcome) };
    },
  },
  {
    name: 'POST /api/meal-plans/meals',
    updates: false,
    run: async () => {
      const res = await mealPlansPost(json('http://localhost/api/meal-plans/meals', 'POST', { dayDate: '2026-10-11', mealType: 'dinner', dishName: 'カレー', dishes: [CURRY] }));
      return { status: res.status, ...((await res.json()) as Outcome) };
    },
  },
  {
    name: 'PATCH /api/meals/[id]',
    updates: true,
    run: async () => {
      const res = await mealsPatch(json(`http://localhost/api/meals/${MEAL_ID}`, 'PATCH', { dishes: [CURRY] }), { params: { id: MEAL_ID } });
      return { status: res.status, ...((await res.json()) as Outcome) };
    },
  },
  {
    name: 'PATCH /api/meal-plans/meals/[id]',
    updates: true,
    run: async () => {
      const res = await mealPlansPatch(json(`http://localhost/api/meal-plans/meals/${MEAL_ID}`, 'PATCH', { dishes: [CURRY] }), { params: { id: MEAL_ID } });
      return { status: res.status, ...((await res.json()) as Outcome) };
    },
  },
  {
    name: 'AI 相談の update_meal',
    updates: true,
    run: async () => {
      const db = makeUserDb();
      const out = await runConsultationAction(db as unknown as Parameters<typeof runConsultationAction>[0], { id: USER_ID }, {
        id: 'action-1',
        action_type: 'update_meal',
        action_params: { mealId: MEAL_ID, updates: { dishes: [CURRY] } },
      } as unknown as Parameters<typeof runConsultationAction>[2]);
      return { status: out.success ? 200 : 500, ...((out.result ?? {}) as Outcome) };
    },
  },
];

/** planned_meals に保存した料理 (insert / update の最後の dishes) */
function savedDishes(): MealImageDish[] {
  const saves = h.state.writes.filter((w) => w.table === 'planned_meals' && (w.op === 'insert' || w.op === 'update'));
  const last = saves[saves.length - 1]?.payload as { dishes?: MealImageDish[] } | undefined;
  return last?.dishes ?? [];
}

beforeEach(() => {
  vi.clearAllMocks();
  h.state.existingDishes = [];
  h.state.saveError = null;
  h.state.queueError = null;
  h.state.writes = [];
  h.state.queueInserts = [];
  h.checkRateLimit.mockResolvedValue({ success: true, limit: 1, remaining: 0, reset: 0 });
  h.checkUserAiConsent.mockResolvedValue({ allowed: true });
  h.consumeAiUsage.mockResolvedValue(AI_USAGE_ALLOWED);
});

describe.each(ENTRIES)('#1487 料理画像の見送り・数え戻し: $name', (entry) => {
  it('A. 料理画像の安全弁で止められた: 料理を failed + skipped_ai_limit で保存し (pending を残さない)、ジョブを積まない', async () => {
    const capped: AiUsageResult = { ...AI_USAGE_DENIED, safetyCap: true };
    h.consumeAiUsage.mockResolvedValue(capped);
    const out = await entry.run();

    expect(out.status).toBe(200);
    expect(h.consumeAiUsage).toHaveBeenCalledWith(USER_ID, 'meal_image_auto');
    expect(savedDishes()).toHaveLength(1);
    expect(savedDishes()[0]).toMatchObject({ name: 'カレー', image_status: 'failed', image_error: 'skipped_ai_limit', image_url: null });
    expect(h.state.queueInserts).toEqual([]);
    expect(h.trigger).not.toHaveBeenCalled();
    expect(h.refundAiUsage).not.toHaveBeenCalled();
    expect(out.aiSkipped).toBe('AI_DAILY_LIMIT');
    // 献立の保存は 1 回だけ (保存したあとに料理を書き直す 2 回目の update で直す形ではない。判定は保存の前)
    expect(h.state.writes.filter((w) => w.table === 'planned_meals')).toHaveLength(1);
  });

  it('B. レート制限で止められた: failed + skipped_rate_limit で保存し、上限を数えない', async () => {
    h.checkRateLimit.mockResolvedValue({ success: false, limit: 1, remaining: 0, reset: 0 });
    const out = await entry.run();

    expect(out.status).toBe(200);
    expect(savedDishes()[0]).toMatchObject({ image_status: 'failed', image_error: 'skipped_rate_limit' });
    expect(h.consumeAiUsage).not.toHaveBeenCalled();
    expect(h.state.queueInserts).toEqual([]);
    expect(out.imageGenerationThrottled).toBe(true);
    expect(out.aiSkipped).toBeUndefined();
  });

  it('B. レート制限の判定が例外: failed + skipped_rate_limit で保存し、保存は成功させる', async () => {
    h.checkRateLimit.mockRejectedValue(new Error('upstash unreachable'));
    const out = await entry.run();

    expect(out.status).toBe(200);
    expect(savedDishes()[0]).toMatchObject({ image_status: 'failed', image_error: 'skipped_rate_limit' });
    expect(h.state.queueInserts).toEqual([]);
  });

  it('C. 許可: pending で保存してからジョブを 1 行積む。数え戻さない', async () => {
    const out = await entry.run();

    expect(out.status).toBe(200);
    expect(savedDishes()[0]).toMatchObject({ image_status: 'pending', image_error: null });
    expect(h.state.queueInserts).toHaveLength(1);
    expect(h.state.queueInserts[0]).toMatchObject({ planned_meal_id: MEAL_ID, user_id: USER_ID, dish_index: 0, status: 'pending' });
    expect(h.trigger).toHaveBeenCalledTimes(1);
    expect(h.refundAiUsage).not.toHaveBeenCalled();
  });

  it('C. 同意が無い: 数えずにジョブを積む (処理する Edge Function が止めて failed にする)', async () => {
    h.checkUserAiConsent.mockResolvedValue({ allowed: false, reason: 'not_consented' });
    await entry.run();

    expect(h.consumeAiUsage).not.toHaveBeenCalled();
    expect(savedDishes()[0]).toMatchObject({ image_status: 'pending' });
    expect(h.state.queueInserts).toHaveLength(1);
    expect(h.refundAiUsage).not.toHaveBeenCalled();
  });

  it.each([
    ['書き込みに失敗', { code: '42501', message: 'permission denied for table meal_image_jobs' }],
    ['同じ料理のジョブが待ち・処理中 (重複)', { code: '23505', message: 'duplicate key value' }],
  ])('D. ジョブを 1 行も積めなかった (%s): 数えた 1 回を戻す', async (_label, error) => {
    h.state.queueError = error;
    const out = await entry.run();

    expect(out.status).toBe(200);
    expect(h.state.queueInserts).toEqual([]);
    expect(h.refundAiUsage).toHaveBeenCalledTimes(1);
    expect(h.refundAiUsage).toHaveBeenCalledWith(USER_ID, 'meal_image_auto', AI_USAGE_ALLOWED);
  });

  it('E. 献立の保存に失敗: 数えた 1 回を戻し、ジョブを積まない', async () => {
    h.state.saveError = { code: 'XX000', message: 'boom' };
    const out = await entry.run();

    expect(out.status).toBeGreaterThanOrEqual(500);
    expect(h.state.queueInserts).toEqual([]);
    expect(h.refundAiUsage).toHaveBeenCalledTimes(1);
    expect(h.refundAiUsage).toHaveBeenCalledWith(USER_ID, 'meal_image_auto', AI_USAGE_ALLOWED);
  });

  it('E. 安全弁で止められたあと保存に失敗: 数えていないので戻さない', async () => {
    h.consumeAiUsage.mockResolvedValue(AI_USAGE_DENIED);
    h.state.saveError = { code: 'XX000', message: 'boom' };
    await entry.run();

    expect(h.refundAiUsage).not.toHaveBeenCalled();
  });
});

describe.each(ENTRIES.filter((entry) => entry.updates))('#1487 同じ料理の保存し直し: $name', (entry) => {
  async function previousCurry(overrides: Partial<MealImageDish>): Promise<MealImageDish[]> {
    return [{ ...CURRY, image_subject_hash: await buildDishImageSubjectHash(CURRY, 0), image_source: 'generated_ai', image_url: null, ...overrides }];
  }

  it.each([
    ['見送った (failed + skipped_ai_limit)', { image_status: 'failed' as const, image_error: 'skipped_ai_limit' }],
    ['待ちのまま (pending。前は永久に「生成中」だった)', { image_status: 'pending' as const }],
    ['失敗 (failed)', { image_status: 'failed' as const, image_error: 'storage upload failed' }],
  ])('F. 前回 %s の同じ料理: ジョブを積み直し、pending で保存する', async (_label, overrides) => {
    h.state.existingDishes = await previousCurry(overrides);
    await entry.run();

    expect(h.consumeAiUsage).toHaveBeenCalledWith(USER_ID, 'meal_image_auto');
    expect(savedDishes()[0]).toMatchObject({ image_status: 'pending', image_error: null });
    expect(h.state.queueInserts).toHaveLength(1);
    expect(h.state.queueInserts[0]).toMatchObject({ dish_index: 0, subject_hash: await buildDishImageSubjectHash(CURRY, 0) });
  });

  it('F. 前回画像を作れた (ready) 同じ料理: 積まず、数えない', async () => {
    h.state.existingDishes = await previousCurry({ image_status: 'ready', image_url: 'https://example.com/curry.png' });
    await entry.run();

    expect(h.checkRateLimit).not.toHaveBeenCalled();
    expect(h.consumeAiUsage).not.toHaveBeenCalled();
    expect(h.state.queueInserts).toEqual([]);
    expect(savedDishes()[0]).toMatchObject({ image_status: 'ready', image_url: 'https://example.com/curry.png' });
  });

  it('F. 見送ったあとも安全弁に達したまま: もう一度見送りにして保存する (pending を残さない)', async () => {
    h.state.existingDishes = await previousCurry({ image_status: 'failed', image_error: 'skipped_ai_limit' });
    h.consumeAiUsage.mockResolvedValue(AI_USAGE_DENIED);
    await entry.run();

    expect(savedDishes()[0]).toMatchObject({ image_status: 'failed', image_error: 'skipped_ai_limit' });
    expect(h.state.queueInserts).toEqual([]);
  });
});
