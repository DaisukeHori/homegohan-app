/**
 * #2050: 写真の解析 (analyze-meal-photo の mealId の経路) で、先に送った解析の印が、後に送った要求の時刻より後に付いても、
 * 最後に送った写真の結果が残る。
 *
 * 直す前は、Next.js の route が Edge を呼ぶ直前の時刻 (route の時計) を invokedAt として送り、Edge の背景の処理が
 * 「行の updated_at が invokedAt 以前 (または NULL) なら印を付ける」だけだった (_shared/meal-photo-cas.ts の claimPhotoAnalysis)。
 * A を送り (invokedAt = IA)、B を送り (IB > IA)、A の Edge の起動・本人の確認が遅れて A の印が IB より後に付くと、
 * B の印は updated_at <= IB も updated_at IS NULL も満たさず superseded になり、古い A の写真の結果が書かれ、新しい B は解析されなかった。
 *
 * 直した形: route が Edge を呼ぶ直前に、利用者の client で行に「要求の印」を付け (markPhotoAnalysisRequest。updated_at を進める)、
 * 進んだあとの updated_at (DB の時刻) を invokedAt として送る。後に送った B の要求の印が行に残るので、遅れて届いた A の印は
 * 「updated_at が A の invokedAt 以前」を満たさず付かない。B の印は付き、B の結果が書かれる。
 *
 * ここでは Next.js の route (src/app/api/ai/analyze-meal-photo/route.ts) と Edge Function のハンドラ
 * (supabase/functions/analyze-meal-photo/index.ts) の両方を本物で動かし、route の functions.invoke は要求を溜めて、
 * テストが決めた順に Edge のハンドラへ渡す (Edge の起動の遅れを作る)。planned_meals は作り物の 1 行で、update の条件 (eq / lte / is) を
 * 本当に評価し、当たると updated_at を作り物の時計で進める (トリガー trg_planned_meals_updated_at と同じ)。時計は Date だけを
 * 作り物にしたもので、route の new Date() も同じ時計を読む。解析のパイプラインは呼ばれたらすぐに写真ごとの結果を返す。
 * 本物の PostgREST での評価 (要求の印の返す行・マイクロ秒の印の一致) は tests/integration/rls/planned-meals-photo-analysis-cas.test.ts の P-7〜P-9。
 *
 * 確かめること (RO-n はこのファイルの it の番号):
 *   - RO-1: A の Edge が B の要求のあと (B の Edge より前) に印を付けようとしても、A は解析も書き込みもせず、B の結果が残る (直す前は A の結果が残り B は解析されなかった)
 *   - RO-2: A の Edge が B の Edge より後に届いても、B の結果が残る
 *   - RO-3: 競う要求が無ければ、route の要求の印の時刻で Edge が印を付けて書く
 *   - RO-4: route は要求の印を利用者の client の planned_meals の update で付け、送る値は updated_at だけ (3 列などを書かない)、
 *           本人の行が見つからないときは今までどおり route の時計を送り、Edge の本人の行の確認が止める
 *   - RO-5: parseInvokedAt は DB の時刻 (マイクロ秒まで・+00:00) の桁を落とさない (落とすと印の直後の updated_at が invokedAt より後になり、自分の要求の印で止まる)
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveHeavyUnitTimeouts } from './helpers/heavy-unit-test-timeout';
import { AI_USAGE_ALLOWED } from './helpers/ai-usage-mock';
import { parseInvokedAt } from '../supabase/functions/_shared/meal-photo-cas';

type Row = Record<string, unknown>;
type Filter =
  | { op: 'eq'; column: string; value: unknown }
  | { op: 'lte'; column: string; value: string }
  | { op: 'is_null'; column: string };

const MEAL_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '33333333-3333-4333-8333-333333333333';
const OTHER_USER_ID = '44444444-4444-4444-8444-444444444444';
/** 作り物の時計の始まり (行の最初の updated_at) */
const CLOCK_START_MS = Date.parse('2026-10-26T00:00:00.000Z');
/** 作り物の時計を進める幅 (ミリ秒。1 ミリ秒でも前後が決まる) */
const CLOCK_STEP_MS = 1;
/** 写真 A・B (base64。atob で読める値) */
const PHOTO_A = 'QUFB';
const PHOTO_B = 'QkJC';
const DISH_A = '古い写真の鮭の塩焼き';
const DISH_B = '新しい写真の豚の生姜焼き';
/** 解析の前の献立の名前 (写真の結果で上書きされたかを見る) */
const ORIGINAL_DISH = 'AI 献立のハンバーグ';
const ROUTE_URL = 'http://localhost/api/ai/analyze-meal-photo';
const EDGE_URL = 'http://localhost/functions/v1/analyze-meal-photo';
const WEB_ORIGIN = 'https://homegohan-app.vercel.app';
const PUBLIC_URL_BASE = 'http://127.0.0.1:54321/storage/v1/object/public/fridge-images/';
/** route が Edge の呼び出しに付ける「数え済みの印」(作り物) */
const RECORDED_HEADERS = { 'x-hg-ai-usage-recorded': 'test-marker' };

