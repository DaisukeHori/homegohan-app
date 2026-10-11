/**
 * T15 (#1154) 未同意の利用者のデータを、外国の AI 事業者へ送らない: 実際の API Route で確かめる (表で全経路)
 *
 * tests/ai-consent-enforcement.test.ts の棚卸しは「判定を import して呼んでいる」ことまでしか見ない。
 * ここでは、送る手前で判定する API Route (tests/helpers/ai-consent-enforced-paths.ts の ENFORCED_ROUTES) を 1 本ずつ実際に呼び、
 * 同意の状況ごとに、AI へ送る関数が何回呼ばれたかを数える。判定の結果を無視する・送ったあとで判定する・条件を反転する、
 * のどれをしてもこのテストが落ちる (同意済みの行が「送る関数に届く」ことを確かめているので、0 回が空振りにならない)。
 *
 * 判定 (src/lib/ai/consent-guard.ts と supabase/functions/_shared/ai-consent.ts) は差し替えない。
 * 差し替えるのは外との境目だけ: Supabase のクライアント (external_data_consents の読み取りの結果を同意の状況ごとに変える)、
 * AI へ送る関数 (fast-llm / gemini-json / @google/genai / Edge Function の呼び出し / fetch)、レート制限、ログ。
 *
 * 同意の状況 (行):
 *   - none     : 有効な同意が無い (一度も同意していない・撤回した)            → 403 AI_CONSENT_REQUIRED
 *   - outdated : 古い版の文面に同意している                                  → 403 AI_CONSENT_REQUIRED
 *   - failed   : 同意の状況を読めない (fail-closed)                          → 503 AI_CONSENT_CHECK_FAILED
 *   - granted  : 全事業者について現行の版に同意している                        → AI へ送る (1 回以上)
 * 保存・集計と AI を兼ねる API (kind: 'skip') は、止めずに保存・集計だけをして、応答の aiSkipped で知らせる。
 * 同意と関係なく AI へ送らない分岐 (kind: 'pass') は、同意の状況に関わらず進み、AI へは送らない。
 *
 * AI の利用回数の上限 (#1149) も、同じ表で確かめる。同意済みで、DB の consume_ai_usage が「上限に達している」を返したとき、
 * 一覧 (tests/helpers/ai-consent-enforced-paths.ts) の onLimit どおりに止める:
 *   - reject : 429 AI_DAILY_LIMIT (固定の文・retryAfter)。AI へ 1 回も送らず、キューにも積まない
 *   - skipAi : 200。保存・集計はして、AI の部分だけ省く (aiSkipped: AI_DAILY_LIMIT)
 * 画面を開くと自動で呼ばれる行 (unmetered) は、上限に数えない機能 (nutrition_advice_auto) で数えることを確かめる (DB は止めない)。
 * 生成のリクエストの行を作れなかった行 (refundOnInsertFailure) は、AI へ送らずに数えた 1 回を戻す (refund_ai_usage)。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AI_CONSENT_CHECK_FAILED_CODE,
  AI_CONSENT_PROVIDERS,
  AI_CONSENT_REQUIRED_CODE,
  AI_CONSENT_TABLE,
  AI_CONSENT_VERSION,
} from '../supabase/functions/_shared/ai-consent';
import { ENFORCED_ROUTES } from './helpers/ai-consent-enforced-paths';
import type { HttpMethod } from './helpers/ai-reach';
import { AI_QUEUE_TABLES } from '../src/lib/ai/ai-queue-tables';
import { aiDailyLimitMessage } from '../supabase/functions/_shared/ai-daily-limit';
import { isMeteredAiFeature } from '../supabase/functions/_shared/ai-usage-core';

const USER = '11111111-1111-4111-8111-111111111111';
/** DB の consume_ai_usage の戻り値 (#1149): 許可 / 上限に達している */
const CONSUME_ALLOWED_ROW = { allowed: true, metered: true, plan: 'free', limit: 10, used: 1, usage_date: '2026-10-11' };
const CONSUME_DENIED_ROW = { allowed: false, metered: true, plan: 'free', limit: 10, used: 10, usage_date: '2026-10-11' };
const SESSION_ID = '22222222-2222-4222-8222-222222222222';
const MEAL_ID = '33333333-3333-4333-8333-333333333333';
const TODAY = new Date().toISOString().split('T')[0];

type ConsentMode = 'none' | 'outdated' | 'failed' | 'granted';
const CONSENT_MODES: readonly ConsentMode[] = ['none', 'outdated', 'failed', 'granted'];
const DENIED_MODES: readonly ConsentMode[] = ['none', 'outdated', 'failed'];

/** 同意の状況ごとの、止めたときの応答 */
const EXPECTED_DENIAL: Record<Exclude<ConsentMode, 'granted'>, { status: number; code: string }> = {
  none: { status: 403, code: AI_CONSENT_REQUIRED_CODE },
  outdated: { status: 403, code: AI_CONSENT_REQUIRED_CODE },
  failed: { status: 503, code: AI_CONSENT_CHECK_FAILED_CODE },
};

type Row = Record<string, unknown>;
/** 書き込みに使ったクライアント (makeSupabase を参照) */
type SupabaseClientKind = 'user' | 'service' | 'supabase-js';

const h = vi.hoisted(() => {
  const state = {
    consentMode: 'none' as 'none' | 'outdated' | 'failed' | 'granted',
    /** 表ごとの select の結果 (無ければ []) */
    rows: {} as Record<string, Array<Record<string, unknown>>>,
    /** 表ごとの single() / maybeSingle() の結果 (キーが無ければ既定の行。null なら行が無い) */
    single: {} as Record<string, Record<string, unknown> | null>,
    /** rpc の結果 */
    rpc: {} as Record<string, unknown>,
    /** 書き込み (insert / update / upsert / delete) の記録 */
    writes: [] as Array<{ table: string; op: string; payload: unknown; client: SupabaseClientKind }>,
    /** 呼んだ rpc の名前 (AI 利用回数の判定と記録 consume_ai_usage を確かめるため。#1177 / #1149) */
    rpcCalls: [] as string[],
    /** 呼んだ rpc の引数 (名前と同じ順) */
    rpcArgs: [] as Array<Record<string, unknown>>,
    /** insert を失敗させる表 (#1149 の数え戻しを確かめるため) */
    failInsert: new Set<string>(),
  };
  const fastLLMCreate = vi.fn(async () => ({
    choices: [{ message: { content: '{"summary":"要約","title":"t","praiseComment":"p","advice":"a","nutritionTip":"n"}' } }],
  }));
  const getFastLLMClient = vi.fn(() => ({ chat: { completions: { create: fastLLMCreate } } }));
  const generateGeminiJson = vi.fn(async () => ({
    data: {
      ingredients: [{ name: '卵', quantity: '2個' }],
      summary: '卵があります',
      suggestions: [],
      type: 'meal',
      confidence: 0.9,
      description: '食事',
      insights: [],
    },
    model: 'test-model',
  }));
  const genaiGenerateContent = vi.fn(async () => ({ candidates: [] }));
  const functionsInvoke = vi.fn(async () => ({ data: { dishes: [], weight: 60 }, error: null }));
  const callV4 = vi.fn(async () => ({ ok: true }));
  const callV5 = vi.fn(async () => ({ ok: true }));
  const runConsultationAction = vi.fn(async () => ({ success: true, result: {} }));
  /** global fetch のうち、AI 事業者・Edge Function へ送ったもの */
  const aiFetch = vi.fn();
  /** rpc を呼んだ印 (呼んだ順番を、AI へ送る口と比べるため。#1177 の「記録 → 送信」) */
  const rpcMark = vi.fn((_name: string) => undefined);
  return {
    state,
    fastLLMCreate,
    getFastLLMClient,
    generateGeminiJson,
    genaiGenerateContent,
    functionsInvoke,
    callV4,
    callV5,
    runConsultationAction,
    aiFetch,
    rpcMark,
  };
});

