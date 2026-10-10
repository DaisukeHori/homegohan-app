/**
 * tests/planned-meal-nutrient-validation-routes.test.ts
 *
 * #1205: 食事の登録・更新 API が calories_kcal / protein_g / fat_g / carbs_g / meal_type を
 * 型・範囲の確認なしに planned_meals へ渡していた問題の回帰テスト。
 *
 * - 不正な入力 (負の値・範囲外・NaN・数値でない値・想定外の meal_type) は、DB に触れる前に
 *   400 (+ 項目ごとのメッセージ) で拒否され、INSERT / UPDATE は呼ばれない
 * - 正当な入力は、整数に丸めるなど正規化された値で DB に渡る
 * - AI の推定値 (写真から登録・栄養解析) は保存を止めず、範囲内に整えて保存する
 * 対象: POST /api/meals・PATCH /api/meals/[id]・POST /api/meal-plans/meals・
 *       PATCH /api/meal-plans/meals/[id]・POST /api/meal-plans/add-from-photo・POST /api/ai/nutrition
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// 同意の判定 (T15 / #1154) は「同意済み」に差し替える。同意が無いときに AI へ送らないことは tests/ai-consent-enforcement-routes.test.ts が実際の route を呼んで確かめる
vi.mock('@/lib/ai/consent-guard', () => import('./helpers/ai-consent-guard-allowed'));
vi.mock('../lib/catalog-products', () => ({
  buildCatalogSelectionUpdate: vi.fn(),
  clearCatalogSelectionMetadata: vi.fn(),
}));

vi.mock('../lib/meal-image-jobs', () => ({
  buildDishImagePayload: vi.fn(async (params: { nextDishes?: unknown; fallbackMealImageUrl?: string | null }) => ({
    dishes: params.nextDishes ?? null,
    jobs: [],
    mealCoverImageUrl: params.fallbackMealImageUrl ?? null,
  })),
  cancelPendingMealImageJobs: vi.fn(async () => undefined),
  enqueueMealImageJobs: vi.fn(async () => undefined),
  triggerMealImageJobProcessing: vi.fn(async () => undefined),
}));

vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(async () => ({ success: true, limit: 10, remaining: 9, reset: Date.now() + 60_000 })),
  rateLimitExceededResponse: vi.fn(),
}));

vi.mock('@/lib/db-logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const mockChatCreate = vi.fn();
vi.mock('@/lib/ai/fast-llm', () => ({
  getFastLLMClient: () => ({ chat: { completions: { create: mockChatCreate } } }),
  getFastLLMModel: () => 'test-model',
}));

const mockGetUser = vi.fn();
const mockFrom = vi.fn();
const supabaseClient = {
  auth: { getUser: mockGetUser },
  from: mockFrom,
};

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => supabaseClient,
}));

import { buildDishImagePayload } from '../lib/meal-image-jobs';
import { POST as mealsPOST } from '../src/app/api/meals/route';
import { PATCH as mealsPATCH } from '../src/app/api/meals/[id]/route';
import { POST as mealPlansPOST } from '../src/app/api/meal-plans/meals/route';
import { PATCH as mealPlansPATCH } from '../src/app/api/meal-plans/meals/[id]/route';
import { POST as addFromPhotoPOST } from '../src/app/api/meal-plans/add-from-photo/route';
import { POST as aiNutritionPOST } from '../src/app/api/ai/nutrition/route';

// ==================== モックの部品 ====================

/** どのメソッドを呼んでも自分自身を返し、await すると result になるクエリビルダ */
function queryBuilder(result: unknown) {
  const builder: Record<string, unknown> = {};
  for (const method of ['select', 'eq', 'order', 'limit', 'in']) {
    builder[method] = vi.fn(() => builder);
  }
  builder.single = vi.fn(async () => result);
  builder.maybeSingle = vi.fn(async () => result);
  builder.then = (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve);
  return builder;
}

