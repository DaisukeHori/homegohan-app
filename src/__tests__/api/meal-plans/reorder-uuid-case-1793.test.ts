import { describe, it, expect, vi, beforeEach } from 'vitest';

// #1793 POST /api/meal-plans/meals/reorder: 本文の mealId を DB の小文字の id と findIndex の === で比べていたため、
// 正しい本人が mealId を大文字・混在の UUID で送ると 404 (Meal not found) になっていた。
// 受け取った直後に normalizeUuid でそろえ、照合・DB にはそろえた値だけを使うことを固定する。

const mockGetUser = vi.fn();
const mockFrom = vi.fn();

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: mockGetUser },
    from: mockFrom,
  })),
}));

const { POST } = await import('@/app/api/meal-plans/meals/reorder/route');

const USER = { id: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11' };
// 16 進の英字を含む id (DB の id は小文字)
const DAY_ID = 'dabcdef0-1234-4abc-8def-0123456789ab';
const LUNCH_1 = 'abcdef12-3456-4abc-8def-0123456789ab';
const LUNCH_2 = 'bcdef123-4567-4bcd-9ef0-123456789abc';
const MEALS = [
  { id: LUNCH_1, meal_type: 'lunch', display_order: 1 },
  { id: LUNCH_2, meal_type: 'lunch', display_order: 2 },
];

/** 英字を 1 文字おきに大文字にする (大文字・小文字の混在) */
const mixedCase = (id: string) => id.replace(/[a-f]/g, (c, i: number) => (i % 2 === 0 ? c.toUpperCase() : c));

let selectEqCalls: unknown[][];
let updates: Array<{ values: unknown; eq: unknown[] }>;

const postRequest = (body: unknown) =>
  new Request('http://localhost/api/meal-plans/meals/reorder', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  vi.clearAllMocks();
  selectEqCalls = [];
  updates = [];
  mockGetUser.mockResolvedValue({ data: { user: USER }, error: null });
  mockFrom.mockImplementation((table: string) => {
    if (table !== 'planned_meals') throw new Error(`想定外のテーブル: ${table}`);
    return {
      select: () => ({
        eq: (...args: unknown[]) => {
          selectEqCalls.push(args);
          return { order: async () => ({ data: MEALS, error: null }) };
        },
      }),
      update: (values: unknown) => ({
        eq: async (...args: unknown[]) => {
          updates.push({ values, eq: args });
          return { error: null };
        },
      }),
    };
  });
});

describe('POST /api/meal-plans/meals/reorder: 大文字・混在の UUID (#1793)', () => {
  it('mealId を大文字で送っても 404 にならず、同じ区分の次の食事と display_order を入れ替える', async () => {
    const res = await POST(postRequest({ mealId: LUNCH_1.toUpperCase(), direction: 'down', dayId: DAY_ID }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toEqual({
      success: true,
      message: '順序を変更しました',
      swapped: {
        meal1: { id: LUNCH_1, newOrder: 2 },
        meal2: { id: LUNCH_2, newOrder: 1 },
      },
    });
    expect(updates).toEqual([
      { values: { display_order: 2 }, eq: ['id', LUNCH_1] },
      { values: { display_order: 1 }, eq: ['id', LUNCH_2] },
    ]);
  });

  it('mealId と dayId を大文字・小文字の混在で送っても同じで、その日の食事の取得には小文字の dayId を渡す', async () => {
    const mixedMealId = mixedCase(LUNCH_2);
    const mixedDayId = mixedCase(DAY_ID);
    expect(mixedMealId).not.toBe(LUNCH_2);
    expect(mixedMealId).not.toBe(LUNCH_2.toUpperCase());
    expect(mixedDayId).not.toBe(DAY_ID);

    const res = await POST(postRequest({ mealId: mixedMealId, direction: 'up', dayId: mixedDayId }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.swapped).toEqual({
      meal1: { id: LUNCH_2, newOrder: 1 },
      meal2: { id: LUNCH_1, newOrder: 2 },
    });
    expect(selectEqCalls).toEqual([['daily_meal_id', DAY_ID]]);
  });

  it('その日に無い食事の id は大文字にしても 404 のまま (書き込まない)', async () => {
    const otherMealId = 'cdef1234-5678-4cde-af01-23456789abcd';
    const res = await POST(postRequest({ mealId: otherMealId.toUpperCase(), direction: 'down', dayId: DAY_ID }));

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: '食事が見つかりません' });
    expect(updates).toEqual([]);
  });
});