const h = vi.hoisted(() => ({
  edgeHandlers: [] as Array<(req: Request) => Promise<Response>>,
  /** EdgeRuntime.waitUntil に渡された背景の処理 */
  background: [] as Array<Promise<unknown>>,
  meal: null as Record<string, unknown> | null,
  /** route の functions.invoke が溜めた、Edge へ渡す前の要求 */
  invocations: [] as Array<{ body: Record<string, unknown> }>,
  /** 解析 (analyzeWithEvidence) を始めた写真 */
  analyzedPhotos: [] as string[],
  uploads: [] as string[],
  /** planned_meals の update の記録 (どの client からか・送った値・行に当たったか) */
  mealUpdates: [] as Array<{ by: 'user' | 'service'; values: Record<string, unknown>; matched: boolean }>,
}));

/** 作り物の時計を 1 ミリ秒進めて、今の時刻を返す (DB の now() と route の new Date() の両方がこの時計) */
function tick(): string {
  vi.setSystemTime(Date.now() + CLOCK_STEP_MS);
  return new Date().toISOString();
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
    return columnOf(row, f.column) === null;
  });
}

/** 行の列を選ぶ (select の列の並び。埋め込みは返さない) */
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

/**
 * planned_meals の作り物の問い合わせ。by = 'user' は利用者の client (RLS が本人の行だけを見せる)、'service' は service_role の client
 */
function plannedMealsQuery(by: 'user' | 'service', userId: string) {
  const filters: Filter[] = [];
  let mode: 'select' | 'update' = 'select';
  let values: Record<string, unknown> = {};
  let columns: string | undefined;

  const visible = (row: Row): boolean => by === 'service' || row.owner === userId;
  const run = (): { data: Row[]; error: null } => {
    const hit = h.meal !== null && visible(h.meal) && matches(h.meal, filters);
    if (mode === 'update') {
      h.mealUpdates.push({ by, values, matched: hit });
      if (!hit || !h.meal) return { data: [], error: null };
      // トリガー trg_planned_meals_updated_at: 送った updated_at は使わず、DB の now() にする
      h.meal = { ...h.meal, ...structuredClone(values), updated_at: tick() };
      return { data: [pick(h.meal, columns)], error: null };
    }
    return { data: hit && h.meal ? [pick(h.meal, columns)] : [], error: null };
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
    is: (column: string, value: null) => {
      if (value !== null) throw new Error('作り物の is は null だけ');
      filters.push({ op: 'is_null', column });
      return query;
    },
    // or は作り物に無い (PostgREST は or の条件を update の返す行にも当て直し、印を付けた行が返らない。_shared/meal-photo-cas.ts の注)
    or: () => {
      throw new Error('写真の解析の印に or を使わない (_shared/meal-photo-cas.ts の注)');
    },
    maybeSingle: async () => {
      const { data } = run();
      return { data: data[0] ?? null, error: null };
    },
    then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
      Promise.resolve(run()).then(resolve, reject),
  };
  return query;
}

