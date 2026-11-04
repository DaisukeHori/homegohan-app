// @vitest-environment node
/**
 * #2235 I5 料理画像の積み込みの後始末
 *
 * 問題 (直す前):
 *   1. 積み込みの後始末 (失敗した行のログ・積めなかった料理の印・数え戻し) が投げても、runMealImageEnqueueAftercare は
 *      console.error に出すだけで、app_logs に残らなかった (数え戻しが投げると、AI 利用回数の 1 回が戻らないまま運営が追えない)
 *   2. enqueueMealImageJobs (Next.js) は、積む種が空なら数え戻しを後始末で囲まずに呼んでいた。数え戻しが一部だけ戻して投げると、
 *      呼び出し側 (enqueueMealImageJobsAfterSave) の catch が積み込みの例外とみなし、もう一度戻しうる (二重の数え戻し)
 *   3. 呼び出し側の catch の数え戻しが投げると、印付けまで飛ばして例外が外へ出た (献立は保存済みなのに、料理は「生成中」のまま)
 *
 * 直したあと (このテストが固定する):
 *   1. 後始末が投げたら、Next.js の側は createLogger('lib/meal-image-jobs').error に残す (step = 諦めた後始末)。やり直さない
 *   2. 種が空の数え戻しも runMealImageEnqueueAftercare で囲む。呼び出し側は数え戻しを 1 回だけ呼ぶ
 *   3. 呼び出し側の数え戻しが投げても、印付けを続けて結果を返し、app_logs に残す (やり直さない)
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

import {
  MEAL_IMAGE_REFUND_AFTER_ENQUEUE_THREW_LOG_MESSAGE,
  enqueueMealImageJobsAfterSave,
} from '@/lib/meal-image-enqueue-after-save';
import {
  MEAL_IMAGE_ENQUEUE_AFTERCARE_FAILED_LOG_MESSAGE,
  MEAL_IMAGE_ENQUEUE_AFTERCARE_STEPS,
  enqueueMealImageJobs,
} from '@/lib/meal-image-jobs';
import {
  EMPTY_ENQUEUE_MEAL_IMAGE_JOBS_RESULT,
  MEAL_IMAGE_ENQUEUE_FAILED_ERROR,
  MEAL_IMAGE_JOB_UNIQUE_VIOLATION_CODE,
  runMealImageEnqueueAftercare,
  type MealImageJobSeed,
} from '@/lib/meal-image';
import { enqueueMealImageJobs as enqueueMealImageJobsEdge } from '../supabase/functions/_shared/meal-image-jobs';
import { createRecordingSupabase, firstMethodOf, type QueryOutcome, type RecordedQuery } from './helpers/recording-supabase';

const USER_ID = 'user-1';
const MEAL_ID = 'meal-1';
const SAVED_AT = '2026-11-04T00:00:00.000Z';
/** 権限の失敗 (積めなかった行) */
const PERMISSION_DENIED = { code: '42501', message: 'permission denied' };
/** DB の失敗 */
const DB_FAILURE = { message: 'db error' };
/** 数え戻しの失敗 (一部だけ戻して投げた、を表す) */
const REFUND_FAILURE_MESSAGE = 'refund rpc down';

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
const ZERO_RESULT = { ...EMPTY_ENQUEUE_MEAL_IMAGE_JOBS_RESULT };

/** 行ごとの insert の結果 (dish_index → 結果) */
type InsertResult = 'inserted' | 'failed' | 'duplicate';

