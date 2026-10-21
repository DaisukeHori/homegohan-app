/**
 * #1553: 画像の処理 (process-meal-image-jobs) の端の経路。
 *
 * (1) 料理を失敗の印にできなかったとき (writeDishImageFailure が MEAL_DISH_WRITE_MAX_ATTEMPTS 回負けた) は、以前は
 *     console.warn だけで終わり、料理が生成中 (pending) のまま残ったことをジョブの側から追えなかった。
 *     いまは app_logs に error で残し、ジョブの last_error に目印 (DISH_LEFT_PENDING_LAST_ERROR_MARKER) を足す。
 *     料理の側は条件なしで書かない (#1527 の排他を壊さない)。
 * (2) 最初の献立の読み取りが error を見ておらず、読み取りのエラーも「献立が消えた」としてジョブを取り消していた。
 *     いまは書くときの読み直し (readMealSnapshot) と同じく、エラーはジョブを失敗にし、行が無いときだけ取り消す。
 * (3) 書き込みを諦めたとき・書かずにやめたとき、ジョブがアップロードした画像が Storage に残っていた。
 *     いまはそのジョブ自身のパスの 1 ファイルだけを消す (消せなくてもジョブの結果は変えない)。
 * (4) 料理画像のプランの門 (billing/03 §8.8): 0 なら作らず、読めなくても止めない
 *
 * ここでは Edge Function のハンドラ (index.ts) を本物で動かし、Supabase (meal_image_jobs・planned_meals・Storage)・
 * 画像の AI・同意の判定・ロガーを作り物にする。planned_meals の update は条件 (eq / is) を本当に評価し、
 * 当たると updated_at を進める (本物の trg_planned_meals_updated_at と同じく、どの書き手が書いても変わる)。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveHeavyUnitTimeouts } from './helpers/heavy-unit-test-timeout';

import { reconcileDishImages, type MealImageDish } from '../supabase/functions/_shared/meal-image';
import {
  buildImageUploadPath,
  DISH_LEFT_PENDING_LAST_ERROR_MARKER,
  formatDishLeftPendingLastError,
  isOwnJobUploadPath,
  MEAL_DISH_WRITE_MAX_ATTEMPTS,
  MealDishWriteExhaustedError,
} from '../supabase/functions/process-meal-image-jobs/utils';

type Row = Record<string, unknown>;
type Filter = ['eq' | 'is', string, unknown];

const SERVICE_ROLE_KEY = 'test-service-role-key';
const SUPABASE_URL = 'http://127.0.0.1:54321';
const MEAL_ID = '11111111-1111-4111-8111-111111111111';
const JOB_ID = '22222222-2222-4222-8222-222222222222';
const USER_ID = '33333333-3333-4333-8333-333333333333';
const PUBLIC_URL_BASE = `${SUPABASE_URL}/storage/v1/object/public/fridge-images/`;
const READ_AT = '2026-10-14T00:00:00.000000+00:00';
const GENERATED_IMAGE_BASE64 = 'ZmFrZS1pbWFnZQ==';
const URL_ = 'http://localhost/functions/v1/process-meal-image-jobs';

const h = vi.hoisted(() => ({
  env: {} as Record<string, string | undefined>,
  handlers: [] as Array<(req: Request) => Promise<Response> | Response>,
  jobs: [] as Array<Record<string, unknown>>,
  meal: null as Record<string, unknown> | null,
  tick: 0,
  /** planned_meals を読むたびに呼ぶ (n は何回目か)。読んでから書くまでのあいだに、ほかの書き手が書いた状況を作る */
  onMealRead: null as ((n: number) => void) | null,
  mealReads: 0,
  /** planned_meals の読み取りで返すエラー (n 回目に返すか) */
  mealReadError: null as ((n: number) => { message: string } | null) | null,
  /** planned_meals の update で返すエラー (書けたかどうかが分からない書き込みのエラー) */
  mealUpdateError: null as { message: string } | null,
  /** planned_meals を select した列 */
  mealSelects: [] as string[],
  mealUpdates: [] as Array<{ values: Record<string, unknown>; filters: Array<['eq' | 'is', string, unknown]>; matched: boolean }>,
  jobUpdates: [] as Array<{ values: Record<string, unknown>; filters: Array<['eq' | 'is', string, unknown]>; matched: boolean }>,
  uploads: [] as string[],
  removes: [] as string[][],
  removeError: null as { message: string } | null,
  generateCalls: 0,
  generateError: null as Error | null,
  logs: [] as Array<{ level: string; message: string; error?: unknown; metadata?: Record<string, unknown> }>,
  /** billing/03: ai_plan_feature_daily_cap の答え (既定 null = 行なし = 止めない) */
  planCap: null as number | null,
  planCapError: null as { code: string; message: string } | null,
  planCapThrows: null as Error | null,
  rpcCalls: [] as Array<{ name: string; args: Record<string, unknown> }>,
}));

