// @vitest-environment node
/**
 * #2206 G4 料理を保存する 4 つの route は、料理画像の積み込みが投げたとき、印を書いた後の料理を応答に返す
 *
 * 問題 (直す前):
 *   積み込みの例外のとき、enqueueMealImageJobsAfterSave (#2201 U4) は DB の料理を 'failed' + 'enqueue_failed' に書き直すが、
 *   route の応答 (meal / data) は書き直す前の行 ('pending') のままだった。画面は次の読み込みまで「料理画像を生成中です」を出した
 *   (AI 相談の update_meal の updatedMeal も同じ)。
 *
 * 直したあと (このテストが固定する):
 *   - enqueueMealImageJobsAfterSave は積み込みの例外のとき、印を書いた後の献立の料理と updated_at を読み直して返す (mealAfterMark)
 *   - 4 つの route は、それを応答の行に重ねる (withMealAfterEnqueueThrew)。積めたときは保存した行のまま
 */
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AI_USAGE_ALLOWED } from './helpers/ai-usage-mock';

const h = vi.hoisted(() => ({
  buildDishImagePayload: vi.fn(),
  enqueueMealImageJobs: vi.fn(),
  triggerMealImageJobProcessing: vi.fn(),
  refundAiUsage: vi.fn(async () => undefined),
  client: null as null | Record<string, unknown>,
  logWarn: vi.fn(),
}));

vi.mock('@/lib/meal-image-jobs', () => ({
  buildDishImagePayload: h.buildDishImagePayload,
  cancelPendingMealImageJobs: vi.fn(),
  enqueueMealImageJobs: h.enqueueMealImageJobs,
  triggerMealImageJobProcessing: h.triggerMealImageJobProcessing,
}));
vi.mock('@/lib/ai/ai-queue-writer', () => ({ getAiQueueWriter: () => ({ from: vi.fn() }) }));
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(async () => ({ success: true, limit: 1, remaining: 0, reset: 0 })),
  rateLimitExceededResponse: vi.fn(),
}));
vi.mock('@/lib/ai/consent-guard', () => ({ checkUserAiConsent: vi.fn(async () => ({ allowed: true })) }));
vi.mock('@/lib/plan/entitlements', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/plan/entitlements')>()),
  consumeAiUsage: vi.fn(async () => AI_USAGE_ALLOWED),
  refundAiUsage: h.refundAiUsage,
}));
vi.mock('@/lib/db-logger', () => {
  const logger: Record<string, unknown> = { warn: h.logWarn, info: vi.fn(), error: vi.fn() };
  logger.withUser = () => logger;
  return { createLogger: () => logger, generateRequestId: () => 'request-1' };
});
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ ...h.client, auth: { getUser: async () => ({ data: { user: { id: USER_ID } }, error: null }) } }),
  getSupabaseAdmin: () => {
    throw new Error('service role のクライアントは、この検査では使わない');
  },
}));

import {
  MEAL_AFTER_ENQUEUE_THREW_COLUMNS,
  enqueueMealImageJobsAfterSave,
  withMealAfterEnqueueThrew,
} from '@/lib/meal-image-enqueue-after-save';
import { MEAL_IMAGE_ENQUEUE_FAILED_ERROR, type MealImageJobSeed } from '@/lib/meal-image';
import { createRecordingSupabase, firstMethodOf, type RecordedQuery } from './helpers/recording-supabase';
import { ROOT, stripComments } from './helpers/ai-reach';
import { POST as mealsPost } from '@/app/api/meals/route';
import { PATCH as mealsPatch } from '@/app/api/meals/[id]/route';
import { POST as mealPlansPost } from '@/app/api/meal-plans/meals/route';
import { PATCH as mealPlansPatch } from '@/app/api/meal-plans/meals/[id]/route';

