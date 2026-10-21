/**
 * #1532 積み直しの道具 (scripts/lib/meal-image-backfill.ts の runMealImageBackfill) が処理を起こす条件と件数。
 *
 *   - limit は積めた行と重複 (同じ料理のジョブが待ち) の数 (countMealImageJobsToProcess)。書き込みに失敗した行・処理中の重複 (#1561) は数えない
 *   - 1 行も積めず重複も無い (書き込みの失敗だけ) なら起こさない
 * 積み方 (enqueueMealImageJobs) と起こす関数 (triggerMealImageJobProcessing) は作り物にして、渡した値だけを見る。
 * 実 DB に対しての積み直しは tests/integration/rls/meal-image-backfill.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  enqueue: vi.fn(),
  trigger: vi.fn(async () => undefined),
}));

vi.mock('../supabase/functions/_shared/meal-image-jobs.ts', () => ({
  enqueueMealImageJobs: h.enqueue,
  triggerMealImageJobProcessing: h.trigger,
}));

import type { SupabaseClient } from '@supabase/supabase-js';
import { runMealImageBackfill, type MealImageBackfillOptions } from '../scripts/lib/meal-image-backfill';

const MEAL_ID = 'meal-1';
/** 画像を待っている AI の画像の料理 (3 品。役割が無いので、積み直すのは先頭の 1 品だけ。billing/03 Q-16) */
const WAITING_DISHES = [0, 1, 2].map((index) => ({
  name: `料理${index}`,
  image_status: 'pending',
  image_url: null,
  image_source: 'generated_ai',
  image_subject_hash: `hash-${index}`,
}));

/** planned_meals を読む作り物 (どの条件でも同じ 1 献立を返す。道具は id で重ねて数えないようにする) */
function makeAdmin(): SupabaseClient {
  const rows = [
    {
      id: MEAL_ID,
      dishes: WAITING_DISHES,
      image_url: null,
      catalog_product_id: null,
      source_type: null,
      user_daily_meals: { user_id: 'user-1', day_date: '2026-10-14' },
    },
  ];
  const builder: unknown = new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === 'then') return (resolve: (value: unknown) => unknown) => Promise.resolve({ data: rows, error: null }).then(resolve);
        return () => builder;
      },
    },
  );
  return { from: () => builder } as unknown as SupabaseClient;
}

const options = (): MealImageBackfillOptions => ({
  apply: true,
  maxMeals: 1,
  trigger: true,
  intervalMs: 0,
  supabaseUrl: 'http://supabase.test',
  serviceRoleKey: 'service-key',
  sleep: async () => undefined,
});

describe('#1532 runMealImageBackfill: 処理を起こす条件と件数', () => {
  beforeEach(() => {
    h.enqueue.mockReset();
    h.trigger.mockClear();
  });

  it('limit は積めた行と重複の数 (積めた 1・重複 1・失敗 1 の結果なら 2)', async () => {
    h.enqueue.mockResolvedValue({ inserted: 1, duplicates: 1, duplicatesProcessing: 0, failed: 1 });
    const report = await runMealImageBackfill(makeAdmin(), options());

    expect(h.enqueue).toHaveBeenCalledTimes(1);
    expect(h.enqueue.mock.calls[0][0].jobs.map((job: { dishIndex: number }) => job.dishIndex)).toEqual([0]);
    expect(h.trigger).toHaveBeenCalledTimes(1);
    expect(h.trigger).toHaveBeenCalledWith({
      supabaseUrl: 'http://supabase.test',
      serviceRoleKey: 'service-key',
      plannedMealId: MEAL_ID,
      limit: 2,
    });
    expect(report.triggeredMeals).toBe(1);
  });

  it('#1561 重複がどれも処理中なら起こさない。処理中の重複も報告の合計に数える', async () => {
    h.enqueue.mockResolvedValue({ inserted: 0, duplicates: 2, duplicatesProcessing: 2, failed: 0 });
    const report = await runMealImageBackfill(makeAdmin(), options());

    expect(h.trigger).not.toHaveBeenCalled();
    expect(report.triggeredMeals).toBe(0);
    expect(report.enqueue).toEqual({ inserted: 0, duplicates: 2, duplicatesProcessing: 2, failed: 0 });
  });

  it('書き込みの失敗だけ (積めた行も重複も無い) なら起こさない', async () => {
    h.enqueue.mockResolvedValue({ inserted: 0, duplicates: 0, duplicatesProcessing: 0, failed: WAITING_DISHES.length });
    const report = await runMealImageBackfill(makeAdmin(), options());

    expect(h.trigger).not.toHaveBeenCalled();
    expect(report.triggeredMeals).toBe(0);
    expect(report.enqueue).toEqual({ inserted: 0, duplicates: 0, duplicatesProcessing: 0, failed: WAITING_DISHES.length });
  });
});
