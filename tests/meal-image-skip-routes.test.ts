// @vitest-environment node
/**
 * #1487 料理画像を付ける 5 つの入口 (POST /api/meals・PATCH /api/meals/[id]・POST /api/meal-plans/meals・
 * PATCH /api/meal-plans/meals/[id]・AI 相談の update_meal) の、見送り・積み直し・数え戻し
 *
 * 料理の画像の組み立て (buildDishImagePayload → reconcileDishImages) とジョブの積み方 (enqueueMealImageJobs) は本物を使い、
 * DB (利用者のクライアント・service role のクライアント)・レート制限・同意の判定・上限の判定と数え戻しだけを作り物にする。
 *
 *   A. 料理画像の安全弁で止められた (consumeAiUsage が不許可): 料理は 'failed' + skipped_ai_limit で保存され ('pending' のまま残らない)、
 *      ジョブを積まない。応答に aiSkipped
 *   B. レート制限で止められた・判定が例外: 'failed' + skipped_rate_limit で保存し、上限を数えない。応答に imageGenerationThrottled
 *   C. 許可: 'pending' で保存してからジョブを積む (行ごとの insert)。数え戻さない
 *   D. ジョブの書き込みに失敗・すべて重複: 数えた 1 回を戻す
 *   E. 献立の保存に失敗: 数えた 1 回を戻し、ジョブを積まない
 *   F. (更新の入口) 前回見送った・失敗した・待ちの同じ料理を保存し直す: ジョブを積み直す。画像のある料理は積まない
 *   G. (#1487 の整合ゲート) 実データの形 (subject_hash の無い写真の料理 = buildPhotoDishList の出力、商品の料理 =
 *      buildCatalogSelectionUpdate の dishes) を前回にして、完了の切り替え (料理以外だけを変える保存) ではジョブを積まず・
 *      consumeAiUsage を呼ばず・料理の画像を消さない。料理の中身を変えても写真・商品の画像を AI の画像で置き換えない
 *   H. (#1487 の整合ゲート) 商品を選んだ保存 (catalogProductId): 料理は商品の料理 (画像は商品の画像) で、AI の画像のジョブを作らない
 *   I. (#1487 の整合ゲート R1) 商品の献立の古い商品の料理 (origin/main の形: 画像の項目なし。以前の保存し直しで generated_ai に書き換わった形) と、
 *      写真の複数の料理に料理を足す保存: ジョブを積まず・数えず、献立のカバーは商品・写真の画像のまま
 *   J. (#1487 の整合ゲート 3 回目・カバーの持ち主) 料理が 3 品の AI の献立に利用者がカバーを付ける保存: カバーは利用者の画像になり、
 *      ジョブは今の決まりのまま積む。画像の処理が料理の画像を書いても、完了を切り替えても、カバーは利用者の画像のまま。
 *      新しく作る入口 (POST) で送られた写真の料理は、画像を消さず AI の画像の料理にしない
 *   K. (#1553) 料理が 2 品以上の献立の PATCH に image_url / imageUrl の null: 利用者・写真のカバーを外し、AI の料理の画像
 *      (あれば) に戻す。料理が 1 品の献立 (手で付けた画像・AI の画像と別の利用者のカバー) は今までどおり変えない
 *
 * 献立の行の作り物は、入口が select で名指しした列だけを返す (入口が読まない列 (catalog_product_id など) を読んだことにしない)
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiUsageResult } from '../supabase/functions/_shared/ai-daily-limit';
import {
  applyGeneratedDishImage,
  buildDishImageSubjectHash,
  buildPhotoDishList,
  reconcileDishImages,
  type MealImageDish,
} from '../supabase/functions/_shared/meal-image';
import { AI_USAGE_ALLOWED, AI_USAGE_DENIED } from './helpers/ai-usage-mock';

const USER_ID = 'user-1';
// route は UUID の形でない id を DB に渡さず 404 にする (#1917) ので、食事・1 日の献立の id は UUID の形にする
const MEAL_ID = '77777777-7777-4777-8777-777777777774';
const DAY_ID = '77777777-7777-4777-8777-777777777775';
const CURRY = { name: 'カレー', role: 'main' };
const PHOTO_URL = 'https://example.com/storage/meal-photos/user-1/photo.jpg';
const PRODUCT_URL = 'https://example.com/catalog/bento.jpg';
const CATALOG_PRODUCT_ID = 'catalog-1';
/** catalog_products の行 (buildCatalogSelectionUpdate が読む) */
const CATALOG_ROW = {
  id: CATALOG_PRODUCT_ID,
  source_id: 'source-1',
  name: '幕の内弁当',
  brand_name: 'ブランド',
  category_code: null,
  description: null,
  main_image_url: PRODUCT_URL,
  canonical_url: 'https://example.com/catalog/bento',
  price_yen: 500,
  calories_kcal: 650,
  protein_g: 20,
  fat_g: 18,
  carbs_g: 90,
  sodium_g: 2.5,
  fiber_g: 3,
  sugar_g: 5,
  availability_status: 'available',
  catalog_sources: { code: 'store', brand_name: 'ブランド' },
};

interface DbError {
  code: string;
  message: string;
}
interface Write {
  table: string;
  op: 'insert' | 'update' | 'upsert';
  payload: unknown;
}

const h = vi.hoisted(() => ({
  state: {
    /** 献立 (planned_meals) の今の行 (更新の入口が読む) */
    existingDishes: [] as MealImageDish[],
    /** 献立の今のカバー画像 (planned_meals.image_url) */
    existingImageUrl: null as string | null,
    /** 献立の今の商品 (planned_meals.catalog_product_id) */
    existingCatalogProductId: null as string | null,
    /** 献立の今の作り方 (planned_meals.source_type) */
    existingSourceType: null as string | null,
    /** planned_meals の insert / update の失敗 */
    saveError: null as { code: string; message: string } | null,
    /** meal_image_jobs の insert の結果 */
    queueError: null as { code: string; message: string } | null,
    /** meal_image_jobs の insert の結果を行ごとに決める (#1532。queueError より優先) */
    queueErrorFor: null as ((row: Record<string, unknown>) => { code: string; message: string } | null) | null,
    writes: [] as Array<{ table: string; op: 'insert' | 'update' | 'upsert'; payload: unknown }>,
    queueInserts: [] as Array<Record<string, unknown>>,
  },
  checkRateLimit: vi.fn(),
  checkUserAiConsent: vi.fn(),
  consumeAiUsage: vi.fn(),
  refundAiUsage: vi.fn(async () => undefined),
  trigger: vi.fn(async () => undefined),
}));

/**
 * select の列の指定 ('id, dishes, user_daily_meals!inner(user_id)' など) の、列 (埋め込みは表の名前) の一覧。'*' や指定なしは null (全部)
 */