function nextUpdatedAt(): string {
  h.tick += 1;
  return `2026-10-14T00:00:${String(h.tick).padStart(2, '0')}.000000+00:00`;
}

function matches(row: Record<string, unknown>, filters: Filter[]): boolean {
  return filters.every(([op, column, value]) => (op === 'is' ? row[column] === null : row[column] === value));
}

/** meal_image_jobs / planned_meals の、つなげて呼べる問い合わせの作り物 */
function tableQuery(table: string) {
  const filters: Filter[] = [];
  let mode: 'select' | 'update' = 'select';
  let values: Record<string, unknown> = {};

  const runUpdate = (): { data: Row[]; error: { message: string } | null } => {
    if (table === 'planned_meals') {
      if (h.mealUpdateError) {
        h.mealUpdates.push({ values, filters: [...filters], matched: false });
        return { data: [], error: h.mealUpdateError };
      }
      const matched = h.meal !== null && matches(h.meal, filters);
      h.mealUpdates.push({ values, filters: [...filters], matched });
      if (matched && h.meal) {
        h.meal = { ...h.meal, ...structuredClone(values), updated_at: nextUpdatedAt() };
        return { data: [{ id: h.meal.id }], error: null };
      }
      return { data: [], error: null };
    }
    const hit = h.jobs.filter((job) => matches(job, filters));
    h.jobUpdates.push({ values, filters: [...filters], matched: hit.length > 0 });
    for (const job of hit) Object.assign(job, structuredClone(values));
    return { data: hit.map((job) => ({ ...job })), error: null };
  };

  const runSelect = (): { data: Row[]; error: { message: string } | null } => {
    if (table === 'planned_meals') {
      h.mealReads += 1;
      const n = h.mealReads;
      const readError = h.mealReadError?.(n) ?? null;
      if (readError) return { data: [], error: readError };
      const snapshot = h.meal && matches(h.meal, filters) ? [structuredClone(h.meal)] : [];
      h.onMealRead?.(n);
      return { data: snapshot, error: null };
    }
    return { data: h.jobs.filter((job) => matches(job, filters)).map((job) => ({ ...job })), error: null };
  };

  const query = {
    select: (columns?: string) => {
      if (table === 'planned_meals' && mode === 'select' && typeof columns === 'string') h.mealSelects.push(columns);
      return query;
    },
    update: (next: Record<string, unknown>) => {
      mode = 'update';
      values = next;
      return query;
    },
    eq: (column: string, value: unknown) => {
      filters.push(['eq', column, value]);
      return query;
    },
    is: (column: string, value: unknown) => {
      filters.push(['is', column, value]);
      return query;
    },
    order: () => query,
    limit: () => query,
    single: async () => {
      const rows = mode === 'update' ? runUpdate().data : runSelect().data;
      return rows.length === 1 ? { data: rows[0], error: null } : { data: null, error: { message: 'no rows' } };
    },
    maybeSingle: async () => {
      const result = runSelect();
      return { data: result.data[0] ?? null, error: result.error };
    },
    then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
      Promise.resolve(mode === 'update' ? runUpdate() : runSelect()).then(resolve, reject),
  };
  return query;
}

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: (table: string) => tableQuery(table),
    rpc: async (name: string, args: Record<string, unknown>) => {
      h.rpcCalls.push({ name, args });
      if (h.planCapThrows) throw h.planCapThrows;
      return { data: h.planCap, error: h.planCapError };
    },
    storage: {
      from: () => ({
        upload: async (path: string) => {
          h.uploads.push(path);
          return { data: { path }, error: null };
        },
        getPublicUrl: (path: string) => ({ data: { publicUrl: `${PUBLIC_URL_BASE}${path}` } }),
        remove: async (paths: string[]) => {
          h.removes.push([...paths]);
          return { data: h.removeError ? null : paths.map((name) => ({ name })), error: h.removeError };
        },
      }),
    },
  }),
}));