/** insert(...).select().single() の戻り値を作る */
function insertBuilder(row: Record<string, unknown>) {
  return vi.fn(() => ({
    select: vi.fn(() => ({ single: vi.fn(async () => ({ data: row, error: null })) })),
  }));
}

/** update(...).eq(...).select().single() の戻り値を作る */
function updateBuilder(row: Record<string, unknown>) {
  return vi.fn(() => ({
    eq: vi.fn(() => ({
      select: vi.fn(() => ({ single: vi.fn(async () => ({ data: row, error: null })) })),
    })),
  }));
}

const jsonRequest = (url: string, method: string, body: unknown) =>
  new Request(url, { method, body: typeof body === 'string' ? body : JSON.stringify(body) });

async function readBody(response: Response) {
  return (await response.json()) as Record<string, any>;
}

/** 400 で、メッセージが項目ごとに付き、DB (from) にまったく触れていないこと */
async function expectRejectedWithoutDb(response: Response, fields: string[]) {
  expect(response.status).toBe(400);
  const body = await readBody(response);
  expect(body.code).toBe('VALIDATION_ERROR');
  expect(typeof body.error).toBe('string');
  expect(Object.keys(body.fieldErrors).sort()).toEqual([...fields].sort());
  expect(mockFrom).not.toHaveBeenCalled();
  expect(vi.mocked(buildDishImagePayload)).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null });
});

// ==================== POST /api/meals ====================

describe('POST /api/meals (#1205)', () => {
  const valid = { date: '2026-10-07', mealType: 'lunch', dishName: '定食' };
  const post = (body: unknown) => mealsPOST(jsonRequest('http://localhost/api/meals', 'POST', body));

  function mockDb() {
    const upsert = vi.fn(() => ({
      select: vi.fn(() => ({ single: vi.fn(async () => ({ data: { id: 'day-1' }, error: null })) })),
    }));
    const insert = insertBuilder({ id: 'meal-1' });
    mockFrom.mockImplementation((table: string) => {
      if (table === 'user_daily_meals') return { upsert };
      if (table === 'planned_meals') return { insert };
      throw new Error(`Unexpected table: ${table}`);
    });
    return { insert };
  }

  it.each([
    ['負の値', -1],
    ['上限 (5000) を超える値', 5001],
    ['桁外れの値', 1e12],
    ['数値でない文字列', 'abc'],
    ['文字列の NaN', 'NaN'],
    ['文字列の Infinity', 'Infinity'],
    ['真偽値', true],
    ['配列', [500]],
    ['オブジェクト', { kcal: 500 }],
  ])('caloriesKcal が %s なら 400 で、DB に触れない', async (_label, caloriesKcal) => {
    const response = await post({ ...valid, caloriesKcal });
    await expectRejectedWithoutDb(response, ['calories_kcal']);
  });

  it('JSON の 1e999 (パース結果が Infinity) も 400', async () => {
    const response = await post('{"date":"2026-10-07","mealType":"lunch","dishName":"定食","caloriesKcal":1e999}');
    await expectRejectedWithoutDb(response, ['calories_kcal']);
  });

  it.each(['brunch', 'Breakfast', '朝食', 5, ['lunch'], { type: 'lunch' }])(
    'mealType が %j なら 400 で、DB に触れない',
    async (mealType) => {
      const response = await post({ ...valid, mealType });
      await expectRejectedWithoutDb(response, ['meal_type']);
    },
  );

  it('meal_type と caloriesKcal の両方が不正なら、両方のメッセージを返す', async () => {
    const response = await post({ ...valid, mealType: 'brunch', caloriesKcal: -5 });
    await expectRejectedWithoutDb(response, ['meal_type', 'calories_kcal']);
  });

  it('必須項目が無いときは従来どおり 400 "Missing required fields"', async () => {
    const response = await post({ mealType: 'lunch' });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'Missing required fields' });
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it('未認証は従来どおり 401 (検証より先)', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null });
    const response = await post({ ...valid, caloriesKcal: -1 });
    expect(response.status).toBe(401);
  });

  it('正当な入力は、整数に丸めた calories_kcal で INSERT される', async () => {
    const { insert } = mockDb();
    const response = await post({ ...valid, caloriesKcal: 523.6 });
    expect(response.status).toBe(200);
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ meal_type: 'lunch', calories_kcal: 524 }));
  });

  it('数字の文字列 ("640") は数値として読んで INSERT される', async () => {
    const { insert } = mockDb();
    const response = await post({ ...valid, caloriesKcal: '640' });
    expect(response.status).toBe(200);
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ calories_kcal: 640 }));
  });

  it('caloriesKcal を送らなければ calories_kcal は書かない。null は null のまま', async () => {
    const { insert } = mockDb();
    expect((await post(valid)).status).toBe(200);
    expect(insert.mock.calls[0][0]).toMatchObject({ meal_type: 'lunch' });
    expect((insert.mock.calls[0][0] as Record<string, unknown>).calories_kcal).toBeUndefined();

    expect((await post({ ...valid, caloriesKcal: null })).status).toBe(200);
    expect((insert.mock.calls[1][0] as Record<string, unknown>).calories_kcal).toBeNull();
  });

  it.each(['breakfast', 'lunch', 'dinner', 'snack', 'midnight_snack'])('mealType %s は通る (夜食を含む)', async (mealType) => {
    const { insert } = mockDb();
    const response = await post({ ...valid, mealType });
    expect(response.status).toBe(200);
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ meal_type: mealType }));
  });
});