function selectedColumns(columns: unknown): Set<string> | null {
  if (typeof columns !== 'string' || columns.trim() === '' || columns.trim() === '*') return null;
  const names: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of columns) {
    if (char === '(') depth += 1;
    if (char === ')') depth -= 1;
    if (char === ',' && depth === 0) {
      names.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  names.push(current);
  return new Set(names.map((name) => name.trim().split(/[!(:\s]/)[0]).filter(Boolean));
}

/** 利用者のクライアントの作り物。どのメソッドを繋いでも同じものを返し、single / maybeSingle / await で表ごとの結果を返す */
function makeUserDb() {
  const from = (table: string) => {
    let op: Write['op'] | 'select' = 'select';
    let payload: unknown = null;
    /** 読むときに入口が名指しした列 (null は全部) */
    let readColumns: Set<string> | null = null;
    const result = (): { data: unknown; error: DbError | null } => {
      if (table === 'user_daily_meals') return { data: { id: DAY_ID }, error: null };
      if (table === 'catalog_products') return { data: CATALOG_ROW, error: null };
      if (table === 'planned_meals') {
        if (op === 'select') {
          const row: Record<string, unknown> = {
            id: MEAL_ID,
            dish_name: 'カレー',
            mode: 'cook',
            catalog_product_id: h.state.existingCatalogProductId,
            source_type: h.state.existingSourceType,
            generation_metadata: null,
            dishes: h.state.existingDishes,
            image_url: h.state.existingImageUrl,
            user_daily_meals: { user_id: USER_ID },
          };
          const columns = readColumns;
          return { data: columns ? Object.fromEntries(Object.entries(row).filter(([key]) => columns.has(key))) : row, error: null };
        }
        if (h.state.saveError) return { data: null, error: h.state.saveError };
        return { data: { id: MEAL_ID, daily_meal_id: DAY_ID, ...(payload as Record<string, unknown>) }, error: null };
      }
      return { data: null, error: null };
    };
    const builder: Record<string, unknown> = {};
    const chain = () => builder;
    for (const name of ['eq', 'in', 'is', 'order', 'limit']) builder[name] = chain;
    builder.select = (columns?: unknown) => {
      if (op === 'select') readColumns = selectedColumns(columns);
      return builder;
    };
    for (const name of ['insert', 'update', 'upsert'] as const) {
      builder[name] = (value: unknown) => {
        op = name;
        payload = value;
        h.state.writes.push({ table, op: name, payload: value });
        return builder;
      };
    }
    builder.single = async () => result();
    builder.maybeSingle = async () => result();
    builder.then = (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
      Promise.resolve(result()).then(resolve, reject);
    return builder;
  };
  return { from, auth: { getUser: async () => ({ data: { user: { id: USER_ID } }, error: null }) } };
}

/** service role のクライアントの作り物 (meal_image_jobs への行ごとの insert) */
function makeQueueDb() {
  return {
    from: (table: string) => ({
      insert: async (row: Record<string, unknown>) => {
        if (table !== 'meal_image_jobs') throw new Error(`unexpected queue table ${table}`);
        const error = h.state.queueErrorFor ? h.state.queueErrorFor(row) : h.state.queueError;
        if (error) return { data: null, error };
        h.state.queueInserts.push(row);
        return { data: null, error: null };
      },
      upsert: () => {
        throw new Error('meal_image_jobs は upsert (ON CONFLICT) で積まない (#1487)');
      },
    }),
  };
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => makeUserDb(),
  getSupabaseAdmin: () => makeQueueDb(),
}));
vi.mock('@/lib/ai/ai-queue-writer', () => ({ getAiQueueWriter: () => makeQueueDb() }));
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: h.checkRateLimit, rateLimitExceededResponse: vi.fn() }));
vi.mock('@/lib/ai/consent-guard', () => ({ checkUserAiConsent: h.checkUserAiConsent }));
vi.mock('@/lib/plan/entitlements', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/plan/entitlements')>()),
  consumeAiUsage: h.consumeAiUsage,
  refundAiUsage: h.refundAiUsage,
}));
vi.mock('../lib/meal-image-jobs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/meal-image-jobs')>()),
  triggerMealImageJobProcessing: h.trigger,
}));
vi.mock('@/lib/db-logger', () => {
  const logger = () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn() });
  return { createLogger: () => ({ ...logger(), withUser: () => logger() }) };
});
// AI 相談のアクションの実行部が読むもの (update_meal では使わない)
vi.mock('@/lib/feature-flags', () => ({ isFeatureEnabled: vi.fn(async () => false) }));
vi.mock('@/lib/generate-menu-v4-retry', () => ({ invokeGenerateMenuV4WithRetry: vi.fn(), markWeeklyMenuRequestFailed: vi.fn() }));
vi.mock('@/lib/v4-target-slots', () => ({ resolveExistingTargetSlots: vi.fn() }));
vi.mock('@/lib/health-streaks', () => ({ updateHealthStreak: vi.fn() }));

import { POST as mealsPost } from '../src/app/api/meals/route';
import { PATCH as mealsPatch } from '../src/app/api/meals/[id]/route';
import { POST as mealPlansPost } from '../src/app/api/meal-plans/meals/route';
import { PATCH as mealPlansPatch } from '../src/app/api/meal-plans/meals/[id]/route';
import { runConsultationAction } from '../src/lib/ai/consultation-action-executor';
import { buildCatalogSelectionUpdate } from '../lib/catalog-products';

/** 入口を 1 回動かした結果 (応答の本文 / アクションの結果) */
type Outcome = Record<string, unknown>;

interface Entry {
  name: string;
  /** 前回の料理を読んで更新する入口か (同じ料理の保存し直しを確かめる) */
  updates: boolean;
  run: () => Promise<Outcome>;
}

/** 入口へ送る x-request-id (#1532。null なら送らない) */
let requestIdHeader: string | null = null;
/** 入口へ送る料理 (#1532 で 2 品にする。既定はカレー 1 品) */
let submittedDishes: MealImageDish[] = [CURRY];

const json = (url: string, method: string, body: unknown) =>
  new Request(url, {
    method,
    headers: { 'content-type': 'application/json', ...(requestIdHeader === null ? {} : { 'x-request-id': requestIdHeader }) },
    body: JSON.stringify(body),
  });

const ENTRIES: Entry[] = [
  {
    name: 'POST /api/meals',
    updates: false,
    run: async () => {
      const res = await mealsPost(json('http://localhost/api/meals', 'POST', { date: '2026-10-11', mealType: 'dinner', dishName: 'カレー', dishes: submittedDishes }));
      return { status: res.status, ...((await res.json()) as Outcome) };
    },
  },
  {
    name: 'POST /api/meal-plans/meals',
    updates: false,
    run: async () => {
      const res = await mealPlansPost(json('http://localhost/api/meal-plans/meals', 'POST', { dayDate: '2026-10-11', mealType: 'dinner', dishName: 'カレー', dishes: submittedDishes }));
      return { status: res.status, ...((await res.json()) as Outcome) };
    },
  },
  {
    name: 'PATCH /api/meals/[id]',
    updates: true,
    run: async () => {
      const res = await mealsPatch(json(`http://localhost/api/meals/${MEAL_ID}`, 'PATCH', { dishes: submittedDishes }), { params: { id: MEAL_ID } });
      return { status: res.status, ...((await res.json()) as Outcome) };
    },
  },
  {
    name: 'PATCH /api/meal-plans/meals/[id]',
    updates: true,
    run: async () => {
      const res = await mealPlansPatch(json(`http://localhost/api/meal-plans/meals/${MEAL_ID}`, 'PATCH', { dishes: submittedDishes }), { params: { id: MEAL_ID } });
      return { status: res.status, ...((await res.json()) as Outcome) };
    },
  },
  {
    name: 'AI 相談の update_meal',
    updates: true,
    run: async () => {
      const db = makeUserDb();
      const out = await runConsultationAction(db as unknown as Parameters<typeof runConsultationAction>[0], { id: USER_ID }, {
        id: 'action-1',
        action_type: 'update_meal',
        action_params: { mealId: MEAL_ID, updates: { dishes: submittedDishes } },
      } as unknown as Parameters<typeof runConsultationAction>[2]);
      return { status: out.success ? 200 : 500, ...((out.result ?? {}) as Outcome) };
    },
  },
];

