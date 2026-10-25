/**
 * #2025 の続き (#121 の CAS を戻す): 写真の解析 (analyze-meal-photo の mealId の経路) の古い結果が、新しい結果を上書きしない。
 *
 * 以前は背景の処理の planned_meals の update が .eq('id', mealId) だけで、同じ献立に写真の解析を 2 回続けて送ると、
 * 後に終わった方が書いた。先に送った古い写真の解析が後に終わると、新しい写真の結果 (料理名・料理・栄養・veg_score・image_url) を
 * 上書きした。route (src/app/api/ai/analyze-meal-photo/route.ts) は invokedAt を Edge へ送り「CAS で防ぐ」と書いていたが、
 * Edge は invokedAt を受け取っていなかった (#160 の CAS は #248 の競合の解消で消えていた)。
 *
 * 守り方は supabase/functions/_shared/meal-photo-cas.ts の注 (印を付ける → 書く前に確かめる → 印のままの行にだけ書く)。
 *
 * ここでは Edge Function のハンドラ (index.ts) を本物で動かし、Supabase (planned_meals・Storage・認証)・解析のパイプライン・
 * 画像のジョブの取り消し・同意の判定・利用回数・ロガーを作り物にする。planned_meals の update は条件 (eq / lte / or) を
 * 本当に評価し、当たると updated_at を進める (本物の trg_planned_meals_updated_at と同じく、どの書き手が書いても変わる)。
 * 時刻は作り物の時計 (呼ぶたびに 1 ミリ秒進む) で、invokedAt もこの時計から取る (本物の DB の時刻と route の時刻の前後と同じ)。
 * PostgREST の本物の評価 (or の引用・timestamptz の一致) は tests/integration/rls/planned-meals-photo-analysis-cas.test.ts が見る。
 *
 * 確かめること (PC-n はこのファイルの it の番号):
 *   - PC-1: 先に送った解析 (A) が後に終わっても、後に送った解析 (B) の結果が残る (直す前は A が上書きした)
 *   - PC-2: A が先に終わっても、B の結果が残る (A は B の印で古くなっている。「updated_at <= invokedAt なら書く」だけの直し方では A が残り B が捨てられる)
 *   - PC-3: 競う解析が無ければ、写真の結果を書く (印を付けても自分の書き込みを止めない)
 *   - PC-4: invokedAt より後に行が書かれていた (Edge に遅れて届いた古い要求) なら、解析せず、行を変えない
 *   - PC-5: 解析のあいだにほかの書き手が行を書いたら、アップロード・ジョブの取り消し・書き込みをしない
 *   - PC-6: 書く前の確認のあと、書くまでのあいだに行が書かれても、update の条件で止まって書かない
 *   - PC-7: invokedAt が無い (利用者の JWT で直接呼んだ) ときも、印を付けて書く。後から送った解析には負ける
 *   - PC-8: 他人の献立の mealId では、印を付けず (他人の行の updated_at を進めない)、解析も書き込みもしない
 *   - PC-9: invokedAt が日時として読めなければ 400 で、利用回数を数えず解析もしない
 *   - PC-10: updated_at が NULL の行でも、invokedAt つきで印を付けて書ける
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveHeavyUnitTimeouts } from './helpers/heavy-unit-test-timeout';
import { AI_USAGE_ALLOWED } from './helpers/ai-usage-mock';

type Row = Record<string, unknown>;
type Filter =
  | { op: 'eq'; column: string; value: unknown }
  | { op: 'lte'; column: string; value: string }
  | { op: 'or'; alternatives: Array<{ op: 'is_null' | 'lte'; column: string; value?: string }> };

const MEAL_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '33333333-3333-4333-8333-333333333333';
const OTHER_USER_ID = '44444444-4444-4444-8444-444444444444';
/** 作り物の時計の始まり (行の最初の updated_at) */
const CLOCK_START_MS = Date.parse('2026-10-26T00:00:00.000Z');
/** 写真 A・B (base64。atob で読める値) */
const PHOTO_A = 'QUFB';
const PHOTO_B = 'QkJC';
const DISH_A = '古い写真の鮭の塩焼き';
const DISH_B = '新しい写真の豚の生姜焼き';
/** 解析の前の献立の名前 (写真の結果で上書きされたかを見る) */
const ORIGINAL_DISH = 'AI 献立のハンバーグ';
const URL_ = 'http://localhost/functions/v1/analyze-meal-photo';
const WEB_ORIGIN = 'https://homegohan-app.vercel.app';
const PUBLIC_URL_BASE = 'http://127.0.0.1:54321/storage/v1/object/public/fridge-images/';

