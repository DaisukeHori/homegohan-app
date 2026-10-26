/**
 * tests/meal-photo-result-watch.test.ts
 *
 * #2047: 週間献立の「写真から入力」(mealId つきの /api/ai/analyze-meal-photo) は、route の 200 のあとに Edge の背景の処理で
 * 解析して planned_meals を書く (10〜20 秒)。以前の画面は 200 のすぐあとに 1 回だけ献立を読み直していたので、解析の前の献立を置いていた。
 * src/lib/meal-photo-result-watch.ts の waitForMealPhotoResult は、結果が書かれたことが分かるまで上限つきで読み直す。
 *   - 結果の印 = 頼む前に無かった image_generated_at を持つ image_source 'meal_photo' の料理 (Edge の buildPhotoDishList が置く)
 *   - updated_at だけが進んだ (#2041 の CAS の印を付けただけ) のは、結果ではない
 *   - 結果が書かれない (解析の失敗・#2041 の CAS で捨てた) ときは、回数と全体の時間の上限で止まる (待ち続けない)
 */

import { describe, it, expect, vi } from 'vitest';
import {
  PHOTO_RESULT_MAX_POLLS,
  PHOTO_RESULT_POLL_INTERVAL_MS,
  PHOTO_RESULT_POLL_TIMEOUT_MS,
  findMealInWeek,
  isPhotoResultWritten,
  photoResultBaseline,
  waitForMealPhotoResult,
  type PhotoResultMealLike,
  type PhotoResultWeekLike,
} from '../src/lib/meal-photo-result-watch';

const MEAL_ID = 'meal-target';
const OTHER_MEAL_ID = 'meal-other';
const BEFORE_UPDATED_AT = '2026-10-26T00:00:00.000Z';
const CLAIMED_UPDATED_AT = '2026-10-26T00:00:01.000Z';
const WRITTEN_UPDATED_AT = '2026-10-26T00:00:15.000Z';
const PHOTO_WRITTEN_AT = '2026-10-26T00:00:14.900Z';
const OLD_PHOTO_WRITTEN_AT = '2026-10-25T09:00:00.000Z';

type TestMeal = PhotoResultMealLike & { updatedAt: string };
type TestWeek = PhotoResultWeekLike<TestMeal> & { tag: string };

/** AI が作った献立 (写真の解析の前) */
const aiMeal: TestMeal = {
  id: MEAL_ID,
  dishName: '鮭の塩焼き',
  imageUrl: 'https://example.test/generated.jpg',
  description: null,
  updatedAt: BEFORE_UPDATED_AT,
  dishes: [{ image_source: 'generated_ai', image_generated_at: '2026-10-20T00:00:00.000Z' }],
};

/** #2041 の CAS の印を付けただけ (updated_at が進んだ。中身は変わらない) */
const claimedMeal: TestMeal = { ...aiMeal, updatedAt: CLAIMED_UPDATED_AT };

/** Edge が写真の結果を書いたあと */
const photoWrittenMeal: TestMeal = {
  id: MEAL_ID,
  dishName: 'カレーライス、サラダ',
  imageUrl: 'https://example.test/user/meals/photo.jpg',
  description: 'よく食べました',
  updatedAt: WRITTEN_UPDATED_AT,
  dishes: [
    { image_source: 'meal_photo', image_generated_at: PHOTO_WRITTEN_AT },
    { image_source: 'meal_photo', image_generated_at: PHOTO_WRITTEN_AT },
  ],
};

const otherMeal: TestMeal = { ...aiMeal, id: OTHER_MEAL_ID };

function weekWith(tag: string, ...meals: TestMeal[]): TestWeek {
  return { tag, dailyMeals: [{ meals: [otherMeal] }, { meals }] };
}

/** 時計を進める sleep (待つたびに ms だけ進む) */
function fakeClock() {
  let current = 0;
  return {
    now: () => current,
    sleep: vi.fn(async (ms: number) => {
      current += ms;
    }),
    advance: (ms: number) => {
      current += ms;
    },
  };
}