/** planned_meals に保存した料理 (insert / update の最後の dishes) */
function savedDishes(): MealImageDish[] {
  const saves = h.state.writes.filter((w) => w.table === 'planned_meals' && (w.op === 'insert' || w.op === 'update'));
  const last = saves[saves.length - 1]?.payload as { dishes?: MealImageDish[] } | undefined;
  return last?.dishes ?? [];
}

beforeEach(() => {
  vi.clearAllMocks();
  h.state.existingDishes = [];
  h.state.existingImageUrl = null;
  h.state.existingCatalogProductId = null;
  h.state.existingSourceType = null;
  h.state.saveError = null;
  h.state.queueError = null;
  h.state.queueErrorFor = null;
  requestIdHeader = null;
  submittedDishes = [CURRY];
  h.state.writes = [];
  h.state.queueInserts = [];
  h.checkRateLimit.mockResolvedValue({ success: true, limit: 1, remaining: 0, reset: 0 });
  h.checkUserAiConsent.mockResolvedValue({ allowed: true });
  h.consumeAiUsage.mockResolvedValue(AI_USAGE_ALLOWED);
});

describe.each(ENTRIES)('#1487 料理画像の見送り・数え戻し: $name', (entry) => {
  it('A. 料理画像の安全弁で止められた: 料理を failed + skipped_ai_limit で保存し (pending を残さない)、ジョブを積まない', async () => {
    const capped: AiUsageResult = { ...AI_USAGE_DENIED, safetyCap: true };
    h.consumeAiUsage.mockResolvedValue(capped);
    const out = await entry.run();

    expect(out.status).toBe(200);
    expect(h.consumeAiUsage).toHaveBeenCalledWith(USER_ID, 'meal_image_auto');
    expect(savedDishes()).toHaveLength(1);
    expect(savedDishes()[0]).toMatchObject({ name: 'カレー', image_status: 'failed', image_error: 'skipped_ai_limit', image_url: null });
    expect(h.state.queueInserts).toEqual([]);
    expect(h.trigger).not.toHaveBeenCalled();
    expect(h.refundAiUsage).not.toHaveBeenCalled();
    expect(out.aiSkipped).toBe('AI_DAILY_LIMIT');
    // 献立の保存は 1 回だけ (保存したあとに料理を書き直す 2 回目の update で直す形ではない。判定は保存の前)
    expect(h.state.writes.filter((w) => w.table === 'planned_meals')).toHaveLength(1);
  });

  it('A-plan. meal_image_auto が plan-locked: 料理を failed + skipped_plan で保存し (pending を残さない)、ジョブを積まず、数え戻さず、aiSkipped を付けない', async () => {
    const locked: AiUsageResult = { ...AI_USAGE_DENIED, limit: 0, used: 0, cappedFeature: 'meal_image_auto', planLocked: true };
    h.consumeAiUsage.mockResolvedValue(locked);
    const out = await entry.run();

    expect(out.status).toBe(200);
    expect(h.consumeAiUsage).toHaveBeenCalledWith(USER_ID, 'meal_image_auto');
    expect(savedDishes()).toHaveLength(1);
    expect(savedDishes()[0]).toMatchObject({ name: 'カレー', image_status: 'failed', image_error: 'skipped_plan', image_url: null });
    expect(h.state.queueInserts).toEqual([]);
    expect(h.trigger).not.toHaveBeenCalled();
    expect(h.refundAiUsage).not.toHaveBeenCalled();
    expect(out.aiSkipped).toBeUndefined();
    expect(out.imageGenerationThrottled).toBeUndefined();
  });

  it('Q-16. 汁物と主菜 (主菜が 2 品目) を保存すると、主菜の 1 行 (dish_index 1) だけを積んで 1 回数え、汁物は画像の無い状態で保存する', async () => {
    submittedDishes = [SOUP, CURRY];
    const out = await entry.run();

    expect(out.status).toBe(200);
    expect(h.consumeAiUsage).toHaveBeenCalledTimes(1);
    expect(h.consumeAiUsage).toHaveBeenCalledWith(USER_ID, 'meal_image_auto');
    expect(h.state.queueInserts.map((row) => row.dish_index)).toEqual([1]);
    // POST の入口は 1 品目の名前を献立の名前 (dishName) にするので、役割で見る
    expect(savedDishes()[0]).toMatchObject({ role: 'soup', image_url: null, image_source: null, image_status: null, image_subject_hash: null });
    expect(savedDishes()[1]).toMatchObject({ role: 'main', image_source: 'generated_ai', image_status: 'pending' });
  });

  it('B. レート制限で止められた: failed + skipped_rate_limit で保存し、上限を数えない', async () => {
    h.checkRateLimit.mockResolvedValue({ success: false, limit: 1, remaining: 0, reset: 0 });
    const out = await entry.run();

    expect(out.status).toBe(200);
    expect(savedDishes()[0]).toMatchObject({ image_status: 'failed', image_error: 'skipped_rate_limit' });
    expect(h.consumeAiUsage).not.toHaveBeenCalled();
    expect(h.state.queueInserts).toEqual([]);
    expect(out.imageGenerationThrottled).toBe(true);
    expect(out.aiSkipped).toBeUndefined();
  });

  it('B. レート制限の判定が例外: failed + skipped_rate_limit で保存し、保存は成功させる', async () => {
    h.checkRateLimit.mockRejectedValue(new Error('upstash unreachable'));
    const out = await entry.run();

    expect(out.status).toBe(200);
    expect(savedDishes()[0]).toMatchObject({ image_status: 'failed', image_error: 'skipped_rate_limit' });
    expect(h.state.queueInserts).toEqual([]);
  });

  it('C. 許可: pending で保存してからジョブを 1 行積む。数え戻さない', async () => {
    const out = await entry.run();

    expect(out.status).toBe(200);
    expect(savedDishes()[0]).toMatchObject({ image_status: 'pending', image_error: null });
    expect(h.state.queueInserts).toHaveLength(1);
    expect(h.state.queueInserts[0]).toMatchObject({ planned_meal_id: MEAL_ID, user_id: USER_ID, dish_index: 0, status: 'pending' });
    expect(h.trigger).toHaveBeenCalledTimes(1);
    expect(h.refundAiUsage).not.toHaveBeenCalled();
  });

  it('C. 同意が無い: 数えずにジョブを積む (処理する Edge Function が止めて failed にする)', async () => {
    h.checkUserAiConsent.mockResolvedValue({ allowed: false, reason: 'not_consented' });
    await entry.run();

    expect(h.consumeAiUsage).not.toHaveBeenCalled();
    expect(savedDishes()[0]).toMatchObject({ image_status: 'pending' });
    expect(h.state.queueInserts).toHaveLength(1);
    expect(h.refundAiUsage).not.toHaveBeenCalled();
  });

  it.each([
    ['書き込みに失敗', { code: '42501', message: 'permission denied for table meal_image_jobs' }],
    ['同じ料理のジョブが待ち・処理中 (重複)', { code: '23505', message: 'duplicate key value' }],
  ])('D. ジョブを 1 行も積めなかった (%s): 数えた 1 回を戻す', async (_label, error) => {
    h.state.queueError = error;
    const out = await entry.run();

    expect(out.status).toBe(200);
    expect(h.state.queueInserts).toEqual([]);
    expect(h.refundAiUsage).toHaveBeenCalledTimes(1);
    expect(h.refundAiUsage).toHaveBeenCalledWith(USER_ID, 'meal_image_auto', AI_USAGE_ALLOWED);
  });

  it('E. 献立の保存に失敗: 数えた 1 回を戻し、ジョブを積まない', async () => {
    h.state.saveError = { code: 'XX000', message: 'boom' };
    const out = await entry.run();

    expect(out.status).toBeGreaterThanOrEqual(500);
    expect(h.state.queueInserts).toEqual([]);
    expect(h.refundAiUsage).toHaveBeenCalledTimes(1);
    expect(h.refundAiUsage).toHaveBeenCalledWith(USER_ID, 'meal_image_auto', AI_USAGE_ALLOWED);
  });

  it('E. 安全弁で止められたあと保存に失敗: 数えていないので戻さない', async () => {
    h.consumeAiUsage.mockResolvedValue(AI_USAGE_DENIED);
    h.state.saveError = { code: 'XX000', message: 'boom' };
    await entry.run();

    expect(h.refundAiUsage).not.toHaveBeenCalled();
  });
});

