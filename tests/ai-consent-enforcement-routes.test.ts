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

const USER = '11111111-1111-4111-8111-111111111111';
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
    writes: [] as Array<{ table: string; op: string; payload: unknown }>,
    /** 呼んだ rpc の名前 (AI 利用回数の記録 consume_ai_quota を数えるため。#1177) */
    rpcCalls: [] as string[],
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
  };
});

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
function makeQuery(table: string): unknown {
  const listResult = () =>
    table === AI_CONSENT_TABLE ? consentResult() : { data: h.state.rows[table] ?? [], error: null, count: (h.state.rows[table] ?? []).length };
  // 書き込みのあとの .select().single() は、書いた行を返す (読み取りの single の設定とは別)
  let written: Row | null = null;
  const singleResult = () => {
    if (table === AI_CONSENT_TABLE) return consentResult();
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
            h.state.writes.push({ table, op: String(prop), payload });
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

function makeSupabase() {
  return {
    auth: {
      getUser: async () => ({ data: { user: { id: USER, email: 'user@example.test' } }, error: null }),
      getSession: async () => ({ data: { session: { access_token: 'token' } }, error: null }),
    },
    from: (table: string) => makeQuery(table),
    rpc: async (name: string) => {
      h.state.rpcCalls.push(name);
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
  createClient: vi.fn(async () => makeSupabase()),
  getSupabaseAdmin: vi.fn(() => makeSupabase()),
}));
vi.mock('@supabase/supabase-js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@supabase/supabase-js')>()),
  createClient: vi.fn(() => makeSupabase()),
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
vi.mock('@/lib/menu-generation-feature-flags', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/menu-generation-feature-flags')>()),
  loadFeatureFlags: vi.fn(async () => ({})),
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
   * 同意済みのとき、この route 自身が AI の利用回数を数えないなら、その理由 (#1177)。
   * 既定 (省略) は「同意済みなら 1 回の操作で 1 回だけ数える」
   */
  notCountedHere?: string;
}

const ROUTE_CASES: RouteCase[] = [
  {
    name: 'analyze-fridge (冷蔵庫の写真)',
    file: 'src/app/api/ai/analyze-fridge/route.ts',
    kind: 'reject',
    call: async () => (await import('@/app/api/ai/analyze-fridge/route')).POST(
      json('http://localhost/api/ai/analyze-fridge', { imageBase64: 'aGVsbG8=', mimeType: 'image/jpeg' }),
    ),
  },
  {
    name: 'analyze-health-checkup (健康診断の写真)',
    file: 'src/app/api/ai/analyze-health-checkup/route.ts',
    kind: 'reject',
    call: async () => (await import('@/app/api/ai/analyze-health-checkup/route')).POST(
      json('http://localhost/api/ai/analyze-health-checkup', { imageBase64: 'aGVsbG8=', mimeType: 'image/jpeg' }),
    ),
  },
  {
    name: 'analyze-meal-photo (食事の写真 → Edge Function)',
    file: 'src/app/api/ai/analyze-meal-photo/route.ts',
    kind: 'reject',
    call: async () => (await import('@/app/api/ai/analyze-meal-photo/route')).POST(
      json('http://localhost/api/ai/analyze-meal-photo', { imageBase64: 'aGVsbG8=', mimeType: 'image/jpeg' }),
    ),
  },
  {
    name: 'analyze-weight-scale (体重計の写真 → Edge Function)',
    file: 'src/app/api/ai/analyze-weight-scale/route.ts',
    kind: 'reject',
    call: async () => (await import('@/app/api/ai/analyze-weight-scale/route')).POST(
      json('http://localhost/api/ai/analyze-weight-scale', { image: 'aGVsbG8=', mimeType: 'image/jpeg' }),
    ),
  },
  {
    name: 'classify-photo (写真の種類の判別)',
    file: 'src/app/api/ai/classify-photo/route.ts',
    kind: 'reject',
    call: async () => (await import('@/app/api/ai/classify-photo/route')).POST(
      json('http://localhost/api/ai/classify-photo', { imageBase64: LARGE_IMAGE_BASE64, mimeType: 'image/jpeg' }),
    ),
  },
  {
    name: 'image/generate (料理の画像の作成)',
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
  },
  {
    name: 'nutrition-analysis POST (献立の変更 → generate-menu-v4)',
    file: 'src/app/api/ai/nutrition-analysis/route.ts',
    kind: 'reject',
    call: async () => (await import('@/app/api/ai/nutrition-analysis/route')).POST(
      json('http://localhost/api/ai/nutrition-analysis', { targetDate: TODAY, targetMealType: 'dinner', prompt: '野菜を増やす' }),
    ),
  },
  {
    name: 'nutrition/feedback: 新しく作る (OpenAI)',
    file: 'src/app/api/ai/nutrition/feedback/route.ts',
    kind: 'reject',
    setup: () => {
      h.state.single.nutrition_feedback_cache = null;
    },
    call: async () => (await import('@/app/api/ai/nutrition/feedback/route')).POST(
      json('http://localhost/api/ai/nutrition/feedback', { date: TODAY, nutrition: { caloriesKcal: 1800 }, mealCount: 3 }),
    ),
  },
  {
    name: 'nutrition/feedback: 作成中のコメントの状態を返すだけ (AI へ送らない)',
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
    file: 'src/app/api/ai/consultation/sessions/[sessionId]/messages/route.ts',
    kind: 'reject',
    setup: () => {
      h.state.single.ai_consultation_sessions = { id: SESSION_ID, user_id: USER, status: 'active', context_snapshot: {} };
    },
    // 相談の本体 (1,400 行) を作り物の DB で最後まで流すと、送る前に別の理由で止まりうる。
    // 判定のすぐあとで AI のクライアントを作るので、それを「送る口を開けた」回数として数える
    sends: () => h.getFastLLMClient.mock.calls.length + aiSendCount(),
    call: async () => (await import('@/app/api/ai/consultation/sessions/[sessionId]/messages/route')).POST(
      json(`http://localhost/api/ai/consultation/sessions/${SESSION_ID}/messages`, { message: 'こんにちは' }),
      { params: { sessionId: SESSION_ID } },
    ),
  },
  {
    name: 'consultation summarize (相談の要約)',
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
    notCountedHere: 'AI を使うアクションは runConsultationAction (ライブラリ) が数える。このテストでは runConsultationAction を差し替えている',
    call: async () => (await import('@/app/api/ai/consultation/actions/[actionId]/execute/route')).POST(
      json('http://localhost/api/ai/consultation/actions/action-1/execute', {}),
      { params: { actionId: 'action-1' } },
    ),
  },
  {
    name: 'consultation execute: update_meal (AI へ送らないアクション)',
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
    file: 'src/app/api/ai/menu/day/regenerate/route.ts',
    kind: 'reject',
    setup: () => {
      h.state.single.user_daily_meals = { id: 'day-1', day_date: TODAY };
    },
    call: async () => (await import('@/app/api/ai/menu/day/regenerate/route')).POST(
      json('http://localhost/api/ai/menu/day/regenerate', { dailyMealId: 'day-1' }),
    ),
  },
  {
    name: 'menu/meal/generate (1 食の献立の作成)',
    file: 'src/app/api/ai/menu/meal/generate/route.ts',
    kind: 'reject',
    setup: () => {
      h.state.single.user_daily_meals = { id: 'day-1', day_date: TODAY };
    },
    call: async () => (await import('@/app/api/ai/menu/meal/generate/route')).POST(
      json('http://localhost/api/ai/menu/meal/generate', { dayDate: TODAY, mealType: 'dinner' }),
    ),
  },
  {
    name: 'menu/meal/regenerate (1 食の献立の作り直し)',
    file: 'src/app/api/ai/menu/meal/regenerate/route.ts',
    kind: 'reject',
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
    file: 'src/app/api/ai/menu/v4/generate/route.ts',
    kind: 'reject',
    call: async () => (await import('@/app/api/ai/menu/v4/generate/route')).POST(
      json('http://localhost/api/ai/menu/v4/generate', { targetSlots: [{ date: TODAY, mealType: 'dinner' }] }),
    ),
  },
  {
    name: 'menu/v5/generate (献立の作成 V5。キューに積む)',
    file: 'src/app/api/ai/menu/v5/generate/route.ts',
    kind: 'reject',
    // この route は AI へ送らず、キュー (weekly_menu_requests) に積むだけ (積んだ行は cron が Edge Function へ渡す)。
    // 未同意なら積まないことを、キューへの書き込みの回数で確かめる
    sends: () => h.state.writes.filter((w) => w.table === 'weekly_menu_requests' && w.op === 'insert').length + aiSendCount(),
    call: async () => (await import('@/app/api/ai/menu/v5/generate/route')).POST(
      json('http://localhost/api/ai/menu/v5/generate', { targetSlots: [{ date: TODAY, mealType: 'dinner' }] }),
    ),
  },
  {
    name: 'menu/weekly/request (週間献立の作成)',
    file: 'src/app/api/ai/menu/weekly/request/route.ts',
    kind: 'reject',
    call: async () => (await import('@/app/api/ai/menu/weekly/request/route')).POST(
      json('http://localhost/api/ai/menu/weekly/request', { startDate: TODAY }),
    ),
  },
  {
    name: 'health/checkups POST (健康診断の保存 + AI のレビュー)',
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
    file: 'src/app/api/shopping-list/regenerate/route.ts',
    kind: 'reject',
    call: async () => (await import('@/app/api/shopping-list/regenerate/route')).POST(
      json('http://localhost/api/shopping-list/regenerate', { startDate: TODAY, endDate: TODAY }),
    ),
  },
  {
    name: 'cron/process-menu-queue (キューの献立の作成 → Edge Function)',
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
    notCountedHere: 'キューに積む route (POST /api/ai/menu/v5/generate) が数え済み (AI_QUOTA_EXEMPT)',
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
  h.state.rpc = {};
  h.state.writes = [];
  h.state.rpcCalls = [];
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
  ]) {
    fn.mockClear();
  }
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://project.supabase.test');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-role-key');
  vi.stubEnv('OPENAI_API_KEY', 'test-openai-key');
});