describe('上限は名前付きの定数 (#2047)', () => {
  it('回数の上限は、全体の時間 ÷ 間隔 (時間と回数がそろう)', () => {
    expect(PHOTO_RESULT_POLL_INTERVAL_MS).toBeGreaterThan(0);
    expect(PHOTO_RESULT_POLL_TIMEOUT_MS).toBeGreaterThan(PHOTO_RESULT_POLL_INTERVAL_MS);
    expect(PHOTO_RESULT_MAX_POLLS).toBe(Math.ceil(PHOTO_RESULT_POLL_TIMEOUT_MS / PHOTO_RESULT_POLL_INTERVAL_MS));
  });
});

describe('isPhotoResultWritten: 結果が書かれたかの見分け (#2047)', () => {
  it('CAS の印を付けただけ (updated_at だけ進んだ) は、結果ではない', () => {
    expect(isPhotoResultWritten(claimedMeal, photoResultBaseline(aiMeal))).toBe(false);
  });

  it('頼む前と同じ献立は、結果ではない', () => {
    expect(isPhotoResultWritten(aiMeal, photoResultBaseline(aiMeal))).toBe(false);
  });

  it("新しい image_generated_at の 'meal_photo' の料理が現れたら、結果が書かれた", () => {
    expect(isPhotoResultWritten(photoWrittenMeal, photoResultBaseline(aiMeal))).toBe(true);
  });

  it('前の写真の結果の献立に写真を送り直したとき: 前の結果のままなら結果ではなく、新しい結果が書かれたら結果', () => {
    const previousPhotoMeal: TestMeal = {
      ...photoWrittenMeal,
      dishes: [{ image_source: 'meal_photo', image_generated_at: OLD_PHOTO_WRITTEN_AT }],
    };
    const baseline = photoResultBaseline(previousPhotoMeal);
    expect(isPhotoResultWritten({ ...previousPhotoMeal, updatedAt: CLAIMED_UPDATED_AT }, baseline)).toBe(false);
    expect(isPhotoResultWritten(photoWrittenMeal, baseline)).toBe(true);
  });

  it("ほかの書き手が中身を変えただけ ('meal_photo' の新しい料理が無い) は、結果ではない", () => {
    const editedMeal: TestMeal = { ...aiMeal, dishName: '手で直した料理', dishes: [{ image_source: 'manual_override', image_generated_at: PHOTO_WRITTEN_AT }] };
    expect(isPhotoResultWritten(editedMeal, photoResultBaseline(aiMeal))).toBe(false);
  });

  it('料理が 0 品の結果 (料理を読み取れなかった) は、0 品になって中身が変わったことで見分ける', () => {
    const emptyResult: TestMeal = { ...aiMeal, dishName: '写真から入力', imageUrl: 'https://example.test/user/meals/empty.jpg', dishes: [] };
    expect(isPhotoResultWritten(emptyResult, photoResultBaseline(aiMeal))).toBe(true);
    // 頼む前から 0 品で、中身も同じなら結果ではない
    const emptyBefore: TestMeal = { ...aiMeal, dishes: [] };
    expect(isPhotoResultWritten({ ...emptyBefore, updatedAt: CLAIMED_UPDATED_AT }, photoResultBaseline(emptyBefore))).toBe(false);
  });

  it('dishes が null の献立も扱える', () => {
    const nullDishes: TestMeal = { ...aiMeal, dishes: null };
    expect(isPhotoResultWritten(nullDishes, photoResultBaseline(nullDishes))).toBe(false);
  });
});

describe('findMealInWeek', () => {
  it('週の献立から mealId の献立を探す。無ければ null', () => {
    expect(findMealInWeek(weekWith('w', aiMeal), MEAL_ID)).toBe(aiMeal);
    expect(findMealInWeek(weekWith('w'), MEAL_ID)).toBeNull();
    expect(findMealInWeek(null, MEAL_ID)).toBeNull();
    expect(findMealInWeek({ dailyMeals: null }, MEAL_ID)).toBeNull();
  });
});