// ==================== PATCH /api/meals/[id] ====================

describe('PATCH /api/meals/[id] (#1205)', () => {
  const existing = {
    id: 'meal-1',
    mode: 'cook',
    catalog_product_id: null,
    source_type: 'manual',
    generation_metadata: null,
    dishes: null,
    image_url: null,
    user_daily_meals: { user_id: 'user-1' },
  };
  const patch = (body: unknown) =>
    mealsPATCH(jsonRequest('http://localhost/api/meals/meal-1', 'PATCH', body), { params: { id: 'meal-1' } });

  function mockDb() {
    const update = updateBuilder({ id: 'meal-1' });
    mockFrom.mockImplementation((table: string) => {
      if (table === 'planned_meals') return { select: () => queryBuilder({ data: existing, error: null }), update };
      throw new Error(`Unexpected table: ${table}`);
    });
    return { update };
  }

  it.each([
    ['calories_kcal', -1],
    ['calories_kcal', 5001],
    ['protein_g', -0.5],
    ['protein_g', 501],
    ['fat_g', 301],
    ['carbs_g', 801],
    ['carbs_g', 'abc'],
    ['fat_g', 'NaN'],
    ['protein_g', false],
  ])('%s = %j なら 400 で、DB に触れない', async (field, value) => {
    const response = await patch({ [field]: value });
    await expectRejectedWithoutDb(response, [field]);
  });

  it('複数の項目が不正なら、すべての項目のメッセージを返す', async () => {
    const response = await patch({ calories_kcal: -1, protein_g: 9999, fat_g: 'x', carbs_g: 10 });
    await expectRejectedWithoutDb(response, ['calories_kcal', 'protein_g', 'fat_g']);
  });

  it('正当な値は正規化して UPDATE する (calories は整数に丸め、数字の文字列は数値、null は値なし)', async () => {
    const { update } = mockDb();
    const response = await patch({
      dish_name: '鮭定食',
      calories_kcal: 523.6,
      protein_g: '20.5',
      fat_g: null,
      carbs_g: 80,
    });
    expect(response.status).toBe(200);
    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0][0]).toEqual({
      dish_name: '鮭定食',
      calories_kcal: 524,
      protein_g: 20.5,
      fat_g: null,
      carbs_g: 80,
      updated_at: expect.any(String),
    });
  });

  it('栄養素を送らない更新 (完食の切り替え) は、栄養素の列を書かない', async () => {
    const { update } = mockDb();
    const response = await patch({ is_completed: true, completed_at: '2026-10-07T12:00:00.000Z' });
    expect(response.status).toBe(200);
    expect(update.mock.calls[0][0]).toEqual({
      is_completed: true,
      completed_at: '2026-10-07T12:00:00.000Z',
      updated_at: expect.any(String),
    });
  });

  it('上限ちょうど・0 は通る', async () => {
    const { update } = mockDb();
    const response = await patch({ calories_kcal: 5000, protein_g: 0, fat_g: 300, carbs_g: 800 });
    expect(response.status).toBe(200);
    expect(update.mock.calls[0][0]).toMatchObject({ calories_kcal: 5000, protein_g: 0, fat_g: 300, carbs_g: 800 });
  });
});