describe.each(ENTRIES.filter((entry) => entry.updates))('#1487 同じ料理の保存し直し: $name', (entry) => {
  async function previousCurry(overrides: Partial<MealImageDish>): Promise<MealImageDish[]> {
    return [{ ...CURRY, image_subject_hash: await buildDishImageSubjectHash(CURRY, 0), image_source: 'generated_ai', image_url: null, ...overrides }];
  }

  it.each([
    ['見送った (failed + skipped_ai_limit)', { image_status: 'failed' as const, image_error: 'skipped_ai_limit' }],
    ['待ちのまま (pending。前は永久に「生成中」だった)', { image_status: 'pending' as const }],
    ['失敗 (failed)', { image_status: 'failed' as const, image_error: 'storage upload failed' }],
  ])('F. 前回 %s の同じ料理: ジョブを積み直し、pending で保存する', async (_label, overrides) => {
    h.state.existingDishes = await previousCurry(overrides);
    await entry.run();

    expect(h.consumeAiUsage).toHaveBeenCalledWith(USER_ID, 'meal_image_auto');
    expect(savedDishes()[0]).toMatchObject({ image_status: 'pending', image_error: null });
    expect(h.state.queueInserts).toHaveLength(1);
    expect(h.state.queueInserts[0]).toMatchObject({ dish_index: 0, subject_hash: await buildDishImageSubjectHash(CURRY, 0) });
  });

  it('F. 前回画像を作れた (ready) 同じ料理: 積まず、数えない', async () => {
    h.state.existingDishes = await previousCurry({ image_status: 'ready', image_url: 'https://example.com/curry.png' });
    await entry.run();

    expect(h.checkRateLimit).not.toHaveBeenCalled();
    expect(h.consumeAiUsage).not.toHaveBeenCalled();
    expect(h.state.queueInserts).toEqual([]);
    expect(savedDishes()[0]).toMatchObject({ image_status: 'ready', image_url: 'https://example.com/curry.png' });
  });

  it('F. 見送ったあとも安全弁に達したまま: もう一度見送りにして保存する (pending を残さない)', async () => {
    h.state.existingDishes = await previousCurry({ image_status: 'failed', image_error: 'skipped_ai_limit' });
    h.consumeAiUsage.mockResolvedValue(AI_USAGE_DENIED);
    await entry.run();

    expect(savedDishes()[0]).toMatchObject({ image_status: 'failed', image_error: 'skipped_ai_limit' });
    expect(h.state.queueInserts).toEqual([]);
  });
});

/** 更新の入口に、料理以外 (または料理) だけを変える本文を送る */
interface UpdateEntry {
  name: string;
  /** 完了の切り替え (料理以外だけを変える保存) */
  toggle: () => Promise<Outcome>;
  /** 料理を送る保存 */
  withDishes: (dishes: MealImageDish[]) => Promise<Outcome>;
}

const runConsultation = async (updates: Record<string, unknown>): Promise<Outcome> => {
  const db = makeUserDb();
  const out = await runConsultationAction(db as unknown as Parameters<typeof runConsultationAction>[0], { id: USER_ID }, {
    id: 'action-1',
    action_type: 'update_meal',
    action_params: { mealId: MEAL_ID, updates },
  } as unknown as Parameters<typeof runConsultationAction>[2]);
  return { status: out.success ? 200 : 500, ...((out.result ?? {}) as Outcome) };
};

const UPDATE_ENTRIES: UpdateEntry[] = [
  {
    name: 'PATCH /api/meals/[id]',
    toggle: async () => {
      const res = await mealsPatch(json(`http://localhost/api/meals/${MEAL_ID}`, 'PATCH', { is_completed: true }), { params: { id: MEAL_ID } });
      return { status: res.status, ...((await res.json()) as Outcome) };
    },
    withDishes: async (dishes) => {
      const res = await mealsPatch(json(`http://localhost/api/meals/${MEAL_ID}`, 'PATCH', { dishes }), { params: { id: MEAL_ID } });
      return { status: res.status, ...((await res.json()) as Outcome) };
    },
  },
  {
    name: 'PATCH /api/meal-plans/meals/[id]',
    toggle: async () => {
      const res = await mealPlansPatch(json(`http://localhost/api/meal-plans/meals/${MEAL_ID}`, 'PATCH', { isCompleted: true }), { params: { id: MEAL_ID } });
      return { status: res.status, ...((await res.json()) as Outcome) };
    },
    withDishes: async (dishes) => {
      const res = await mealPlansPatch(json(`http://localhost/api/meal-plans/meals/${MEAL_ID}`, 'PATCH', { dishes }), { params: { id: MEAL_ID } });
      return { status: res.status, ...((await res.json()) as Outcome) };
    },
  },
  {
    name: 'AI 相談の update_meal',
    // AI 相談の update_meal は完了の項目を持たない (完了は complete_meal)。料理以外だけを変える更新としてメモを変える
    toggle: () => runConsultation({ memo: '少なめに食べた' }),
    withDishes: (dishes) => runConsultation({ dishes }),
  },
];

/** 実データの形の前回の料理と献立のカバー */
interface MealShape {
  label: string;
  build: () => Promise<{ dishes: MealImageDish[]; cover: string | null; catalogProductId: string | null }>;
  /** 画像の項目の無い古い商品の料理 (保存すると、商品の料理 (image_source: 'catalog') として保存する) */
  legacyCatalog?: boolean;
}

/** origin/main の buildCatalogMealFields・端末の保存が作った商品の料理 (画像の項目なし。画像は献立のカバーだけ) */
const LEGACY_CATALOG_DISH: MealImageDish = { name: '幕の内弁当', role: 'main', calories_kcal: 650, protein_g: 20 };

/** 保存したあとの料理の image_source (古い商品の料理は商品の料理として保存する) */
const savedSourceOf = (shape: MealShape, dish: MealImageDish) => (shape.legacyCatalog ? 'catalog' : dish.image_source);

const MEAL_SHAPES: MealShape[] = [
  {
    label: '写真の料理 (1 つ・buildPhotoDishList の出力)',
    build: async () => ({ dishes: buildPhotoDishList([{ name: '親子丼', role: 'main' }], PHOTO_URL), cover: PHOTO_URL, catalogProductId: null }),
  },
  {
    label: '写真の料理 (複数・buildPhotoDishList の出力)',
    build: async () => ({
      dishes: buildPhotoDishList([{ name: '親子丼', role: 'main' }, { name: '味噌汁', role: 'soup' }], PHOTO_URL),
      cover: PHOTO_URL,
      catalogProductId: null,
    }),
  },
  {
    label: '商品の料理 (buildCatalogSelectionUpdate の dishes)',
    build: async () => {
      const { fields } = await buildCatalogSelectionUpdate({
        supabase: makeUserDb() as unknown as Parameters<typeof buildCatalogSelectionUpdate>[0]['supabase'],
        catalogProductId: CATALOG_PRODUCT_ID,
        selectedFrom: 'manual_search',
      });
      return { dishes: fields.dishes as MealImageDish[], cover: fields.image_url as string | null, catalogProductId: CATALOG_PRODUCT_ID };
    },
  },
  {
    label: '商品の料理 (origin/main の形・画像の項目なし)',
    build: async () => ({ dishes: [{ ...LEGACY_CATALOG_DISH }], cover: PRODUCT_URL, catalogProductId: CATALOG_PRODUCT_ID }),
    legacyCatalog: true,
  },
];