/** AI のキュー (weekly_menu_requests / meal_image_jobs) へ、利用者のクライアントで書いたもの (#1465。あってはならない) */
function userClientQueueWrites() {
  return h.state.writes.filter((w) => w.client === 'user' && (AI_QUEUE_TABLES as readonly string[]).includes(w.table));
}

/** AI 事業者・Edge Function の宛先 (global fetch で数える) */
const AI_URL_PATTERN = /api\.openai\.com|generativelanguage\.googleapis\.com|api\.x\.ai|api\.perplexity\.ai|api\.aimlapi\.com|\/functions\/v1\//;

function consentResult(): { data: unknown; error: unknown } {
  switch (h.state.consentMode) {
    case 'granted':
      return { data: AI_CONSENT_PROVIDERS.map((provider) => ({ provider, consented: true, policy_version: AI_CONSENT_VERSION })), error: null };
    case 'outdated':
      return { data: AI_CONSENT_PROVIDERS.map((provider) => ({ provider, consented: true, policy_version: 'draft-2000-01-01' })), error: null };
    case 'failed':
      return { data: null, error: { message: 'connection refused' } };
    default:
      return { data: [], error: null };
  }
}

const DEFAULT_SINGLE_ROW: Row = { id: 'row-1', user_id: USER, status: 'active', day_date: TODAY };

/** Supabase のクエリの作り物。どのメソッドを繋いでも同じ作り物を返し、await / single() で表ごとの結果を返す */
function makeQuery(table: string, client: SupabaseClientKind): unknown {
  const listResult = () =>
    table === AI_CONSENT_TABLE ? consentResult() : { data: h.state.rows[table] ?? [], error: null, count: (h.state.rows[table] ?? []).length };
  // 書き込みのあとの .select().single() は、書いた行を返す (読み取りの single の設定とは別)
  let written: Row | null = null;
  let insertFailed = false;
  const singleResult = () => {
    if (table === AI_CONSENT_TABLE) return consentResult();
    if (insertFailed) return { data: null, error: { message: 'insert failed', code: '23514' } };
    if (written) return { data: written, error: null };
    const row = table in h.state.single ? h.state.single[table] : DEFAULT_SINGLE_ROW;
    return { data: row, error: row ? null : { message: 'not found', code: 'PGRST116' } };
  };
  const builder: unknown = new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === 'then') {
          return (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => Promise.resolve(listResult()).then(resolve, reject);
        }
        if (prop === 'single' || prop === 'maybeSingle') return () => Promise.resolve(singleResult());
        if (prop === 'insert' || prop === 'update' || prop === 'upsert' || prop === 'delete') {
          return (payload: unknown) => {
            h.state.writes.push({ table, op: String(prop), payload, client });
            if ((prop === 'insert' || prop === 'upsert') && h.state.failInsert.has(table)) insertFailed = true;
            const first = Array.isArray(payload) ? payload[0] : payload;
            written = { ...DEFAULT_SINGLE_ROW, ...(first && typeof first === 'object' ? (first as Row) : {}) };
            return builder;
          };
        }
        return () => builder;
      },
    },
  );
  return builder;
}

/**
 * user: 利用者のセッションのクライアント (@/lib/supabase/server の createClient)。
 * service: service role のクライアント (getSupabaseAdmin。AI のキューへ書く getAiQueueWriter もこれ。#1465)。
 * supabase-js: @supabase/supabase-js の createClient を直接呼んだもの (cron など)
 */
function makeSupabase(client: SupabaseClientKind = 'user') {
  return {
    auth: {
      getUser: async () => ({ data: { user: { id: USER, email: 'user@example.test' } }, error: null }),
      getSession: async () => ({ data: { session: { access_token: 'token' } }, error: null }),
    },
    from: (table: string) => makeQuery(table, client),
    rpc: async (name: string, args: Record<string, unknown> = {}) => {
      h.state.rpcCalls.push(name);
      h.state.rpcArgs.push(args);
      h.rpcMark(name);
      return { data: h.state.rpc[name] ?? null, error: null };
    },
    storage: {
      from: () => ({
        upload: async () => ({ data: { path: 'p' }, error: null }),
        getPublicUrl: () => ({ data: { publicUrl: 'https://storage.example.test/p.png' } }),
        createSignedUrl: async () => ({ data: { signedUrl: 'https://storage.example.test/p.png' }, error: null }),
        remove: async () => ({ data: null, error: null }),
      }),
    },
    functions: { invoke: h.functionsInvoke },
    channel: () => ({ on: () => ({ subscribe: () => ({}) }), subscribe: () => ({}) }),
  };
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => makeSupabase('user')),
  getSupabaseAdmin: vi.fn(() => makeSupabase('service')),
}));
vi.mock('@supabase/supabase-js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@supabase/supabase-js')>()),
  createClient: vi.fn(() => makeSupabase('supabase-js')),
}));
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(async () => ({ success: true })),
  rateLimitExceededResponse: vi.fn(),
}));
vi.mock('@/lib/cron-auth', () => ({ requireCronAuth: vi.fn(async () => null) }));
vi.mock('@/lib/db-logger', async (importOriginal) => {
  const silent = { debug: () => {}, info: () => {}, warn: () => {}, error: async () => {} };
  const logger = { ...silent, withUser: () => logger };
  return {
    ...(await importOriginal<typeof import('@/lib/db-logger')>()),
    createLogger: () => logger,
    generateRequestId: () => 'req_test',
  };
});
vi.mock('@/lib/ai/fast-llm', () => ({
  getFastLLMClient: h.getFastLLMClient,
  getFastLLMModel: () => 'test-model',
  getFastLLMBaseUrl: () => 'https://api.x.ai/v1',
  getFastLLMChatCompletionsUrl: () => 'https://api.x.ai/v1/chat/completions',
}));
vi.mock('@/lib/ai/gemini-json', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/gemini-json')>()),
  generateGeminiJson: h.generateGeminiJson,
  fetchImageAsBase64: vi.fn(async () => ({ base64: 'aGVsbG8=', mimeType: 'image/jpeg' })),
}));
vi.mock('@google/genai', () => ({
  GoogleGenAI: class {
    models = { generateContent: h.genaiGenerateContent };
  },
  createUserContent: (parts: unknown) => parts,
}));
vi.mock('@/lib/generate-menu-v4-retry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/generate-menu-v4-retry')>()),
  callGenerateMenuV4WithRetry: h.callV4,
  markWeeklyMenuRequestFailed: vi.fn(async () => undefined),
}));
vi.mock('@/lib/generate-menu-v5-retry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/generate-menu-v5-retry')>()),
  callGenerateMenuV5WithRetry: h.callV5,
}));
// 機能フラグ (#1148): AI 相談の緊急停止スイッチ (ai_chat_enabled) は ON のまま、献立のエンジンは v4 にする
vi.mock('@/lib/feature-flags', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/feature-flags')>()),
  isFeatureEnabled: vi.fn(async (key: string) => key === 'ai_chat_enabled'),
}));
vi.mock('@vercel/functions', () => ({
  waitUntil: (promise: Promise<unknown>) => {
    void Promise.resolve(promise).catch(() => undefined);
  },
}));
vi.mock('@/lib/ai/consultation-action-executor', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/consultation-action-executor')>()),
  runConsultationAction: h.runConsultationAction,
}));

