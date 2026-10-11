/**
 * #1103 (T45): AI 相談の generate_single_meal が受け付ける mealType は、夜食 (midnight_snack) を含む 5 値
 *
 * 以前は AI_ALLOWED_MEAL_TYPES が朝・昼・夕・おやつの 4 値だけで、システムプロンプトも夜食を提示しなかった。
 * 理由は「planned_meals.meal_type には 4 値の CHECK (#221) があり、'midnight_snack' を入れると 500 になる」だったが、
 * その CHECK は本番に存在しなかった (#1205)。UI・献立生成の Edge Function・DB のトリガーはどれも夜食を扱うため、
 * 「夜食を作り直して」と頼んでも AI 相談だけが断っていた。
 *
 * 方針 (#1103 項目 9): 夜食を正式な食事区分とし、DB の検査と AI の許可リストを 5 値にそろえる。
 * ここでは次を確かめる。
 *   1. 許可リストは アプリの 5 値 (PLANNED_MEAL_TYPES = DB のトリガーが通す値 = packages/shared の MealType) と同じ
 *   2. generate_single_meal は 5 値のどれでも献立生成に進み、Edge Function へ渡すスロットに mealType がそのまま入る
 *   3. 5 値以外 (大文字小文字・前後の空白・日本語・配列など) は、DB にも Edge Function にも触れずに断る。
 *      エラーに許可する 5 値を入れる (AI が選び直せるように)
 *   4. システムプロンプト (messages/route.ts) の mealType は、許可リストから作る (4 値の固定文字列を持たない)
 *
 * DB 側の検査 (meals.meal_type のトリガー) は tests/integration/rls/meals-meal-type-trigger.test.ts が確認する。
 */
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MEAL_ORDER } from '@homegohan/shared';

// 献立生成の呼び出しに関係しない重い依存は差し替える (import 時の副作用を避ける)
// 機能フラグ (#1148): AI 相談の緊急停止スイッチ (ai_chat_enabled) は ON のまま、献立のエンジンは v4 にする
vi.mock('@/lib/feature-flags', () => ({ isFeatureEnabled: vi.fn(async (key: string) => key === 'ai_chat_enabled') }));
vi.mock('@/lib/generate-menu-v4-retry', () => ({
  // 本物と同じく、渡された invoke を呼ぶ (Edge Function への呼び出しの中身を確かめるため)
  invokeGenerateMenuV4WithRetry: vi.fn(async ({ invoke }: { invoke: () => Promise<unknown> }) => {
    await invoke();
    return { ok: true };
  }),
  markWeeklyMenuRequestFailed: vi.fn(),
}));
vi.mock('@/lib/meal-image-jobs', () => ({
  buildDishImagePayload: vi.fn(),
  cancelPendingMealImageJobs: vi.fn(),
  enqueueMealImageJobs: vi.fn(),
  triggerMealImageJobProcessing: vi.fn(),
}));
// 既存の献立 (planned_meal) が見つかったことにして、plannedMealId を付けて返す
vi.mock('@/lib/v4-target-slots', () => ({
  resolveExistingTargetSlots: vi.fn(async ({ targetSlots }: { targetSlots: Array<Record<string, unknown>> }) =>
    targetSlots.map((slot) => ({ ...slot, plannedMealId: 'planned-meal-1' })),
  ),
}));
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: vi.fn() }));
vi.mock('@/lib/db-logger', () => {
  const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), withUser: () => logger };
  return { createLogger: () => logger };
});
vi.mock('@/lib/health-streaks', () => ({ updateHealthStreak: vi.fn() }));
// 献立生成のリクエストの行 (weekly_menu_requests) は service role のクライアント (getAiQueueWriter) で書く (#1465)。
// 利用者のクライアントとは別の作り物にして、INSERT がそちらに届くことを見る
const queue = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@/lib/ai/ai-queue-writer', () => ({ getAiQueueWriter: () => queue.db }));

import { AI_ALLOWED_MEAL_TYPES, runConsultationAction } from '@/lib/ai/consultation-action-executor';
import { invokeGenerateMenuV4WithRetry } from '@/lib/generate-menu-v4-retry';
import { resolveExistingTargetSlots } from '@/lib/v4-target-slots';
import { PLANNED_MEAL_TYPES } from '@/lib/planned-meal-validation';