/** planned_meals に保存した最後の行 */
function savedRow(): Record<string, unknown> {
  const saves = h.state.writes.filter((w) => w.table === 'planned_meals' && (w.op === 'insert' || w.op === 'update'));
  return (saves[saves.length - 1]?.payload ?? {}) as Record<string, unknown>;
}

describe.each(UPDATE_ENTRIES)('#1487 G. 写真・商品の料理を保存し直す: $name', (entry) => {
  it.each(MEAL_SHAPES)('$label: 完了の切り替えでジョブを積まず、consumeAiUsage を呼ばず、料理の画像を消さない', async (shape) => {
    const meal = await shape.build();
    expect(meal.dishes.every((dish) => dish.image_subject_hash === undefined)).toBe(true);
    h.state.existingDishes = meal.dishes;
    h.state.existingImageUrl = meal.cover;
    h.state.existingCatalogProductId = meal.catalogProductId;

    const out = await entry.toggle();

    expect(out.status).toBe(200);
    expect(h.checkRateLimit).not.toHaveBeenCalled();
    expect(h.consumeAiUsage).not.toHaveBeenCalled();
    expect(h.state.queueInserts).toEqual([]);
    expect(h.trigger).not.toHaveBeenCalled();
    const row = savedRow();
    const saved = (row.dishes ?? []) as MealImageDish[];
    expect(saved).toHaveLength(meal.dishes.length);
    meal.dishes.forEach((dish, index) => {
      expect(saved[index]).toMatchObject({
        image_url: dish.image_url ?? null,
        image_source: savedSourceOf(shape, dish),
        image_status: dish.image_status ?? null,
      });
    });
    // 献立のカバーも写真・商品の画像のまま
    expect(row.image_url).toBe(meal.cover);
  });

  it.each(MEAL_SHAPES)('$label: 料理の中身を変えても、写真・商品の画像を AI の画像で置き換えない (ジョブを積まない)', async (shape) => {
    const meal = await shape.build();
    h.state.existingDishes = meal.dishes;
    h.state.existingImageUrl = meal.cover;
    h.state.existingCatalogProductId = meal.catalogProductId;

    // 画面が前回の料理を編集して送る形 (画像の項目がついたまま) と、AI が画像の項目の無い料理を送る形
    const edited = meal.dishes.map((dish) => ({ ...dish, name: `${String(dish.name)}(大盛り)` }));
    const bare = meal.dishes.map((_dish, index) => ({ name: `別の料理${index}`, role: 'main' }));
    for (const next of [edited, bare]) {
      h.state.writes = [];
      const out = await entry.withDishes(next);

      expect(out.status).toBe(200);
      expect(h.consumeAiUsage).not.toHaveBeenCalled();
      expect(h.state.queueInserts).toEqual([]);
      const saved = (savedRow().dishes ?? []) as MealImageDish[];
      meal.dishes.forEach((dish, index) => {
        expect(saved[index]).toMatchObject({ name: next[index].name, image_url: dish.image_url ?? null, image_source: savedSourceOf(shape, dish) });
      });
      // 献立のカバーも写真・商品の画像のまま
      expect(savedRow().image_url).toBe(meal.cover);
    }
  });

  it('料理を足しても、主菜でない料理には AI の画像のジョブを積まず・数えない (写真の料理は置き換えない。billing/03 Q-16)', async () => {
    h.state.existingDishes = buildPhotoDishList([{ name: '親子丼', role: 'main' }], PHOTO_URL);
    h.state.existingImageUrl = PHOTO_URL;

    await entry.withDishes([...h.state.existingDishes, { name: '味噌汁', role: 'soup' }]);

    expect(h.consumeAiUsage).not.toHaveBeenCalled();
    expect(h.state.queueInserts).toEqual([]);
    const saved = savedRow().dishes as MealImageDish[];
    expect(saved[0]).toMatchObject({ image_url: PHOTO_URL, image_source: 'meal_photo', image_status: 'ready', image_subject_hash: null });
    expect(saved[1]).toMatchObject({ image_url: null, image_source: null, image_status: null, image_subject_hash: null });
  });

  it('Q-16. 主菜の画像ができた献立で汁物だけを変えて保存し直すと、積まず・数えず (consumeAiUsage を呼ばない)、汁物は画像の無い状態になる', async () => {
    const main: MealImageDish = {
      ...CURRY,
      image_subject_hash: await buildDishImageSubjectHash(CURRY, 0),
      image_source: 'generated_ai',
      image_status: 'ready',
      image_url: aiImageUrl(0),
    };
    h.state.existingDishes = [main, { name: '味噌汁', role: 'soup' }];
    h.state.existingImageUrl = aiImageUrl(0);

    const out = await entry.withDishes([{ ...main }, { name: 'すまし汁', role: 'soup' }]);

    expect(out.status).toBe(200);
    expect(h.consumeAiUsage).not.toHaveBeenCalled();
    expect(h.state.queueInserts).toEqual([]);
    const saved = savedRow().dishes as MealImageDish[];
    expect(saved[0]).toMatchObject({ image_url: aiImageUrl(0), image_status: 'ready' });
    expect(saved[1]).toMatchObject({ name: 'すまし汁', image_url: null, image_source: null, image_status: null, image_subject_hash: null });
  });

  it('Q-16. ご飯と主菜 (主菜は画像あり・ご飯は画像の無い状態) の献立で主菜を消して保存し直すと、ご飯の 1 行 (dish_index 0) を積んで 1 回数える', async () => {
    const rice: MealImageDish = { name: 'ご飯', role: 'rice' };
    const main: MealImageDish = {
      ...CURRY,
      image_subject_hash: await buildDishImageSubjectHash(CURRY, 1),
      image_source: 'generated_ai',
      image_status: 'ready',
      image_url: aiImageUrl(1),
    };
    h.state.existingDishes = [rice, main];
    h.state.existingImageUrl = aiImageUrl(1);

    const out = await entry.withDishes([{ ...rice }]);

    expect(out.status).toBe(200);
    expect(h.consumeAiUsage).toHaveBeenCalledTimes(1);
    expect(h.consumeAiUsage).toHaveBeenCalledWith(USER_ID, 'meal_image_auto');
    expect(h.state.queueInserts.map((row) => row.dish_index)).toEqual([0]);
    expect((savedRow().dishes as MealImageDish[])[0]).toMatchObject({ name: 'ご飯', image_source: 'generated_ai', image_status: 'pending', image_url: null });
  });
});