vi.mock('@google/genai', () => ({
  GoogleGenAI: class {
    models = {
      generateContent: async () => {
        h.generateCalls += 1;
        if (h.generateError) throw h.generateError;
        return { candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: GENERATED_IMAGE_BASE64 } }] } }] };
      },
    };
  },
  createUserContent: (parts: unknown) => parts,
}));

// 同意の判定は通す (ここで確かめたいのは同意の後の経路。同意の判定は ai-consent の各テスト)
vi.mock('../supabase/functions/_shared/ai-consent-guard.ts', () => ({
  checkAiConsent: async () => ({ allowed: true }),
}));

// ロガーは app_logs へ書き込むので差し替え、呼ばれた内容を残す
vi.mock('../supabase/functions/_shared/db-logger.ts', () => {
  const record = (level: string) => (message: string, metadata?: Record<string, unknown>) => {
    h.logs.push({ level, message, metadata });
  };
  return {
    createLogger: () => ({
      debug: record('debug'),
      info: record('info'),
      warn: record('warn'),
      error: (message: string, error?: unknown, metadata?: Record<string, unknown>) => {
        h.logs.push({ level: 'error', message, error, metadata });
      },
    }),
    generateRequestId: () => 'req_test',
  };
});

let handler: (req: Request) => Promise<Response> | Response;

/**
 * Edge Function の本体を動的に読み込むフック (beforeAll) の時間切れ (#1605)。負荷の高い機械で、Edge Function の動的 import が
 * フックの既定の 10 秒を超えたことがある (tests/ai-consent-enforcement-edge.test.ts。#1488)。このファイルのテストは読み込んだ
 * ハンドラを呼ぶだけなので一覧 (HEAVY_UNIT_TEST_FILES) には入れず、読み込みのフックにだけ同じ値 (環境変数で上書き可) を使う
 * (tests/ai-chat-flag-edge.test.ts と同じ形)
 */
const EDGE_IMPORT_HOOK_TIMEOUT_MS = resolveHeavyUnitTimeouts(process.env).hookTimeout;

beforeAll(async () => {
  vi.stubGlobal('Deno', {
    env: { get: (key: string) => h.env[key] },
    serve: (fn: (req: Request) => Promise<Response> | Response) => {
      h.handlers.push(fn);
    },
  });
  h.env = { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE_KEY, GOOGLE_AI_STUDIO_API_KEY: 'test-google-key' };
  await import('../supabase/functions/process-meal-image-jobs/index.ts');
  handler = h.handlers[h.handlers.length - 1];
}, EDGE_IMPORT_HOOK_TIMEOUT_MS);

afterAll(() => {
  vi.unstubAllGlobals();
});

/** AI の献立の料理 (reconcileDishImages を通した。主菜は画像を待つ pending (subject_hash つき)、汁物は画像の無い状態 (billing/03 Q-16)。この file は主菜 (位置 0) のジョブだけを流す) */
async function pendingAiDishes(): Promise<MealImageDish[]> {
  const result = await reconcileDishImages({
    previousDishes: [],
    nextDishes: [
      { name: '鮭の塩焼き', role: 'main', ingredients: ['鮭'] },
      { name: '味噌汁', role: 'soup', ingredients: ['豆腐', 'わかめ'] },
    ],
    triggerSource: 'test',
  });
  return result.dishes;
}

let dishes: MealImageDish[];

