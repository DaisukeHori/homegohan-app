// @vitest-environment node
/**
 * #2227 H4 料理画像の積み込みの例外の縁で、料理の印や応答の行が実際の状態とずれる
 *
 * 問題 (直す前):
 *   1. enqueueMealImageJobs (Next.js の lib/meal-image-jobs.ts・Edge の supabase/functions/_shared/meal-image-jobs.ts) が
 *      行を積んだあとの後始末 (失敗した行のログ・積めなかった料理の印・数え戻し) で投げると、呼び出し側
 *      (enqueueMealImageJobsAfterSave・Edge の enqueueSavedMealImageJobs) は積み込み全体の失敗とみなし、積めた料理や
 *      同じ料理の待ちのジョブがある料理まで 'failed' + 'enqueue_failed' にし、数え戻しも重ねた
 *   2. 積み込みの例外のあと、印の書き込みが error を返すと、読み直した行 ('pending') をそのまま返し、画面は「生成中」に残った
 *      (ジョブが無いので画像はできない)
 *   3. 印の後の読み直しが失敗すると、応答は保存した行 ('pending') のままだった (DB は見送りの状態)
 *
 * 直したあと (このテストが固定する):
 *   1. 行を積み始めたあとの後始末は runMealImageEnqueueAftercare で囲み、投げても結果を返す
 *      (呼び出し側は積めた料理に印を付けず、数え戻しは 1 回だけ)
 *   2. 印の書き込みが失敗したら、読み直した行の料理に見送りの印を重ねて返す (updated_at は DB の値のまま)
 *   3. 読み直しに失敗したら、印を書けた・印の書き込みが失敗したときは、応答の行の料理に見送りの印を重ねる (failuresToOverlay)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AI_USAGE_ALLOWED } from './helpers/ai-usage-mock';

const h = vi.hoisted(() => ({
  queueDb: null as null | Record<string, unknown>,
  queueWriterThrows: false,
  loggerWarnThrows: false,
  refundAiUsage: vi.fn(async () => undefined),
  triggerMealImageJobProcessing: vi.fn(async () => undefined),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

vi.mock('@/lib/meal-image-jobs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/meal-image-jobs')>()),
  triggerMealImageJobProcessing: h.triggerMealImageJobProcessing,
}));
vi.mock('@/lib/plan/entitlements', () => ({ refundAiUsage: h.refundAiUsage }));
vi.mock('@/lib/ai/ai-queue-writer', () => ({
  getAiQueueWriter: () => {
    if (h.queueWriterThrows) throw new Error('missing service role key');
    return h.queueDb;
  },
}));
vi.mock('@/lib/db-logger', () => {
  const logger: Record<string, unknown> = {
    warn: (...args: unknown[]) => {
      h.logWarn(...args);
      if (h.loggerWarnThrows) throw new Error('log sink down');
    },
    info: vi.fn(),
    error: h.logError,
  };
  logger.withUser = () => logger;
  return { createLogger: () => logger };
});

import { enqueueMealImageJobsAfterSave, withMealAfterEnqueueThrew } from '@/lib/meal-image-enqueue-after-save';
import { MEAL_IMAGE_ENQUEUE_FAILED_ERROR, MEAL_IMAGE_JOB_UNIQUE_VIOLATION_CODE, type MealImageJobSeed } from '@/lib/meal-image';
import { enqueueMealImageJobs as enqueueMealImageJobsEdge } from '../supabase/functions/_shared/meal-image-jobs';
import { createRecordingSupabase, firstMethodOf, type QueryOutcome, type RecordedQuery } from './helpers/recording-supabase';

const USER_ID = 'user-1';
const MEAL_ID = 'meal-1';
const SAVED_AT = '2026-11-04T00:00:00.000Z';
/** 権限の失敗 (積めなかった行) */
const PERMISSION_DENIED = { code: '42501', message: 'permission denied' };
/** DB の失敗 */
const DB_FAILURE = { message: 'db error' };