const USER = { id: 'user-1' };
const DATE = '2026-10-09';

// ── Supabase のモック (generate_single_meal が触る weekly_menu_requests / user_profiles と Edge Function だけ) ──
interface FakeDb {
  from: ReturnType<typeof vi.fn>;
  functions: { invoke: ReturnType<typeof vi.fn> };
  /** weekly_menu_requests への INSERT の中身 */
  requestInserts: Array<Record<string, unknown>>;
}

function makeSupabase(): FakeDb {
  const requestInserts: Array<Record<string, unknown>> = [];
  const from = vi.fn((table: string) => {
    const builder: Record<string, unknown> = {};
    builder.insert = vi.fn((payload: Record<string, unknown>) => {
      if (table === 'weekly_menu_requests') requestInserts.push(payload);
      return builder;
    });
    builder.select = vi.fn(() => builder);
    builder.eq = vi.fn(() => builder);
    builder.single = vi.fn(async () => {
      if (table === 'weekly_menu_requests') return { data: { id: 'request-1' }, error: null };
      if (table === 'user_profiles') return { data: { family_size: 2 }, error: null };
      throw new Error(`想定外の表: ${table}`);
    });
    return builder;
  });
  return { from, functions: { invoke: vi.fn(async () => ({ data: {}, error: null })) }, requestInserts };
}

/** service role のクライアント (AI のキューへ書く。#1465) */
let queueDb: FakeDb;

