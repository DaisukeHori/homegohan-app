// @vitest-environment node
/**
 * #1790 (同じ型の掃除): POST /api/ai/menu/v4/generate・v5/generate の targetSlots[].plannedMealId は、UUID の形なら
 * 小文字にそろえてから使う。
 *
 * Postgres の uuid は大文字小文字を区別せずに比べるので、大文字の plannedMealId でも planned_meals の .in('id', ...) は自分の食事に当たる。
 * そろえないと、DB から読んだ id (小文字) との突き合わせ (foundIds / byId) が外れて plannedMealId が「見つからない」として消され、
 * 区分・日付の確認も飛ばして既存の食事を置き換えない生成に進んでいた。
 *   - .in('id', ...) に渡す id は小文字
 *   - DB から読んだ食事と突き合わせが成り立つ (区分が違えば 400「指定した献立の食事の区分が、選んだ枠と一致しません」になる = 突き合わせた印)
 *   - 同じ食事を大文字小文字だけ変えて 2 回送ると、DB に触れる前に重複として 400
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  getUser: vi.fn(),
  from: vi.fn(),
  plannedMealsIn: vi.fn(),
  checkRateLimit: vi.fn(),
  callV4: vi.fn(),
  callV5: vi.fn(),
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { getUser: h.getUser }, from: h.from }),
  // AI のキューへ書く service role のクライアント (getAiQueueWriter)。この試験の範囲では書くところまで進まない
  getSupabaseAdmin: () => ({
    from: () => {
      throw new Error('QUEUE_TOUCHED');
    },
  }),
}));
// 同意の判定は「同意済み」に差し替える (同意が無いときの動きは tests/ai-consent-enforcement-routes.test.ts が見る)
vi.mock('@/lib/ai/consent-guard', () => import('./helpers/ai-consent-guard-allowed'));
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: h.checkRateLimit,
  rateLimitExceededResponse: vi.fn(),
}));
vi.mock('@/lib/feature-flags', () => ({ isFeatureEnabled: vi.fn(async () => false) }));
vi.mock('@/lib/generate-menu-v4-retry', () => ({
  callGenerateMenuV4WithRetry: h.callV4,
  markWeeklyMenuRequestFailed: vi.fn(),
}));
vi.mock('@/lib/generate-menu-v5-retry', () => ({ callGenerateMenuV5WithRetry: h.callV5 }));
vi.mock('@vercel/functions', () => ({ waitUntil: vi.fn() }));

import { POST as postV4Generate } from '../src/app/api/ai/menu/v4/generate/route';
import { POST as postV5Generate } from '../src/app/api/ai/menu/v5/generate/route';

const USER_ID = 'a1b2c3d4-0000-4000-8000-00000000abcd';
const DATE = '2099-01-01';
const NEXT_DATE = '2099-01-02';
/** 16 進の英字を含む自分の食事の id (小文字 = DB に保存されている形) */
const PLANNED_MEAL_ID = '0c6a3b7e-1111-4222-8333-944455556666';
const PLANNED_MEAL_ID_UPPER = '0C6A3B7E-1111-4222-8333-944455556666';
const PLANNED_MEAL_ID_MIXED = '0c6A3b7E-1111-4222-8333-944455556666';

/** HTTP の入力の誤り */
const HTTP_BAD_REQUEST = 400;

function jsonRequest(body: unknown): Request {
  return new Request('http://localhost/api/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  // 本物のキーではないダミー値 (getSupabaseServiceConfig は環境変数の有無だけを見る)
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'http://127.0.0.1:54321');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'test-service-role-key');
  h.getUser.mockResolvedValue({ data: { user: { id: USER_ID } }, error: null });
  h.checkRateLimit.mockResolvedValue({ success: true });
  // planned_meals だけを読める。DB は保存された小文字の id で、区分は lunch の食事を 1 件返す
  // (Postgres と同じく、.in('id', ...) の照合は大文字小文字を区別しない)
  h.from.mockImplementation((table: string) => {
    if (table !== 'planned_meals') throw new Error(`DB_TOUCHED: ${table}`);
    return {
      select: () => ({
        in: (column: string, ids: string[]) => {
          h.plannedMealsIn(column, ids);
          const hit = ids.some((id) => id.toLowerCase() === PLANNED_MEAL_ID);
          return {
            eq: async () => ({
              data: hit
                ? [
                    {
                      id: PLANNED_MEAL_ID,
                      meal_type: 'lunch',
                      daily_meal_id: 'daily-1',
                      user_daily_meals: { day_date: DATE, user_id: USER_ID },
                    },
                  ]
                : [],
              error: null,
            }),
          };
        },
      }),
    };
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe.each([
  { name: 'POST /api/ai/menu/v4/generate', post: postV4Generate },
  { name: 'POST /api/ai/menu/v5/generate', post: postV5Generate },
])('$name: 大文字の plannedMealId でも自分の食事と突き合わせる (#1790)', ({ post }) => {
  it.each([
    ['すべて大文字', PLANNED_MEAL_ID_UPPER],
    ['大文字小文字の混在', PLANNED_MEAL_ID_MIXED],
  ])('plannedMealId が%s: 小文字の id で読み、読んだ食事と突き合わせる (区分が違うので 400 mealType mismatch)', async (_label, plannedMealId) => {
    expect(plannedMealId).not.toBe(PLANNED_MEAL_ID);
    expect(plannedMealId.toLowerCase()).toBe(PLANNED_MEAL_ID);

    const res = await post(jsonRequest({ targetSlots: [{ date: DATE, mealType: 'dinner', plannedMealId }] }));

    expect(h.plannedMealsIn).toHaveBeenCalledTimes(1);
    expect(h.plannedMealsIn).toHaveBeenCalledWith('id', [PLANNED_MEAL_ID]);
    // 突き合わせが外れて plannedMealId を消していたら、区分の確認を飛ばして先 (user_daily_meals など) へ進んでいた
    expect(res.status).toBe(HTTP_BAD_REQUEST);
    expect(await res.json()).toEqual({ error: '指定した献立の食事の区分が、選んだ枠と一致しません' });
    expect(h.callV4).not.toHaveBeenCalled();
    expect(h.callV5).not.toHaveBeenCalled();
  });

  it('同じ食事を大文字小文字だけ変えて 2 回送ると、DB・認証に触れる前に重複として 400', async () => {
    const res = await post(
      jsonRequest({
        targetSlots: [
          { date: DATE, mealType: 'lunch', plannedMealId: PLANNED_MEAL_ID },
          { date: NEXT_DATE, mealType: 'dinner', plannedMealId: PLANNED_MEAL_ID_UPPER },
        ],
      }),
    );

    expect(res.status).toBe(HTTP_BAD_REQUEST);
    expect(await res.json()).toEqual({ error: `同じ枠 (${NEXT_DATE} の dinner) が 2 回指定されています` });
    expect(h.getUser).not.toHaveBeenCalled();
    expect(h.from).not.toHaveBeenCalled();
  });
});