const h = vi.hoisted(() => ({
  handlers: [] as Array<(req: Request) => Promise<Response>>,
  /** EdgeRuntime.waitUntil に渡された背景の処理 */
  background: [] as Array<Promise<unknown>>,
  clockMs: 0,
  meal: null as Record<string, unknown> | null,
  /** 解析 (analyzeWithEvidence) の呼び出し。resolve を呼ぶまで終わらない */
  analyses: [] as Array<{ photo: string; resolve: () => void }>,
  uploads: [] as string[],
  cancelCalls: 0,
  /** 画像のジョブの取り消しの中で呼ぶ (書く前の確認と書き込みのあいだに、ほかの書き手が書いた状況を作る) */
  onCancel: null as (() => void) | null,
  consumeCalls: 0,
  /** planned_meals の update (印・写真の結果) の記録 */
  mealUpdates: [] as Array<{ values: Record<string, unknown>; matched: boolean }>,
}));

/** 作り物の時計 (呼ぶたびに 1 ミリ秒進む)。DB の now() と route の invokedAt の両方をここから取る */
function tick(): string {
  h.clockMs += 1;
  return new Date(CLOCK_START_MS + h.clockMs).toISOString();
}

function timeOf(value: unknown): number {
  return typeof value === 'string' ? Date.parse(value) : Number.NaN;
}

function columnOf(row: Row, column: string): unknown {
  // 本人の行の確認の埋め込みの絞り込み (user_daily_meals!inner(user_id))
  return column === 'user_daily_meals.user_id' ? row.owner : row[column];
}

function matches(row: Row, filters: Filter[]): boolean {
  return filters.every((f) => {
    if (f.op === 'eq') return columnOf(row, f.column) === f.value;
    if (f.op === 'lte') return timeOf(columnOf(row, f.column)) <= timeOf(f.value);
    return f.alternatives.some((alt) =>
      alt.op === 'is_null' ? columnOf(row, alt.column) === null : timeOf(columnOf(row, alt.column)) <= timeOf(alt.value),
    );
  });
}

/** PostgREST の or の文字列 (このファイルが見る形だけ: `col.is.null` と `col.lte."値"`) を読む */
function parseOr(expr: string): Extract<Filter, { op: 'or' }>['alternatives'] {
  return expr.split(',').map((part) => {
    const isNull = /^([a-z_]+)\.is\.null$/.exec(part);
    if (isNull) return { op: 'is_null' as const, column: isNull[1] };
    const lte = /^([a-z_]+)\.lte\."([^"]+)"$/.exec(part);
    if (lte) return { op: 'lte' as const, column: lte[1], value: lte[2] };
    throw new Error(`作り物が読めない or の条件: ${part}`);
  });
}

/** 行の列を選ぶ (select の列の並び。埋め込みは id だけ返す) */
function pick(row: Row, columns: string | undefined): Row {
  if (!columns || columns === '*') return { ...row };
  const out: Row = {};
  for (const raw of columns.split(',')) {
    const column = raw.trim();
    if (column.includes('(')) continue;
    out[column] = row[column];
  }
  return out;
}

/** ほかの書き手 (完了の RPC・料理の画像のジョブ・画面の編集など) が行を書いた */
function touchMealByAnotherWriter(): void {
  if (h.meal) h.meal = { ...h.meal, updated_at: tick() };
}