// Next.js の route の利用者の client。functions.invoke は要求を溜めるだけ (Edge へ渡す順はテストが決める)
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: USER_ID } }, error: null }) },
    from: (table: string) => {
      if (table !== 'planned_meals') throw new Error(`作り物が知らない表: ${table}`);
      return plannedMealsQuery('user', USER_ID);
    },
    functions: {
      invoke: async (_name: string, options: { body: Record<string, unknown> }) => {
        h.invocations.push({ body: options.body });
        return { data: { message: 'Photo analysis started in background' }, error: null };
      },
    },
  }),
}));

vi.mock('next/headers', () => ({
  cookies: vi.fn(async () => undefined),
}));

// 同意の判定は通す (同意が無いときに AI へ送らないことは tests/ai-consent-enforcement-routes.test.ts・ai-consent-enforcement-edge.test.ts)
vi.mock('@/lib/ai/consent-guard', () => import('./helpers/ai-consent-guard-allowed'));
vi.mock('../supabase/functions/_shared/ai-consent-guard.ts', () => import('./helpers/edge-ai-consent-guard-allowed'));

vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: async () => ({ success: true }),
  rateLimitExceededResponse: () => {
    throw new Error('このテストではレート制限に当たらない');
  },
}));

vi.mock('@/lib/plan/entitlements', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/plan/entitlements')>()),
  redeemAiUsageGrant: async () => false,
  consumeAiUsage: async () => AI_USAGE_ALLOWED,
  aiUsageRecordedHeaders: async () => RECORDED_HEADERS,
}));

// Edge の側の Supabase の client (利用者の client と service_role の client の区別は、渡された鍵で見分けない。Edge の
// 本人の行の確認は service_role の client の埋め込みの絞り込みで見るので、ここでは service として扱う)
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    auth: { getUser: async () => ({ data: { user: { id: USER_ID } }, error: null }) },
    from: (table: string) => {
      if (table !== 'planned_meals') throw new Error(`作り物が知らない表: ${table}`);
      return plannedMealsQuery('service', USER_ID);
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

// 解析のパイプライン: 呼ばれたらすぐに写真ごとの結果を返す (このファイルが見るのは印の付く順で、解析の終わる順ではない)
vi.mock('../supabase/functions/_shared/nutrition-pipeline.ts', () => ({
  analyzeWithEvidence: async (images: Array<{ base64: string }>) => {
    const photo = images[0]?.base64 ?? '';
    h.analyzedPhotos.push(photo);
    const name = photo === PHOTO_A ? DISH_A : DISH_B;
    return {
      dishes: [{ name, role: 'main', calories_kcal: 500, protein_g: 20, carbs_g: 60, fat_g: 15, ingredient: '', ingredients: [] }],
      totalCalories: 500,
      totalProtein: 20,
      totalFat: 15,
      totalCarbs: 60,
      nutrition: {},
      vegScore: photo === PHOTO_A ? 10 : 90,
      praiseComment: `${name}、いいですね`,
      evidence: { confidenceScore: 0.9, verification: { reason: 'ok' } },
    };
  },
}));

vi.mock('../supabase/functions/_shared/meal-image-jobs.ts', () => ({
  cancelPendingMealImageJobs: async () => {},
}));

vi.mock('../supabase/functions/_shared/ai-usage.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../supabase/functions/_shared/ai-usage.ts')>()),
  consumeEdgeAiUsage: async () => AI_USAGE_ALLOWED,
}));

vi.mock('../supabase/functions/_shared/db-logger.ts', () => {
  const logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
  return {
    createLogger: () => ({ ...logger, withUser: () => logger }),
    generateRequestId: () => 'req_test',
  };
});

let edgeHandler: (req: Request) => Promise<Response>;
let routePost: (req: Request) => Promise<Response>;

/**
 * Edge Function と route を動的に読み込むフック (beforeAll) の時間切れ (#1605)。tests/analyze-meal-photo-cas.test.ts と同じ形
 * (一覧 HEAVY_UNIT_TEST_FILES には入れず、読み込みのフックにだけ同じ値 (環境変数で上書き可) を使う)
 */