describe('waitForMealPhotoResult: 解析が終わってから献立を読む (#2047)', () => {
  it('route の 200 のすぐあとには読まない (読む前に間隔だけ待つ)', async () => {
    const clock = fakeClock();
    const order: string[] = [];
    clock.sleep.mockImplementation(async (ms: number) => {
      order.push(`sleep:${ms}`);
      clock.advance(ms);
    });
    const fetchWeek = vi.fn(async () => {
      order.push('fetch');
      return weekWith('written', photoWrittenMeal);
    });
    await waitForMealPhotoResult({ mealId: MEAL_ID, baseline: photoResultBaseline(aiMeal), fetchWeek, isActive: () => true, sleep: clock.sleep, now: clock.now });
    expect(order).toEqual([`sleep:${PHOTO_RESULT_POLL_INTERVAL_MS}`, 'fetch']);
  });

  it('CAS の印だけの献立 (解析中) を読んでも止まらず、結果が書かれた献立を読んだところで written を返す', async () => {
    const clock = fakeClock();
    const weeks = [weekWith('before', aiMeal), weekWith('claimed', claimedMeal), weekWith('written', photoWrittenMeal)];
    const fetchWeek = vi.fn(async () => weeks.shift() ?? null);
    const outcome = await waitForMealPhotoResult({ mealId: MEAL_ID, baseline: photoResultBaseline(aiMeal), fetchWeek, isActive: () => true, sleep: clock.sleep, now: clock.now });
    expect(outcome.status).toBe('written');
    expect(outcome.status === 'written' && outcome.week.tag).toBe('written');
    expect(fetchWeek).toHaveBeenCalledTimes(3);
  });

  it('結果が書かれない (#2041 の CAS で捨てた・解析の失敗) ときは、回数の上限で止まって timeout と最後に読めた週を返す', async () => {
    const clock = fakeClock();
    const fetchWeek = vi.fn(async () => weekWith('claimed', claimedMeal));
    const outcome = await waitForMealPhotoResult({ mealId: MEAL_ID, baseline: photoResultBaseline(aiMeal), fetchWeek, isActive: () => true, sleep: clock.sleep, now: clock.now });
    expect(outcome.status).toBe('timeout');
    expect(outcome.status === 'timeout' && outcome.week?.tag).toBe('claimed');
    expect(fetchWeek).toHaveBeenCalledTimes(PHOTO_RESULT_MAX_POLLS);
  });

  it('ほかの書き手が解析のあいだに献立を書いた (CAS で写真の結果は書かれない) ときも、上限で止まる', async () => {
    const clock = fakeClock();
    const editedMeal: TestMeal = { ...aiMeal, dishName: '手で直した料理', updatedAt: WRITTEN_UPDATED_AT };
    const fetchWeek = vi.fn(async () => weekWith('edited', editedMeal));
    const outcome = await waitForMealPhotoResult({ mealId: MEAL_ID, baseline: photoResultBaseline(aiMeal), fetchWeek, isActive: () => true, sleep: clock.sleep, now: clock.now });
    expect(outcome.status).toBe('timeout');
    expect(outcome.status === 'timeout' && outcome.week?.tag).toBe('edited');
  });

  it('読み直しが遅くても、全体の時間の上限で止まる (回数の上限より先に)', async () => {
    const clock = fakeClock();
    const slowFetchMs = PHOTO_RESULT_POLL_TIMEOUT_MS / 2;
    const fetchWeek = vi.fn(async () => {
      clock.advance(slowFetchMs);
      return weekWith('claimed', claimedMeal);
    });
    const outcome = await waitForMealPhotoResult({ mealId: MEAL_ID, baseline: photoResultBaseline(aiMeal), fetchWeek, isActive: () => true, sleep: clock.sleep, now: clock.now });
    expect(outcome.status).toBe('timeout');
    expect(fetchWeek.mock.calls.length).toBeLessThan(PHOTO_RESULT_MAX_POLLS);
    expect(fetchWeek).toHaveBeenCalledTimes(2);
  });

  it('読めなかった回 (null・例外) も 1 回に数えて次を待ち、1 度も読めなければ week は null', async () => {
    const clock = fakeClock();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let calls = 0;
    const fetchWeek = vi.fn(async () => {
      calls++;
      if (calls % 2 === 0) throw new Error('network');
      return null;
    });
    const outcome = await waitForMealPhotoResult({ mealId: MEAL_ID, baseline: photoResultBaseline(aiMeal), fetchWeek, isActive: () => true, sleep: clock.sleep, now: clock.now });
    expect(outcome).toEqual({ status: 'timeout', week: null });
    expect(fetchWeek).toHaveBeenCalledTimes(PHOTO_RESULT_MAX_POLLS);
    warn.mockRestore();
  });

  it('読めなかった回のあとに結果が書かれた献立を読めたら written', async () => {
    const clock = fakeClock();
    const responses: Array<TestWeek | null> = [null, weekWith('written', photoWrittenMeal)];
    const fetchWeek = vi.fn(async () => responses.shift() ?? null);
    const outcome = await waitForMealPhotoResult({ mealId: MEAL_ID, baseline: photoResultBaseline(aiMeal), fetchWeek, isActive: () => true, sleep: clock.sleep, now: clock.now });
    expect(outcome.status).toBe('written');
  });

  it('待っているあいだに献立が見つからなくなったら meal_missing (待ち続けない)', async () => {
    const clock = fakeClock();
    const fetchWeek = vi.fn(async () => weekWith('deleted'));
    const outcome = await waitForMealPhotoResult({ mealId: MEAL_ID, baseline: photoResultBaseline(aiMeal), fetchWeek, isActive: () => true, sleep: clock.sleep, now: clock.now });
    expect(outcome.status).toBe('meal_missing');
    expect(outcome.status === 'meal_missing' && outcome.week.tag).toBe('deleted');
    expect(fetchWeek).toHaveBeenCalledTimes(1);
  });

  it('待つのをやめた (アンマウント) ら、読む前でも読んだあとでも cancelled を返し、それ以上読まない', async () => {
    const clock = fakeClock();
    let active = true;
    const fetchWeek = vi.fn(async () => {
      active = false;
      return weekWith('written', photoWrittenMeal);
    });
    const afterFetch = await waitForMealPhotoResult({ mealId: MEAL_ID, baseline: photoResultBaseline(aiMeal), fetchWeek, isActive: () => active, sleep: clock.sleep, now: clock.now });
    expect(afterFetch).toEqual({ status: 'cancelled' });
    expect(fetchWeek).toHaveBeenCalledTimes(1);

    const neverFetch = vi.fn(async () => weekWith('written', photoWrittenMeal));
    const beforeFetch = await waitForMealPhotoResult({ mealId: MEAL_ID, baseline: photoResultBaseline(aiMeal), fetchWeek: neverFetch, isActive: () => false, sleep: clock.sleep, now: clock.now });
    expect(beforeFetch).toEqual({ status: 'cancelled' });
    expect(neverFetch).not.toHaveBeenCalled();
  });

  it('間隔・上限を指定しなければ名前付きの定数を使う (既定の sleep は実時間で待つ)', async () => {
    vi.useFakeTimers();
    try {
      const fetchWeek = vi.fn(async () => weekWith('written', photoWrittenMeal));
      const pending = waitForMealPhotoResult({ mealId: MEAL_ID, baseline: photoResultBaseline(aiMeal), fetchWeek, isActive: () => true });
      await vi.advanceTimersByTimeAsync(PHOTO_RESULT_POLL_INTERVAL_MS - 1);
      expect(fetchWeek).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await expect(pending).resolves.toMatchObject({ status: 'written' });
    } finally {
      vi.useRealTimers();
    }
  });
});
