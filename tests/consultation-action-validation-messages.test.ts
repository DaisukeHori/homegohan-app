// @vitest-environment node
/**
 * AI 相談の提案の実行 (runConsultationAction) の検証の失敗の文は日本語 (#1917 の ai の配下)
 *
 * 問題:
 *   提案の実行の結果 (result) は、そのまま応答の本文 (POST /api/ai/consultation/actions/[actionId]/execute の { result }・
 *   messages の route の actionResult) と ai_action_logs.result に入る。値の検証 (サニタイザ) が積む失敗の文が
 *   'dish_name must be a non-empty string (max 200 chars)' のような英語だったので、result.error に英語の文が出ていた。
 *   健康の記録・目標の検証 (src/lib/health-payloads.ts。/api/health/** と共有) も以前は 'weight must be a finite number or null' のような
 *   英語の文を返していた (#1983 の health の直しで、今は日本語の文を返す)。
 *
 * 決まり (このテストが固定する):
 *   1. 提案の実行の中の検証 (献立・買い物リスト・栄養目標の更新) の文は、項目の名前と上限の数を入れた日本語の固定の文
 *   2. health-payloads の検証が返す日本語の文は、そのまま result.error に入れる (置き換えもログも足さない)
 *   3. 検証が日本語でない文を返したとき (health-payloads に将来英語の文が入ったときの守り) は、英語の文を 1 つの固定の文
 *      (AI_CONSULTATION_ACTION_INVALID_VALUES_MESSAGE) に置き換え、元の英語の文は構造化ログ (warn) にだけ残す。
 *      health-payloads はもう英語を返さないので、この道は英語の文を返すスタブで確かめる
 *   4. どの道でも result.error に英語だけの文 ('must be' の文) が出ない。検証に通らなければ DB を更新しない
 *   5. 提案の実行の中の文 (検証の文と、引数の抜け・形の誤りの文) は、項目を「日本語の名前 (キー)」の形で出し、
 *      括弧の外に英字の項目名・値を出さない (#1917 の続き。以前は 'date は必須です'・'dishes は配列で指定してください'・
 *      'mealIdが指定されていません'・'target_value と target_unit は空にできません' のように英字の項目名が括弧の外に出ていた)。
 *      検証する項目は、どれも表の日本語の名前で出す (表に無いキーの「項目 (キー)」にならない)
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/feature-flags', () => ({ isFeatureEnabled: vi.fn(async () => false) }));
vi.mock('@/lib/generate-menu-v4-retry', () => ({
  invokeGenerateMenuV4WithRetry: vi.fn(),
  markWeeklyMenuRequestFailed: vi.fn(),
}));
vi.mock('@/lib/meal-image-jobs', () => ({
  buildDishImagePayload: vi.fn(),
  cancelPendingMealImageJobs: vi.fn(),
  enqueueMealImageJobs: vi.fn(),
  triggerMealImageJobProcessing: vi.fn(),
}));
vi.mock('@/lib/v4-target-slots', () => ({ resolveExistingTargetSlots: vi.fn() }));
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: vi.fn() }));
const logger = vi.hoisted(() => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock('@/lib/db-logger', () => ({ createLogger: () => ({ ...logger, withUser: () => logger }) }));
vi.mock('@/lib/health-streaks', () => ({ updateHealthStreak: vi.fn() }));
// 実物の検証をそのまま使い、守りの道 (英語の文) を確かめるテストだけが 1 回分の戻り値を英語の文に差し替える
vi.mock('@/lib/health-payloads', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/health-payloads')>();
  return {
    ...actual,
    sanitizeHealthRecordPayload: vi.fn(actual.sanitizeHealthRecordPayload),
    sanitizeHealthGoalCreate: vi.fn(actual.sanitizeHealthGoalCreate),
    sanitizeHealthGoalUpdate: vi.fn(actual.sanitizeHealthGoalUpdate),
  };
});

import { runConsultationAction } from '@/lib/ai/consultation-action-executor';
import { AI_CONSULTATION_ACTION_INVALID_VALUES_MESSAGE } from '@/lib/ai/ai-api-messages';
import {
  sanitizeHealthGoalCreate,
  sanitizeHealthGoalUpdate,
  sanitizeHealthRecordPayload,
} from '@/lib/health-payloads';
import { englishIdentifiersOutsideParentheses, isEnglishOnly, JAPANESE } from './helpers/api-error-text-scan';
import { createRecordingSupabase, type RecordedQuery } from './helpers/recording-supabase';

const USER = { id: 'user-1' };

/** 更新の前の本人の確認 (select) には本人の行を返す。更新 (update / upsert / insert) は記録だけする */
function respond(query: RecordedQuery) {
  switch (query.table) {
    case 'planned_meals':
      return { data: { id: 'meal-1', dish_name: '鮭の塩焼き', dishes: [], image_url: null, user_daily_meals: { user_id: USER.id } } };
    case 'shopping_list_items':
      return { data: { shopping_list_id: 'list-1' } };
    case 'shopping_lists':
      return { data: { user_id: USER.id } };
    case 'health_goals':
      return { data: { user_id: USER.id, goal_type: 'weight' } };
    default:
      return { data: null };
  }
}