const IMPORT_HOOK_TIMEOUT_MS = resolveHeavyUnitTimeouts(process.env).hookTimeout;

beforeAll(async () => {
  vi.stubGlobal('Deno', {
    env: { get: () => undefined },
    serve: (fn: (req: Request) => Promise<Response>) => {
      h.edgeHandlers.push(fn);
    },
  });
  vi.stubGlobal('EdgeRuntime', {
    waitUntil: (promise: Promise<unknown>) => {
      h.background.push(promise);
    },
  });
  await import('../supabase/functions/analyze-meal-photo/index.ts');
  edgeHandler = h.edgeHandlers[h.edgeHandlers.length - 1];
  routePost = (await import('../src/app/api/ai/analyze-meal-photo/route')).POST;
}, IMPORT_HOOK_TIMEOUT_MS);

afterAll(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  // Date だけを作り物にする (setTimeout は本物のまま。route の時間切れの競争と vi.waitFor が動く)
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(CLOCK_START_MS);
  h.background = [];
  h.meal = { id: MEAL_ID, owner: USER_ID, dish_name: ORIGINAL_DISH, veg_score: null, image_url: null, updated_at: tick() };
  h.invocations = [];
  h.analyzedPhotos = [];
  h.uploads = [];
  h.mealUpdates = [];
});

/** 画面と同じ本文で route に送る (route は Edge を呼ぶ直前に invokedAt を決めて、要求を溜める) */
async function sendToRoute(photo: string): Promise<Response> {
  return routePost(
    new Request(ROUTE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ images: [{ base64: photo, mimeType: 'image/jpeg' }], mealId: MEAL_ID, mealType: 'dinner' }),
    }),
  );
}

/** route が溜めた i 番目の要求を Edge のハンドラへ渡し、背景の処理が終わるまで待つ (Edge の起動の順をテストが決める) */
async function deliverToEdge(i: number): Promise<void> {
  const invocation = h.invocations[i];
  if (!invocation) throw new Error(`route が ${i} 番目の要求を Edge へ送っていない`);
  const before = h.background.length;
  const res = await edgeHandler(
    new Request(EDGE_URL, {
      method: 'POST',
      headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json', Origin: WEB_ORIGIN, ...RECORDED_HEADERS },
      body: JSON.stringify(invocation.body),
    }),
  );
  expect(res.status).toBe(200);
  expect(h.background).toHaveLength(before + 1);
  await h.background[before];
}

/** 写真の結果の書き込み (印でない update) のうち、行に当たったものの料理名 */
function writtenDishes(): unknown[] {
  return h.mealUpdates.filter((u) => u.matched && 'dish_name' in u.values).map((u) => u.values.dish_name);
}