function plannedMealsQuery() {
  const filters: Filter[] = [];
  let mode: 'select' | 'update' = 'select';
  let values: Record<string, unknown> = {};
  let columns: string | undefined;

  const run = (): { data: Row[]; error: null } => {
    if (mode === 'update') {
      const matched = h.meal !== null && matches(h.meal, filters);
      h.mealUpdates.push({ values, matched });
      if (!matched || !h.meal) return { data: [], error: null };
      // トリガー trg_planned_meals_updated_at: 送った updated_at は使わず、DB の now() にする
      h.meal = { ...h.meal, ...structuredClone(values), updated_at: tick() };
      return { data: [pick(h.meal, columns)], error: null };
    }
    return { data: h.meal && matches(h.meal, filters) ? [pick(h.meal, columns)] : [], error: null };
  };

  const query = {
    select: (cols?: string) => {
      columns = cols;
      return query;
    },
    update: (next: Record<string, unknown>) => {
      mode = 'update';
      values = next;
      return query;
    },
    eq: (column: string, value: unknown) => {
      filters.push({ op: 'eq', column, value });
      return query;
    },
    lte: (column: string, value: string) => {
      filters.push({ op: 'lte', column, value });
      return query;
    },
    or: (expr: string) => {
      filters.push({ op: 'or', alternatives: parseOr(expr) });
      return query;
    },
    maybeSingle: async () => {
      const { data } = run();
      return { data: data[0] ?? null, error: null };
    },
    single: async () => {
      const { data } = run();
      return data.length === 1 ? { data: data[0], error: null } : { data: null, error: { message: 'no rows' } };
    },
    then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
      Promise.resolve(run()).then(resolve, reject),
  };
  return query;
}

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    auth: { getUser: async () => ({ data: { user: { id: USER_ID } }, error: null }) },
    from: (table: string) => {
      if (table !== 'planned_meals') throw new Error(`作り物が知らない表: ${table}`);
      return plannedMealsQuery();
    },
    storage: {
      from: () => ({
        upload: async (path: string) => {
          h.uploads.push(path);
          return { data: { path }, error: null };
        },
        getPublicUrl: (path: string) => ({ data: { publicUrl: `${PUBLIC_URL_BASE}${path}` } }),
      }),
    },
  }),
}));

// 解析のパイプライン: 写真ごとに結果を決め、テストが resolve を呼ぶまで終わらない (終わる順番をテストが決める)
vi.mock('../supabase/functions/_shared/nutrition-pipeline.ts', () => ({
  analyzeWithEvidence: (images: Array<{ base64: string }>) =>
    new Promise((resolve) => {
      const photo = images[0]?.base64 ?? '';
      const name = photo === PHOTO_A ? DISH_A : DISH_B;
      h.analyses.push({
        photo,
        resolve: () =>
          resolve({
            dishes: [{ name, role: 'main', calories_kcal: 500, protein_g: 20, carbs_g: 60, fat_g: 15, ingredient: '', ingredients: [] }],
            totalCalories: 500,
            totalProtein: 20,
            totalFat: 15,
            totalCarbs: 60,
            nutrition: {},
            vegScore: photo === PHOTO_A ? 10 : 90,
            praiseComment: `${name}、いいですね`,
            evidence: { confidenceScore: 0.9, verification: { reason: 'ok' } },
          }),
      });
    }),
}));

vi.mock('../supabase/functions/_shared/meal-image-jobs.ts', () => ({
  cancelPendingMealImageJobs: async () => {
    h.cancelCalls += 1;
    h.onCancel?.();
  },
}));

// 同意の判定は通す (同意が無いときに AI へ送らないことは tests/ai-consent-enforcement-edge.test.ts)
vi.mock('../supabase/functions/_shared/ai-consent-guard.ts', () => import('./helpers/edge-ai-consent-guard-allowed'));

vi.mock('../supabase/functions/_shared/ai-usage.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../supabase/functions/_shared/ai-usage.ts')>()),
  consumeEdgeAiUsage: async () => {
    h.consumeCalls += 1;
    return AI_USAGE_ALLOWED;
  },
}));

vi.mock('../supabase/functions/_shared/db-logger.ts', () => {
  const logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
  return {
    createLogger: () => ({ ...logger, withUser: () => logger }),
    generateRequestId: () => 'req_test',
  };
});

let handler: (req: Request) => Promise<Response>;

/**
 * Edge Function の本体を動的に読み込むフック (beforeAll) の時間切れ (#1605)。このファイルのテストは読み込んだハンドラを
 * 呼ぶだけなので一覧 (HEAVY_UNIT_TEST_FILES) には入れず、読み込みのフックにだけ同じ値 (環境変数で上書き可) を使う
 * (tests/process-meal-image-jobs-worker-edges.test.ts と同じ形)
 */