/** service role のクライアント。planned_meals の印の書き込みは options.markWrite */
function useQueueDb(results: Record<number, InsertResult>, options: { markWrite: 'ok' | 'error' } = { markWrite: 'ok' }) {
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
    if (first === 'update') return options.markWrite === 'ok' ? { data: [{ id: MEAL_ID }] } : { error: DB_FAILURE };
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

/** 後始末の失敗のログ (app_logs) の呼び出しのうち、step が一致するもの */
function aftercareFailureLogsOf(step: string): unknown[][] {
  return h.logError.mock.calls.filter(
    (call: unknown[]) =>
      call[0] === MEAL_IMAGE_ENQUEUE_AFTERCARE_FAILED_LOG_MESSAGE && (call[2] as { step?: unknown } | undefined)?.step === step,
  );
}

function expectAftercareFailureLogged(step: string, errorMessage: string) {
  const logs = aftercareFailureLogsOf(step);
  expect(logs).toHaveLength(1);
  const [, error, metadata] = logs[0];
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toBe(errorMessage);
  expect(metadata).toEqual({ userId: USER_ID, plannedMealId: MEAL_ID, step });
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

describe('1. 後始末が投げたら app_logs に残す (#2235 I5)', () => {
  it('Next.js: 1 行も積めず (待ちの重複だけ) の数え戻しが投げたら、error に残す (やり直さない)', async () => {
    h.refundAiUsage.mockRejectedValueOnce(new Error(REFUND_FAILURE_MESSAGE));
    useQueueDb({ 0: 'duplicate' });

    const result = await enqueueMealImageJobs({
      supabase: h.queueDb as never,
      plannedMealId: MEAL_ID,
      userId: USER_ID,
      triggerSource: 'test',
      jobSeeds: [seedOf(0)],
      usage: AI_USAGE_ALLOWED,
    });

    expect(result).toEqual({ inserted: 0, duplicates: 1, duplicatesProcessing: 0, failed: 0 });
    expect(h.refundAiUsage).toHaveBeenCalledTimes(1);
    expect(h.refundAiUsage).toHaveBeenCalledWith(USER_ID, 'meal_image_auto', AI_USAGE_ALLOWED);
    expectAftercareFailureLogged(MEAL_IMAGE_ENQUEUE_AFTERCARE_STEPS.refundUnusedUsage, REFUND_FAILURE_MESSAGE);
    expect(h.logError).toHaveBeenCalledTimes(1);
    // ロガーが投げたときのために console にも出す (今までどおり)
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining(MEAL_IMAGE_ENQUEUE_AFTERCARE_STEPS.refundUnusedUsage),
      REFUND_FAILURE_MESSAGE,
    );
  });

  it('Next.js: 失敗した行のログと印の後始末が投げたら、それぞれ error に残す', async () => {
    h.loggerWarnThrows = true;
    const queueDb = useQueueDb({ 0: 'inserted', 1: 'failed' }, { markWrite: 'error' });

    const result = await enqueueMealImageJobs({
      supabase: h.queueDb as never,
      plannedMealId: MEAL_ID,
      userId: USER_ID,
      triggerSource: 'test',
      jobSeeds: SEEDS,
      usage: AI_USAGE_ALLOWED,
    });

    expect(result).toEqual({ inserted: 1, duplicates: 0, duplicatesProcessing: 0, failed: 1 });
    // 印の書き込みは 1 回試した (error が返り、warn が投げた)
    expect(dishWrites(queueDb.queries)).toHaveLength(1);
    expect(dishWrites(queueDb.queries)[0][1]).toMatchObject({ image_status: 'failed', image_error: MEAL_IMAGE_ENQUEUE_FAILED_ERROR });
    expectAftercareFailureLogged(MEAL_IMAGE_ENQUEUE_AFTERCARE_STEPS.logFailedRows, 'log sink down');
    expectAftercareFailureLogged(MEAL_IMAGE_ENQUEUE_AFTERCARE_STEPS.markFailedDishes, 'log sink down');
    // 1 行は積めたので数え戻さない
    expect(h.refundAiUsage).not.toHaveBeenCalled();
    expect(aftercareFailureLogsOf(MEAL_IMAGE_ENQUEUE_AFTERCARE_STEPS.refundUnusedUsage)).toEqual([]);
  });

  it('Next.js: 後始末が投げなければ error に残さない', async () => {
    useQueueDb({ 0: 'duplicate' });

    await enqueueMealImageJobs({
      supabase: h.queueDb as never,
      plannedMealId: MEAL_ID,
      userId: USER_ID,
      triggerSource: 'test',
      jobSeeds: [seedOf(0)],
      usage: AI_USAGE_ALLOWED,
    });

    expect(h.refundAiUsage).toHaveBeenCalledTimes(1);
    expect(h.logError).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
  });

  it('runMealImageEnqueueAftercare: 後始末が投げたら onFailure に label と例外を渡す。onFailure が投げても外へ出さない', async () => {
    const stepError = new Error('step failed');
    const onFailure = vi.fn(() => {
      throw new Error('report failed');
    });

    await expect(
      runMealImageEnqueueAftercare(
        'doing the step',
        () => {
          throw stepError;
        },
        onFailure,
      ),
    ).resolves.toBeUndefined();

    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(onFailure).toHaveBeenCalledWith({ label: 'doing the step', error: stepError });
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('doing the step failed after enqueueing'), 'step failed');
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('reporting that doing the step failed also failed'), 'report failed');
  });

  it('runMealImageEnqueueAftercare: 後始末が投げなければ onFailure を呼ばない', async () => {
    const onFailure = vi.fn();

    await runMealImageEnqueueAftercare('doing the step', async () => undefined, onFailure);

    expect(onFailure).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
  });
});