/** AI へ送った回数 (全部の送り口の合計) */
function aiSendCount(): number {
  return (
    h.fastLLMCreate.mock.calls.length +
    h.generateGeminiJson.mock.calls.length +
    h.genaiGenerateContent.mock.calls.length +
    h.functionsInvoke.mock.calls.length +
    h.callV4.mock.calls.length +
    h.callV5.mock.calls.length +
    h.aiFetch.mock.calls.length
  );
}

/** 送り口ごとの内訳 (失敗したときに、どこから送ったかを出す) */
function aiSendBreakdown(): Record<string, number> {
  return {
    fastLLM: h.fastLLMCreate.mock.calls.length,
    gemini: h.generateGeminiJson.mock.calls.length,
    genai: h.genaiGenerateContent.mock.calls.length,
    functionsInvoke: h.functionsInvoke.mock.calls.length,
    generateMenuV4: h.callV4.mock.calls.length,
    generateMenuV5: h.callV5.mock.calls.length,
    fetch: h.aiFetch.mock.calls.length,
  };
}

function json(url: string, body: unknown, method = 'POST'): Request {
  return new Request(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

/** 画像の品質の検査 (classify-photo の小さすぎる画像の除外) を通る大きさの base64 */
const LARGE_IMAGE_BASE64 = 'A'.repeat(40_000);

type CaseKind = 'reject' | 'skip' | 'pass';

interface RouteCase {
  /** 表の行の名前 */
  name: string;
  /** 呼ぶハンドラ */
  method: HttpMethod;
  /** ENFORCED_ROUTES のキー */
  file: string;
  kind: CaseKind;
  call: () => Promise<Response>;
  /** DB の作り物の行 (既定は空の select と、既定の 1 行の single) */
  setup?: () => void;
  /** 何を「AI へ送った」と数えるか。既定は全部の送り口の合計 (aiSendCount) */
  sends?: () => number;
  /** kind: 'skip' のとき、止めても行われる保存・集計の書き込み (表と操作) */
  savedWrite?: { table: string; op: string };
  /**
   * 画面を開くと自動で呼ばれる経路 (#1149)。上限に数えない機能 (nutrition_advice_auto) で数える (DB はこの機能では止めない)
   */
  unmetered?: true;
  /** 数えたあとに insert する、生成のリクエストの行の表。insert が失敗したら、AI へ送らずに数えた 1 回を戻す (#1149) */
  refundOnInsertFailure?: { table: string; feature: string };
}

const ROUTE_CASES: RouteCase[] = [
  {
    name: 'analyze-fridge (冷蔵庫の写真)',
    method: 'POST',
    file: 'src/app/api/ai/analyze-fridge/route.ts',
    kind: 'reject',
    call: async () => (await import('@/app/api/ai/analyze-fridge/route')).POST(
      json('http://localhost/api/ai/analyze-fridge', { imageBase64: 'aGVsbG8=', mimeType: 'image/jpeg' }),
    ),
  },
  {
    name: 'analyze-health-checkup (健康診断の写真)',
    method: 'POST',
    file: 'src/app/api/ai/analyze-health-checkup/route.ts',
    kind: 'reject',
    call: async () => (await import('@/app/api/ai/analyze-health-checkup/route')).POST(
      json('http://localhost/api/ai/analyze-health-checkup', { imageBase64: 'aGVsbG8=', mimeType: 'image/jpeg' }),
    ),
  },
  {
    name: 'analyze-meal-photo (食事の写真 → Edge Function)',
    method: 'POST',
    file: 'src/app/api/ai/analyze-meal-photo/route.ts',
    kind: 'reject',
    call: async () => (await import('@/app/api/ai/analyze-meal-photo/route')).POST(
      json('http://localhost/api/ai/analyze-meal-photo', { imageBase64: 'aGVsbG8=', mimeType: 'image/jpeg' }),
    ),
  },
  {
    name: 'analyze-weight-scale (体重計の写真 → Edge Function)',
    method: 'POST',
    file: 'src/app/api/ai/analyze-weight-scale/route.ts',
    kind: 'reject',
    call: async () => (await import('@/app/api/ai/analyze-weight-scale/route')).POST(
      json('http://localhost/api/ai/analyze-weight-scale', { image: 'aGVsbG8=', mimeType: 'image/jpeg' }),
    ),
  },
  {
    name: 'classify-photo (写真の種類の判別)',
    method: 'POST',
    file: 'src/app/api/ai/classify-photo/route.ts',
    kind: 'reject',
    call: async () => (await import('@/app/api/ai/classify-photo/route')).POST(
      json('http://localhost/api/ai/classify-photo', { imageBase64: LARGE_IMAGE_BASE64, mimeType: 'image/jpeg' }),
    ),
  },
  {
    name: 'image/generate (料理の画像の作成)',
    method: 'POST',
    file: 'src/app/api/ai/image/generate/route.ts',
    kind: 'reject',
    setup: () => {
      vi.stubEnv('GOOGLE_AI_STUDIO_API_KEY', 'test-key');
    },
    call: async () => (await import('@/app/api/ai/image/generate/route')).POST(
      json('http://localhost/api/ai/image/generate', { prompt: '肉じゃが' }),
    ),
  },
  {
    name: 'nutrition: imageUrl (写真の URL から栄養の推定)',
    method: 'POST',
    file: 'src/app/api/ai/nutrition/route.ts',
    kind: 'reject',
    setup: () => {
      h.state.single.planned_meals = { id: MEAL_ID, dishes: [], is_simple: false, user_daily_meals: { user_id: USER } };
    },
    call: async () => (await import('@/app/api/ai/nutrition/route')).POST(
      json('http://localhost/api/ai/nutrition', { plannedMealId: MEAL_ID, imageUrl: 'https://storage.example.test/meal.jpg' }),
    ),
  },
  {
    name: 'nutrition: nutritionData (数値の保存。AI へ送らない)',
    method: 'POST',
    file: 'src/app/api/ai/nutrition/route.ts',
    kind: 'pass',
    setup: () => {
      h.state.single.planned_meals = { id: MEAL_ID, dishes: [], is_simple: false, user_daily_meals: { user_id: USER } };
    },
    call: async () => (await import('@/app/api/ai/nutrition/route')).POST(
      json('http://localhost/api/ai/nutrition', {
        plannedMealId: MEAL_ID,
        nutritionData: { calories_kcal: 500, protein_g: 20, fat_g: 10, carbs_g: 60 },
      }),
    ),
    savedWrite: { table: 'planned_meals', op: 'update' },
  },
  {
    name: 'nutrition-analysis GET (ホームの栄養の集計 + AI のアドバイス)',
    method: 'GET',
    file: 'src/app/api/ai/nutrition-analysis/route.ts',
    kind: 'skip',
    setup: () => {
      h.state.single.user_profiles = { id: USER, nutrition_goal: 'maintain' };
      h.state.single.nutrition_targets = null;
      h.state.rows.planned_meals = [
        { id: MEAL_ID, calories_kcal: 600, protein_g: 20, fat_g: 15, carbs_g: 80, is_completed: true, user_daily_meals: { day_date: TODAY, user_id: USER } },
      ];
    },
    call: async () => (await import('@/app/api/ai/nutrition-analysis/route')).GET(
      new Request('http://localhost/api/ai/nutrition-analysis?period=today&includeAdvice=true&includeSuggestion=true'),
    ),
    unmetered: true,
  },
  {
    name: 'nutrition-analysis POST (献立の変更 → generate-menu-v4)',
    method: 'POST',
    file: 'src/app/api/ai/nutrition-analysis/route.ts',
    kind: 'reject',
    refundOnInsertFailure: { table: 'weekly_menu_requests', feature: 'menu_generation' },
    call: async () => (await import('@/app/api/ai/nutrition-analysis/route')).POST(
      json('http://localhost/api/ai/nutrition-analysis', { targetDate: TODAY, targetMealType: 'dinner', prompt: '野菜を増やす' }),
    ),
  },
  {
    name: 'nutrition/feedback: 新しく作る (OpenAI。栄養の詳細を開いたときの自動の取得)',
    method: 'POST',
    file: 'src/app/api/ai/nutrition/feedback/route.ts',
    kind: 'reject',
    setup: () => {
      h.state.single.nutrition_feedback_cache = null;
    },
    call: async () => (await import('@/app/api/ai/nutrition/feedback/route')).POST(
      json('http://localhost/api/ai/nutrition/feedback', { date: TODAY, nutrition: { caloriesKcal: 1800 }, mealCount: 3 }),
    ),
    unmetered: true,
  },
  {
    name: 'nutrition/feedback: 「再分析」(forceRefresh。OpenAI)',
    method: 'POST',
    file: 'src/app/api/ai/nutrition/feedback/route.ts',
    kind: 'reject',
    call: async () => (await import('@/app/api/ai/nutrition/feedback/route')).POST(
      json('http://localhost/api/ai/nutrition/feedback', { date: TODAY, nutrition: { caloriesKcal: 1800 }, mealCount: 3, forceRefresh: true }),
    ),
    refundOnInsertFailure: { table: 'nutrition_feedback_cache', feature: 'nutrition_advice' },
  },
  {
    name: 'nutrition/feedback: 作成中のコメントの状態を返すだけ (AI へ送らない)',
    method: 'POST',
    file: 'src/app/api/ai/nutrition/feedback/route.ts',
    kind: 'pass',
    setup: () => {
      h.state.single.nutrition_feedback_cache = { id: 'cache-1', feedback: '', nutrition_hash: 'x', status: 'generating' };
    },
    call: async () => (await import('@/app/api/ai/nutrition/feedback/route')).POST(
      json('http://localhost/api/ai/nutrition/feedback', { date: TODAY, nutrition: { caloriesKcal: 1800 }, mealCount: 3 }),
    ),
  },
  {
    name: 'consultation messages (AI 相談)',
    method: 'POST',
    file: 'src/app/api/ai/consultation/sessions/[sessionId]/messages/route.ts',
    kind: 'reject',
    setup: () => {
      h.state.single.ai_consultation_sessions = { id: SESSION_ID, user_id: USER, status: 'active', context_snapshot: {} };
    },
    // 相談の本体 (1,400 行) を作り物の DB で最後まで流すと、送る前に別の理由で止まりうる。
    // 判定のすぐあとで AI のクライアントを作るので、それを「送る口を開けた」回数として数える
    sends: () => h.getFastLLMClient.mock.calls.length + aiSendCount(),
    refundOnInsertFailure: { table: 'ai_consultation_messages', feature: 'consultation' },
    call: async () => (await import('@/app/api/ai/consultation/sessions/[sessionId]/messages/route')).POST(
      json(`http://localhost/api/ai/consultation/sessions/${SESSION_ID}/messages`, { message: 'こんにちは' }),
      { params: { sessionId: SESSION_ID } },
    ),
  },
  {
    name: 'consultation summarize (相談の要約)',
    method: 'POST',
    file: 'src/app/api/ai/consultation/sessions/[sessionId]/summarize/route.ts',
    kind: 'reject',
    setup: () => {
      h.state.single.ai_consultation_sessions = { id: SESSION_ID, user_id: USER, status: 'active', context_snapshot: {} };
      h.state.rows.ai_consultation_messages = [
        { role: 'user', content: '体重を減らしたい', created_at: '2026-10-10T00:00:00Z', is_important: false },
        { role: 'assistant', content: '一緒に考えましょう', created_at: '2026-10-10T00:01:00Z', is_important: false },
      ];
    },
    call: async () => (await import('@/app/api/ai/consultation/sessions/[sessionId]/summarize/route')).POST(
      json(`http://localhost/api/ai/consultation/sessions/${SESSION_ID}/summarize`, {}),
      { params: { sessionId: SESSION_ID } },
    ),
  },
  {
    name: 'consultation close (相談を閉じる。要約だけ省く)',
    method: 'POST',
    file: 'src/app/api/ai/consultation/sessions/[sessionId]/close/route.ts',
    kind: 'skip',
    setup: () => {
      h.state.single.ai_consultation_sessions = { id: SESSION_ID, user_id: USER, status: 'active', context_snapshot: {} };
      h.state.rows.ai_consultation_messages = [
        { role: 'user', content: '体重を減らしたい', created_at: '2026-10-10T00:00:00Z', is_important: false },
        { role: 'assistant', content: '一緒に考えましょう', created_at: '2026-10-10T00:01:00Z', is_important: false },
      ];
    },
    call: async () => (await import('@/app/api/ai/consultation/sessions/[sessionId]/close/route')).POST(
      json(`http://localhost/api/ai/consultation/sessions/${SESSION_ID}/close`, {}),
      { params: { sessionId: SESSION_ID } },
    ),
    savedWrite: { table: 'ai_consultation_sessions', op: 'update' },
  },
  {
    name: 'consultation execute: generate_day_menu (献立の生成のアクション)',
    method: 'POST',
    file: 'src/app/api/ai/consultation/actions/[actionId]/execute/route.ts',
    kind: 'reject',
    setup: () => {
      h.state.single.ai_action_logs = {
        id: 'action-1',
        action_type: 'generate_day_menu',
        action_params: { date: TODAY },
        status: 'pending',
        ai_consultation_sessions: { user_id: USER },
      };
    },
    sends: () => h.runConsultationAction.mock.calls.length,
    call: async () => (await import('@/app/api/ai/consultation/actions/[actionId]/execute/route')).POST(
      json('http://localhost/api/ai/consultation/actions/action-1/execute', {}),
      { params: { actionId: 'action-1' } },
    ),
  },
  {
    name: 'consultation execute: update_meal (AI へ送らないアクション)',
    method: 'POST',
    file: 'src/app/api/ai/consultation/actions/[actionId]/execute/route.ts',
    kind: 'pass',
    setup: () => {
      h.state.single.ai_action_logs = {
        id: 'action-2',
        action_type: 'update_meal',
        action_params: { mealId: MEAL_ID },
        status: 'pending',
        ai_consultation_sessions: { user_id: USER },
      };
    },
    // AI へは送らないアクションなので、AI の送り口は 0 のまま、アクションの実行 (runConsultationAction) は進む
    call: async () => (await import('@/app/api/ai/consultation/actions/[actionId]/execute/route')).POST(
      json('http://localhost/api/ai/consultation/actions/action-2/execute', {}),
      { params: { actionId: 'action-2' } },
    ),
  },
  {
    name: 'menu/day/regenerate (1 日の献立の作り直し)',
    method: 'POST',
    file: 'src/app/api/ai/menu/day/regenerate/route.ts',
    kind: 'reject',
    refundOnInsertFailure: { table: 'weekly_menu_requests', feature: 'menu_generation' },
    setup: () => {
      h.state.single.user_daily_meals = { id: 'day-1', day_date: TODAY };
    },
    call: async () => (await import('@/app/api/ai/menu/day/regenerate/route')).POST(
      json('http://localhost/api/ai/menu/day/regenerate', { dailyMealId: 'day-1' }),
    ),
  },
  {
    name: 'menu/meal/generate (1 食の献立の作成)',
    method: 'POST',
    file: 'src/app/api/ai/menu/meal/generate/route.ts',
    kind: 'reject',
    refundOnInsertFailure: { table: 'weekly_menu_requests', feature: 'menu_generation' },
    setup: () => {
      h.state.single.user_daily_meals = { id: 'day-1', day_date: TODAY };
    },
    call: async () => (await import('@/app/api/ai/menu/meal/generate/route')).POST(
      json('http://localhost/api/ai/menu/meal/generate', { dayDate: TODAY, mealType: 'dinner' }),
    ),
  },
  {
    name: 'menu/meal/regenerate (1 食の献立の作り直し)',
    method: 'POST',
    file: 'src/app/api/ai/menu/meal/regenerate/route.ts',
    kind: 'reject',
    refundOnInsertFailure: { table: 'weekly_menu_requests', feature: 'menu_generation' },
    setup: () => {
      h.state.single.planned_meals = {
        id: MEAL_ID,
        meal_type: 'dinner',
        daily_meal_id: 'day-1',
        is_completed: false,
        user_daily_meals: { id: 'day-1', day_date: TODAY, user_id: USER },
      };
    },
    call: async () => (await import('@/app/api/ai/menu/meal/regenerate/route')).POST(
      json('http://localhost/api/ai/menu/meal/regenerate', { mealId: MEAL_ID }),
    ),
  },
  {
    name: 'menu/v4/generate (献立の作成 V4)',
    method: 'POST',
    file: 'src/app/api/ai/menu/v4/generate/route.ts',
    kind: 'reject',
    refundOnInsertFailure: { table: 'weekly_menu_requests', feature: 'menu_generation' },
    call: async () => (await import('@/app/api/ai/menu/v4/generate/route')).POST(
      json('http://localhost/api/ai/menu/v4/generate', { targetSlots: [{ date: TODAY, mealType: 'dinner' }] }),
    ),
  },
  {
    name: 'menu/v5/generate (献立の作成 V5。キューに積む)',
    method: 'POST',
    file: 'src/app/api/ai/menu/v5/generate/route.ts',
    kind: 'reject',
    refundOnInsertFailure: { table: 'weekly_menu_requests', feature: 'menu_generation' },
    // この route は AI へ送らず、キュー (weekly_menu_requests) に積むだけ (積んだ行は cron が Edge Function へ渡す)。
    // 未同意なら積まないことを、キューへの書き込みの回数で確かめる
    sends: () => h.state.writes.filter((w) => w.table === 'weekly_menu_requests' && w.op === 'insert').length + aiSendCount(),
    call: async () => (await import('@/app/api/ai/menu/v5/generate/route')).POST(
      json('http://localhost/api/ai/menu/v5/generate', { targetSlots: [{ date: TODAY, mealType: 'dinner' }] }),
    ),
  },
  {
    name: 'menu/weekly/request (週間献立の作成)',
    method: 'POST',
    file: 'src/app/api/ai/menu/weekly/request/route.ts',
    kind: 'reject',
    refundOnInsertFailure: { table: 'weekly_menu_requests', feature: 'menu_generation' },
    call: async () => (await import('@/app/api/ai/menu/weekly/request/route')).POST(
      json('http://localhost/api/ai/menu/weekly/request', { startDate: TODAY }),
    ),
  },
  {
    name: 'health/checkups POST (健康診断の保存 + AI のレビュー)',
    method: 'POST',
    file: 'src/app/api/health/checkups/route.ts',
    kind: 'skip',
    setup: () => {
      h.state.single.health_checkups = { id: 'checkup-1', user_id: USER, checkup_date: TODAY, hba1c: 5.6 };
    },
    call: async () => (await import('@/app/api/health/checkups/route')).POST(
      json('http://localhost/api/health/checkups', { checkup_date: TODAY, hba1c: 5.6 }) as never,
    ),
    savedWrite: { table: 'health_checkups', op: 'upsert' },
  },
  {
    name: 'health/blood-tests POST (血液検査の保存 + AI のレビュー)',
    method: 'POST',
    file: 'src/app/api/health/blood-tests/route.ts',
    kind: 'skip',
    setup: () => {
      h.state.single.blood_test_results = { id: 'blood-1', user_id: USER, test_date: TODAY, hba1c: 5.6 };
    },
    call: async () => (await import('@/app/api/health/blood-tests/route')).POST(
      json('http://localhost/api/health/blood-tests', { test_date: TODAY, hba1c: 5.6 }) as never,
    ),
    savedWrite: { table: 'blood_test_results', op: 'insert' },
  },
  {
    name: 'health/insights POST (健康のインサイト)',
    method: 'POST',
    file: 'src/app/api/health/insights/route.ts',
    kind: 'reject',
    setup: () => {
      h.state.rows.health_records = [
        { record_date: TODAY, weight: 60, systolic_bp: 120, diastolic_bp: 80, sleep_hours: 7, mood_score: 3 },
        { record_date: TODAY, weight: 60.2, systolic_bp: 121, diastolic_bp: 79, sleep_hours: 7, mood_score: 3 },
      ];
    },
    call: async () => (await import('@/app/api/health/insights/route')).POST(
      json('http://localhost/api/health/insights', { analysisType: 'weekly' }) as never,
    ),
  },
  {
    name: 'shopping-list/regenerate (買い物リストの作成 → Edge Function)',
    method: 'POST',
    file: 'src/app/api/shopping-list/regenerate/route.ts',
    kind: 'reject',
    refundOnInsertFailure: { table: 'shopping_list_requests', feature: 'shopping_list' },
    call: async () => (await import('@/app/api/shopping-list/regenerate/route')).POST(
      json('http://localhost/api/shopping-list/regenerate', { startDate: TODAY, endDate: TODAY }),
    ),
  },
  {
    name: 'cron/process-menu-queue (キューの献立の作成 → Edge Function)',
    method: 'GET',
    file: 'src/app/api/cron/process-menu-queue/route.ts',
    kind: 'skip',
    setup: () => {
      h.state.rpc.claim_menu_request = { id: 'req-1', user_id: USER, attempt_count: 1, current_step: 1, generated_data: {} };
    },
    call: async () => (await import('@/app/api/cron/process-menu-queue/route')).GET(
      new Request('http://localhost/api/cron/process-menu-queue', { headers: { Authorization: 'Bearer cron' } }),
    ),
    // cron は止めた行を失敗にして 200 { skipped, code } を返す (Vercel の cron を赤くしない)
    savedWrite: { table: 'weekly_menu_requests', op: 'update' },
  },
];

beforeAll(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (AI_URL_PATTERN.test(url)) h.aiFetch(url);
      return new Response(JSON.stringify({ choices: [{ message: { content: '{}' } }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }),
  );
});

afterAll(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

beforeEach(() => {
  h.state.rows = {};
  h.state.single = {};
  // AI の利用回数の判定 (#1149) は、既定で「許可 (上限に数えて 1 回目)」を返す
  h.state.rpc = { consume_ai_usage: CONSUME_ALLOWED_ROW };
  h.state.writes = [];
  h.state.rpcCalls = [];
  h.state.rpcArgs = [];
  h.state.failInsert = new Set();
  for (const fn of [
    h.fastLLMCreate,
    h.getFastLLMClient,
    h.generateGeminiJson,
    h.genaiGenerateContent,
    h.functionsInvoke,
    h.callV4,
    h.callV5,
    h.runConsultationAction,
    h.aiFetch,
    h.rpcMark,
  ]) {
    fn.mockClear();
  }
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://project.supabase.test');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-role-key');
  vi.stubEnv('OPENAI_API_KEY', 'test-openai-key');
});

describe('表の網羅: 送る手前で判定する API Route は、AI へ送るハンドラごとに表に行がある', () => {
  it('ENFORCED_ROUTES の AI へ送るハンドラ (一覧の usage が noAi でないもの) の全件に、少なくとも 1 行ある (表に行の無いハンドラを足すと落ちる)', () => {
    const covered = new Set(ROUTE_CASES.map((c) => `${c.method} ${c.file}`));
    const required = Object.entries(ENFORCED_ROUTES).flatMap(([file, entry]) =>
      Object.entries(entry.handlers)
        .filter(([, usage]) => usage && !('noAi' in usage))
        .map(([method]) => `${method} ${file}`),
    );
    expect(required.filter((key) => !covered.has(key))).toEqual([]);
  });

  it('表の行は、すべて ENFORCED_ROUTES にあるハンドラを指す', () => {
    expect(ROUTE_CASES.filter((c) => !ENFORCED_ROUTES[c.file]?.handlers[c.method]).map((c) => `${c.method} ${c.file}`)).toEqual([]);
  });
});

const sendsOf = (c: RouteCase) => (c.sends ? c.sends() : aiSendCount());

/** AI の利用回数の判定と記録をした回数 (consume_ai_usage の rpc。#1177 / #1149) */
const usageRecords = () => h.state.rpcCalls.filter((name) => name === 'consume_ai_usage').length;
/** consume_ai_usage に渡した機能名 */
const consumedFeatures = () =>
  h.state.rpcCalls.flatMap((name, i) => (name === 'consume_ai_usage' ? [String(h.state.rpcArgs[i]?.p_feature)] : []));

/**
 * 同意済みのとき、このハンドラが記録する回数 (#1177。一覧 tests/helpers/ai-consent-enforced-paths.ts の usage の列から決める)。
 * record なら 1 回の操作で 1 回。recordedBy (ライブラリ・キューに積む route が記録する) なら、このハンドラ自身は 0 回
 */
const expectedRecords = (c: RouteCase) => {
  const usage = ENFORCED_ROUTES[c.file]?.handlers[c.method];
  return usage && 'record' in usage ? 1 : 0;
};

/**
 * 利用回数の判定と記録 (consume_ai_usage の rpc) が、AI へ送る口 (全部) のどれよりも先に呼ばれたか (#1177: 記録 → 送信の順)。
 * 順番は、ソースの文字ではなく、実際に route を動かして呼ばれた順番で確かめる (ここが Next.js の順番の検査の本体)
 */
function recordedBeforeEverySend(): { ok: boolean; detail: string } {
  const recordOrders = h.rpcMark.mock.calls.flatMap(([name], i) => (name === 'consume_ai_usage' ? [h.rpcMark.mock.invocationCallOrder[i]] : []));
  const senders = {
    fastLLM: h.fastLLMCreate,
    gemini: h.generateGeminiJson,
    genai: h.genaiGenerateContent,
    functionsInvoke: h.functionsInvoke,
    generateMenuV4: h.callV4,
    generateMenuV5: h.callV5,
    fetch: h.aiFetch,
  };
  const sendOrders = Object.entries(senders).flatMap(([label, fn]) => fn.mock.invocationCallOrder.map((order) => ({ label, order })));
  const firstRecord = Math.min(...recordOrders);
  const early = sendOrders.filter((send) => send.order < firstRecord).map((send) => send.label);
  return { ok: recordOrders.length > 0 && early.length === 0, detail: `記録する前に送った口: ${early.join(', ') || 'なし'} / 記録した回数: ${recordOrders.length}` };
}

async function run(c: RouteCase, mode: ConsentMode): Promise<Response> {
  h.state.consentMode = mode;
  c.setup?.();
  return c.call();
}

async function bodyOf(res: Response): Promise<Record<string, unknown>> {
  return (await res.clone().json().catch(() => ({}))) as Record<string, unknown>;
}

describe.each(ROUTE_CASES.filter((c) => c.kind === 'reject'))('止める経路: $name', (c) => {
  it.each(DENIED_MODES)('同意が %s: AI へ 1 回も送らず、止めた応答 (403 / 503 とコード) を返す', async (mode) => {
    const res = await run(c, mode);
    expect(sendsOf(c), JSON.stringify(aiSendBreakdown())).toBe(0);
    const expected = EXPECTED_DENIAL[mode as Exclude<ConsentMode, 'granted'>];
    expect(res.status).toBe(expected.status);
    expect((await bodyOf(res)).code).toBe(expected.code);
    // #1177: 同意が無くて止めた操作は、AI の利用回数に記録しない (同意の判定 → 記録 → 送信の順)
    expect(usageRecords(), h.state.rpcCalls.join(', ')).toBe(0);
  });

  it('同意済み: AI へ送る (この行の 0 回が空振りでないことの確かめ)。AI の利用回数は 1 回の操作で 1 回だけ、AI へ送るより前に記録する', async () => {
    const res = await run(c, 'granted');
    expect(res.status).not.toBe(403);
    expect(sendsOf(c), JSON.stringify(aiSendBreakdown())).toBeGreaterThanOrEqual(1);
    // AI のキュー (weekly_menu_requests / meal_image_jobs) へは、利用者のクライアントで書かない (#1465。利用者からは書けない)
    expect(userClientQueueWrites(), JSON.stringify(userClientQueueWrites())).toEqual([]);
    expect(usageRecords(), h.state.rpcCalls.join(', ')).toBe(expectedRecords(c));
    if (expectedRecords(c) > 0) {
      const order = recordedBeforeEverySend();
      expect(order.ok, order.detail).toBe(true);
    }
  });
});

describe.each(ROUTE_CASES.filter((c) => c.kind === 'skip'))('AI の部分だけ省く経路: $name', (c) => {
  it.each(DENIED_MODES)('同意が %s: AI へ 1 回も送らず、保存・集計はして、aiSkipped で知らせる', async (mode) => {
    const res = await run(c, mode);
    expect(sendsOf(c), JSON.stringify(aiSendBreakdown())).toBe(0);
    expect(res.status).toBe(200);
    const body = await bodyOf(res);
    const expected = EXPECTED_DENIAL[mode as Exclude<ConsentMode, 'granted'>];
    // cron は { skipped, code }、ほかは aiSkipped
    expect(body.aiSkipped ?? body.code).toBe(expected.code);
    if (c.savedWrite) {
      expect(h.state.writes.some((w) => w.table === c.savedWrite?.table && w.op === c.savedWrite?.op), JSON.stringify(h.state.writes)).toBe(true);
    }
    // #1177: AI の部分を省いた操作は、AI の利用回数に記録しない (保存・集計だけでは記録しない)
    expect(usageRecords(), h.state.rpcCalls.join(', ')).toBe(0);
  });

  it('同意済み: AI へ送り、aiSkipped は付かない。AI の利用回数は 1 回の操作で 1 回だけ、AI へ送るより前に記録する', async () => {
    const res = await run(c, 'granted');
    expect(sendsOf(c), JSON.stringify(aiSendBreakdown())).toBeGreaterThanOrEqual(1);
    const body = await bodyOf(res);
    expect(body.aiSkipped).toBeUndefined();
    expect(body.skipped).toBeUndefined();
    expect(usageRecords(), h.state.rpcCalls.join(', ')).toBe(expectedRecords(c));
    if (expectedRecords(c) > 0) {
      const order = recordedBeforeEverySend();
      expect(order.ok, order.detail).toBe(true);
    }
  });
});

describe.each(ROUTE_CASES.filter((c) => c.kind === 'pass'))('同意と関係なく AI へ送らない分岐: $name', (c) => {
  it.each(CONSENT_MODES)('同意が %s: 止めずに進み、AI へは送らない', async (mode) => {
    const res = await run(c, mode);
    expect(aiSendCount(), JSON.stringify(aiSendBreakdown())).toBe(0);
    expect(res.status).toBe(200);
    const body = await bodyOf(res);
    expect(body.code).not.toBe(AI_CONSENT_REQUIRED_CODE);
    expect(body.code).not.toBe(AI_CONSENT_CHECK_FAILED_CODE);
    if (c.savedWrite) {
      expect(h.state.writes.some((w) => w.table === c.savedWrite?.table && w.op === c.savedWrite?.op)).toBe(true);
    }
    // #1177: AI へ送らない操作は、AI の利用回数に記録しない
    expect(usageRecords(), h.state.rpcCalls.join(', ')).toBe(0);
  });
});

describe('consultation execute: AI へ送らないアクションは、未同意でも実行する', () => {
  it.each(DENIED_MODES)('同意が %s: update_meal は実行される (runConsultationAction が呼ばれる)', async (mode) => {
    h.state.consentMode = mode;
    h.state.single.ai_action_logs = {
      id: 'action-2',
      action_type: 'update_meal',
      action_params: { mealId: MEAL_ID },
      status: 'pending',
      ai_consultation_sessions: { user_id: USER },
    };
    const { POST } = await import('@/app/api/ai/consultation/actions/[actionId]/execute/route');
    const res = await POST(json('http://localhost/api/ai/consultation/actions/action-2/execute', {}), { params: { actionId: 'action-2' } });
    expect(res.status).toBe(200);
    expect(h.runConsultationAction).toHaveBeenCalledTimes(1);
  });
});

// ─────────────────────────────────────────────
// #1149 AI の利用回数の上限
// ─────────────────────────────────────────────

/** 一覧の usage (record のときだけ) */
const usageOf = (c: RouteCase) => {
  const usage = ENFORCED_ROUTES[c.file]?.handlers[c.method];
  return usage && 'record' in usage ? usage : null;
};
const LIMIT_CASES = ROUTE_CASES.filter((c) => c.kind !== 'pass' && usageOf(c) && !c.unmetered);

describe('表の網羅 (#1149): 数える (record) ハンドラは、どれも上限の行がある', () => {
  it('ENFORCED_ROUTES の record のハンドラ (上限に数える機能があるもの) の全件に、上限で止める行がある', () => {
    const covered = new Set(LIMIT_CASES.map((c) => `${c.method} ${c.file}`));
    const required = Object.entries(ENFORCED_ROUTES).flatMap(([file, entry]) =>
      Object.entries(entry.handlers)
        .filter(([, usage]) => usage && 'record' in usage && usage.record.some((f) => isMeteredAiFeature(f)))
        .map(([method]) => `${method} ${file}`),
    );
    expect(required.filter((key) => !covered.has(key))).toEqual([]);
  });
});

describe.each(LIMIT_CASES)('上限に達していたら (#1149): $name', (c) => {
  it('一覧の onLimit どおりに止める。AI へ 1 回も送らない', async () => {
    h.state.rpc.consume_ai_usage = CONSUME_DENIED_ROW;
    const res = await run(c, 'granted');
    const body = await bodyOf(res);

    expect(usageRecords(), h.state.rpcCalls.join(', ')).toBe(1);
    // AI の送り口は 1 回も呼ばない (表の sends は、行によっては「送る口を開けた」(クライアントを作った) も数えるので、ここでは送り口だけを数える。
    // キューに積む行は、下の「キューに積まない」で見る)
    expect(aiSendCount(), JSON.stringify(aiSendBreakdown())).toBe(0);
    expect(h.state.rpcCalls).not.toContain('refund_ai_usage');
    const onLimit = usageOf(c)!.onLimit;
    if (onLimit === 'reject') {
      expect(res.status).toBe(429);
      expect(body).toMatchObject({ code: 'AI_DAILY_LIMIT', limit: CONSUME_DENIED_ROW.limit, error: aiDailyLimitMessage(CONSUME_DENIED_ROW.limit) });
      expect(Number(res.headers.get('Retry-After'))).toBeGreaterThan(0);
      expect(body.retryAfter).toBe(Number(res.headers.get('Retry-After')));
      // キューに積まない (積んだあとの処理は数えないので、積む前に止める)
      expect(h.state.writes.filter((w) => (AI_QUEUE_TABLES as readonly string[]).includes(w.table) && w.op === 'insert')).toEqual([]);
    } else {
      expect(onLimit).toBe('skipAi');
      expect(res.status).toBe(200);
      expect(body.aiSkipped).toBe('AI_DAILY_LIMIT');
      if (c.savedWrite) {
        expect(h.state.writes.some((w) => w.table === c.savedWrite?.table && w.op === c.savedWrite?.op), JSON.stringify(h.state.writes)).toBe(true);
      }
    }
  });
});

describe.each(ROUTE_CASES.filter((c) => c.unmetered))('画面を開くと自動で呼ばれる経路 (#1149): $name', (c) => {
  it('上限に数えない機能 (nutrition_advice_auto) で 1 回数え、AI へ送る (開くだけで今日の回数が減らない)', async () => {
    const res = await run(c, 'granted');
    expect(res.status).toBe(200);
    expect(consumedFeatures()).toEqual(['nutrition_advice_auto']);
    expect(isMeteredAiFeature('nutrition_advice_auto')).toBe(false);
    expect(sendsOf(c), JSON.stringify(aiSendBreakdown())).toBeGreaterThanOrEqual(1);
  });
});

describe.each(ROUTE_CASES.filter((c) => c.refundOnInsertFailure))('生成のリクエストの行を作れなかったら (#1149): $name', (c) => {
  it('AI へ送らず、数えた 1 回を、数えた日で戻す (refund_ai_usage)', async () => {
    const { table, feature } = c.refundOnInsertFailure!;
    h.state.failInsert.add(table);
    const res = await run(c, 'granted');

    expect(res.status).toBeGreaterThanOrEqual(500);
    // AI の送り口は 1 回も呼ばない (失敗した insert も書き込みとして残るので、表の sends ではなく送り口だけを数える)
    expect(aiSendCount(), JSON.stringify(aiSendBreakdown())).toBe(0);
    expect(consumedFeatures()).toEqual([feature]);
    const refunds = h.state.rpcCalls.flatMap((name, i) => (name === 'refund_ai_usage' ? [h.state.rpcArgs[i]] : []));
    expect(refunds).toEqual([{ p_user_id: USER, p_feature: feature, p_usage_date: CONSUME_ALLOWED_ROW.usage_date }]);
  });
});

describe('consultation execute (#1149): 献立の生成のアクションが上限で止まったら', () => {
  it('429 AI_DAILY_LIMIT を返し、アクションを pending のまま残す (ai_action_logs を書き換えない)', async () => {
    h.state.consentMode = 'granted';
    h.state.single.ai_action_logs = {
      id: 'action-1',
      action_type: 'generate_day_menu',
      action_params: { date: TODAY },
      status: 'pending',
      ai_consultation_sessions: { user_id: USER },
    };
    const denied = { allowed: false as const, limit: 10, used: 10, usageDate: '2026-10-11' };
    h.runConsultationAction.mockResolvedValueOnce({
      success: false,
      result: { error: aiDailyLimitMessage(10), code: 'AI_DAILY_LIMIT' },
      aiDailyLimit: denied,
    } as never);
    const { POST } = await import('@/app/api/ai/consultation/actions/[actionId]/execute/route');
    const res = await POST(json('http://localhost/api/ai/consultation/actions/action-1/execute', {}), { params: { actionId: 'action-1' } });

    expect(res.status).toBe(429);
    expect(await bodyOf(res)).toMatchObject({ code: 'AI_DAILY_LIMIT', limit: 10 });
    expect(h.state.writes.filter((w) => w.table === 'ai_action_logs')).toEqual([]);
  });
});

describe('究極モード (#1149): 1 回の操作は 1 回と数える', () => {
  it.each([
    ['menu/v5/generate', async () => (await import('@/app/api/ai/menu/v5/generate/route')).POST(
      json('http://localhost/api/ai/menu/v5/generate', { targetSlots: [{ date: TODAY, mealType: 'dinner' }], ultimateMode: true }),
    )],
    ['menu/weekly/request', async () => (await import('@/app/api/ai/menu/weekly/request/route')).POST(
      json('http://localhost/api/ai/menu/weekly/request', { startDate: TODAY, ultimateMode: true }),
    )],
  ] as const)('%s: ultimateMode でも consume_ai_usage は 1 回 (menu_generation)', async (_label, call) => {
    h.state.consentMode = 'granted';
    const res = await call();
    expect(res.status).toBeLessThan(400);
    expect(consumedFeatures()).toEqual(['menu_generation']);
  });
});