// ==================== POST /api/meal-plans/meals ====================

describe('POST /api/meal-plans/meals (#1205)', () => {
  const valid = { dayDate: '2026-10-07', mealType: 'dinner', mode: 'cook', dishName: '手入力' };
  const post = (body: unknown) => mealPlansPOST(jsonRequest('http://localhost/api/meal-plans/meals', 'POST', body));

  function mockDb() {
    const insert = insertBuilder({ id: 'meal-1', daily_meal_id: 'day-1' });
    mockFrom.mockImplementation((table: string) => {
      if (table === 'user_daily_meals') return queryBuilder({ data: { id: 'day-1' }, error: null });
      if (table === 'planned_meals') return { insert };
      throw new Error(`Unexpected table: ${table}`);
    });
    return { insert };
  }

  it.each([
    ['負の値', -100],
    ['上限を超える値', 5001],
    ['数値でない文字列', 'many'],
    ['文字列の NaN', 'NaN'],
  ])('caloriesKcal が %s なら 400 で、DB に触れない', async (_label, caloriesKcal) => {
    const response = await post({ ...valid, caloriesKcal });
    await expectRejectedWithoutDb(response, ['calories_kcal']);
  });

  it.each(['brunch', 'Breakfast', '夕食', 3])('mealType が %j なら 400 で、DB に触れない', async (mealType) => {
    const response = await post({ ...valid, mealType });
    await expectRejectedWithoutDb(response, ['meal_type']);
  });

  it('必須項目が無いときは従来どおり 400', async () => {
    const response = await post({ dayDate: '2026-10-07' });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'dayDate and mealType are required' });
  });

  it('正当な入力は、整数に丸めた calories_kcal で INSERT される', async () => {
    const { insert } = mockDb();
    const response = await post({ ...valid, caloriesKcal: 612.4 });
    expect(response.status).toBe(200);
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ meal_type: 'dinner', calories_kcal: 612 }));
  });

  it('0 と未入力は従来どおり null で保存される', async () => {
    const { insert } = mockDb();
    expect((await post({ ...valid, caloriesKcal: 0 })).status).toBe(200);
    expect((await post(valid)).status).toBe(200);
    expect((await post({ ...valid, caloriesKcal: null })).status).toBe(200);
    for (const call of insert.mock.calls) {
      expect((call[0] as Record<string, unknown>).calories_kcal).toBeNull();
    }
  });

  it('夜食 (midnight_snack) は通る', async () => {
    const { insert } = mockDb();
    const response = await post({ ...valid, mealType: 'midnight_snack' });
    expect(response.status).toBe(200);
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ meal_type: 'midnight_snack' }));
  });
});

// ==================== PATCH /api/meal-plans/meals/[id] ====================

