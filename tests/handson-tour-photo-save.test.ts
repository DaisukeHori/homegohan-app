/**
 * #1604: ハンズオンツアー Step 1 の保存 (packages/handson-tour-shared/src/photo-save.ts の本文 (#1625 で Web とモバイルの共有へ移した) と、
 * POST /api/meal-plans/add-from-photo の sandbox 経路 = src/lib/handson-tour/sandbox-photo-meal.ts) のテスト。
 *
 * 以前のツアーは MOCK_PHOTO_RESPONSE に sandbox / source を足しただけの本文を送っていて、
 * route が読む mealType が無く、mealType の検証で 400 になっていた (#846 の E2E で発見)。
 *
 * 設計書 docs/design/family/09-onboarding-handson-tour/03-step1-photo.md §3.7 の決め: 保存した「今」の「夕食」(meal_type: 'dinner')。
 * お試しの記録は meals (is_sandbox = true) の 1 行に入れる (13-integration §2.7)。user_daily_meals には書かない:
 *   - 今日の user_daily_meals をお試しで作ると、同じ日の本物の記録が UNIQUE(user_id, day_date) でそこにぶら下がる
 *   - uniq_user_sandbox_daily_meal (利用者ごとに 1 行) があり、別の日にやり直すと 2 行目の insert が一意違反になる
 * (DB は tests/helpers/fake-sandbox-supabase.ts のフェイク)
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MOCK_PHOTO_RESPONSE,
  SANDBOX_NOT_ELIGIBLE_CODE,
  TOUR_PHOTO_MEAL_TYPE,
  TOUR_PHOTO_SAVE_URL,
  buildTourPhotoSaveBody,
  isSandboxNotEligibleBody,
} from '@homegohan/handson-tour-shared';
import { createFakeSandboxDb, eligibleProfile, type FakeCall, type FakeResult } from './helpers/fake-sandbox-supabase';
import { saveSandboxPhotoMeal } from '@/lib/handson-tour/sandbox-photo-meal';
import { validatePlannedMealInput } from '@/lib/planned-meal-validation';

const USER_ID = 'user-1';
const EXISTING_SANDBOX_MEAL_ID = 'sandbox-meal-old';
const NEW_SANDBOX_MEAL_ID = 'sandbox-meal-new';
const HTTP_OK = 200;
const HTTP_BAD_REQUEST = 400;
const HTTP_INTERNAL_ERROR = 500;

const { loggerError } = vi.hoisted(() => ({ loggerError: vi.fn() }));
vi.mock('@/lib/db-logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: loggerError,
    withUser: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: loggerError }),
  }),
  generateRequestId: () => 'req_test',
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let currentClient: any;

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => currentClient,
}));

const { POST } = await import('@/app/api/meal-plans/add-from-photo/route');

type MealsState = {
  /** 利用者のお試しの行 (uniq_user_sandbox_meal で 1 行だけ)。null なら無い */
  sandboxMealId: string | null;
  /** insert が一意違反 (23505) になる (同時に送られたもう 1 回が先に作った) */
  insertConflicts?: boolean;
};

/** meals の振る舞い: お試しの行を user_id + is_sandbox = true で探す / 1 行だけ作れる */
function mealsHandler(state: MealsState) {
  return (call: FakeCall): FakeResult => {
    if (call.op === 'select') {
      return { data: state.sandboxMealId ? { id: state.sandboxMealId } : null, error: null };
    }
    if (call.op === 'insert') {
      if (state.insertConflicts || state.sandboxMealId) {
        // 競合したもう 1 回が作った行が、このあと見えるようになる
        state.sandboxMealId = state.sandboxMealId ?? EXISTING_SANDBOX_MEAL_ID;
        return {
          data: null,
          error: { code: '23505', message: 'duplicate key value violates unique constraint "uniq_user_sandbox_meal"' },
        };
      }
      state.sandboxMealId = NEW_SANDBOX_MEAL_ID;
      return { data: { id: NEW_SANDBOX_MEAL_ID }, error: null };
    }
    return { data: null, error: null };
  };
}

function setup(meals: MealsState = { sandboxMealId: null }) {
  const db = createFakeSandboxDb({
    userId: USER_ID,
    profile: eligibleProfile(USER_ID),
    // user_daily_meals / planned_meals は渡さない: sandbox 経路が触ればフェイクが例外を投げて 500 になる
    tables: { meals: mealsHandler(meals) },
  });
  currentClient = db.client;
  return db;
}