describe('表の網羅: 送る手前で判定する API Route は、すべて表に行がある', () => {
  it('ENFORCED_ROUTES の全件に、少なくとも 1 行ある (表に行の無い経路を足すと落ちる)', () => {
    const covered = new Set(ROUTE_CASES.map((c) => c.file));
    expect(Object.keys(ENFORCED_ROUTES).filter((file) => !covered.has(file))).toEqual([]);
  });

  it('表の行は、すべて ENFORCED_ROUTES にある経路を指す', () => {
    expect(ROUTE_CASES.map((c) => c.file).filter((file) => !(file in ENFORCED_ROUTES))).toEqual([]);
  });
});

const sendsOf = (c: RouteCase) => (c.sends ? c.sends() : aiSendCount());

/** AI の利用回数を数えた回数 (consume_ai_quota の rpc。#1177) */
const quotaCounts = () => h.state.rpcCalls.filter((name) => name === 'consume_ai_quota').length;

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
    // #1177: 同意が無くて止めた操作は、AI の利用回数に数えない (同意の判定 → 記録 → 送信の順)
    expect(quotaCounts(), h.state.rpcCalls.join(', ')).toBe(0);
  });

  it('同意済み: AI へ送る (この行の 0 回が空振りでないことの確かめ)。AI の利用回数は 1 回の操作で 1 回だけ数える', async () => {
    const res = await run(c, 'granted');
    expect(res.status).not.toBe(403);
    expect(sendsOf(c), JSON.stringify(aiSendBreakdown())).toBeGreaterThanOrEqual(1);
    expect(quotaCounts(), h.state.rpcCalls.join(', ')).toBe(c.notCountedHere ? 0 : 1);
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
    // #1177: AI の部分を省いた操作は、AI の利用回数に数えない (保存・集計だけでは数えない)
    expect(quotaCounts(), h.state.rpcCalls.join(', ')).toBe(0);
  });

  it('同意済み: AI へ送り、aiSkipped は付かない。AI の利用回数は 1 回の操作で 1 回だけ数える', async () => {
    const res = await run(c, 'granted');
    expect(sendsOf(c), JSON.stringify(aiSendBreakdown())).toBeGreaterThanOrEqual(1);
    const body = await bodyOf(res);
    expect(body.aiSkipped).toBeUndefined();
    expect(body.skipped).toBeUndefined();
    expect(quotaCounts(), h.state.rpcCalls.join(', ')).toBe(c.notCountedHere ? 0 : 1);
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
    // #1177: AI へ送らない操作は、AI の利用回数に数えない
    expect(quotaCounts(), h.state.rpcCalls.join(', ')).toBe(0);
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