describe('PATCH /api/meal-plans/meals/[id] (#1205)', () => {
  const existing = {
    id: 'meal-1',
    mode: 'cook',
    catalog_product_id: null,
    source_type: 'manual',
    generation_metadata: null,
    dishes: null,
    image_url: null,
    user_daily_meals: { user_id: 'user-1' },
  };
  const patch = (body: unknown) =>
    mealPlansPATCH(jsonRequest('http://localhost/api/meal-plans/meals/meal-1', 'PATCH', body), {
      params: { id: 'meal-1' },
    });

  function mockDb() {
    const update = updateBuilder({ id: 'meal-1' });
    mockFrom.mockImplementation((table: string) => {
      if (table === 'planned_meals') return { select: () => queryBuilder({ data: existing, error: null }), update };
      throw new Error(`Unexpected table: ${table}`);
    });
    return { update };
  }

  it.each([
    ['負の値', -1],
    ['上限を超える値', 99999],
    ['数値でない文字列', 'abc'],
    ['文字列の Infinity', 'Infinity'],
  ])('caloriesKcal が %s なら 400 で、DB に触れない', async (_label, caloriesKcal) => {
    const response = await patch({ caloriesKcal });
    await expectRejectedWithoutDb(response, ['calories_kcal']);
  });

  it('正当な値は、整数に丸めて UPDATE する', async () => {
    const { update } = mockDb();
    const response = await patch({ dishName: '手動で変更', caloriesKcal: 523.4 });
    expect(response.status).toBe(200);
    expect(update.mock.calls[0][0]).toMatchObject({ dish_name: '手動で変更', calories_kcal: 523 });
  });

  it('null は値なしとして UPDATE する (モバイル・Web が合計 0 のときに送る)', async () => {
    const { update } = mockDb();
    const response = await patch({ caloriesKcal: null });
    expect(response.status).toBe(200);
    expect((update.mock.calls[0][0] as Record<string, unknown>).calories_kcal).toBeNull();
  });

  it('caloriesKcal を送らない更新 (完食の切り替え) は、calories_kcal を書かない', async () => {
    const { update } = mockDb();
    const response = await patch({ isCompleted: true });
    expect(response.status).toBe(200);
    expect('calories_kcal' in (update.mock.calls[0][0] as Record<string, unknown>)).toBe(false);
  });
});

// ==================== POST /api/meal-plans/add-from-photo ====================

describe('POST /api/meal-plans/add-from-photo (#1205)', () => {
  const valid = {
    dayDate: '2026-10-07',
    mealType: 'dinner',
    dishes: [{ name: 'カレー', cal: 620, role: 'main' }],
    totalCalories: 620,
  };
  const post = (body: unknown) =>
    addFromPhotoPOST(jsonRequest('http://localhost/api/meal-plans/add-from-photo', 'POST', body));

  function mockDb() {
    const insert = insertBuilder({ id: 'meal-1' });
    const del = vi.fn(() => queryBuilder({ error: null }));
    mockFrom.mockImplementation((table: string) => {
      if (table === 'user_daily_meals') return queryBuilder({ data: { id: 'day-1' }, error: null });
      if (table === 'planned_meals') {
        return { select: () => queryBuilder({ data: [], error: null }), delete: del, insert };
      }
      throw new Error(`Unexpected table: ${table}`);
    });
    return { insert, del };
  }

  it.each(['brunch', 'Dinner', '', null, undefined, 7])(
    'mealType が %j なら 400 で、同じ meal_type の既存の食事を削除せず、DB に触れない',
    async (mealType) => {
      const response = await post({ ...valid, mealType });
      await expectRejectedWithoutDb(response, ['meal_type']);
    },
  );

  it('正当な入力は INSERT される', async () => {
    const { insert } = mockDb();
    const response = await post(valid);
    expect(response.status).toBe(200);
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ meal_type: 'dinner', calories_kcal: 620 }));
  });

  it.each([
    ['上限を超える推定値は上限にする', 99999, 5000],
    ['小数は四捨五入する', 620.4, 620],
    ['数字の文字列は数値として読む', '640', 640],
    ['負の値は値なし (null)', -5, null],
    ['数値でない値は値なし (null)', 'abc', null],
    ['NaN の文字列は値なし (null)', 'NaN', null],
    ['0 は従来どおり null', 0, null],
    ['未入力は従来どおり null', undefined, null],
  ])('totalCalories: %s', async (_label, totalCalories, expected) => {
    const { insert } = mockDb();
    const response = await post({ ...valid, totalCalories });
    // AI の推定値が範囲外でも、写真からの登録そのものは失敗させない
    expect(response.status).toBe(200);
    expect((insert.mock.calls[0][0] as Record<string, unknown>).calories_kcal).toBe(expected);
  });
});