const seedOf = (dishIndex: number): MealImageJobSeed => ({
  dishIndex,
  dishName: `料理${dishIndex}`,
  subjectHash: `hash-${dishIndex}`,
  prompt: 'prompt',
  model: 'model',
  triggerSource: 'test',
  referenceImageUrls: [],
});
const pendingDishOf = (dishIndex: number) => ({
  name: `料理${dishIndex}`,
  role: 'main',
  image_source: 'generated_ai',
  image_status: 'pending',
  image_subject_hash: `hash-${dishIndex}`,
  image_url: null,
});
const SEEDS = [seedOf(0), seedOf(1)];
const PENDING_DISHES = [pendingDishOf(0), pendingDishOf(1)];
const SAVED_MEAL = { id: MEAL_ID, dishes: PENDING_DISHES, image_url: null, updated_at: SAVED_AT, catalog_product_id: null, source_type: 'manual' };
const FAILURES = SEEDS.map((seed) => ({ dishIndex: seed.dishIndex, subjectHash: seed.subjectHash }));

/** 行ごとの insert の結果 (dish_index → 結果) */
type InsertResult = 'inserted' | 'failed' | 'duplicate';

/**
 * service role のクライアント (積み込みの受け手)。meal_image_jobs の insert は dish_index ごとの結果を返し、
 * 重複の状態の読み取りは待ち (pending)。planned_meals は SAVED_MEAL を読み、料理の書き込みは 1 行書けた
 */
function useQueueDb(results: Record<number, InsertResult>) {
  const db = createRecordingSupabase((query: RecordedQuery): QueryOutcome => {
    const first = firstMethodOf(query);
    if (query.table === 'meal_image_jobs') {
      if (first === 'insert') {
        const record = query.calls[0].args[0] as { dish_index: number };
        const result = results[record.dish_index];
        if (result === 'failed') return { error: PERMISSION_DENIED };
        if (result === 'duplicate') return { error: { code: MEAL_IMAGE_JOB_UNIQUE_VIOLATION_CODE, message: 'dup' } };
        return { data: null };
      }
      return { data: { status: 'pending' } };
    }
    if (first === 'update') return { data: [{ id: MEAL_ID }] };
    return { data: { ...SAVED_MEAL } };
  });
  h.queueDb = db.client;
  return db;
}

/** 料理の書き込み (planned_meals の update) が書いた料理 */
function dishWrites(queries: RecordedQuery[]): Array<Array<Record<string, unknown>>> {
  return queries
    .filter((query) => query.table === 'planned_meals' && firstMethodOf(query) === 'update')
    .map((query) => (query.calls[0].args[0] as { dishes: Array<Record<string, unknown>> }).dishes);
}

function expectEnqueueFailed(dish: unknown) {
  expect(dish).toMatchObject({ image_status: 'failed', image_error: MEAL_IMAGE_ENQUEUE_FAILED_ERROR });
}