/** ツアーの画面と同じ URL (?source=handson_tour) で本物のルートを呼ぶ */
async function postAsTour(body: unknown) {
  const res = await POST(
    new Request(`https://homegohan-app.vercel.app${TOUR_PHOTO_SAVE_URL}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
  return { status: res.status, json: await res.json() };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('#1604: Step 1 の保存の本文 (buildTourPhotoSaveBody)', () => {
  it('お試しの記録として、夕食を、サンプルの料理名とカロリーで送る (日付は送らない)', () => {
    const body = buildTourPhotoSaveBody();

    expect(body).toEqual({
      sandbox: true,
      mealType: 'dinner',
      dishes: [{ name: '鶏の唐揚げ定食', cal: 780, role: 'main' }],
      totalCalories: 780,
      imageUrl: null,
    });
    expect(body.dishes[0].name).toBe(MOCK_PHOTO_RESPONSE.dishName);
    expect(body.totalCalories).toBe(MOCK_PHOTO_RESPONSE.calories);
    expect(body).not.toHaveProperty('dayDate');
  });

  it('食事の種類はルートの入力の確認 (mealType の 5 値) を通る', () => {
    expect(validatePlannedMealInput({ mealType: buildTourPhotoSaveBody().mealType }).ok).toBe(true);
    expect(TOUR_PHOTO_MEAL_TYPE).toBe('dinner');
  });

  it('保存先は add-from-photo で、出どころ (source) を handson_tour にする', () => {
    const url = new URL(TOUR_PHOTO_SAVE_URL, 'https://example.test');
    expect(url.pathname).toBe('/api/meal-plans/add-from-photo');
    expect(url.searchParams.get('source')).toBe('handson_tour');
  });
});

describe('#1604: 本文を本物のルート (POST /api/meal-plans/add-from-photo) に通す', () => {
  it('200 で、meals にお試しの行 (is_sandbox = true・夕食・料理名・今の時刻) が 1 行入り、user_daily_meals には書かない', async () => {
    const db = setup();
    const before = Date.now();

    const { status, json } = await postAsTour(buildTourPhotoSaveBody());

    expect(status, JSON.stringify(json)).toBe(HTTP_OK);
    expect(json).toEqual({ success: true, sandbox: true, mealId: NEW_SANDBOX_MEAL_ID });
    expect(db.state.writes.map((w) => `${w.table}:${w.op}`)).toEqual(['meals:insert']);
    const payload = db.state.writes[0].payload as Record<string, unknown>;
    expect(payload).toMatchObject({
      user_id: USER_ID,
      is_sandbox: true,
      meal_type: 'dinner',
      memo: '鶏の唐揚げ定食',
      photo_url: null,
    });
    const eatenAt = Date.parse(String(payload.eaten_at));
    expect(eatenAt).toBeGreaterThanOrEqual(before);
    expect(eatenAt).toBeLessThanOrEqual(Date.now());
  });

  it('前の日のお試しの行が残っている状態でやり直しても 200 で、行は増やさず今回の値に更新する (以前は一意違反で 500)', async () => {
    const meals: MealsState = { sandboxMealId: EXISTING_SANDBOX_MEAL_ID };
    const db = setup(meals);

    const { status, json } = await postAsTour(buildTourPhotoSaveBody());

    expect(status, JSON.stringify(json)).toBe(HTTP_OK);
    expect(json).toMatchObject({ success: true, mealId: EXISTING_SANDBOX_MEAL_ID });
    // insert は走らない。お試しの行の 1 行だけを更新する
    expect(db.state.writes.map((w) => `${w.table}:${w.op}`)).toEqual(['meals:update']);
    expect(db.state.writes[0].payload).toMatchObject({ meal_type: 'dinner', memo: '鶏の唐揚げ定食' });
    expect(meals.sandboxMealId).toBe(EXISTING_SANDBOX_MEAL_ID);
  });

  it('二重に送られて insert が一意違反 (23505) になっても、先に入ったお試しの行を使って 200 を返す', async () => {
    const db = setup({ sandboxMealId: null, insertConflicts: true });

    const { status, json } = await postAsTour(buildTourPhotoSaveBody());

    expect(status, JSON.stringify(json)).toBe(HTTP_OK);
    expect(json).toMatchObject({ success: true, mealId: EXISTING_SANDBOX_MEAL_ID });
    expect(db.state.writes.map((w) => `${w.table}:${w.op}`)).toEqual(['meals:insert']);
  });

  it('お試しの行を探す段で DB が失敗したら 500 (成功のふりをしない) で、何も書かない', async () => {
    const db = createFakeSandboxDb({
      userId: USER_ID,
      profile: eligibleProfile(USER_ID),
      tables: { meals: () => ({ data: null, error: { code: '57014', message: 'statement timeout' } }) },
    });
    currentClient = db.client;

    const { status } = await postAsTour(buildTourPhotoSaveBody());

    expect(status).toBe(HTTP_INTERNAL_ERROR);
    expect(db.state.writes).toEqual([]);
  });

  it('(再現) 以前の本文 (MOCK_PHOTO_RESPONSE + sandbox / source) は mealType が無く 400 になり、何も書き込まれない', async () => {
    const db = setup();

    const { status } = await postAsTour({ ...MOCK_PHOTO_RESPONSE, sandbox: true, source: 'handson_tour' });

    expect(status).toBe(HTTP_BAD_REQUEST);
    expect(db.state.writes).toEqual([]);
  });
});

describe('#1604: saveSandboxPhotoMeal (お試しの行の保存)', () => {
  it('料理名が無ければ memo は null。写真の URL はそのまま photo_url に入る。食べた時刻は渡した「今」', async () => {
    const db = setup();
    const now = new Date('2026-10-15T10:00:00.000Z');

    const result = await saveSandboxPhotoMeal(
      db.client as never,
      USER_ID,
      { mealType: 'lunch', dishNames: [], imageUrl: 'https://example.test/a.jpg' },
      now,
    );

    expect(result).toEqual({ ok: true, mealId: NEW_SANDBOX_MEAL_ID, reused: false });
    expect(db.state.writes[0].payload).toEqual({
      eaten_at: '2026-10-15T10:00:00.000Z',
      meal_type: 'lunch',
      photo_url: 'https://example.test/a.jpg',
      memo: null,
      user_id: USER_ID,
      is_sandbox: true,
    });
  });

  it('お試しの行は本人の user_id と is_sandbox = true で探し、更新はその行の id と本人の user_id で絞る', async () => {
    const calls: FakeCall[] = [];
    const handler = mealsHandler({ sandboxMealId: EXISTING_SANDBOX_MEAL_ID });
    const db = createFakeSandboxDb({
      userId: USER_ID,
      profile: eligibleProfile(USER_ID),
      tables: {
        meals: (call) => {
          calls.push({ ...call, filters: [...call.filters] });
          return handler(call);
        },
      },
    });

    const result = await saveSandboxPhotoMeal(db.client as never, USER_ID, {
      mealType: 'dinner',
      dishNames: ['a', 'b'],
      imageUrl: null,
    });

    expect(result).toEqual({ ok: true, mealId: EXISTING_SANDBOX_MEAL_ID, reused: true });
    expect(calls[0].op).toBe('select');
    expect(calls[0].filters).toEqual([
      ['user_id', USER_ID],
      ['is_sandbox', true],
    ]);
    expect(calls[1].op).toBe('update');
    expect(calls[1].filters).toEqual([
      ['id', EXISTING_SANDBOX_MEAL_ID],
      ['user_id', USER_ID],
    ]);
    expect(calls[1].payload).toMatchObject({ memo: 'a、b' });
  });

  it('更新が失敗したら ok: false (stage: update) を返す', async () => {
    const db = createFakeSandboxDb({
      userId: USER_ID,
      profile: eligibleProfile(USER_ID),
      tables: {
        meals: (call) =>
          call.op === 'select'
            ? { data: { id: EXISTING_SANDBOX_MEAL_ID }, error: null }
            : { data: null, error: { code: '42501', message: 'permission denied' } },
      },
    });

    const result = await saveSandboxPhotoMeal(db.client as never, USER_ID, {
      mealType: 'dinner',
      dishNames: [],
      imageUrl: null,
    });

    expect(result).toMatchObject({ ok: false, stage: 'update' });
  });
});

describe('#1604: isSandboxNotEligibleBody (保存の対象でない利用者への応答)', () => {
  it('sandbox_not_eligible の応答だけを「保存の要らない利用者」と読む', () => {
    expect(isSandboxNotEligibleBody({ error: { code: 'sandbox_not_eligible', reason: 'already_finished' } })).toBe(true);
    expect(isSandboxNotEligibleBody({ error: { code: 'sandbox_not_eligible', reason: 'existing_user' } })).toBe(true);
    expect(isSandboxNotEligibleBody({ error: { code: 'profile_not_found' } })).toBe(false);
    expect(isSandboxNotEligibleBody({ error: 'Failed to save sandbox meal' })).toBe(false);
    expect(isSandboxNotEligibleBody({ error: null })).toBe(false);
    expect(isSandboxNotEligibleBody(null)).toBe(false);
    expect(isSandboxNotEligibleBody('sandbox_not_eligible')).toBe(false);
  });
});

describe('#1625: 共有の読み方 (packages/handson-tour-shared) が本物のルートの応答と合っている', () => {
  // このパッケージは Web の型 (SandboxEligibilityError) を読めないので、code の一致は本物のルートに通して確かめる
  const HTTP_CONFLICT = 409;

  it('ツアーを完了済みの利用者の保存は 409 sandbox_not_eligible になり、共有の isSandboxNotEligibleBody がそれを読む', async () => {
    const db = createFakeSandboxDb({
      userId: USER_ID,
      profile: eligibleProfile(USER_ID, { handson_tour_completed_at: '2026-10-01T00:00:00.000Z' }),
      tables: {},
    });
    currentClient = db.client;

    const { status, json } = await postAsTour(buildTourPhotoSaveBody());

    expect(status).toBe(HTTP_CONFLICT);
    expect(json.error.code).toBe(SANDBOX_NOT_ELIGIBLE_CODE);
    expect(isSandboxNotEligibleBody(json)).toBe(true);
    expect(db.state.writes).toEqual([]);
  });
});