// ==================== POST /api/ai/nutrition ====================

describe('POST /api/ai/nutrition (#1205)', () => {
  const existing = { id: 'meal-1', dishes: null, is_simple: true, user_daily_meals: { user_id: 'user-1' } };
  const post = (body: unknown) => aiNutritionPOST(jsonRequest('http://localhost/api/ai/nutrition', 'POST', body));

  function mockDb() {
    const updateEq = vi.fn(async () => ({ error: null }));
    const update = vi.fn(() => ({ eq: updateEq }));
    mockFrom.mockImplementation((table: string) => {
      if (table === 'planned_meals') return { select: () => queryBuilder({ data: existing, error: null }), update };
      throw new Error(`Unexpected table: ${table}`);
    });
    return { update };
  }

  describe('nutritionData (クライアントから直接渡された栄養素)', () => {
    it.each([
      ['calories_kcal', -1],
      ['calories_kcal', 99999],
      ['protein_g', 'abc'],
      ['fat_g', 301],
      ['carbs_g', 'NaN'],
    ])('%s = %j なら 400 で、UPDATE しない', async (field, value) => {
      const { update } = mockDb();
      const response = await post({ plannedMealId: 'meal-1', nutritionData: { calories_kcal: 500, [field]: value } });
      expect(response.status).toBe(400);
      const body = await readBody(response);
      expect(body.code).toBe('VALIDATION_ERROR');
      expect(Object.keys(body.fieldErrors)).toEqual([field]);
      expect(update).not.toHaveBeenCalled();
    });

    it('正当な値は正規化して UPDATE する。送られていない項目は書かない', async () => {
      const { update } = mockDb();
      const response = await post({
        plannedMealId: 'meal-1',
        nutritionData: { calories_kcal: 523.6, protein_g: '20.5', veg_score: 4 },
      });
      expect(response.status).toBe(200);
      const payload = update.mock.calls[0][0] as Record<string, unknown>;
      expect(payload).toMatchObject({ calories_kcal: 524, protein_g: 20.5, veg_score: 4 });
      expect('fat_g' in payload).toBe(false);
      expect('carbs_g' in payload).toBe(false);
    });
  });

  describe('imageUrl (AI の写真解析)', () => {
    const aiReturns = (result: Record<string, unknown>) =>
      mockChatCreate.mockResolvedValue({ choices: [{ message: { content: JSON.stringify(result) } }] });

    it('AI の推定値が範囲外でも保存を止めず、範囲内に整えて UPDATE する', async () => {
      const { update } = mockDb();
      aiReturns({
        calories_kcal: 99999,
        protein_g: -3,
        fat_g: '12.5',
        carbs_g: null,
        veg_score: 3,
        quality_tags: [],
        dishes: [],
      });
      const response = await post({ plannedMealId: 'meal-1', imageUrl: 'https://example.com/a.jpg' });
      expect(response.status).toBe(200);
      expect(update.mock.calls[0][0]).toMatchObject({
        calories_kcal: 5000,
        protein_g: null,
        fat_g: 12.5,
        carbs_g: null,
      });
    });

    it('AI の応答に含まれない項目は書かない (既存の値を消さない)', async () => {
      const { update } = mockDb();
      aiReturns({ calories_kcal: 480.4, veg_score: 2, quality_tags: [], dishes: [] });
      const response = await post({ plannedMealId: 'meal-1', imageUrl: 'https://example.com/a.jpg' });
      expect(response.status).toBe(200);
      const payload = update.mock.calls[0][0] as Record<string, unknown>;
      expect(payload.calories_kcal).toBe(480);
      for (const field of ['protein_g', 'fat_g', 'carbs_g']) {
        expect(field in payload).toBe(false);
      }
    });
  });
});