const WRITE_METHODS = new Set(['update', 'upsert', 'insert', 'delete']);

async function run(actionType: string, params: Record<string, unknown>) {
  const db = createRecordingSupabase(respond);
  const out = await runConsultationAction(db.client, USER, {
    id: 'action-1',
    action_type: actionType,
    action_params: params,
    ai_consultation_sessions: { user_id: USER.id },
  });
  const writes = db.queries.filter((query) => query.calls.some((call) => WRITE_METHODS.has(call.method)));
  return { out, writes };
}

beforeEach(() => {
  vi.clearAllMocks();
});

/** 提案の実行の中の検証の文 (手で書いた期待値) */
const OWN_VALIDATION_CASES: Array<{ name: string; actionType: string; params: Record<string, unknown>; error: string }> = [
  { name: 'update_meal: 料理名が空', actionType: 'update_meal', params: { mealId: 'meal-1', updates: { dish_name: '' } }, error: '料理名 (dish_name) は 1〜200 文字の文字列で指定してください' },
  { name: 'update_meal: 料理名が長すぎる', actionType: 'update_meal', params: { mealId: 'meal-1', updates: { dish_name: 'あ'.repeat(201) } }, error: '料理名 (dish_name) は 1〜200 文字の文字列で指定してください' },
  { name: 'update_meal: メモが文字列でない', actionType: 'update_meal', params: { mealId: 'meal-1', updates: { memo: 5 } }, error: 'メモ (memo) は 1000 文字以内の文字列か null で指定してください' },
  { name: 'update_meal: モードが空', actionType: 'update_meal', params: { mealId: 'meal-1', updates: { mode: '' } }, error: '食事のモード (mode) は 1〜50 文字の文字列で指定してください' },
  { name: 'update_meal: 料理が配列でない', actionType: 'update_meal', params: { mealId: 'meal-1', updates: { dishes: 'ごはん' } }, error: '料理の一覧 (dishes) は配列で指定してください' },
  { name: 'update_meal: 画像の URL が文字列でない', actionType: 'update_meal', params: { mealId: 'meal-1', updates: { image_url: 1 } }, error: '画像の URL (image_url) は文字列で指定してください' },
  { name: 'update_meal: たんぱく質が範囲の外', actionType: 'update_meal', params: { mealId: 'meal-1', updates: { protein_g: -1 } }, error: 'たんぱく質 (protein_g) は 0 〜 500 の範囲の数値で指定してください' },
  { name: 'update_meal: エネルギーが数値でない', actionType: 'update_meal', params: { mealId: 'meal-1', updates: { calories_kcal: '500' } }, error: 'エネルギー (calories_kcal) は 0 〜 5000 の範囲の数値で指定してください' },
  { name: 'update_meal: 更新の内容がオブジェクトでない', actionType: 'update_meal', params: { mealId: 'meal-1', updates: 'dish_name' }, error: '更新する内容の指定が正しくありません' },
  {
    name: 'update_meal: 2 つの項目の誤りは両方の文をつなぐ',
    actionType: 'update_meal',
    params: { mealId: 'meal-1', updates: { dish_name: '', dishes: 'ごはん' } },
    error: '料理名 (dish_name) は 1〜200 文字の文字列で指定してください, 料理の一覧 (dishes) は配列で指定してください',
  },
  { name: 'update_shopping_item: 品名が空', actionType: 'update_shopping_item', params: { itemId: 'item-1', updates: { item_name: ' ' } }, error: '品名 (item_name) は 1〜200 文字の文字列で指定してください' },
  { name: 'update_shopping_item: 数量が文字列でない', actionType: 'update_shopping_item', params: { itemId: 'item-1', updates: { quantity: 3 } }, error: '数量 (quantity) は 100 文字以内の文字列か null で指定してください' },
  { name: 'update_shopping_item: 分類が長すぎる', actionType: 'update_shopping_item', params: { itemId: 'item-1', updates: { category: 'a'.repeat(101) } }, error: '分類 (category) は 1〜100 文字の文字列で指定してください' },
  { name: 'update_shopping_item: 更新の内容がオブジェクトでない', actionType: 'update_shopping_item', params: { itemId: 'item-1', updates: null }, error: '更新する内容の指定が正しくありません' },
  { name: 'update_nutrition_target: 数値でない', actionType: 'update_nutrition_target', params: { targets: { protein_g: '60' } }, error: 'たんぱく質 (protein_g) は数値で指定してください' },
  { name: 'update_nutrition_target: 範囲の外', actionType: 'update_nutrition_target', params: { targets: { daily_calories: 100 } }, error: '1 日のエネルギー (daily_calories) は 500 〜 6000 の範囲で指定してください' },
  { name: 'update_nutrition_target: 目標がオブジェクトでない', actionType: 'update_nutrition_target', params: { targets: [] }, error: '栄養目標の指定が正しくありません' },
];