const EDGE_IMPORT_HOOK_TIMEOUT_MS = resolveHeavyUnitTimeouts(process.env).hookTimeout;

beforeAll(async () => {
  vi.stubGlobal('Deno', {
    env: { get: () => undefined },
    serve: (fn: (req: Request) => Promise<Response>) => {
      h.handlers.push(fn);
    },
  });
  vi.stubGlobal('EdgeRuntime', {
    waitUntil: (promise: Promise<unknown>) => {
      h.background.push(promise);
    },
  });
  await import('../supabase/functions/analyze-meal-photo/index.ts');
  handler = h.handlers[h.handlers.length - 1];
}, EDGE_IMPORT_HOOK_TIMEOUT_MS);

afterAll(() => {
  vi.unstubAllGlobals();
});

beforeEach(() => {
  h.background = [];
  h.clockMs = 0;
  h.meal = { id: MEAL_ID, owner: USER_ID, dish_name: ORIGINAL_DISH, veg_score: null, image_url: null, updated_at: tick() };
  h.analyses = [];
  h.uploads = [];
  h.cancelCalls = 0;
  h.onCancel = null;
  h.consumeCalls = 0;
  h.mealUpdates = [];
});

/** Next.js の route と同じ本文で呼ぶ (invokedAt を省くときは null を渡す) */
async function send(photo: string, invokedAt: string | null | number): Promise<Response> {
  return handler(
    new Request(URL_, {
      method: 'POST',
      headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json', Origin: WEB_ORIGIN },
      body: JSON.stringify({
        images: [{ base64: photo, mimeType: 'image/jpeg' }],
        mealId: MEAL_ID,
        mealType: 'dinner',
        userId: USER_ID,
        ...(invokedAt === null ? {} : { invokedAt }),
      }),
    }),
  );
}

/** 解析が n 本、解析のパイプラインで止まるまで待つ */
async function untilAnalyses(n: number): Promise<void> {
  await vi.waitFor(() => expect(h.analyses).toHaveLength(n));
}

function analysisOf(photo: string): { resolve: () => void } {
  const found = h.analyses.find((a) => a.photo === photo);
  if (!found) throw new Error(`解析が始まっていない: ${photo}`);
  return found;
}

/** 写真の結果の書き込み (印でない update) のうち、行に当たったもの */
function photoWrites(): Array<Record<string, unknown>> {
  return h.mealUpdates.filter((u) => u.matched && 'dish_name' in u.values).map((u) => u.values);
}