function generateSingleMeal(db: FakeDb, params: Record<string, unknown>) {
  return runConsultationAction(db, USER, {
    id: 'action-1',
    action_type: 'generate_single_meal',
    action_params: params,
    ai_consultation_sessions: { user_id: USER.id },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  queueDb = makeSupabase();
  queue.db = queueDb;
});

describe('AI_ALLOWED_MEAL_TYPES (#1103)', () => {
  it('夜食 midnight_snack を含む 5 値 (プロンプトに出す並びも、この順)', () => {
    expect([...AI_ALLOWED_MEAL_TYPES]).toEqual(['breakfast', 'lunch', 'dinner', 'snack', 'midnight_snack']);
  });

  it('アプリの 5 値 (PLANNED_MEAL_TYPES = DB のトリガーが通す値) と同じ値', () => {
    expect([...AI_ALLOWED_MEAL_TYPES].sort()).toEqual([...PLANNED_MEAL_TYPES].sort());
  });

  it('packages/shared の MealType (MEAL_ORDER) と同じ値', () => {
    expect([...AI_ALLOWED_MEAL_TYPES].sort()).toEqual([...MEAL_ORDER].sort());
  });
});

describe('generate_single_meal: mealType の許可 (#1103)', () => {
  it.each(['breakfast', 'lunch', 'dinner', 'snack', 'midnight_snack'])(
    '%s は受け付け、献立生成のリクエストと Edge Function へのスロットに mealType がそのまま入る',
    async (mealType) => {
      const db = makeSupabase();
      const out = await generateSingleMeal(db, { date: DATE, mealType });

      expect(out.success).toBe(true);
      expect(out.result).toMatchObject({ requestId: 'request-1', status: 'processing' });

      // weekly_menu_requests の target_slots (Edge Function が読む)。service role のクライアントで積み、利用者のクライアントでは書かない
      expect(db.requestInserts).toHaveLength(0);
      expect(queueDb.requestInserts).toHaveLength(1);
      expect(queueDb.requestInserts[0]).toMatchObject({
        user_id: USER.id,
        start_date: DATE,
        status: 'processing',
        target_slots: [{ date: DATE, meal_type: mealType, planned_meal_id: 'planned-meal-1' }],
      });

      // Edge Function への呼び出し
      expect(resolveExistingTargetSlots).toHaveBeenCalledWith(
        expect.objectContaining({ userId: USER.id, targetSlots: [{ date: DATE, mealType }] }),
      );
      expect(invokeGenerateMenuV4WithRetry).toHaveBeenCalledTimes(1);
      expect(db.functions.invoke).toHaveBeenCalledTimes(1);
      expect(db.functions.invoke).toHaveBeenCalledWith(
        'generate-menu-v4',
        expect.objectContaining({
          body: expect.objectContaining({
            userId: USER.id,
            requestId: 'request-1',
            targetSlots: [expect.objectContaining({ date: DATE, mealType, plannedMealId: 'planned-meal-1' })],
            familySize: 2,
          }),
        }),
      );
    },
  );

  it('★夜食 midnight_snack: 以前は「mealType は breakfast/lunch/dinner/snack のいずれか」と断られていた', async () => {
    const out = await generateSingleMeal(makeSupabase(), { date: DATE, mealType: 'midnight_snack', specificDish: 'おにぎり' });
    expect(out.success).toBe(true);
    expect(out.result).not.toHaveProperty('error');
  });

  it.each([
    ['存在しない値', 'brunch'],
    ['大文字小文字が違う', 'Midnight_Snack'],
    ['ハイフン', 'midnight-snack'],
    ['日本語 (夜食)', '夜食'],
    ['日本語 (朝食)', '朝食'],
    ['前に空白', ' dinner'],
    ['後ろに空白', 'dinner '],
    ['複数指定', 'lunch,dinner'],
    ['すべて', 'all'],
    ['配列', ['dinner']],
    ['オブジェクト', { mealType: 'dinner' }],
    ['数値', 1],
    ['真偽値', true],
  ])('5 値以外 (%s) は、DB にも Edge Function にも触れずに断る。エラーに許可する 5 値を入れる', async (_label, mealType) => {
    const db = makeSupabase();
    const out = await generateSingleMeal(db, { date: DATE, mealType });

    expect(out.success).toBe(false);
    expect(out.result).toEqual({
      error: 'mealType は breakfast/lunch/dinner/snack/midnight_snack のいずれかである必要があります',
    });
    expect(db.from).not.toHaveBeenCalled();
    expect(queueDb.from).not.toHaveBeenCalled();
    expect(resolveExistingTargetSlots).not.toHaveBeenCalled();
    expect(invokeGenerateMenuV4WithRetry).not.toHaveBeenCalled();
    expect(db.functions.invoke).not.toHaveBeenCalled();
  });

  it.each([
    ['mealType が無い', { date: DATE }],
    ['mealType が空文字', { date: DATE, mealType: '' }],
    ['mealType が null', { date: DATE, mealType: null }],
    ['date が無い', { mealType: 'midnight_snack' }],
  ])('必須項目の抜け (%s) は、従来どおり「date と mealType は必須です」', async (_label, params) => {
    const db = makeSupabase();
    const out = await generateSingleMeal(db, params);

    expect(out.success).toBe(false);
    expect(out.result).toEqual({ error: 'date と mealType は必須です' });
    expect(db.from).not.toHaveBeenCalled();
    expect(queueDb.from).not.toHaveBeenCalled();
  });
});

describe('システムプロンプトの mealType は executor の許可リストと同じ (#1103)', () => {
  const routeSource = fs.readFileSync(
    path.join(__dirname, '../src/app/api/ai/consultation/sessions/[sessionId]/messages/route.ts'),
    'utf8',
  );

  it('generate_single_meal の mealType は AI_ALLOWED_MEAL_TYPES から作る', () => {
    expect(routeSource).toContain("mealType: \"${AI_ALLOWED_MEAL_TYPES.join('|')}\"");
    expect(routeSource).toMatch(/import \{[^}]*\bAI_ALLOWED_MEAL_TYPES\b[^}]*\} from '@\/lib\/ai\/consultation-action-executor'/);
  });

  it('★4 値だけの固定文字列 (夜食が抜けた "breakfast|lunch|dinner|snack") を持たない', () => {
    expect(routeSource).not.toMatch(/breakfast\|lunch\|dinner\|snack(?!\|midnight_snack)/);
  });

  it('各 mealType が何の食事かを AI に伝える (夜食 = midnight_snack)。献立一覧の表示に使う mealTypeLabels から作る', () => {
    expect(routeSource).toMatch(/AI_ALLOWED_MEAL_TYPES\.map\(.*mealTypeLabels\[/);
    expect(routeSource).toMatch(/midnight_snack: '夜食'/);
  });
});