beforeEach(async () => {
  dishes = await pendingAiDishes();
  h.tick = 0;
  h.mealReads = 0;
  h.onMealRead = null;
  h.mealReadError = null;
  h.mealUpdates = [];
  h.mealUpdateError = null;
  h.mealSelects = [];
  h.jobUpdates = [];
  h.uploads = [];
  h.removes = [];
  h.removeError = null;
  h.generateCalls = 0;
  h.generateError = null;
  h.logs = [];
  h.planCap = null;
  h.planCapError = null;
  h.planCapThrows = null;
  h.rpcCalls = [];
  h.meal = { id: MEAL_ID, dishes: structuredClone(dishes), image_url: null, updated_at: READ_AT };
  h.jobs = [
    {
      id: JOB_ID,
      user_id: USER_ID,
      planned_meal_id: MEAL_ID,
      dish_index: 0,
      subject_hash: dishes[0].image_subject_hash ?? null,
      prompt: '鮭の塩焼き',
      model: null,
      reference_image_urls: null,
      attempt_count: 0,
      status: 'pending',
      lease_token: null,
      leased_until: null,
      last_error: null,
      result_image_url: null,
    },
  ];
});

async function runWorker(): Promise<Array<{ jobId: string; status: string; message?: string }>> {
  const res = await handler(
    new Request(URL_, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${SERVICE_ROLE_KEY}` },
      body: JSON.stringify({ plannedMealId: h.jobs[0]?.planned_meal_id, limit: 1 }),
    }),
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { jobs: Array<{ jobId: string; status: string; message?: string }> };
  return body.jobs;
}

/** 読むたびに、ほかの書き手が献立を書く (読んだときの updated_at の行が、書くときには無い) */
function anotherWriterAfterEveryRead(fromRead = 1) {
  h.onMealRead = (n) => {
    if (n >= fromRead && h.meal) h.meal = { ...h.meal, updated_at: nextUpdatedAt() };
  };
}

const job = () => h.jobs[0];
const mealDish = (index: number) => (h.meal?.dishes as MealImageDish[])[index];

describe('(1) 料理を失敗の印にできなかったとき (#1553)', () => {
  it('印の書き込みが上限まで負けたら、料理は条件なしで書かず (pending のまま)、app_logs に error で残し、ジョブの last_error に目印を足す', async () => {
    h.generateError = new Error('image generation returned no binary data');
    // 最初の読み取り (1 回目) のあと、印の書き込みの読み直しのたびに、ほかの書き手が書く
    anotherWriterAfterEveryRead(2);

    const [outcome] = await runWorker();

    expect(outcome).toEqual({ jobId: JOB_ID, status: 'failed', message: 'image generation returned no binary data' });
    // 印の書き込みは、読んだときの updated_at を条件にして MEAL_DISH_WRITE_MAX_ATTEMPTS 回試し、どれも当たらない
    expect(h.mealUpdates).toHaveLength(MEAL_DISH_WRITE_MAX_ATTEMPTS);
    expect(h.mealUpdates.every((update) => !update.matched)).toBe(true);
    for (const update of h.mealUpdates) {
      expect(update.filters.some(([op, column]) => op === 'eq' && column === 'updated_at')).toBe(true);
    }
    expect(mealDish(0).image_status).toBe('pending');

    expect(job().status).toBe('failed');
    expect(job().last_error).toBe(
      `image generation returned no binary data | ${DISH_LEFT_PENDING_LAST_ERROR_MARKER}: ${new MealDishWriteExhaustedError().message}`,
    );
    // 目印は、終えたときの行 (同じ status・attempt_count・貸し出しなし) にだけ書く
    const note = h.jobUpdates.at(-1);
    expect(note?.matched).toBe(true);
    expect(note?.filters).toEqual(
      expect.arrayContaining([
        ['eq', 'id', JOB_ID],
        ['eq', 'status', 'failed'],
        ['eq', 'attempt_count', 1],
        ['is', 'lease_token', null],
      ]),
    );

    const errors = h.logs.filter((log) => log.level === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('生成中 (pending) のまま');
    expect(errors[0].error).toBeInstanceOf(MealDishWriteExhaustedError);
    expect(errors[0].metadata).toMatchObject({ jobId: JOB_ID, plannedMealId: MEAL_ID, dishIndex: 0, jobStatus: 'failed' });
  });

  it('印を付けられたときは、last_error はジョブの理由のまま・error のログも残さない', async () => {
    h.generateError = new Error('image generation returned no binary data');

    const [outcome] = await runWorker();

    expect(outcome.status).toBe('failed');
    expect(mealDish(0)).toMatchObject({ image_status: 'failed', image_error: 'image generation returned no binary data' });
    expect(job().last_error).toBe('image generation returned no binary data');
    expect(h.logs.filter((log) => log.level === 'error')).toEqual([]);
  });

  it('ジョブの行が終えたあとに変わっていたら (積み直しなど)、目印で上書きせず、そのことも error で残す', async () => {
    h.generateError = new Error('boom');
    h.onMealRead = (n) => {
      if (n >= 2 && h.meal) h.meal = { ...h.meal, updated_at: nextUpdatedAt() };
      // 印の書き込みの最中に、ジョブが積み直された
      if (n === 2) Object.assign(job(), { status: 'pending', attempt_count: 0 });
    };

    await runWorker();

    expect(job().status).toBe('pending');
    expect(job().last_error).toBe('boom');
    const errors = h.logs.filter((log) => log.level === 'error');
    expect(errors.map((log) => log.message)).toEqual([
      '料理を失敗の印にできず、生成中 (pending) のまま残りました',
      '料理が生成中のまま残ったことを、ジョブの last_error に書けませんでした',
    ]);
  });
});

describe('(2) 最初の献立の読み取り (#1553)', () => {
  it('読み取りのエラーは「献立が消えた」にせず、ジョブを失敗にする (画像は作らない)', async () => {
    h.mealReadError = (n) => (n === 1 ? { message: 'connection reset' } : null);

    const [outcome] = await runWorker();

    expect(outcome).toEqual({ jobId: JOB_ID, status: 'failed', message: 'failed to read meal: connection reset' });
    expect(job()).toMatchObject({ status: 'failed', last_error: 'failed to read meal: connection reset', attempt_count: 1 });
    expect(job().last_error).not.toBe('planned meal deleted');
    expect(h.generateCalls).toBe(0);
    expect(h.uploads).toEqual([]);
    // 失敗の印は、読み直した最新の料理に付ける (読み直しでは読めた)
    expect(mealDish(0)).toMatchObject({ image_status: 'failed', image_error: 'failed to read meal: connection reset' });
  });

  it('行が無いときだけ meal_deleted として取り消す (従来どおり)', async () => {
    h.meal = null;

    const [outcome] = await runWorker();

    expect(outcome).toEqual({ jobId: JOB_ID, status: 'cancelled', message: 'meal was deleted' });
    expect(job()).toMatchObject({ status: 'cancelled', last_error: 'planned meal deleted' });
    expect(h.generateCalls).toBe(0);
  });

  it('最初の読み取りは、書くときの読み直しと同じ列 (updated_at を含む) を読む', async () => {
    const [outcome] = await runWorker();

    expect(outcome.status).toBe('completed');
    expect(h.mealSelects).toHaveLength(2);
    expect(new Set(h.mealSelects)).toEqual(new Set(['id, dishes, image_url, updated_at']));
    expect(mealDish(0)).toMatchObject({ image_status: 'ready', image_source: 'generated_ai' });
  });
});

describe('(3) 書かなかった画像を Storage から消す (#1553)', () => {
  it('書き込みを諦めたら (上限まで負けた)、このジョブがアップロードした 1 ファイルだけを消す', async () => {
    anotherWriterAfterEveryRead(2);

    const [outcome] = await runWorker();

    expect(outcome.status).toBe('failed');
    expect(outcome.message).toBe(new MealDishWriteExhaustedError().message);
    expect(h.uploads).toHaveLength(1);
    const [uploaded] = h.uploads;
    expect(isOwnJobUploadPath(uploaded, { plannedMealId: MEAL_ID, jobId: JOB_ID })).toBe(true);
    expect(h.removes).toEqual([[uploaded]]);
    expect(mealDish(0).image_url ?? null).toBeNull();
  });

  it.each([
    {
      label: '献立が消えた (meal_deleted)',
      interleave: () => {
        h.meal = null;
      },
      message: 'meal was deleted',
      lastError: 'planned meal deleted',
    },
    {
      label: '料理が変わった (dish_changed)',
      interleave: () => {
        const next = structuredClone(h.meal?.dishes as MealImageDish[]);
        next[0] = { ...next[0], image_subject_hash: 'another-subject' };
        h.meal = { ...(h.meal as Record<string, unknown>), dishes: next, updated_at: nextUpdatedAt() };
      },
      message: 'dish schema changed',
      lastError: 'dish signature changed',
    },
  ])('書かずにやめたら ($label)、ジョブを取り消し、このジョブの画像だけを消す', async ({ interleave, message, lastError }) => {
    // 最初の読み取りのあと、画像を作っているあいだに献立が変わる
    h.onMealRead = (n) => {
      if (n === 1) interleave();
    };

    const [outcome] = await runWorker();

    expect(outcome).toEqual({ jobId: JOB_ID, status: 'cancelled', message });
    expect(job()).toMatchObject({ status: 'cancelled', last_error: lastError });
    expect(h.uploads).toHaveLength(1);
    expect(h.removes).toEqual([[h.uploads[0]]]);
    expect(h.removes[0][0].startsWith(`generated/${MEAL_ID}/${JOB_ID}-`)).toBe(true);
  });

  it('消せなくても、ジョブの結果は変えずログ (warn) だけ', async () => {
    h.onMealRead = (n) => {
      if (n === 1) h.meal = null;
    };
    h.removeError = { message: 'storage unavailable' };

    const [outcome] = await runWorker();

    expect(outcome).toEqual({ jobId: JOB_ID, status: 'cancelled', message: 'meal was deleted' });
    expect(job()).toMatchObject({ status: 'cancelled', last_error: 'planned meal deleted' });
    expect(h.removes).toHaveLength(1);
    const warns = h.logs.filter((log) => log.level === 'warn');
    expect(warns).toHaveLength(1);
    expect(warns[0].metadata).toMatchObject({ jobId: JOB_ID, error: 'storage unavailable', why: 'meal_deleted' });
    expect(h.logs.filter((log) => log.level === 'error')).toEqual([]);
  });

  it('組み立てたパスがそのジョブのものと確かめられないとき (献立の ID に区切り文字) は消さず、warn だけ', async () => {
    const oddMealId = 'meal/../other';
    h.meal = { ...(h.meal as Record<string, unknown>), id: oddMealId };
    Object.assign(job(), { planned_meal_id: oddMealId });
    h.onMealRead = (n) => {
      if (n === 1) h.meal = null;
    };

    const [outcome] = await runWorker();

    expect(outcome).toEqual({ jobId: JOB_ID, status: 'cancelled', message: 'meal was deleted' });
    expect(h.uploads).toHaveLength(1);
    expect(h.removes).toEqual([]);
    const warns = h.logs.filter((log) => log.level === 'warn');
    expect(warns).toHaveLength(1);
    expect(warns[0].metadata).toMatchObject({ jobId: JOB_ID, uploadPath: h.uploads[0], why: 'meal_deleted' });
  });

  it('書けたときは消さない', async () => {
    const [completed] = await runWorker();
    expect(completed.status).toBe('completed');
    expect(h.uploads).toHaveLength(1);
    expect(h.removes).toEqual([]);
  });

  it('書き込み自体のエラー (書けたかどうかが分からない) のときは消さない (ジョブは失敗)', async () => {
    h.mealUpdateError = { message: 'network error' };

    const [outcome] = await runWorker();

    expect(outcome).toEqual({ jobId: JOB_ID, status: 'failed', message: 'failed to update meal: network error' });
    expect(h.uploads).toHaveLength(1);
    expect(h.removes).toEqual([]);
  });

  it('書き込みの途中の読み直しのエラーのときも消さない (諦めた・やめたときだけ消す)', async () => {
    h.mealReadError = (n) => (n === 2 ? { message: 'connection reset' } : null);

    const [outcome] = await runWorker();

    expect(outcome).toEqual({ jobId: JOB_ID, status: 'failed', message: 'failed to read meal: connection reset' });
    expect(h.uploads).toHaveLength(1);
    expect(h.removes).toEqual([]);
  });

  it('画像を作る前にやめたとき・画像の生成に失敗したとき (アップロードしていない) は、何も消さない', async () => {
    h.generateError = new Error('boom');
    const [outcome] = await runWorker();
    expect(outcome.status).toBe('failed');
    expect(h.uploads).toEqual([]);
    expect(h.removes).toEqual([]);
  });
});

describe('(4) プランの門 (billing/03 §8.8)', () => {
  it('billing/03: ai_plan_feature_daily_cap が 0 (無料の利用者) なら、画像を作らずにジョブを cancelled (last_error = skipped_plan) にし、料理を failed + skipped_plan にする', async () => {
    h.planCap = 0;
    const outcomes = await runWorker();
    expect(outcomes).toEqual([{ jobId: JOB_ID, status: 'cancelled', message: 'skipped_plan' }]);
    expect(job()).toMatchObject({ status: 'cancelled', last_error: 'skipped_plan' });
    expect(h.generateCalls).toBe(0);
    expect(h.uploads).toEqual([]);
    expect(mealDish(0)).toMatchObject({ image_status: 'failed', image_error: 'skipped_plan' });
    expect(h.rpcCalls).toEqual([{ name: 'ai_plan_feature_daily_cap', args: { p_user_id: USER_ID, p_feature: 'meal_image_auto' } }]);
  });

  it.each(['error', 'throws'] as const)('billing/03: ai_plan_feature_daily_cap の RPC が %s のときも止めずに画像を作り (completed)、warn を 1 つ残す', async (mode) => {
    if (mode === 'error') h.planCapError = { code: 'XX000', message: 'db unavailable' };
    else h.planCapThrows = new TypeError('fetch failed');
    const [outcome] = await runWorker();
    expect(outcome.status).toBe('completed');
    expect(h.generateCalls).toBe(1);
    const warns = h.logs.filter((log) => log.level === 'warn');
    expect(warns).toHaveLength(1);
    expect(warns[0].metadata).toMatchObject({ ownerId: USER_ID });
  });
});

describe('isOwnJobUploadPath: そのジョブの画像のパスだけを消す (#1553)', () => {
  const params = { plannedMealId: 'meal-1', jobId: 'job-1' };

  it('buildImageUploadPath が組み立てたそのジョブのパスは真', () => {
    expect(isOwnJobUploadPath(buildImageUploadPath({ ...params, timestamp: 1_700_000_000_000 }), params)).toBe(true);
    expect(isOwnJobUploadPath(buildImageUploadPath(params), params)).toBe(true);
  });

  it.each([
    ['ほかのジョブの画像', 'generated/meal-1/job-2-1700000000000.png'],
    ['前の部分だけが一致する別のジョブ (job-1 と job-10)', 'generated/meal-1/job-10-1700000000000.png'],
    ['ID の後ろに別の区切りが続く', 'generated/meal-1/job-1-abc-1700000000000.png'],
    ['ほかの献立の画像', 'generated/meal-2/job-1-1700000000000.png'],
    ['利用者の画像 (別の置き場)', 'meal-photos/user-1/photo.jpg'],
    ['利用者の手の画像 (generated の下の別の ID)', 'generated/user-1/user-made.png'],
    ['献立のフォルダ全体', 'generated/meal-1/'],
    ['相対の指定', 'generated/meal-1/job-1-1/../../other.png'],
    ['拡張子が違う', 'generated/meal-1/job-1-1700000000000.jpg'],
    ['頭が違う', 'x/generated/meal-1/job-1-1700000000000.png'],
  ])('%s は偽: %s', (_label, path) => {
    expect(isOwnJobUploadPath(path, params)).toBe(false);
  });

  it.each([
    { plannedMealId: '', jobId: 'job-1' },
    { plannedMealId: 'meal-1', jobId: '' },
    { plannedMealId: '..', jobId: 'job-1' },
    { plannedMealId: 'meal-1/x', jobId: 'job-1' },
    { plannedMealId: 'meal-1', jobId: 'a\\b' },
  ])('ID が空・区切り文字・相対の指定なら偽: %o', (ids) => {
    expect(isOwnJobUploadPath(buildImageUploadPath({ ...ids, timestamp: 1 }), ids)).toBe(false);
  });
});

describe('formatDishLeftPendingLastError (#1553)', () => {
  it('ジョブの理由のあとに目印と、印を付けられなかった理由を足す', () => {
    expect(formatDishLeftPendingLastError('boom', new Error('read failed'))).toBe(
      `boom | ${DISH_LEFT_PENDING_LAST_ERROR_MARKER}: read failed`,
    );
    expect(formatDishLeftPendingLastError('boom', 'plain')).toBe(`boom | ${DISH_LEFT_PENDING_LAST_ERROR_MARKER}: plain`);
  });

  it('上限の例外は、従来と同じ文で、型で見分けられる', () => {
    const error = new MealDishWriteExhaustedError();
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe(
      `failed to update meal: the meal kept changing while writing (${MEAL_DISH_WRITE_MAX_ATTEMPTS} attempts)`,
    );
  });
});

describe('認証: pg_cron (Vault の app_cron_secret = CRON_SECRET) からも呼べる (#1561)', () => {
  /** pg_cron のジョブ process-pending-meal-image-jobs が Bearer に付ける値 (テスト用) */
  const CRON_SECRET = 'test-cron-secret';
  /** public.invoke_process_meal_image_jobs が送る本文 (献立を指定せず、件数だけ) */
  const CRON_BODY = { limit: 5 };
  const BASE_ENV = { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE_KEY, GOOGLE_AI_STUDIO_API_KEY: 'test-google-key' };

  async function call(headers: Record<string, string>, body: unknown = CRON_BODY): Promise<Response> {
    return await handler(
      new Request(URL_, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }),
    );
  }

  afterAll(() => {
    h.env = { ...BASE_ENV };
  });

  it('Bearer が CRON_SECRET と合えば、献立を指定しない本文で待ちのジョブを処理する', async () => {
    h.env = { ...BASE_ENV, CRON_SECRET };

    const res = await call({ authorization: `Bearer ${CRON_SECRET}` });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { processed: number; jobs: Array<{ jobId: string; status: string }> };
    expect(body.jobs).toEqual([expect.objectContaining({ jobId: JOB_ID, status: 'completed' })]);
    expect(h.jobs[0].status).toBe('completed');
    expect(h.generateCalls).toBe(1);
  });

  it('CRON_SECRET が未設定のあいだは、service role key でない Bearer を 503 (Service not configured) で止め、ジョブに触れない', async () => {
    h.env = { ...BASE_ENV };

    const res = await call({ authorization: `Bearer ${CRON_SECRET}` });

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Service not configured' });
    expect(h.jobUpdates).toEqual([]);
    expect(h.jobs[0].status).toBe('pending');
    expect(h.generateCalls).toBe(0);
  });

  it('CRON_SECRET と合わない Bearer・Bearer の無い要求は 401 で止め、ジョブに触れない', async () => {
    h.env = { ...BASE_ENV, CRON_SECRET };

    for (const headers of [{ authorization: 'Bearer wrong-secret' }, {}]) {
      const res = await call(headers);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'Unauthorized' });
    }
    expect(h.jobUpdates).toEqual([]);
    expect(h.generateCalls).toBe(0);
  });

  it('service role key (Bearer か apikey) は、CRON_SECRET が未設定でも従来どおり通る', async () => {
    h.env = { ...BASE_ENV };

    const viaApiKey = await call({ apikey: SERVICE_ROLE_KEY });
    expect(viaApiKey.status).toBe(200);
    expect(h.jobs[0].status).toBe('completed');
  });

  it('ジョブを取るときの貸し出しは 2 分 (JOB_LEASE_MS)。これを過ぎてさらに 5 分で pg_cron が取り戻す', async () => {
    h.env = { ...BASE_ENV };
    /** 貸し出しの長さ (index.ts の JOB_LEASE_MS) */
    const LEASE_MS = 2 * 60_000;
    /** 要求を送ってから貸し出しをつけるまでの時間の幅 (同じテストの中なので十分に大きい) */
    const CLOCK_SLACK_MS = 60_000;
    const before = Date.now();

    await runWorker();

    const lock = h.jobUpdates.find((update) => update.values.status === 'processing');
    expect(lock).toBeDefined();
    const leasedUntil = Date.parse(String(lock?.values.leased_until));
    expect(leasedUntil - before).toBeGreaterThanOrEqual(LEASE_MS);
    expect(leasedUntil - before).toBeLessThan(LEASE_MS + CLOCK_SLACK_MS);
  });
});