describe('写真の解析の古い結果が新しい結果を上書きしない (#121 の CAS・#2025 の続き)', () => {
  it('PC-1: 先に送った解析が後に終わっても、後に送った解析の結果が残る', async () => {
    expect((await send(PHOTO_A, tick())).status).toBe(200);
    expect((await send(PHOTO_B, tick())).status).toBe(200);
    await untilAnalyses(2);

    analysisOf(PHOTO_B).resolve();
    await h.background[1];
    expect(h.meal?.dish_name).toBe(DISH_B);

    analysisOf(PHOTO_A).resolve();
    await h.background[0];
    expect(h.meal?.dish_name).toBe(DISH_B);
    expect(h.meal?.veg_score).toBe(90);
    expect(photoWrites().map((v) => v.dish_name)).toEqual([DISH_B]);
  });

  it('PC-2: 先に送った解析が先に終わっても、後に送った解析の結果が残る (古い解析は後の印で書かない)', async () => {
    await send(PHOTO_A, tick());
    await send(PHOTO_B, tick());
    await untilAnalyses(2);

    analysisOf(PHOTO_A).resolve();
    await h.background[0];
    expect(h.meal?.dish_name).toBe(ORIGINAL_DISH);

    analysisOf(PHOTO_B).resolve();
    await h.background[1];
    expect(h.meal?.dish_name).toBe(DISH_B);
    expect(photoWrites().map((v) => v.dish_name)).toEqual([DISH_B]);
    // 古い解析は Storage にアップロードせず、画像のジョブも取り消さない
    expect(h.uploads).toHaveLength(1);
    expect(h.cancelCalls).toBe(1);
  });

  it('PC-3: 競う解析が無ければ、写真の結果を書く', async () => {
    await send(PHOTO_A, tick());
    await untilAnalyses(1);
    analysisOf(PHOTO_A).resolve();
    await h.background[0];
    expect(h.meal?.dish_name).toBe(DISH_A);
    expect(h.meal?.veg_score).toBe(10);
    expect(h.meal?.image_url).toBe(`${PUBLIC_URL_BASE}${h.uploads[0]}`);
  });

  it('PC-4: invokedAt より後に行が書かれていたら (遅れて届いた古い要求)、解析せず、行を変えない', async () => {
    const staleInvokedAt = tick();
    touchMealByAnotherWriter();
    const before = { ...h.meal };

    expect((await send(PHOTO_A, staleInvokedAt)).status).toBe(200);
    await h.background[0];

    expect(h.analyses).toHaveLength(0);
    expect(h.meal).toEqual(before);
    expect(h.mealUpdates.filter((u) => u.matched)).toEqual([]);
  });

  it('PC-5: 解析のあいだにほかの書き手が行を書いたら、アップロード・取り消し・書き込みをしない', async () => {
    await send(PHOTO_A, tick());
    await untilAnalyses(1);
    touchMealByAnotherWriter();

    analysisOf(PHOTO_A).resolve();
    await h.background[0];
    expect(h.meal?.dish_name).toBe(ORIGINAL_DISH);
    expect(h.uploads).toEqual([]);
    expect(h.cancelCalls).toBe(0);
    expect(photoWrites()).toEqual([]);
  });

  it('PC-6: 書く前の確認のあとに行が書かれても、update の条件で止まって書かない', async () => {
    h.onCancel = touchMealByAnotherWriter;
    await send(PHOTO_A, tick());
    await untilAnalyses(1);

    analysisOf(PHOTO_A).resolve();
    await h.background[0];
    expect(h.cancelCalls).toBe(1);
    expect(h.meal?.dish_name).toBe(ORIGINAL_DISH);
    // 写真の結果の update は送ったが、行に当たらなかった
    const photoUpdates = h.mealUpdates.filter((u) => 'dish_name' in u.values);
    expect(photoUpdates.map((u) => u.matched)).toEqual([false]);
  });

  it('PC-7: invokedAt が無くても印を付けて書く。後から送った解析には負ける', async () => {
    await send(PHOTO_A, null);
    await send(PHOTO_B, null);
    await untilAnalyses(2);

    analysisOf(PHOTO_B).resolve();
    await h.background[1];
    analysisOf(PHOTO_A).resolve();
    await h.background[0];
    expect(h.meal?.dish_name).toBe(DISH_B);
    expect(photoWrites().map((v) => v.dish_name)).toEqual([DISH_B]);
  });

  it('PC-8: 他人の献立の mealId では、印を付けず、解析も書き込みもしない', async () => {
    h.meal = { ...h.meal, owner: OTHER_USER_ID };
    const before = { ...h.meal };

    await send(PHOTO_A, tick());
    await h.background[0];
    expect(h.analyses).toHaveLength(0);
    expect(h.mealUpdates).toEqual([]);
    expect(h.meal).toEqual(before);
  });

  it.each([
    ['日時として読めない文字列', 'not-a-date'],
    ['数値', 12345],
  ])('PC-9: invokedAt が %s なら 400 で、利用回数を数えず解析もしない', async (_label, invokedAt) => {
    const res = await send(PHOTO_A, invokedAt);
    expect(res.status).toBe(400);
    expect(h.consumeCalls).toBe(0);
    expect(h.background).toEqual([]);
    expect(h.analyses).toHaveLength(0);
  });

  it('PC-10: updated_at が NULL の行でも、invokedAt つきで印を付けて書く', async () => {
    h.meal = { ...h.meal, updated_at: null };
    await send(PHOTO_A, tick());
    await untilAnalyses(1);
    analysisOf(PHOTO_A).resolve();
    await h.background[0];
    expect(h.meal?.dish_name).toBe(DISH_A);
  });
});