describe('2. 種が空のときの数え戻しが投げても、呼び出し側がもう一度戻さない (#2235 I5)', () => {
  it('enqueueMealImageJobs: 種が空で数え戻しが投げても、空の結果を返し (投げない)、error に残す', async () => {
    h.refundAiUsage.mockRejectedValueOnce(new Error(REFUND_FAILURE_MESSAGE));
    const queueDb = useQueueDb({});

    await expect(
      enqueueMealImageJobs({
        supabase: queueDb.client as never,
        plannedMealId: MEAL_ID,
        userId: USER_ID,
        triggerSource: 'test',
        jobSeeds: [],
        usage: AI_USAGE_ALLOWED,
      }),
    ).resolves.toEqual(ZERO_RESULT);

    expect(h.refundAiUsage).toHaveBeenCalledTimes(1);
    expectAftercareFailureLogged(MEAL_IMAGE_ENQUEUE_AFTERCARE_STEPS.refundUnusedUsage, REFUND_FAILURE_MESSAGE);
    expect(queueDb.queries).toEqual([]);
  });

  it('enqueueMealImageJobsAfterSave: 種が空で数え戻しが投げても、数え戻しは 1 回だけで、積み込みの例外にしない', async () => {
    h.refundAiUsage.mockRejectedValueOnce(new Error(REFUND_FAILURE_MESSAGE));
    const queueDb = useQueueDb({});
    const userDb = createRecordingSupabase(() => ({ data: null }));

    const outcome = await enqueueMealImageJobsAfterSave({
      userDb: userDb.client as never,
      plannedMealId: MEAL_ID,
      userId: USER_ID,
      triggerSource: 'test',
      jobSeeds: [],
      usage: AI_USAGE_ALLOWED,
    });

    // 直す前は、呼び出し側の catch が積み込みの例外とみなしてもう一度戻していた (2 回)
    expect(h.refundAiUsage).toHaveBeenCalledTimes(1);
    expect(outcome).toEqual({ status: 'enqueued', enqueued: ZERO_RESULT, triggered: false });
    expect(h.triggerMealImageJobProcessing).not.toHaveBeenCalled();
    expect(queueDb.queries).toEqual([]);
    expect(userDb.queries).toEqual([]);
  });

  it('enqueueMealImageJobsAfterSave: 1 行も積めず (待ちの重複だけ) の数え戻しが投げても、数え戻しは 1 回だけ', async () => {
    h.refundAiUsage.mockRejectedValueOnce(new Error(REFUND_FAILURE_MESSAGE));
    useQueueDb({ 0: 'duplicate' });
    const userDb = createRecordingSupabase(() => ({ data: null }));

    const outcome = await enqueueMealImageJobsAfterSave({
      userDb: userDb.client as never,
      plannedMealId: MEAL_ID,
      userId: USER_ID,
      triggerSource: 'test',
      jobSeeds: [seedOf(0)],
      usage: AI_USAGE_ALLOWED,
    });

    expect(outcome.status).toBe('enqueued');
    expect(h.refundAiUsage).toHaveBeenCalledTimes(1);
    expect(userDb.queries).toEqual([]);
  });

  it('Edge: 種が空なら何も書かず、空の結果を返す (Edge は数え戻しをしない)', async () => {
    const queueDb = useQueueDb({});

    await expect(
      enqueueMealImageJobsEdge({ supabase: queueDb.client, plannedMealId: MEAL_ID, userId: USER_ID, jobs: [] }),
    ).resolves.toEqual(ZERO_RESULT);
    expect(queueDb.queries).toEqual([]);
    expect(h.refundAiUsage).not.toHaveBeenCalled();
  });
});

describe('3. 積み込みの例外のあとの数え戻しが投げても、印付けを続ける (#2235 I5)', () => {
  it('数え戻しは 1 回だけ。料理は見送りの状態にし、error に残す', async () => {
    h.queueWriterThrows = true;
    h.refundAiUsage.mockRejectedValueOnce(new Error(REFUND_FAILURE_MESSAGE));
    const userDb = createRecordingSupabase((query: RecordedQuery): QueryOutcome => {
      if (firstMethodOf(query) === 'update') return { data: [{ id: MEAL_ID }] };
      return { data: { ...SAVED_MEAL } };
    });

    const outcome = await enqueueMealImageJobsAfterSave({
      userDb: userDb.client as never,
      plannedMealId: MEAL_ID,
      userId: USER_ID,
      triggerSource: 'test',
      jobSeeds: SEEDS,
      usage: AI_USAGE_ALLOWED,
    });

    expect(outcome.status).toBe('enqueue_threw');
    expect(h.refundAiUsage).toHaveBeenCalledTimes(1);
    const writes = dishWrites(userDb.queries);
    expect(writes).toHaveLength(1);
    for (const dish of writes[0]) expect(dish).toMatchObject({ image_status: 'failed', image_error: MEAL_IMAGE_ENQUEUE_FAILED_ERROR });
    const refundLogs = h.logError.mock.calls.filter((call: unknown[]) => call[0] === MEAL_IMAGE_REFUND_AFTER_ENQUEUE_THREW_LOG_MESSAGE);
    expect(refundLogs).toHaveLength(1);
    expect(refundLogs[0][1]).toBeInstanceOf(Error);
    expect((refundLogs[0][1] as Error).message).toBe(REFUND_FAILURE_MESSAGE);
    expect(refundLogs[0][2]).toEqual({ planned_meal_id: MEAL_ID });
  });
});
