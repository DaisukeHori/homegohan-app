// @vitest-environment node
/**
 * #2245 K5 料理画像の積み込みのログを、利用者つき (withUser) で app_logs に残す
 *
 * 問題 (直す前):
 *   lib/meal-image-jobs.ts の後始末の失敗のログ (logAftercareFailure の error)・積めなかった行の warn・印の失敗の warn は、
 *   createLogger('lib/meal-image-jobs').error / .warn に userId を metadata でだけ渡していた。app_logs の user_id 列は
 *   withUser で作ったロガーだけが埋める (src/lib/db-logger.ts) ので、運営が user_id 列で絞ると、この 3 つだけが出てこなかった
 *   (呼び出し側の src/lib/meal-image-enqueue-after-save.ts の error は .withUser(params.userId) で出している)。
 *
 * 直したあと (このテストが固定する):
 *   3 つとも createLogger('lib/meal-image-jobs').withUser(params.userId) で出す。利用者の無いロガー (withUser を通らない) には出さない。
 *   metadata の userId・plannedMealId は今までどおり残す。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AI_USAGE_ALLOWED } from './helpers/ai-usage-mock';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const h = vi.hoisted(() => ({
  refundAiUsage: vi.fn(async () => undefined),
  /** 利用者の無いロガーへの呼び出し (ログの名前, 段階, ...引数) */
  rootLog: vi.fn(),
  /** withUser(userId) のロガーへの呼び出し (ログの名前, userId, 段階, ...引数) */
  userLog: vi.fn(),
}));

vi.mock('@/lib/plan/entitlements', () => ({ refundAiUsage: h.refundAiUsage }));
vi.mock('@/lib/db-logger', () => {
  const levels: LogLevel[] = ['debug', 'info', 'warn', 'error'];
  const loggerOf = (write: (level: LogLevel, args: unknown[]) => void) =>
    Object.fromEntries(levels.map((level) => [level, (...args: unknown[]) => write(level, args)]));
  return {
    createLogger: (name: string) => ({
      ...loggerOf((level, args) => h.rootLog(name, level, ...args)),
      withUser: (userId: string) => loggerOf((level, args) => h.userLog(name, userId, level, ...args)),
    }),
  };
});

import { MEAL_IMAGE_ENQUEUE_AFTERCARE_FAILED_LOG_MESSAGE, MEAL_IMAGE_ENQUEUE_AFTERCARE_STEPS, enqueueMealImageJobs } from '@/lib/meal-image-jobs';
import { MEAL_IMAGE_JOB_UNIQUE_VIOLATION_CODE, type MealImageJobSeed } from '@/lib/meal-image';
import { createRecordingSupabase, firstMethodOf, type QueryOutcome, type RecordedQuery } from './helpers/recording-supabase';

/** lib/meal-image-jobs.ts のログの名前 (ENQUEUE_LOG_NAME) */
const LOG_NAME = 'lib/meal-image-jobs';
const USER_ID = 'user-2245';
const MEAL_ID = 'meal-2245';
/** 権限の失敗 (積めなかった行) */
const PERMISSION_DENIED = { code: '42501', message: 'permission denied' };
/** 印の書き込みの失敗 */
const DB_FAILURE = { message: 'db error' };
/** 数え戻しの失敗 */
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
const SAVED_MEAL = {
  id: MEAL_ID,
  dishes: [pendingDishOf(0), pendingDishOf(1)],
  image_url: null,
  updated_at: '2026-11-05T00:00:00.000Z',
  catalog_product_id: null,
  source_type: 'manual',
};

type InsertResult = 'inserted' | 'failed' | 'duplicate';

/** service role のクライアント。planned_meals の印の書き込みは失敗させる (印の失敗の warn を出す) */
function queueDbOf(results: Record<number, InsertResult>) {
  return createRecordingSupabase((query: RecordedQuery): QueryOutcome => {
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
    if (first === 'update') return { error: DB_FAILURE };
    return { data: { ...SAVED_MEAL } };
  }).client;
}

function enqueue(results: Record<number, InsertResult>, seeds: MealImageJobSeed[]) {
  return enqueueMealImageJobs({
    supabase: queueDbOf(results) as never,
    plannedMealId: MEAL_ID,
    userId: USER_ID,
    triggerSource: 'test',
    jobSeeds: seeds,
    usage: AI_USAGE_ALLOWED,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('料理画像の積み込みのログは withUser で出す (app_logs の user_id 列に入る。#2245 K5)', () => {
  it('積めなかった行の warn と印の失敗の warn は withUser(userId) で出し、利用者の無いロガーには出さない', async () => {
    const result = await enqueue({ 0: 'inserted', 1: 'failed' }, [seedOf(0), seedOf(1)]);

    expect(result).toEqual({ inserted: 1, duplicates: 0, duplicatesProcessing: 0, failed: 1 });
    expect(h.rootLog).not.toHaveBeenCalled();
    expect(h.userLog.mock.calls.map(([name, userId, level, message]) => [name, userId, level, message])).toEqual([
      [LOG_NAME, USER_ID, 'warn', 'Failed to enqueue meal image job'],
      [LOG_NAME, USER_ID, 'warn', 'Failed to mark dishes whose meal image jobs were not enqueued'],
    ]);
    // metadata の userId・plannedMealId は今までどおり残す
    expect(h.userLog.mock.calls[0][4]).toMatchObject({ userId: USER_ID, plannedMealId: MEAL_ID, dishIndex: 1, code: PERMISSION_DENIED.code });
    expect(h.userLog.mock.calls[1][4]).toEqual({ userId: USER_ID, plannedMealId: MEAL_ID, error: expect.any(String) });
  });

  it('後始末が投げたときの error (logAftercareFailure) は withUser(userId) で出し、利用者の無いロガーには出さない', async () => {
    h.refundAiUsage.mockRejectedValueOnce(new Error(REFUND_FAILURE_MESSAGE));

    const result = await enqueue({ 0: 'duplicate' }, [seedOf(0)]);

    expect(result).toEqual({ inserted: 0, duplicates: 1, duplicatesProcessing: 0, failed: 0 });
    expect(h.refundAiUsage).toHaveBeenCalledTimes(1);
    expect(h.rootLog).not.toHaveBeenCalled();
    expect(h.userLog).toHaveBeenCalledTimes(1);
    const [name, userId, level, message, error, metadata] = h.userLog.mock.calls[0];
    expect([name, userId, level, message]).toEqual([LOG_NAME, USER_ID, 'error', MEAL_IMAGE_ENQUEUE_AFTERCARE_FAILED_LOG_MESSAGE]);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(REFUND_FAILURE_MESSAGE);
    expect(metadata).toEqual({ userId: USER_ID, plannedMealId: MEAL_ID, step: MEAL_IMAGE_ENQUEUE_AFTERCARE_STEPS.refundUnusedUsage });
  });

  it('種が空のときの数え戻しが投げたときの error も withUser(userId) で出す', async () => {
    h.refundAiUsage.mockRejectedValueOnce(new Error(REFUND_FAILURE_MESSAGE));

    await enqueue({}, []);

    expect(h.rootLog).not.toHaveBeenCalled();
    expect(h.userLog).toHaveBeenCalledTimes(1);
    expect(h.userLog.mock.calls[0].slice(0, 4)).toEqual([LOG_NAME, USER_ID, 'error', MEAL_IMAGE_ENQUEUE_AFTERCARE_FAILED_LOG_MESSAGE]);
  });
});