describe.each(UPDATE_ENTRIES)('#1487 I. 商品の献立の古い商品の料理・写真の複数の料理に足した料理 (整合ゲート R1): $name', (entry) => {
  /** 以前の reconcileDishImages が、古い商品の料理を「料理が変わった」とみなして書き換えた形 (ジョブは積めず、AI の画像はできていない) */
  async function rewrittenLegacyCatalogDish(): Promise<MealImageDish> {
    return {
      ...LEGACY_CATALOG_DISH,
      image_subject_hash: await buildDishImageSubjectHash(LEGACY_CATALOG_DISH, 0),
      image_source: 'generated_ai',
      image_status: 'stale',
      image_url: null,
      image_generated_at: null,
      image_error: null,
    };
  }

  const expectNoImageJob = () => {
    expect(h.checkRateLimit).not.toHaveBeenCalled();
    expect(h.consumeAiUsage).not.toHaveBeenCalled();
    expect(h.state.queueInserts).toEqual([]);
    expect(h.trigger).not.toHaveBeenCalled();
  };

  it.each([
    ['catalog_product_id で分かる', { catalogProductId: CATALOG_PRODUCT_ID, sourceType: 'catalog_product' }],
    ['source_type だけで分かる', { catalogProductId: null, sourceType: 'catalog_product' }],
  ])('以前の保存し直しで generated_ai・画像なしに書き換わった商品の料理 (%s): 完了の切り替え・名前の変更で積まず・数えず、商品の料理として保存し、カバーは商品の画像', async (_label, meal) => {
    for (const run of [() => entry.toggle(), () => entry.withDishes([{ ...LEGACY_CATALOG_DISH, name: '幕の内弁当(大盛り)' }])]) {
      vi.clearAllMocks();
      h.state.writes = [];
      h.state.existingDishes = [await rewrittenLegacyCatalogDish()];
      h.state.existingImageUrl = PRODUCT_URL;
      h.state.existingCatalogProductId = meal.catalogProductId;
      h.state.existingSourceType = meal.sourceType;

      const out = await run();

      expect(out.status).toBe(200);
      expectNoImageJob();
      expect((savedRow().dishes as MealImageDish[])[0]).toMatchObject({ image_url: null, image_source: 'catalog', image_status: null, image_subject_hash: null });
      expect(savedRow().image_url).toBe(PRODUCT_URL);
    }
  });

  it('写真の料理 (複数) に料理を足しても、足した料理に積まず・数えず (状態なし)、カバーは写真のまま', async () => {
    h.state.existingDishes = buildPhotoDishList([{ name: '親子丼', role: 'main' }, { name: '味噌汁', role: 'soup' }], PHOTO_URL);
    h.state.existingImageUrl = PHOTO_URL;

    const out = await entry.withDishes([...h.state.existingDishes, { name: 'お新香', role: 'side' }]);

    expect(out.status).toBe(200);
    expectNoImageJob();
    const saved = savedRow().dishes as MealImageDish[];
    expect(saved.slice(0, 2).map((dish) => [dish.image_source, dish.image_status, dish.image_url])).toEqual([
      ['meal_photo', 'stale', null],
      ['meal_photo', 'stale', null],
    ]);
    expect(saved[2]).toMatchObject({ name: 'お新香', image_url: null, image_source: null, image_status: null, image_subject_hash: null });
    expect(savedRow().image_url).toBe(PHOTO_URL);
  });
});

describe('#1487 H. 商品を選んだ保存では AI の画像のジョブを作らない', () => {
  const expectCatalogDish = (dishes: unknown) => {
    expect(dishes).toEqual([
      expect.objectContaining({ name: '幕の内弁当', image_url: PRODUCT_URL, image_source: 'catalog', image_status: 'ready' }),
    ]);
    expect((dishes as MealImageDish[])[0]).not.toHaveProperty('image_subject_hash');
  };

  it.each([
    ['POST /api/meals', async () => mealsPost(json('http://localhost/api/meals', 'POST', { date: '2026-10-11', mealType: 'lunch', dishName: 'カレー', dishes: [CURRY], catalogProductId: CATALOG_PRODUCT_ID }))],
    ['POST /api/meal-plans/meals', async () => mealPlansPost(json('http://localhost/api/meal-plans/meals', 'POST', { dayDate: '2026-10-11', mealType: 'lunch', dishName: 'カレー', dishes: [CURRY], catalogProductId: CATALOG_PRODUCT_ID }))],
  ])('%s: 送られた料理から積まず、数えず、商品の料理で保存する', async (_label, run) => {
    const res = await run();

    expect(res.status).toBe(200);
    expect(h.checkRateLimit).not.toHaveBeenCalled();
    expect(h.consumeAiUsage).not.toHaveBeenCalled();
    expect(h.state.queueInserts).toEqual([]);
    expectCatalogDish(savedRow().dishes);
    expect(savedRow().image_url).toBe(PRODUCT_URL);
  });

  it.each([
    ['PATCH /api/meals/[id]', async () => mealsPatch(json(`http://localhost/api/meals/${MEAL_ID}`, 'PATCH', { catalogProductId: CATALOG_PRODUCT_ID }), { params: { id: MEAL_ID } })],
    ['PATCH /api/meal-plans/meals/[id]', async () => mealPlansPatch(json(`http://localhost/api/meal-plans/meals/${MEAL_ID}`, 'PATCH', { catalogProductId: CATALOG_PRODUCT_ID }), { params: { id: MEAL_ID } })],
  ])('%s: AI の画像の料理の献立で商品を選んでも、前回の料理の名前を変えたものから積まず、商品の料理で保存する', async (_label, run) => {
    h.state.existingDishes = [{ ...CURRY, image_subject_hash: await buildDishImageSubjectHash(CURRY, 0), image_source: 'generated_ai', image_status: 'ready', image_url: 'https://example.com/ai.png' }];
    h.state.existingImageUrl = 'https://example.com/ai.png';
    const res = await run();

    expect(res.status).toBe(200);
    expect(h.consumeAiUsage).not.toHaveBeenCalled();
    expect(h.state.queueInserts).toEqual([]);
    expectCatalogDish(savedRow().dishes);
    expect(savedRow().image_url).toBe(PRODUCT_URL);
  });
});

/** 料理が 3 品の AI の献立 (reconcileDishImages を通した、画像がまだ無い pending の料理) */
const THREE_AI_DISHES: MealImageDish[] = [
  { name: '鮭の塩焼き', role: 'main' },
  { name: 'ほうれん草のおひたし', role: 'side' },
  { name: '味噌汁', role: 'soup' },
];
const USER_COVER = 'https://example.com/storage/generated/user-1/user-made.png';
const aiImageUrl = (dishIndex: number) => `https://example.com/storage/fridge-images/generated/${MEAL_ID}/job-${dishIndex}.png`;

/** 画像の処理 (process-meal-image-jobs) が、積んだジョブの料理に AI の画像を書いたあとの料理とカバー (applyGeneratedDishImage) */
function runImageWorker(dishes: MealImageDish[], cover: string | null): { dishes: MealImageDish[]; cover: string | null } {
  let current = dishes;
  let currentCover = cover;
  for (const job of h.state.queueInserts) {
    const applied = applyGeneratedDishImage({
      dishes: current,
      dishIndex: Number(job.dish_index),
      imageUrl: aiImageUrl(Number(job.dish_index)),
      generatedAt: '2026-10-12T00:00:00.000Z',
      currentCoverImageUrl: currentCover,
    });
    current = applied.dishes;
    currentCover = applied.coverImageUrl;
  }
  return { dishes: current, cover: currentCover };
}

interface CoverEntry extends UpdateEntry {
  /** 利用者がカバーを付ける保存 (Web の PATCH {imageUrl}・PATCH /api/meals/[id] の image_url・AI 相談の update_meal の image_url) */
  withCover: (url: string) => Promise<Outcome>;
}

const COVER_ENTRIES: CoverEntry[] = UPDATE_ENTRIES.map((entry) => ({
  ...entry,
  withCover: async (url: string) => {
    if (entry.name === 'PATCH /api/meals/[id]') {
      const res = await mealsPatch(json(`http://localhost/api/meals/${MEAL_ID}`, 'PATCH', { image_url: url }), { params: { id: MEAL_ID } });
      return { status: res.status, ...((await res.json()) as Outcome) };
    }
    if (entry.name === 'PATCH /api/meal-plans/meals/[id]') {
      const res = await mealPlansPatch(json(`http://localhost/api/meal-plans/meals/${MEAL_ID}`, 'PATCH', { imageUrl: url }), { params: { id: MEAL_ID } });
      return { status: res.status, ...((await res.json()) as Outcome) };
    }
    return runConsultation({ image_url: url });
  },
}));