/** 利用者のクライアント (積み込みの例外のときに印を書く)。update と読み直しの振る舞いを決める */
function useUserDb(options: { markWrite: 'ok' | 'error'; storedDishes?: unknown[]; reread: 'ok' | 'error' }) {
  let reads = 0;
  return createRecordingSupabase((query: RecordedQuery): QueryOutcome => {
    if (firstMethodOf(query) === 'update') return options.markWrite === 'ok' ? { data: [{ id: MEAL_ID }] } : { error: DB_FAILURE };
    reads += 1;
    // 印付けの読み取り (1 回目) は保存した行。その後の読み直し (2 回目) は options.reread
    if (reads > 1 && options.reread === 'error') return { error: DB_FAILURE };
    return { data: { ...SAVED_MEAL, dishes: options.storedDishes ?? PENDING_DISHES } };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  h.queueDb = null;
  h.queueWriterThrows = false;
  h.loggerWarnThrows = false;
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('1. 行を積み始めたあとの後始末が投げても、積み込み全体の失敗にしない (#2227 H4)', () => {
  it('Next.js: 失敗した行のログが投げても、積めた料理に印を付けず、数え戻さない', async () => {
    h.loggerWarnThrows = true;
    const queueDb = useQueueDb({ 0: 'inserted', 1: 'failed' });
    const userDb = createRecordingSupabase(() => ({ data: null }));

    const outcome = await enqueueMealImageJobsAfterSave({
      userDb: userDb.client as never,
      plannedMealId: MEAL_ID,
      userId: USER_ID,
      triggerSource: 'test',
      jobSeeds: SEEDS,
      usage: AI_USAGE_ALLOWED,
    });

    expect(outcome).toEqual({
      status: 'enqueued',
      enqueued: { inserted: 1, duplicates: 0, duplicatesProcessing: 0, failed: 1 },
      triggered: true,
    });
    expect(h.refundAiUsage).not.toHaveBeenCalled();
    expect(h.triggerMealImageJobProcessing).toHaveBeenCalledWith({ plannedMealId: MEAL_ID, limit: 1 });
    // 印は積めなかった料理 (1) だけ。積めた料理 (0) は待ちのまま
    const writes = dishWrites(queueDb.queries);
    expect(writes).toHaveLength(1);
    expect(writes[0][0]).toMatchObject({ image_status: 'pending' });
    expectEnqueueFailed(writes[0][1]);
    expect(userDb.queries).toEqual([]);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('logging the failed rows'), 'log sink down');
  });

  it('Next.js: 1 行も積めず (待ちの重複だけ) の数え戻しが投げても、数え戻しは 1 回だけで、待ちの重複の料理に印を付けない', async () => {
    h.refundAiUsage.mockRejectedValueOnce(new Error('refund rpc down'));
    const queueDb = useQueueDb({ 0: 'duplicate' });
    const userDb = createRecordingSupabase(() => ({ data: null }));

    const outcome = await enqueueMealImageJobsAfterSave({
      userDb: userDb.client as never,
      plannedMealId: MEAL_ID,
      userId: USER_ID,
      triggerSource: 'test',
      jobSeeds: [seedOf(0)],
      usage: AI_USAGE_ALLOWED,
    });

    expect(outcome).toEqual({
      status: 'enqueued',
      enqueued: { inserted: 0, duplicates: 1, duplicatesProcessing: 0, failed: 0 },
      triggered: true,
    });
    expect(h.refundAiUsage).toHaveBeenCalledTimes(1);
    expect(dishWrites(queueDb.queries)).toEqual([]);
    expect(userDb.queries).toEqual([]);
  });

  it('Edge: 失敗した行のログが投げても、結果を返し、積めなかった料理だけに印を付ける', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {
      throw new Error('log sink down');
    });
    const queueDb = useQueueDb({ 0: 'inserted', 1: 'failed' });

    const result = await enqueueMealImageJobsEdge({ supabase: queueDb.client, plannedMealId: MEAL_ID, userId: USER_ID, jobs: SEEDS });

    expect(result).toEqual({ inserted: 1, duplicates: 0, duplicatesProcessing: 0, failed: 1 });
    const writes = dishWrites(queueDb.queries);
    expect(writes).toHaveLength(1);
    expect(writes[0][0]).toMatchObject({ image_status: 'pending' });
    expectEnqueueFailed(writes[0][1]);
  });
});

describe('2. 印の書き込みが失敗したら、読み直した行の料理に印を重ねる (#2227 H4)', () => {
  it('mealAfterMark の料理は見送りの状態、updated_at は DB の値のまま', async () => {
    h.queueWriterThrows = true;
    const userDb = useUserDb({ markWrite: 'error', reread: 'ok' });

    const outcome = await enqueueMealImageJobsAfterSave({
      userDb: userDb.client as never,
      plannedMealId: MEAL_ID,
      userId: USER_ID,
      triggerSource: 'test',
      jobSeeds: SEEDS,
      usage: null,
    });

    expect(outcome.status).toBe('enqueue_threw');
    if (outcome.status !== 'enqueue_threw') return;
    expect(outcome.mealAfterMark?.updated_at).toBe(SAVED_AT);
    const dishes = outcome.mealAfterMark?.dishes as unknown[];
    expect(dishes).toHaveLength(PENDING_DISHES.length);
    dishes.forEach(expectEnqueueFailed);
    expect(h.logWarn).toHaveBeenCalledWith('Failed to mark dishes whose meal image jobs were not enqueued', expect.anything());
    // 応答の行に重ねると、画面は「生成中」に残らない
    const response = withMealAfterEnqueueThrew({ ...SAVED_MEAL }, outcome);
    (response.dishes as unknown[]).forEach(expectEnqueueFailed);
  });

  it('印を書けたときは、読み直した行の料理をそのまま返す (重ねない)', async () => {
    h.queueWriterThrows = true;
    const ready = { ...pendingDishOf(0), image_status: 'ready', image_url: 'https://example.test/ready.png' };
    const userDb = useUserDb({ markWrite: 'ok', storedDishes: [ready], reread: 'ok' });

    const outcome = await enqueueMealImageJobsAfterSave({
      userDb: userDb.client as never,
      plannedMealId: MEAL_ID,
      userId: USER_ID,
      triggerSource: 'test',
      jobSeeds: [seedOf(0)],
      usage: null,
    });

    expect(outcome).toEqual({ status: 'enqueue_threw', mealAfterMark: { dishes: [ready], updated_at: SAVED_AT }, failuresToOverlay: [] });
  });
});

