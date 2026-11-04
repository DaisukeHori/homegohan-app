// @vitest-environment node
/**
 * #2201 U4 献立を保存したあとの料理画像のジョブの積み込み・処理の起動の例外 (src/lib/meal-image-enqueue-after-save.ts)
 *
 * 問題 (直す前):
 *   - 積み込み (getAiQueueWriter・enqueueMealImageJobs) で例外が出ると、料理は 'pending' (料理画像を生成中) で保存済みなのに
 *     ジョブが無く、生成中のまま残った。料理を保存する 4 つの route は例外が外へ出て 500 になり、数えた 1 回も戻さなかった
 *   - AI 相談の update_meal は積み込みと処理の起動を 1 つの try に入れていて、積み込みが成功したあとに処理の起動が投げても
 *     1 回を数え戻した (ジョブは定期の処理が拾うので、安全弁を 1 回ぶん少なく数える)
 *
 * 直したあと (このテストが固定する):
 *   - 積み込みの例外: 数えた 1 回を戻し、ジョブの無い料理を保存済みの献立の上で 'failed' + 'enqueue_failed' に書き直す。例外は外へ出さない
 *   - 処理の起動の例外: ログに残すだけ。数え戻さず、料理も書き直さない
 *   - AI 相談の update_meal と 4 つの route は、積み込みと処理の起動をこの関数だけで行う (同じ縁を作り直さない)
 */
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AI_USAGE_ALLOWED } from './helpers/ai-usage-mock';
import type { AiUsageResult } from '@/lib/plan/entitlements';

const h = vi.hoisted(() => ({
  enqueueMealImageJobs: vi.fn(),
  triggerMealImageJobProcessing: vi.fn(),
  refundAiUsage: vi.fn(async () => undefined),
  queueWriterThrows: false,
  logError: vi.fn(),
  logWarn: vi.fn(),
}));

vi.mock('@/lib/meal-image-jobs', () => ({
  enqueueMealImageJobs: h.enqueueMealImageJobs,
  triggerMealImageJobProcessing: h.triggerMealImageJobProcessing,
}));
vi.mock('@/lib/plan/entitlements', () => ({ refundAiUsage: h.refundAiUsage }));
/** service role のクライアント (積み込みの受け手)。取り出しが投げる (環境変数の欠け) 場合も試す */
const QUEUE_DB = { from: vi.fn() };
vi.mock('@/lib/ai/ai-queue-writer', () => ({
  getAiQueueWriter: () => {
    if (h.queueWriterThrows) throw new Error('missing service role key');
    return QUEUE_DB;
  },
}));
vi.mock('@/lib/db-logger', () => {
  const logger: Record<string, unknown> = { warn: h.logWarn, info: vi.fn(), error: h.logError };
  logger.withUser = () => logger;
  return { createLogger: () => logger };
});

import {
  MEAL_IMAGE_ENQUEUE_THREW_LOG_MESSAGE,
  MEAL_IMAGE_TRIGGER_THREW_LOG_MESSAGE,
  enqueueMealImageJobsAfterSave,
} from '@/lib/meal-image-enqueue-after-save';
import { MEAL_IMAGE_ENQUEUE_FAILED_ERROR, type MealImageJobSeed } from '@/lib/meal-image';
import { createRecordingSupabase, firstMethodOf, type RecordedQuery } from './helpers/recording-supabase';
import { ROOT, stripComments } from './helpers/ai-reach';

const USER_ID = 'user-1';
const MEAL_ID = 'meal-1';
const SAVED_AT = '2026-11-03T00:00:00.000Z';
const SUBJECT_HASH = 'hash-1';
const JOB: MealImageJobSeed = {
  dishIndex: 0,
  dishName: '筑前煮',
  subjectHash: SUBJECT_HASH,
  prompt: 'prompt',
  model: 'model',
  triggerSource: 'test',
  referenceImageUrls: [],
};
/** 保存済みの献立の、画像を待つ料理 (ジョブ JOB の料理) */
const PENDING_DISH = { name: '筑前煮', role: 'main', image_source: 'generated_ai', image_status: 'pending', image_subject_hash: SUBJECT_HASH, image_url: null };
/**
 * 積み込みの例外のあとに読み直す献立の料理と updated_at (#2206 G4)。この偽のクライアントの読み取りは、書いたあとも
 * 同じ行 (画像を待つ料理) を返すので、その行の値になる (書いた後の値を返すことは tests/meal-image-enqueue-threw-response-2206.test.ts)
 */