describe('#2050 先に送った解析の印が、後に送った要求の時刻より後に付いても、最後に送った写真の結果が残る', () => {
  it('RO-1: A の Edge が B の要求のあと (B の Edge より前) に印を付けようとしても、A は解析せず、B の結果が残る', async () => {
    expect((await sendToRoute(PHOTO_A)).status).toBe(200);
    tick();
    expect((await sendToRoute(PHOTO_B)).status).toBe(200);
    // A の Edge の起動・本人の確認が遅れ、A の印を付けようとする時刻が B の要求の時刻より後になる
    tick();
    await deliverToEdge(0);
    await deliverToEdge(1);

    expect(h.analyzedPhotos).toEqual([PHOTO_B]);
    expect(writtenDishes()).toEqual([DISH_B]);
    expect(h.meal?.dish_name).toBe(DISH_B);
    expect(h.meal?.veg_score).toBe(90);
    // 古い A の写真は Storage に上げない
    expect(h.uploads).toHaveLength(1);
  });

  it('RO-2: A の Edge が B の Edge より後に届いても、B の結果が残る', async () => {
    await sendToRoute(PHOTO_A);
    tick();
    await sendToRoute(PHOTO_B);
    tick();
    await deliverToEdge(1);
    await deliverToEdge(0);

    expect(h.analyzedPhotos).toEqual([PHOTO_B]);
    expect(writtenDishes()).toEqual([DISH_B]);
    expect(h.meal?.dish_name).toBe(DISH_B);
  });

  it('RO-3: 競う要求が無ければ、route の要求の印の時刻で Edge が印を付けて書く', async () => {
    await sendToRoute(PHOTO_A);
    tick();
    await deliverToEdge(0);

    expect(h.analyzedPhotos).toEqual([PHOTO_A]);
    expect(h.meal?.dish_name).toBe(DISH_A);
    expect(h.meal?.veg_score).toBe(10);
  });

  it('RO-4: route は利用者の client で updated_at だけを送って要求の印を付け、進んだ updated_at を invokedAt として送る', async () => {
    const before = String(h.meal?.updated_at);
    await sendToRoute(PHOTO_A);

    const routeWrites = h.mealUpdates.filter((u) => u.by === 'user');
    expect(routeWrites).toHaveLength(1);
    expect(Object.keys(routeWrites[0].values)).toEqual(['updated_at']);
    expect(routeWrites[0].matched).toBe(true);
    const sentInvokedAt = h.invocations[0]?.body.invokedAt;
    expect(sentInvokedAt).toBe(h.meal?.updated_at);
    expect(timeOf(sentInvokedAt)).toBeGreaterThan(timeOf(before));
  });

  it('RO-4: 本人の行が見つからない (他人の献立) ときは、行を変えずに route の時計を送り、Edge の本人の行の確認が止める', async () => {
    h.meal = { ...h.meal, owner: OTHER_USER_ID };
    const before = { ...h.meal };
    expect((await sendToRoute(PHOTO_A)).status).toBe(200);
    expect(h.meal).toEqual(before);
    expect(typeof h.invocations[0]?.body.invokedAt).toBe('string');

    await deliverToEdge(0);
    expect(h.analyzedPhotos).toEqual([]);
    expect(h.mealUpdates.filter((u) => u.matched)).toEqual([]);
    expect(h.meal).toEqual(before);
  });
});

describe('RO-5: parseInvokedAt は DB の時刻のマイクロ秒の桁を落とさない', () => {
  it.each([
    ['DB の時刻 (マイクロ秒・+00:00)', '2026-10-26T01:02:03.123456+00:00', '2026-10-26T01:02:03.123456Z'],
    ['末尾の 0 を詰めた DB の時刻', '2026-10-26T01:02:03.1234+00:00', '2026-10-26T01:02:03.123400Z'],
    ['ミリ秒の Z (route の時計)', '2026-10-26T01:02:03.123Z', '2026-10-26T01:02:03.123000Z'],
    ['秒まで', '2026-10-26T01:02:03+00:00', '2026-10-26T01:02:03.000000Z'],
    ['+09:00 (UTC にそろえる)', '2026-10-26T10:02:03.999999+09:00', '2026-10-26T01:02:03.999999Z'],
  ])('%s', (_label, input, expected) => {
    expect(parseInvokedAt(input)).toEqual({ ok: true, invokedAt: expected });
  });

  it('時刻の前後の比べ方が DB と同じになる (マイクロ秒だけ違う 2 つの時刻を取り違えない)', () => {
    const earlier = parseInvokedAt('2026-10-26T01:02:03.123456+00:00');
    const later = parseInvokedAt('2026-10-26T01:02:03.123457+00:00');
    if (!earlier.ok || !later.ok || earlier.invokedAt === null || later.invokedAt === null) throw new Error('読めない');
    expect(earlier.invokedAt < later.invokedAt).toBe(true);
  });

  it.each([
    ['日時として読めない文字列', 'not-a-date'],
    ['数値', 12345],
  ])('%s は ok: false', (_label, input) => {
    expect(parseInvokedAt(input)).toEqual({ ok: false });
  });

  it('無い (undefined / null) ときは null', () => {
    expect(parseInvokedAt(undefined)).toEqual({ ok: true, invokedAt: null });
    expect(parseInvokedAt(null)).toEqual({ ok: true, invokedAt: null });
  });
});