describe('提案の実行の中の検証の文は、日本語の固定の文', () => {
  it.each(OWN_VALIDATION_CASES)('$name', async ({ actionType, params, error }) => {
    const { out, writes } = await run(actionType, params);
    expect(out.success).toBe(false);
    expect(out.result).toEqual({ error });
    expect(writes).toEqual([]);
    // 自分の検証の文は日本語なので、置き換え (固定の文) もログも出さない
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

/**
 * 提案の実行の引数の抜け・形の誤りの文 (検証の関数を通らず、result.error に直接入る文。手で書いた期待値)。
 * どれも DB にも献立の生成にも進まずに止まる (#1917 の続き)
 */
const ARGUMENT_ERROR_CASES: Array<{ name: string; actionType: string; params: Record<string, unknown>; error: string }> = [
  { name: 'generate_day_menu: 日付が無い', actionType: 'generate_day_menu', params: {}, error: '日付 (date) を指定してください' },
  { name: 'generate_week_menu: 開始日が無い', actionType: 'generate_week_menu', params: {}, error: '開始日 (startDate) を指定してください' },
  {
    name: 'generate_single_meal: 食事の区分が無い',
    actionType: 'generate_single_meal',
    params: { date: '2026-10-10' },
    error: '日付 (date) と食事の区分 (mealType) を指定してください',
  },
  {
    name: 'generate_single_meal: 食事の区分が受け付ける値でない (受け付ける英字の値は括弧の中)',
    actionType: 'generate_single_meal',
    params: { date: '2026-10-10', mealType: 'brunch' },
    error: '食事の区分 (mealType) は次のいずれかを指定してください (breakfast / lunch / dinner / snack / midnight_snack)',
  },
  { name: 'update_meal: 献立の ID が無い', actionType: 'update_meal', params: { updates: { memo: 'メモ' } }, error: '献立 (mealId) を指定してください' },
  {
    name: 'update_health_goal: 目標値を空にしようとした',
    actionType: 'update_health_goal',
    params: { goalId: 'goal-1', updates: { target_value: null } },
    error: '目標値 (target_value) は空にできません',
  },
  {
    name: 'update_health_goal: 単位を空にしようとした',
    actionType: 'update_health_goal',
    params: { goalId: 'goal-1', updates: { target_unit: null } },
    error: '単位 (target_unit) は空にできません',
  },
];

describe('提案の実行の引数の抜け・形の誤りの文は、項目を「日本語の名前 (キー)」の形で出す日本語の固定の文 (#1917 の続き)', () => {
  it.each(ARGUMENT_ERROR_CASES)('$name', async ({ actionType, params, error }) => {
    const { out, writes } = await run(actionType, params);
    expect(out.success).toBe(false);
    expect(out.result).toEqual({ error });
    expect(writes).toEqual([]);
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

/** 表に無いキーの名前 (この名前で出たら、表の日本語の名前が漏れている) */
const FALLBACK_LABEL_PATTERN = /項目 \(/;

describe('検証する項目は、どれも表の日本語の名前で出す (「項目 (キー)」にならない。#1917 の続き)', () => {
  // 献立の更新 (update_meal) の項目と、受け付けない値
  const MEAL_FIELDS: Array<[string, unknown]> = [
    ['dish_name', ''],
    ['memo', 5],
    ['mode', ''],
    ['dishes', 'ごはん'],
    ['image_url', 1],
    ['calories_kcal', -1],
    ['protein_g', -1],
    ['fat_g', -1],
    ['carbs_g', -1],
  ];
  // 買い物リストの品の更新 (update_shopping_item) の項目と、受け付けない値
  const SHOPPING_ITEM_FIELDS: Array<[string, unknown]> = [
    ['item_name', ''],
    ['quantity', 3],
    ['category', ''],
  ];
  // 栄養目標の更新 (update_nutrition_target) の項目 (数値でない値を送る)
  const NUTRITION_TARGET_FIELDS = ['daily_calories', 'protein_g', 'fat_g', 'carbs_g', 'fiber_g', 'sodium_g'];

  const cases: Array<{ name: string; actionType: string; params: Record<string, unknown>; field: string }> = [
    ...MEAL_FIELDS.map(([field, value]) => ({
      name: `update_meal の ${field}`,
      actionType: 'update_meal',
      params: { mealId: 'meal-1', updates: { [field]: value } },
      field,
    })),
    ...SHOPPING_ITEM_FIELDS.map(([field, value]) => ({
      name: `update_shopping_item の ${field}`,
      actionType: 'update_shopping_item',
      params: { itemId: 'item-1', updates: { [field]: value } },
      field,
    })),
    ...NUTRITION_TARGET_FIELDS.map((field) => ({
      name: `update_nutrition_target の ${field}`,
      actionType: 'update_nutrition_target',
      params: { targets: { [field]: 'abc' } },
      field,
    })),
  ];

  it.each(cases)('$name', async ({ actionType, params, field }) => {
    const { out } = await run(actionType, params);
    expect(out.success).toBe(false);
    const text = (out.result as { error: string }).error;
    expect(text).toContain(`(${field})`);
    expect(text).not.toMatch(FALLBACK_LABEL_PATTERN);
    expect(englishIdentifiersOutsideParentheses(text), text).toEqual([]);
  });
});

/** health-payloads の検証が返す文 (#1983 で日本語の文になった。そのまま result.error に入る) */
const SHARED_VALIDATION_CASES: Array<{ name: string; actionType: string; params: Record<string, unknown>; error: string }> = [
  {
    name: 'add_health_record: 体脂肪率が数値でない',
    actionType: 'add_health_record',
    params: { date: '2026-10-10', bodyFatPercentage: 'abc' },
    error: '体脂肪率 (%) は数値で指定してください',
  },
  {
    name: 'add_health_record: 範囲の外の体重と数値でない体脂肪率は、両方の日本語の文をつなぐ',
    actionType: 'add_health_record',
    params: { date: '2026-10-10', weight: 500, bodyFatPercentage: 'abc' },
    error: '体重 (kg) は 300 以下の値を入力してください, 体脂肪率 (%) は数値で指定してください',
  },
  {
    name: 'add_health_record: 範囲の外の体重だけ',
    actionType: 'add_health_record',
    params: { date: '2026-10-10', weight: 500 },
    error: '体重 (kg) は 300 以下の値を入力してください',
  },
  {
    name: 'update_health_record: 更新の内容がオブジェクトでない',
    actionType: 'update_health_record',
    params: { date: '2026-10-10', updates: 'weight' },
    error: 'リクエストボディが不正です',
  },
  {
    name: 'update_health_record: 2 つの項目の誤りは両方の文をつなぐ',
    actionType: 'update_health_record',
    params: { date: '2026-10-10', updates: { weight: 'abc', step_count: 1.5 } },
    error: '体重 (kg) は数値で指定してください, 歩数 は整数で指定してください',
  },
  {
    name: 'set_health_goal: 目標値が無い',
    actionType: 'set_health_goal',
    params: { goalType: 'weight' },
    error: '目標の種類 (goal_type)・目標値 (target_value)・単位 (target_unit) を指定してください',
  },
  {
    name: 'update_health_goal: 期日が日付でない',
    actionType: 'update_health_goal',
    params: { goalId: 'goal-1', updates: { target_date: '2026/10/10' } },
    error: '目標の日付 (target_date)はYYYY-MM-DD の形の、0101-01-02 から 9998-12-30 までの実在する日付で指定してください',
  },
];

describe('健康の記録・目標の検証 (health-payloads と共有) の日本語の文は、そのまま返し、固定の文もログも足さない', () => {
  it.each(SHARED_VALIDATION_CASES)('$name', async ({ actionType, params, error }) => {
    const { out, writes } = await run(actionType, params);
    expect(out.success).toBe(false);
    expect(out.result).toEqual({ error });
    expect(writes).toEqual([]);
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

/**
 * 守りの道: 検証が日本語でない文を返したとき (health-payloads はもう英語を返さないので、1 回分の戻り値を英語の文に差し替える)。
 * 英語の文は固定の文に置き換わり、元の文は構造化ログにだけ残る
 */
const NON_JAPANESE_GUARD_CASES: Array<{
  name: string;
  actionType: string;
  params: Record<string, unknown>;
  /** 検証の戻り値を 1 回分だけ差し替える */
  stub: () => void;
  error: string;
  /** 構造化ログにだけ残る元の英語の文 */
  logged: string[];
}> = [
  {
    name: 'add_health_record: 英語の文は固定の文に置き換える',
    actionType: 'add_health_record',
    params: { date: '2026-10-10', bodyFatPercentage: 'abc' },
    stub: () => {
      vi.mocked(sanitizeHealthRecordPayload).mockReturnValueOnce({
        data: {},
        errors: ['body_fat_percentage must be a finite number or null'],
      });
    },
    error: AI_CONSULTATION_ACTION_INVALID_VALUES_MESSAGE,
    logged: ['body_fat_percentage must be a finite number or null'],
  },
  {
    name: 'add_health_record: 日本語の文と英語の文が混ざると、日本語の文を残して固定の文を足す',
    actionType: 'add_health_record',
    params: { date: '2026-10-10', weight: 500, bodyFatPercentage: 'abc' },
    stub: () => {
      vi.mocked(sanitizeHealthRecordPayload).mockReturnValueOnce({
        data: {},
        errors: ['体重 (kg) は 300 以下の値を入力してください', 'body_fat_percentage must be a finite number or null'],
      });
    },
    error: `体重 (kg) は 300 以下の値を入力してください, ${AI_CONSULTATION_ACTION_INVALID_VALUES_MESSAGE}`,
    logged: ['body_fat_percentage must be a finite number or null'],
  },
  {
    name: 'update_health_record: 英語の文が 2 つでも固定の文は 1 つ',
    actionType: 'update_health_record',
    params: { date: '2026-10-10', updates: { weight: 'abc', step_count: 1.5 } },
    stub: () => {
      vi.mocked(sanitizeHealthRecordPayload).mockReturnValueOnce({
        data: {},
        errors: ['weight must be a finite number or null', 'step_count must be an integer or null'],
      });
    },
    error: AI_CONSULTATION_ACTION_INVALID_VALUES_MESSAGE,
    logged: ['weight must be a finite number or null', 'step_count must be an integer or null'],
  },
  {
    name: 'set_health_goal: 英語の文は固定の文に置き換える',
    actionType: 'set_health_goal',
    params: { goalType: 'weight' },
    stub: () => {
      vi.mocked(sanitizeHealthGoalCreate).mockReturnValueOnce({
        data: null,
        errors: ['goal_type, target_value, and target_unit are required'],
      });
    },
    error: AI_CONSULTATION_ACTION_INVALID_VALUES_MESSAGE,
    logged: ['goal_type, target_value, and target_unit are required'],
  },
  {
    name: 'update_health_goal: 英語の文は固定の文に置き換える',
    actionType: 'update_health_goal',
    params: { goalId: 'goal-1', updates: { target_date: '2026/10/10' } },
    stub: () => {
      vi.mocked(sanitizeHealthGoalUpdate).mockReturnValueOnce({
        data: {},
        errors: ['target_date must be a date in YYYY-MM-DD format'],
      });
    },
    error: AI_CONSULTATION_ACTION_INVALID_VALUES_MESSAGE,
    logged: ['target_date must be a date in YYYY-MM-DD format'],
  },
];

describe('検証が日本語でない文を返したときは、固定の文に置き換え、元の文はログにだけ残す (守りの道)', () => {
  it.each(NON_JAPANESE_GUARD_CASES)('$name', async ({ actionType, params, stub, error, logged }) => {
    stub();
    const { out, writes } = await run(actionType, params);
    expect(out.success).toBe(false);
    expect(out.result).toEqual({ error });
    expect(writes).toEqual([]);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith('AI 相談のアクションの値が検証を通りませんでした', {
      userId: USER.id,
      action_id: 'action-1',
      action_type: actionType,
      validation_errors: logged,
    });
  });
});

describe('どの検証の失敗でも、result.error に英語だけの文も、括弧の外の英字の項目名も出ない', () => {
  const ALL_CASES: Array<{ name: string; actionType: string; params: Record<string, unknown>; stub?: () => void }> = [
    ...OWN_VALIDATION_CASES,
    ...ARGUMENT_ERROR_CASES,
    ...SHARED_VALIDATION_CASES,
    ...NON_JAPANESE_GUARD_CASES,
  ];
  it.each(ALL_CASES)('$name', async ({ actionType, params, stub }) => {
    stub?.();
    const { out } = await run(actionType, params);
    const text = (out.result as { error: string }).error;
    for (const part of text.split(', ')) {
      expect(JAPANESE.test(part), part).toBe(true);
      expect(isEnglishOnly(part), part).toBe(false);
      // 英字の項目名・値は括弧の中だけ (#1917 の続き)
      expect(englishIdentifiersOutsideParentheses(part), part).toEqual([]);
    }
    expect(text).not.toMatch(/must be|required/);
  });
});