const MEAL_AFTER_MARK = { dishes: [PENDING_DISH], updated_at: SAVED_AT };
/** 積み込みの例外のあと、読み直せなかったときに応答の行へ見送りの印を重ねる料理 (ジョブ JOB の料理。#2227 H4) */
const JOB_FAILURES = [{ dishIndex: JOB.dishIndex, subjectHash: SUBJECT_HASH }];
const ENQUEUED_ONE = { inserted: 1, duplicates: 0, duplicatesProcessing: 0, failed: 0 };
const ENQUEUED_NONE = { inserted: 0, duplicates: 0, duplicatesProcessing: 0, failed: 1 };

/** 利用者のクライアント: 献立の読み取りは画像を待つ料理のある行、料理の書き込み (select('id')) は 1 行書けた */
function userDb() {
  return createRecordingSupabase((query: RecordedQuery) => {
    if (firstMethodOf(query) === 'update') return { data: [{ id: MEAL_ID }] };
    return { data: { dishes: [PENDING_DISH], image_url: null, updated_at: SAVED_AT, catalog_product_id: null, source_type: null } };
  });
}

/** 料理を 'failed' + 'enqueue_failed' にした書き込み */
function enqueueFailedMarks(queries: RecordedQuery[]) {
  return queries.filter((query) => {
    if (query.table !== 'planned_meals' || firstMethodOf(query) !== 'update') return false;
    const values = query.calls[0].args[0] as { dishes?: Array<{ image_status?: string; image_error?: string }> };
    return values.dishes?.[0]?.image_status === 'failed' && values.dishes[0].image_error === MEAL_IMAGE_ENQUEUE_FAILED_ERROR;
  });
}

async function run(usage: AiUsageResult | null = AI_USAGE_ALLOWED) {
  const db = userDb();
  const outcome = await enqueueMealImageJobsAfterSave({
    userDb: db.client as never,
    plannedMealId: MEAL_ID,
    userId: USER_ID,
    triggerSource: 'test',
    jobSeeds: [JOB],
    requestId: null,
    usage,
    logContext: { action_id: 'action-1' },
  });
  return { outcome, queries: db.queries };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.queueWriterThrows = false;
  h.enqueueMealImageJobs.mockResolvedValue(ENQUEUED_ONE);
  h.triggerMealImageJobProcessing.mockResolvedValue(undefined);
});

