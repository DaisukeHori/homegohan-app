/**
 * #1604: ハンズオンツアー Step 1 の保存で送る本文 (src/lib/handson-tour/photo-save.ts) のテスト。
 *
 * 以前のツアーは MOCK_PHOTO_RESPONSE に sandbox / source を足しただけの本文を送っていて、
 * POST /api/meal-plans/add-from-photo が読む dayDate / mealType が無く、mealType の検証で 400 になっていた (#846 の E2E で発見)。
 * 画面は失敗を無視して Step 2 へ進んでいたので、利用者にも見えなかった。
 *
 * 設計書 docs/design/family/09-onboarding-handson-tour/03-step1-photo.md §3.7 の決め: 保存した「今」の「夕食」(meal_type: 'dinner')。
 * ここでは本文の中身と、その本文を本物のルートに通すと 200 で今日 (JST) の夕食として保存されることを確かめる
 * (DB は tests/helpers/fake-sandbox-supabase.ts のフェイク)。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MOCK_PHOTO_RESPONSE } from '@homegohan/handson-tour-shared';
import { createFakeSandboxDb, eligibleProfile, type FakeSandboxDbOptions } from './helpers/fake-sandbox-supabase';
import { TOUR_PHOTO_MEAL_TYPE, TOUR_PHOTO_SAVE_URL, buildTourPhotoSaveBody } from '@/lib/handson-tour/photo-save';
import { isCalendarDate } from '@/lib/jst-day-ranges';
import { validatePlannedMealInput } from '@/lib/planned-meal-validation';

const USER_ID = 'user-1';

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

/** add-from-photo が触る 2 表の応答 (その日の user_daily_meals はまだ無い) */
const photoTables: FakeSandboxDbOptions['tables'] = {
  user_daily_meals: ({ op }) =>
    op === 'insert'
      ? { data: { id: 'daily-1' }, error: null }
      : { data: null, error: { code: 'PGRST116', message: 'no rows' } },
  planned_meals: ({ op }) => {
    if (op === 'insert') return { data: { id: 'meal-1' }, error: null };
    if (op === 'delete') return { data: null, error: null };
    return { data: [], error: null };
  },
};

function setup() {
  const db = createFakeSandboxDb({ userId: USER_ID, profile: eligibleProfile(USER_ID), tables: photoTables });
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
  it('お試しの記録として、今日 (JST) の夕食を、サンプルの料理名とカロリーで送る', () => {
    // JST 2026-10-15 12:00
    const body = buildTourPhotoSaveBody(new Date('2026-10-15T03:00:00Z'));

    expect(body).toEqual({
      sandbox: true,
      dayDate: '2026-10-15',
      mealType: 'dinner',
      dishes: [{ name: '鶏の唐揚げ定食', cal: 780, role: 'main' }],
      totalCalories: 780,
      imageUrl: null,
    });
    expect(body.dishes[0].name).toBe(MOCK_PHOTO_RESPONSE.dishName);
    expect(body.totalCalories).toBe(MOCK_PHOTO_RESPONSE.calories);
  });

  it('日付は JST の暦日 (UTC の暦日ではない): UTC 15:00 は JST の翌日 0:00', () => {
    expect(buildTourPhotoSaveBody(new Date('2026-10-14T14:59:59Z')).dayDate).toBe('2026-10-14');
    expect(buildTourPhotoSaveBody(new Date('2026-10-14T15:00:00Z')).dayDate).toBe('2026-10-15');
  });

  it('引数なしなら今の日付で、ルートの入力の確認 (日付の形・mealType の 5 値) を通る', () => {
    const body = buildTourPhotoSaveBody();

    expect(isCalendarDate(body.dayDate)).toBe(true);
    expect(validatePlannedMealInput({ mealType: body.mealType }).ok).toBe(true);
    expect(TOUR_PHOTO_MEAL_TYPE).toBe('dinner');
  });

  it('保存先は add-from-photo で、出どころ (source) を handson_tour にする', () => {
    const url = new URL(TOUR_PHOTO_SAVE_URL, 'https://example.test');
    expect(url.pathname).toBe('/api/meal-plans/add-from-photo');
    expect(url.searchParams.get('source')).toBe('handson_tour');
  });
});

describe('#1604: 本文を本物のルート (POST /api/meal-plans/add-from-photo) に通す', () => {
  it('200 で保存され、user_daily_meals は今日のお試しの日、planned_meals は夕食・料理名・出どころ handson_tour で作られる', async () => {
    const db = setup();
    const body = buildTourPhotoSaveBody(new Date('2026-10-15T03:00:00Z'));

    const { status, json } = await postAsTour(body);

    expect(status, JSON.stringify(json)).toBe(200);
    const dailyInsert = db.state.writes.find((w) => w.table === 'user_daily_meals' && w.op === 'insert');
    expect(dailyInsert?.payload).toMatchObject({ user_id: USER_ID, day_date: '2026-10-15', is_sandbox: true });
    const mealInsert = db.state.writes.find((w) => w.table === 'planned_meals' && w.op === 'insert');
    expect(mealInsert?.payload).toMatchObject({
      daily_meal_id: 'daily-1',
      meal_type: 'dinner',
      dish_name: '鶏の唐揚げ定食',
      calories_kcal: 780,
      source_type: 'handson_tour',
      image_url: null,
    });
  });

  it('(再現) 以前の本文 (MOCK_PHOTO_RESPONSE + sandbox / source) は mealType が無く 400 になり、何も書き込まれない', async () => {
    const db = setup();

    const { status } = await postAsTour({ ...MOCK_PHOTO_RESPONSE, sandbox: true, source: 'handson_tour' });

    expect(status).toBe(400);
    expect(db.state.writes).toEqual([]);
  });
});