describe('3. 読み直しに失敗したら、応答の行の料理に印を重ねる (#2227 H4)', () => {
  it('印を書けたとき: failuresToOverlay はジョブの料理全部。応答の行の料理は見送りの状態、updated_at は変えない', async () => {
    h.queueWriterThrows = true;
    const userDb = useUserDb({ markWrite: 'ok', reread: 'error' });

    const outcome = await enqueueMealImageJobsAfterSave({
      userDb: userDb.client as never,
      plannedMealId: MEAL_ID,
      userId: USER_ID,
      triggerSource: 'test',
      jobSeeds: SEEDS,
      usage: null,
    });

    expect(outcome).toEqual({ status: 'enqueue_threw', mealAfterMark: null, failuresToOverlay: FAILURES });
    const response = withMealAfterEnqueueThrew({ ...SAVED_MEAL }, outcome);
    (response.dishes as unknown[]).forEach(expectEnqueueFailed);
    expect(response.updated_at).toBe(SAVED_AT);
    // 渡した行は変えない
    expect(SAVED_MEAL.dishes).toEqual(PENDING_DISHES);
  });

  it('印の書き込みも失敗したとき: 応答の行の料理に印を重ねる', async () => {
    h.queueWriterThrows = true;
    const userDb = useUserDb({ markWrite: 'error', reread: 'error' });

    const outcome = await enqueueMealImageJobsAfterSave({
      userDb: userDb.client as never,
      plannedMealId: MEAL_ID,
      userId: USER_ID,
      triggerSource: 'test',
      jobSeeds: SEEDS,
      usage: null,
    });

    expect(outcome).toEqual({ status: 'enqueue_threw', mealAfterMark: null, failuresToOverlay: FAILURES });
    (withMealAfterEnqueueThrew({ ...SAVED_MEAL }, outcome).dishes as unknown[]).forEach(expectEnqueueFailed);
  });

  it('変える料理が無かった (そのあいだに画像が付いた) とき: 重ねない (応答の行のまま)', async () => {
    h.queueWriterThrows = true;
    const ready = { ...pendingDishOf(0), image_status: 'ready', image_url: 'https://example.test/ready.png' };
    const userDb = useUserDb({ markWrite: 'ok', storedDishes: [ready], reread: 'error' });

    const outcome = await enqueueMealImageJobsAfterSave({
      userDb: userDb.client as never,
      plannedMealId: MEAL_ID,
      userId: USER_ID,
      triggerSource: 'test',
      jobSeeds: [seedOf(0)],
      usage: null,
    });

    expect(outcome).toEqual({ status: 'enqueue_threw', mealAfterMark: null, failuresToOverlay: [] });
    const meal = { ...SAVED_MEAL };
    expect(withMealAfterEnqueueThrew(meal, outcome)).toBe(meal);
  });

  it('応答の行の料理が配列でない・オブジェクトでない要素を含むときは重ねない', () => {
    const outcome = { status: 'enqueue_threw' as const, mealAfterMark: null, failuresToOverlay: FAILURES };
    const noDishes = { id: MEAL_ID, dishes: null };
    const broken = { id: MEAL_ID, dishes: [pendingDishOf(0), 'x'] };

    expect(withMealAfterEnqueueThrew(noDishes, outcome)).toBe(noDishes);
    expect(withMealAfterEnqueueThrew(broken, outcome)).toBe(broken);
  });
});