describe('enqueueMealImageJobsAfterSave (#2201 U4)', () => {
  it('積めたら処理を起こす。数え戻さず、料理も書き直さない', async () => {
    const { outcome, queries } = await run();

    expect(outcome).toEqual({ status: 'enqueued', enqueued: ENQUEUED_ONE, triggered: true });
    expect(h.enqueueMealImageJobs).toHaveBeenCalledWith(expect.objectContaining({ supabase: QUEUE_DB, plannedMealId: MEAL_ID, jobSeeds: [JOB] }));
    expect(h.triggerMealImageJobProcessing).toHaveBeenCalledWith({ plannedMealId: MEAL_ID, limit: 1 });
    expect(h.refundAiUsage).not.toHaveBeenCalled();
    expect(queries).toEqual([]);
  });

  it('1 行も積めなかった (書き込みの失敗) ときは処理を起こさない (数え戻し・印は enqueueMealImageJobs が行う)', async () => {
    h.enqueueMealImageJobs.mockResolvedValueOnce(ENQUEUED_NONE);

    const { outcome } = await run();

    expect(outcome).toEqual({ status: 'enqueued', enqueued: ENQUEUED_NONE, triggered: false });
    expect(h.triggerMealImageJobProcessing).not.toHaveBeenCalled();
    expect(h.refundAiUsage).not.toHaveBeenCalled();
  });

  it('積み込みの例外: 1 回を戻し、料理を見送りの状態に書き直し、例外を外へ出さない', async () => {
    h.enqueueMealImageJobs.mockRejectedValueOnce(new Error('enqueue failed'));

    const { outcome, queries } = await run();

    expect(outcome).toEqual({ status: 'enqueue_threw', mealAfterMark: MEAL_AFTER_MARK, failuresToOverlay: JOB_FAILURES });
    expect(h.refundAiUsage).toHaveBeenCalledTimes(1);
    expect(h.refundAiUsage).toHaveBeenCalledWith(USER_ID, 'meal_image_auto', AI_USAGE_ALLOWED);
    expect(h.triggerMealImageJobProcessing).not.toHaveBeenCalled();
    expect(h.logError).toHaveBeenCalledWith(
      MEAL_IMAGE_ENQUEUE_THREW_LOG_MESSAGE,
      expect.any(Error),
      expect.objectContaining({ planned_meal_id: MEAL_ID, action_id: 'action-1' }),
    );
    const marks = enqueueFailedMarks(queries);
    expect(marks).toHaveLength(1);
    // 読んだときの updated_at の行にだけ書く (ワーカーと同時でも、そのあいだに書かれた画像を巻き戻さない)
    expect(marks[0].calls).toEqual(expect.arrayContaining([{ method: 'eq', args: ['updated_at', SAVED_AT] }]));
  });

  it('service role のクライアントの取り出しが投げても同じ (数え戻し・見送りの状態)', async () => {
    h.queueWriterThrows = true;

    const { outcome, queries } = await run();

    expect(outcome).toEqual({ status: 'enqueue_threw', mealAfterMark: MEAL_AFTER_MARK, failuresToOverlay: JOB_FAILURES });
    expect(h.enqueueMealImageJobs).not.toHaveBeenCalled();
    expect(h.refundAiUsage).toHaveBeenCalledTimes(1);
    expect(enqueueFailedMarks(queries)).toHaveLength(1);
  });

  it('数えていない (usage が null) ときの積み込みの例外は、数え戻さずに料理だけ書き直す', async () => {
    h.enqueueMealImageJobs.mockRejectedValueOnce(new Error('enqueue failed'));

    const { outcome, queries } = await run(null);

    expect(outcome).toEqual({ status: 'enqueue_threw', mealAfterMark: MEAL_AFTER_MARK, failuresToOverlay: JOB_FAILURES });
    expect(h.refundAiUsage).not.toHaveBeenCalled();
    expect(enqueueFailedMarks(queries)).toHaveLength(1);
  });

  it('処理の起動の例外: ログに残すだけ。数え戻さず、料理も書き直さず、例外を外へ出さない', async () => {
    h.triggerMealImageJobProcessing.mockRejectedValueOnce(new Error('trigger failed'));

    const { outcome, queries } = await run();

    expect(outcome).toEqual({ status: 'enqueued', enqueued: ENQUEUED_ONE, triggered: false });
    expect(h.refundAiUsage).not.toHaveBeenCalled();
    expect(queries).toEqual([]);
    expect(h.logWarn).toHaveBeenCalledWith(MEAL_IMAGE_TRIGGER_THREW_LOG_MESSAGE, expect.objectContaining({ planned_meal_id: MEAL_ID }));
  });
});

describe('献立を保存する入口は、積み込みと処理の起動をこの関数だけで行う (#2201 U4)', () => {
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
    expect(code).toMatch(/\benqueueMealImageJobsAfterSave\(/);
    // 直接呼ぶと、例外の縁 (生成中のまま残る・数え戻しの過不足) を作り直す
    expect(code).not.toMatch(/\benqueueMealImageJobs\(/);
    expect(code).not.toMatch(/\btriggerMealImageJobProcessing\(/);
  });
});