const USER_ID = 'user-1';
/** route は UUID の形でない id を 404 にする (#1917) ので UUID の形にする */
const MEAL_ID = '77777777-7777-4777-8777-777777777206';
const DAILY_MEAL_ID = 'daily-1';
const SUBJECT_HASH = 'hash-1';
/** 献立の updated_at の基点 (書くたびに 1 秒進める。planned_meals の更新のトリガーと同じく、書くたびに変わる) */
const UPDATED_AT_BASE_MS = Date.UTC(2026, 10, 4);
const UPDATED_AT_STEP_MS = 1000;
const JOB: MealImageJobSeed = {
  dishIndex: 0,
  dishName: '筑前煮',
  subjectHash: SUBJECT_HASH,
  prompt: 'prompt',
  model: 'model',
  triggerSource: 'test',
  referenceImageUrls: [],
};
/** 画像を待つ料理 (ジョブ JOB の料理) */
const PENDING_DISH = { name: '筑前煮', role: 'main', image_source: 'generated_ai', image_status: 'pending', image_subject_hash: SUBJECT_HASH, image_url: null };

/** planned_meals の 1 行をまねる (insert / update は値を重ねて updated_at を進め、select は今の行を返す) */
function useMealTable(initial: Record<string, unknown> | null) {
  let meal: Record<string, unknown> | null = initial ? { ...initial } : null;
  let writes = 0;
  const nextUpdatedAt = () => {
    writes += 1;
    return new Date(UPDATED_AT_BASE_MS + writes * UPDATED_AT_STEP_MS).toISOString();
  };
  const db = createRecordingSupabase((query: RecordedQuery) => {
    if (query.table !== 'planned_meals') return { data: { id: DAILY_MEAL_ID } };
    const first = firstMethodOf(query);
    const returnsOne = query.calls.some((call) => call.method === 'single' || call.method === 'maybeSingle');
    if (first === 'insert') {
      meal = { id: MEAL_ID, ...(query.calls[0].args[0] as Record<string, unknown>), updated_at: nextUpdatedAt() };
      return { data: { ...meal } };
    }
    if (first === 'update') {
      if (!meal) return { data: returnsOne ? null : [] };
      const current = meal;
      const conditions = query.calls.filter((call) => call.method === 'eq').map((call) => call.args);
      if (!conditions.every(([column, value]) => current[String(column)] === value)) return { data: returnsOne ? null : [] };
      meal = { ...current, ...(query.calls[0].args[0] as Record<string, unknown>), updated_at: nextUpdatedAt() };
      return { data: returnsOne ? { ...meal } : [{ id: MEAL_ID }] };
    }
    return { data: meal ? { ...meal, user_daily_meals: { user_id: USER_ID } } : null };
  });
  h.client = db.client;
  return { db, current: () => meal };
}

const EXISTING_MEAL = {
  id: MEAL_ID,
  mode: 'cook',
  catalog_product_id: null,
  source_type: 'manual',
  generation_metadata: null,
  dishes: [{ name: '前の料理' }],
  image_url: null,
  updated_at: new Date(UPDATED_AT_BASE_MS).toISOString(),
};