describe.each(COVER_ENTRIES)('#1487 J. カバーの持ち主 (利用者が付けたカバーを AI の料理の画像で置き換えない): $name', (entry) => {
  it('3 品の AI の献立 (画像を待つのは主菜だけ。billing/03 Q-16) にカバーを付ける → 画像の処理が料理の画像を書く → 完了を切り替える: カバーは利用者の画像のまま', async () => {
    h.state.existingDishes = (await reconcileDishImages({ previousDishes: [], nextDishes: THREE_AI_DISHES, triggerSource: 'test' })).dishes;
    h.state.existingImageUrl = null;

    const out = await entry.withCover(USER_COVER);

    expect(out.status).toBe(200);
    expect(savedRow().image_url).toBe(USER_COVER);
    // 料理の画像のジョブは今の決まりのまま (画像の無い AI の料理を積み直す。操作 1 回で 1 回数える)
    expect(h.state.queueInserts.map((job) => job.dish_index)).toEqual([0]);
    expect(h.consumeAiUsage).toHaveBeenCalledTimes(1);
    expect(h.consumeAiUsage).toHaveBeenCalledWith(USER_ID, 'meal_image_auto');
    // 利用者の画像は料理には付けない (料理は AI の料理のまま)
    expect((savedRow().dishes as MealImageDish[])[0]).toMatchObject({ image_source: 'generated_ai', image_url: null });
    expect((savedRow().dishes as MealImageDish[]).slice(1).every((dish) => dish.image_source === null && !dish.image_url)).toBe(true);

    const worked = runImageWorker(savedRow().dishes as MealImageDish[], savedRow().image_url as string | null);
    expect(worked.cover).toBe(USER_COVER);
    expect(worked.dishes.map((dish) => dish.image_url)).toEqual([aiImageUrl(0), null, null]);

    vi.clearAllMocks();
    h.state.writes = [];
    h.state.queueInserts = [];
    h.state.existingDishes = worked.dishes;
    h.state.existingImageUrl = worked.cover;
    const toggled = await entry.toggle();

    expect(toggled.status).toBe(200);
    expect(savedRow().image_url).toBe(USER_COVER);
    expect(h.state.queueInserts).toEqual([]);
    expect(h.consumeAiUsage).not.toHaveBeenCalled();
  });

  it('料理の画像ができあがった AI の献立 (カバーは AI の料理の画像) にカバーを付ける → 完了を切り替える: AI の料理の画像に戻らない', async () => {
    const pending = (await reconcileDishImages({ previousDishes: [], nextDishes: THREE_AI_DISHES, triggerSource: 'test' })).dishes;
    h.state.queueInserts = [0].map((dish_index) => ({ dish_index }));
    const ready = runImageWorker(pending, null);
    h.state.queueInserts = [];
    // 空のカバーは AI の料理の画像で付け替わる (今までどおり)
    expect(ready.cover).toBe(aiImageUrl(0));
    h.state.existingDishes = ready.dishes;
    h.state.existingImageUrl = ready.cover;

    await entry.withCover(USER_COVER);
    expect(savedRow().image_url).toBe(USER_COVER);
    expect(h.state.queueInserts).toEqual([]);

    h.state.writes = [];
    h.state.existingDishes = savedRow().dishes as MealImageDish[] ?? ready.dishes;
    h.state.existingImageUrl = USER_COVER;
    await entry.toggle();
    expect(savedRow().image_url).toBe(USER_COVER);
  });
});

describe('#1487 J. 新しく作る入口 (POST) で送られた写真の料理を、AI の画像の料理にしない', () => {
  it.each([
    ['POST /api/meals', (dishes: MealImageDish[]) => mealsPost(json('http://localhost/api/meals', 'POST', { date: '2026-10-11', mealType: 'lunch', dishName: '親子丼', dishes, imageUrl: PHOTO_URL }))],
    ['POST /api/meal-plans/meals', (dishes: MealImageDish[]) => mealPlansPost(json('http://localhost/api/meal-plans/meals', 'POST', { dayDate: '2026-10-11', mealType: 'lunch', dishName: '親子丼', dishes, imageUrl: PHOTO_URL }))],
  ])('%s: 写真の料理 (1 品・複数) の画像と source を保持し、積まず、数えない', async (_label, run) => {
    for (const photoDishes of [
      buildPhotoDishList([{ name: '親子丼', role: 'main' }], PHOTO_URL),
      buildPhotoDishList([{ name: '親子丼', role: 'main' }, { name: '味噌汁', role: 'soup' }], PHOTO_URL),
    ]) {
      vi.clearAllMocks();
      h.state.writes = [];
      h.state.queueInserts = [];
      const res = await run(photoDishes);

      expect(res.status).toBe(200);
      expect(h.consumeAiUsage).not.toHaveBeenCalled();
      expect(h.state.queueInserts).toEqual([]);
      const saved = savedRow().dishes as MealImageDish[];
      photoDishes.forEach((dish, index) => {
        expect(saved[index]).toMatchObject({ image_url: dish.image_url, image_source: 'meal_photo', image_status: dish.image_status });
      });
      expect(savedRow().image_url).toBe(PHOTO_URL);
    }
  });
});

const SOUP = { name: '味噌汁', role: 'soup' };
const PERMISSION_DENIED = { code: '42501', message: 'permission denied for table meal_image_jobs' };
const UNIQUE_VIOLATION = { code: '23505', message: 'duplicate key value' };
/** 4 本の HTTP の入口 (x-request-id を読む入口。AI 相談の update_meal はアクションの id を使う) */
const HTTP_ENTRIES = ENTRIES.filter((entry) => entry.name.includes('/api/'));

describe.each(ENTRIES)('#1532 処理を起こす条件と件数: $name', (entry) => {
  it('料理が 2 品でも積むのは主菜の 1 行だけで、主菜でない料理の位置の書き込みは起こらない (billing/03 Q-16)', async () => {
    submittedDishes = [SOUP, CURRY];
    h.state.queueErrorFor = (row) => (row.dish_index === 0 ? PERMISSION_DENIED : null);
    const out = await entry.run();

    expect(out.status).toBe(200);
    expect(h.state.queueInserts.map((row) => row.dish_index)).toEqual([1]);
    expect(h.trigger).toHaveBeenCalledTimes(1);
    expect(h.trigger).toHaveBeenCalledWith({ plannedMealId: MEAL_ID, limit: 1 });
  });

  it('主菜の 1 行を積めたら limit は 1', async () => {
    submittedDishes = [CURRY, SOUP];
    await entry.run();

    expect(h.state.queueInserts.map((row) => row.dish_index)).toEqual([0]);
    expect(h.trigger).toHaveBeenCalledWith({ plannedMealId: MEAL_ID, limit: 1 });
  });

  it('1 行も積めず待ちのジョブも無い (書き込みの失敗だけ) なら、処理を起こさない (空振りの呼び出しを出さない)', async () => {
    h.state.queueError = PERMISSION_DENIED;
    const out = await entry.run();

    expect(out.status).toBe(200);
    expect(h.state.queueInserts).toEqual([]);
    expect(h.trigger).not.toHaveBeenCalled();
  });

  it('同じ料理のジョブが待ち・処理中 (重複) なら、その件数で処理を起こす (前の呼び出しが失敗して待ちのまま残ったジョブを処理させる)', async () => {
    h.state.queueError = UNIQUE_VIOLATION;
    await entry.run();

    expect(h.state.queueInserts).toEqual([]);
    expect(h.trigger).toHaveBeenCalledTimes(1);
    expect(h.trigger).toHaveBeenCalledWith({ plannedMealId: MEAL_ID, limit: 1 });
  });
});