const jsonRequest = (method: 'POST' | 'PATCH', url: string, body: Record<string, unknown>) =>
  new Request(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

/** 印を書いた後の料理 (見送りの状態) */
function expectEnqueueFailedDish(dish: unknown) {
  expect(dish).toMatchObject({ image_status: 'failed', image_error: MEAL_IMAGE_ENQUEUE_FAILED_ERROR, image_subject_hash: SUBJECT_HASH });
}

beforeEach(() => {
  vi.clearAllMocks();
  h.buildDishImagePayload.mockResolvedValue({ dishes: [PENDING_DISH], jobs: [JOB], mealCoverImageUrl: null });
  h.enqueueMealImageJobs.mockRejectedValue(new Error('enqueue failed'));
  h.triggerMealImageJobProcessing.mockResolvedValue(undefined);
});

describe('積み込みの例外のとき、4 つの route は印を書いた後の料理を応答に返す (#2206 G4)', () => {
  it('POST /api/meals', async () => {
    const table = useMealTable(null);

    const res = await mealsPost(
      jsonRequest('POST', 'http://localhost/api/meals', { date: '2026-11-04', mealType: 'dinner', dishName: '筑前煮', dishes: [{ name: '筑前煮' }] }),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expectEnqueueFailedDish(body.meal.dishes[0]);
    expect(body.meal.dishes).toEqual(table.current()?.dishes);
    expect(body.meal.updated_at).toBe(table.current()?.updated_at);
  });

  it('PATCH /api/meals/[id]', async () => {
    const table = useMealTable(EXISTING_MEAL);

    const res = await mealsPatch(jsonRequest('PATCH', `http://localhost/api/meals/${MEAL_ID}`, { dishes: [{ name: '筑前煮' }] }), {
      params: Promise.resolve({ id: MEAL_ID }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expectEnqueueFailedDish(body.dishes[0]);
    expect(body.dishes).toEqual(table.current()?.dishes);
    expect(body.updated_at).toBe(table.current()?.updated_at);
  });

  it('POST /api/meal-plans/meals', async () => {
    const table = useMealTable(null);

    const res = await mealPlansPost(
      jsonRequest('POST', 'http://localhost/api/meal-plans/meals', { dayDate: '2026-11-04', mealType: 'dinner', dishName: '筑前煮', dishes: [{ name: '筑前煮' }] }),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expectEnqueueFailedDish(body.meal.dishes[0]);
    expect(body.meal.dishes).toEqual(table.current()?.dishes);
    expect(body.meal.updatedAt).toBe(table.current()?.updated_at);
  });

  it('PATCH /api/meal-plans/meals/[id]', async () => {
    const table = useMealTable(EXISTING_MEAL);

    const res = await mealPlansPatch(jsonRequest('PATCH', `http://localhost/api/meal-plans/meals/${MEAL_ID}`, { dishes: [{ name: '筑前煮' }] }), {
      params: Promise.resolve({ id: MEAL_ID }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expectEnqueueFailedDish(body.meal.dishes[0]);
    expect(body.meal.dishes).toEqual(table.current()?.dishes);
    expect(body.meal.updated_at).toBe(table.current()?.updated_at);
  });

  it('積めたときは、保存した行のまま返す (読み直さない)', async () => {
    h.enqueueMealImageJobs.mockResolvedValue({ inserted: 1, duplicates: 0, duplicatesProcessing: 0, failed: 0 });
    const table = useMealTable(EXISTING_MEAL);

    const res = await mealsPatch(jsonRequest('PATCH', `http://localhost/api/meals/${MEAL_ID}`, { dishes: [{ name: '筑前煮' }] }), {
      params: Promise.resolve({ id: MEAL_ID }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.dishes).toEqual([PENDING_DISH]);
    // 保存の update と、所有の確認の読み取りだけ (積み込みの例外のあとの読み直しは無い)
    expect(table.db.queries.filter((query) => firstMethodOf(query) === 'select')).toHaveLength(1);
  });
});

describe('enqueueMealImageJobsAfterSave の mealAfterMark と withMealAfterEnqueueThrew (#2206 G4)', () => {
  it('積み込みの例外のあと、印を書いた後の料理と updated_at を読み直して返す', async () => {
    const table = useMealTable({ ...EXISTING_MEAL, dishes: [PENDING_DISH] });

    const outcome = await enqueueMealImageJobsAfterSave({
      userDb: table.db.client as never,
      plannedMealId: MEAL_ID,
      userId: USER_ID,
      triggerSource: 'test',
      jobSeeds: [JOB],
      usage: null,
    });

    expect(outcome.status).toBe('enqueue_threw');
    const mealAfterMark = outcome.status === 'enqueue_threw' ? outcome.mealAfterMark : null;
    expect(mealAfterMark).toEqual({ dishes: table.current()?.dishes, updated_at: table.current()?.updated_at });
    expectEnqueueFailedDish((mealAfterMark?.dishes as unknown[])[0]);
    const reread = table.db.queries.at(-1);
    expect(reread?.calls[0]).toEqual({ method: 'select', args: [MEAL_AFTER_ENQUEUE_THREW_COLUMNS] });
  });

  it('読み直しに失敗したら mealAfterMark は null (応答は保存した行のまま。ログに残す)', async () => {
    let reads = 0;
    const db = createRecordingSupabase((query) => {
      if (firstMethodOf(query) === 'update') return { data: [{ id: MEAL_ID }] };
      reads += 1;
      // 1 回目は印付けの読み取り、2 回目 (読み直し) は失敗させる
      if (reads > 1) return { error: { message: 'db error' } };
      return { data: { ...EXISTING_MEAL, dishes: [PENDING_DISH] } };
    });

    const outcome = await enqueueMealImageJobsAfterSave({
      userDb: db.client as never,
      plannedMealId: MEAL_ID,
      userId: USER_ID,
      triggerSource: 'test',
      jobSeeds: [JOB],
      usage: null,
    });

    expect(outcome).toEqual({ status: 'enqueue_threw', mealAfterMark: null });
    expect(h.logWarn).toHaveBeenCalledWith(
      'Failed to reload the meal after marking dishes whose meal image jobs were not enqueued',
      expect.objectContaining({ planned_meal_id: MEAL_ID }),
    );
  });

  it('withMealAfterEnqueueThrew: 積み込みの例外のときだけ料理を重ね、updated_at は行が持つときだけ重ねる', () => {
    const mealAfterMark = { dishes: [{ name: '印の後' }], updated_at: '2026-11-04T00:00:09.000Z' };
    const threw = { status: 'enqueue_threw' as const, mealAfterMark };
    const fullRow = { id: MEAL_ID, dishes: [PENDING_DISH], updated_at: '2026-11-04T00:00:01.000Z', dish_name: '筑前煮' };
    const partialRow = { id: MEAL_ID, dish_name: '筑前煮', dishes: [PENDING_DISH] };

    expect(withMealAfterEnqueueThrew(fullRow, threw)).toEqual({ ...fullRow, ...mealAfterMark });
    expect(withMealAfterEnqueueThrew(partialRow, threw)).toEqual({ ...partialRow, dishes: mealAfterMark.dishes });
    expect(withMealAfterEnqueueThrew(fullRow, { status: 'enqueue_threw', mealAfterMark: null })).toBe(fullRow);
    expect(
      withMealAfterEnqueueThrew(fullRow, {
        status: 'enqueued',
        enqueued: { inserted: 1, duplicates: 0, duplicatesProcessing: 0, failed: 0 },
        triggered: true,
      }),
    ).toBe(fullRow);
  });
});

describe('積み込みの入口は、結果を応答の行に重ねる (#2206 G4)', () => {
  /** 料理画像のジョブを積む入口 (AI 相談の update_meal と、料理を保存する 4 つの route) */
  const SAVE_ENTRY_FILES = [
    'src/lib/ai/consultation-action-executor.ts',
    'src/app/api/meals/route.ts',
    'src/app/api/meals/[id]/route.ts',
    'src/app/api/meal-plans/meals/route.ts',
    'src/app/api/meal-plans/meals/[id]/route.ts',
  ];

  it.each(SAVE_ENTRY_FILES)('%s', (file) => {
    const code = stripComments(fs.readFileSync(path.join(ROOT, file), 'utf8'));
    const calls = code.match(/\benqueueMealImageJobsAfterSave\(/g) ?? [];
    const overlays = code.match(/\bwithMealAfterEnqueueThrew\([^,]+,\s*enqueueOutcome\)/g) ?? [];
    expect(calls.length).toBeGreaterThan(0);
    // 結果を捨てる呼び出し (await enqueueMealImageJobsAfterSave(...) だけの文) を作らない
    expect(code).not.toMatch(/^\s*await enqueueMealImageJobsAfterSave\(/m);
    expect(overlays).toHaveLength(calls.length);
  });
});