describe.each(HTTP_ENTRIES)('#1532 x-request-id を request_id (uuid の列) に入れるのは uuid のときだけ: $name', (entry) => {
  it.each([
    ['uuid でない値', 'req-123'],
    // ヘッダの前後の空白は Request が落とすので、空白の検査はここではしない。uuid の後ろに文字が付いた値で形式違いを見る
    ['uuid の後ろに文字が付いた値', '5f0c6a3e-2b9d-4c1a-8e7f-0a1b2c3d4e5f-x'],
    ['波括弧で囲んだ uuid', '{5f0c6a3e-2b9d-4c1a-8e7f-0a1b2c3d4e5f}'],
    ['桁の足りない uuid に似た値', '5f0c6a3e-2b9d-4c1a-8e7f-0a1b2c3d4e5'],
  ])('%s は null にして積み、保存は成功させる', async (_label, header) => {
    requestIdHeader = header;
    const out = await entry.run();

    expect(out.status).toBe(200);
    expect(h.state.queueInserts).toHaveLength(1);
    expect(h.state.queueInserts[0].request_id).toBeNull();
    expect(h.trigger).toHaveBeenCalledTimes(1);
  });

  it('uuid の値はそのまま入れる', async () => {
    requestIdHeader = '5F0C6A3E-2B9D-4C1A-8E7F-0A1B2C3D4E5F';
    await entry.run();

    expect(h.state.queueInserts[0].request_id).toBe('5F0C6A3E-2B9D-4C1A-8E7F-0A1B2C3D4E5F');
  });

  it('ヘッダが無ければ null', async () => {
    await entry.run();

    expect(h.state.queueInserts[0].request_id).toBeNull();
  });
});

/** 利用者がカバーを外す保存 (#1553。PATCH /api/meals/[id] の image_url: null・PATCH /api/meal-plans/meals/[id] の imageUrl: null) */
const CLEAR_COVER_ENTRIES: Array<{ name: string; clear: () => Promise<Outcome> }> = [
  {
    name: 'PATCH /api/meals/[id]',
    clear: async () => {
      const res = await mealsPatch(json(`http://localhost/api/meals/${MEAL_ID}`, 'PATCH', { image_url: null }), { params: { id: MEAL_ID } });
      return { status: res.status, ...((await res.json()) as Outcome) };
    },
  },
  {
    name: 'PATCH /api/meal-plans/meals/[id]',
    clear: async () => {
      const res = await mealPlansPatch(json(`http://localhost/api/meal-plans/meals/${MEAL_ID}`, 'PATCH', { imageUrl: null }), { params: { id: MEAL_ID } });
      return { status: res.status, ...((await res.json()) as Outcome) };
    },
  },
];

describe.each(CLEAR_COVER_ENTRIES)('#1553 K. 料理が 2 品以上の献立で、null を送るとカバーを外す: $name', (entry) => {
  it('料理の画像ができあがった献立: 利用者のカバーを外し、先頭の AI の料理の画像に戻す (ジョブを積まず、数えない)', async () => {
    const pending = (await reconcileDishImages({ previousDishes: [], nextDishes: THREE_AI_DISHES, triggerSource: 'test' })).dishes;
    h.state.queueInserts = [0].map((dish_index) => ({ dish_index }));
    const ready = runImageWorker(pending, USER_COVER);
    h.state.queueInserts = [];
    expect(ready.cover).toBe(USER_COVER);
    h.state.existingDishes = ready.dishes;
    h.state.existingImageUrl = USER_COVER;

    const out = await entry.clear();

    expect(out.status).toBe(200);
    expect(savedRow().image_url).toBe(aiImageUrl(0));
    expect((savedRow().dishes as MealImageDish[]).map((dish) => dish.image_url)).toEqual([aiImageUrl(0), null, null]);
    expect(h.state.queueInserts).toEqual([]);
    expect(h.consumeAiUsage).not.toHaveBeenCalled();
  });

  it('料理の画像がまだ無い献立: カバーを空にし、画像の処理ができた AI の料理の画像を付ける', async () => {
    h.state.existingDishes = (await reconcileDishImages({ previousDishes: [], nextDishes: THREE_AI_DISHES, triggerSource: 'test' })).dishes;
    h.state.existingImageUrl = USER_COVER;

    const out = await entry.clear();

    expect(out.status).toBe(200);
    expect(savedRow().image_url).toBeNull();
    const worked = runImageWorker(savedRow().dishes as MealImageDish[], savedRow().image_url as string | null);
    expect(worked.cover).toBe(aiImageUrl(0));
  });

  it('写真の複数の料理の献立 (カバーは写真): カバーを空にし、写真の料理は変えない', async () => {
    h.state.existingDishes = buildPhotoDishList([{ name: '親子丼', role: 'main' }, { name: '味噌汁', role: 'soup' }], PHOTO_URL);
    h.state.existingImageUrl = PHOTO_URL;

    const out = await entry.clear();

    expect(out.status).toBe(200);
    expect(savedRow().image_url).toBeNull();
    expect((savedRow().dishes as MealImageDish[]).map((dish) => [dish.image_source, dish.image_status, dish.image_url])).toEqual([
      ['meal_photo', 'stale', null],
      ['meal_photo', 'stale', null],
    ]);
    expect(h.state.queueInserts).toEqual([]);
  });

  it('料理が 1 品の献立 (手で付けた画像): 今までどおり、料理とカバーを変えない', async () => {
    h.state.existingDishes = [
      { name: 'カレー', role: 'main', image_url: USER_COVER, image_source: 'manual_override', image_status: 'ready', image_subject_hash: null },
    ];
    h.state.existingImageUrl = USER_COVER;

    const out = await entry.clear();

    expect(out.status).toBe(200);
    expect(savedRow().image_url).toBe(USER_COVER);
    expect((savedRow().dishes as MealImageDish[])[0]).toMatchObject({ image_url: USER_COVER, image_source: 'manual_override', image_status: 'ready' });
    expect(h.state.queueInserts).toEqual([]);
  });

  it('料理が 1 品の AI の献立 (料理の画像ができあがり、カバーは別の利用者の画像): 今までどおりカバーを残し、AI の料理の画像に戻さない', async () => {
    // 2 品で利用者がカバーを付けたあと 1 品に減らした献立など。料理が 1 品なら null でもカバーを外さない (2 品以上だけ)
    const pending = (await reconcileDishImages({ previousDishes: [], nextDishes: [THREE_AI_DISHES[0]], triggerSource: 'test' })).dishes;
    h.state.queueInserts = [{ dish_index: 0 }];
    const ready = runImageWorker(pending, USER_COVER);
    h.state.queueInserts = [];
    expect(ready.cover).toBe(USER_COVER);
    h.state.existingDishes = ready.dishes;
    h.state.existingImageUrl = USER_COVER;

    const out = await entry.clear();

    expect(out.status).toBe(200);
    expect(savedRow().image_url).toBe(USER_COVER);
    expect((savedRow().dishes as MealImageDish[])[0]).toMatchObject({ image_url: aiImageUrl(0), image_source: 'generated_ai', image_status: 'ready' });
    expect(h.state.queueInserts).toEqual([]);
    expect(h.consumeAiUsage).not.toHaveBeenCalled();
  });
});
