// @vitest-environment node
//
// Edge Function の本体を読み込むので node 環境で動かす (jsdom では Edge Runtime の型宣言の import を空のモジュールに差し替えられない)
/**
 * T15 (#1154) 未同意の利用者のデータを、外国の AI 事業者へ送らない: Edge Functions
 *
 * Edge Functions は利用者の JWT で直接呼べる (Supabase の URL と anon key は公開されている) ので、
 * Next.js の API Route とは別に、関数の中でも送る手前で判定する (tests/helpers/ai-consent-enforced-paths.ts の ENFORCED_EDGE)。
 *
 * 1. 構文木の検査 (全件): 判定の呼び出しの結果で「止めて返す」if があり、その if より前に AI へ送る呼び出しが無い。
 *    判定を呼ぶだけで結果を無視する・送ったあとで判定する・条件を反転する (if (!denied) / if (x.allowed) return) と落ちる。
 *    (#1149) AI の利用回数の上限の判定 (consumeEdgeAiUsage) も同じ形で見る: 数える関数の全部で、結果で止める if
 *    (if (!x.allowed) return ...) があり、その if より前に AI へ送る呼び出しが無い。
 * 2. 実際のハンドラ (代表の 6 本。AI の送り口の形と、利用回数の記録の形 (#1177) が違うものを選ぶ):
 *    Deno.serve に渡された関数へ要求を流し、同意の状況ごとに AI へ送った回数と、利用回数の判定と記録 (consumeEdgeAiUsage) の回数・順番を見る。
 *    判定 (_shared/ai-consent-guard.ts / _shared/ai-consent.ts) は差し替えず、Supabase のクライアントと AI の送り口だけを作り物にする。
 *    記録は「同意の判定 → 記録 → 送信」の順 (#1177)。順番はソースの文字ではなく、呼ばれた順番で確かめる。
 *    (#1149) 上限に達していたら、AI へ 1 回も送らずに 429 AI_DAILY_LIMIT を返す (CORS ヘッダーつき)。
 *    献立生成と買い物リストの直接の JWT の経路 (generate-menu-v4 / v5・regenerate-shopping-list-v2) は tests/ai-usage-direct-jwt-edge.test.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AI_CONSENT_CHECK_FAILED_CODE,
  AI_CONSENT_PROVIDERS,
  AI_CONSENT_REQUIRED_CODE,
  AI_CONSENT_TABLE,
  AI_CONSENT_VERSION,
} from '../supabase/functions/_shared/ai-consent';
import { ENFORCED_EDGE } from './helpers/ai-consent-enforced-paths';
import { removeMutants, writeMutant } from './helpers/mutant-module';
import type { AiUsageResult } from '../supabase/functions/_shared/ai-daily-limit';
import { AI_USAGE_ALLOWED, AI_USAGE_DENIED } from './helpers/ai-usage-mock';

// Edge Runtime の型宣言だけの import (node_modules に無い)。中身は無いので空のモジュールにする
vi.mock("@supabase/functions-js/edge-runtime.d.ts", () => ({}));

const ROOT = path.resolve(__dirname, '..');
const FUNCTIONS_DIR = path.join(ROOT, 'supabase/functions');

// ─────────────────────────────────────────────
// 1. 構文木の検査
// ─────────────────────────────────────────────

/** 判定の部品 (_shared/ai-consent-guard.ts) の関数と、AI の利用回数の上限の判定 (_shared/ai-usage.ts。#1149) */
const GUARD_CALLEES = new Set(['requireAiConsentForUser', 'requireAiConsent', 'checkAiConsent', 'consumeEdgeAiUsage']);
/** 結果の .allowed で止める (if (!x.allowed) return) 形の判定 */
const ALLOWED_FLAG_GUARDS = new Set(['checkAiConsent', 'consumeEdgeAiUsage']);

/**
 * AI へ送る (または送る処理を始める) 呼び出しの名前。判定の if より前に、同じ関数の中でこれらを呼んではいけない。
 * fetch / fetchWithRetry は AI 以外の宛先もあるが、判定より前に外へ出る呼び出しが無いことを求める (判定は外へ出る前に置く)
 */
const SEND_CALLEES = new Set([
  'fetch',
  'fetchWithRetry',
  // 献立生成の続きの工程を呼ぶ (呼んだ先が AI へ送る。_shared/ai-consent-guard.ts)
  'invokeMenuContinuation',
  'generateGeminiJson',
  'generateContent',
  'callV4FastLLM',
  'create',
  'invoke',
  'runNutritionPipeline',
]);

interface GuardSite {
  callee: string;
  line: number;
  /** 判定の結果で止めて返す if の行 (無ければ null) */
  stopLine: number | null;
  /** 判定の if より前で、同じ関数の中にある送る呼び出し */
  sendsBefore: string[];
}

function calleeName(expr: ts.LeftHandSideExpression): string | null {
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
  return null;
}

function enclosingFunction(node: ts.Node): ts.Node {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (ts.isFunctionLike(current)) return current;
    current = current.parent;
  }
  return node.getSourceFile();
}

/** 判定の呼び出しの結果を受けた変数の名前 (const x = await guard(...) / x = guard(...))。await で受け直した名前も辿る */
function resultNames(call: ts.CallExpression, fn: ts.Node): Set<string> {
  const names = new Set<string>();
  let node: ts.Node = call.parent;
  if (ts.isAwaitExpression(node)) node = node.parent;
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) names.add(node.name.text);
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(node.left)) {
    names.add(node.left.text);
  }
  // const decision = await consent; のように受け直したもの
  let grew = true;
  while (grew) {
    grew = false;
    const visit = (n: ts.Node) => {
      if (
        ts.isVariableDeclaration(n) &&
        ts.isIdentifier(n.name) &&
        n.initializer &&
        ts.isAwaitExpression(n.initializer) &&
        ts.isIdentifier(n.initializer.expression) &&
        names.has(n.initializer.expression.text) &&
        !names.has(n.name.text)
      ) {
        names.add(n.name.text);
        grew = true;
      }
      ts.forEachChild(n, visit);
    };
    visit(fn);
  }
  return names;
}

/** if の条件が「判定の結果で止める」形か: requireAiConsent* なら if (denied)、checkAiConsent なら if (!decision.allowed) */
function isStopCondition(cond: ts.Expression, callee: string, names: Set<string>): boolean {
  if (ALLOWED_FLAG_GUARDS.has(callee)) {
    return (
      ts.isPrefixUnaryExpression(cond) &&
      cond.operator === ts.SyntaxKind.ExclamationToken &&
      ts.isPropertyAccessExpression(cond.operand) &&
      cond.operand.name.text === 'allowed' &&
      ts.isIdentifier(cond.operand.expression) &&
      names.has(cond.operand.expression.text)
    );
  }
  return ts.isIdentifier(cond) && names.has(cond.text);
}

function thenReturns(statement: ts.Statement): boolean {
  if (ts.isReturnStatement(statement)) return true;
  return ts.isBlock(statement) && statement.statements.some((s) => ts.isReturnStatement(s));
}

function analyzeGuards(file: string, text: string = fs.readFileSync(file, 'utf8')): GuardSite[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const sites: GuardSite[] = [];
  const lineOf = (pos: number) => source.getLineAndCharacterOfPosition(pos).line + 1;

  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const callee = calleeName(node.expression);
      if (callee && GUARD_CALLEES.has(callee)) {
        const fn = enclosingFunction(node);
        const names = resultNames(node, fn);
        let stop: ts.IfStatement | null = null;
        const findStop = (n: ts.Node) => {
          if (stop) return;
          if (ts.isIfStatement(n) && n.getStart() > node.getStart() && isStopCondition(n.expression, callee, names) && thenReturns(n.thenStatement)) {
            stop = n;
            return;
          }
          ts.forEachChild(n, findStop);
        };
        findStop(fn);
        const stopNode = stop as ts.IfStatement | null;
        const limit = stopNode ? stopNode.getStart() : Number.POSITIVE_INFINITY;
        const sendsBefore: string[] = [];
        const findSends = (n: ts.Node) => {
          if (n !== fn && ts.isFunctionLike(n)) return; // 中で定義した別の関数は、この関数の流れではない
          if (ts.isCallExpression(n) && n.getStart() < limit) {
            const name = calleeName(n.expression);
            if (name && SEND_CALLEES.has(name)) sendsBefore.push(`${name} (${lineOf(n.getStart())} 行目)`);
          }
          ts.forEachChild(n, findSends);
        };
        ts.forEachChild(fn, findSends);
        sites.push({ callee, line: lineOf(node.getStart()), stopLine: stopNode ? lineOf(stopNode.getStart()) : null, sendsBefore });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return sites;
}

describe('Edge Functions: 判定の結果で止める if が、送る呼び出しより前にある (構文木)', () => {
  it.each(Object.keys(ENFORCED_EDGE))('%s', (name) => {
    const sites = analyzeGuards(path.join(FUNCTIONS_DIR, name, 'index.ts'));
    expect(sites.filter((site) => site.callee !== 'consumeEdgeAiUsage').length, '判定を呼んでいない').toBeGreaterThan(0);
    // #1149: 一覧で数える (record) 関数は、上限の判定 (consumeEdgeAiUsage) を呼ぶ
    const usage = ENFORCED_EDGE[name].usage;
    expect(sites.some((site) => site.callee === 'consumeEdgeAiUsage'), '上限の判定 (consumeEdgeAiUsage) を呼んでいない').toBe('record' in usage);
    for (const site of sites) {
      expect(site.stopLine, `${site.callee} (${site.line} 行目) の結果で止めて返す if が無い`).not.toBeNull();
      expect(site.sendsBefore, `${site.callee} (${site.line} 行目) の判定より前に送っている`).toEqual([]);
    }
  });

  it('検査そのものの確かめ: 結果を無視する・送ったあとで判定する・条件を反転する、を見つける', () => {
    const check = (body: string) => analyzeGuards('index.ts', body)[0];
    const ignored = check(`Deno.serve(async () => { const denied = await requireAiConsentForUser("u", {}); await fetch("https://api.x.ai"); });`);
    expect(ignored.stopLine).toBeNull();
    const late = check(`Deno.serve(async () => { await fetch("https://api.x.ai"); const denied = await requireAiConsentForUser("u", {}); if (denied) return denied; });`);
    expect(late.sendsBefore).toEqual(['fetch (1 行目)']);
    const inverted = check(`Deno.serve(async () => { const c = await checkAiConsent(db, "u"); if (c.allowed) return deny(c); });`);
    expect(inverted.stopLine).toBeNull();
    const negatedDenied = check(`Deno.serve(async () => { const denied = await requireAiConsentForUser("u", {}); if (!denied) return denied; });`);
    expect(negatedDenied.stopLine).toBeNull();
    const ok = check(`Deno.serve(async () => { const c = await checkAiConsent(db, "u"); if (!c.allowed) { return deny(c); } await fetch("x"); });`);
    expect(ok.stopLine).not.toBeNull();
    expect(ok.sendsBefore).toEqual([]);
    // #1149: 上限の判定も同じ形で見る (結果を無視する・送ったあとで判定する・条件を反転する、を見つける)
    expect(check(`Deno.serve(async (req) => { const u = await consumeEdgeAiUsage(req, "u", "consultation"); await fetch("https://api.x.ai"); });`).stopLine).toBeNull();
    expect(check(`Deno.serve(async (req) => { await fetch("https://api.x.ai"); const u = await consumeEdgeAiUsage(req, "u", "consultation"); if (!u.allowed) return x(u); });`).sendsBefore).toEqual(['fetch (1 行目)']);
    expect(check(`Deno.serve(async (req) => { const u = await consumeEdgeAiUsage(req, "u", "consultation"); if (u.allowed) return x(u); });`).stopLine).toBeNull();
    const usageOk = check(`Deno.serve(async (req) => { const u = await consumeEdgeAiUsage(req, "u", "consultation"); if (!u.allowed) return x(u); await fetch("x"); });`);
    expect(usageOk.stopLine).not.toBeNull();
    expect(usageOk.sendsBefore).toEqual([]);
  });
});

// ─────────────────────────────────────────────
// 2. 実際のハンドラ
// ─────────────────────────────────────────────

const USER = '11111111-1111-4111-8111-111111111111';
type ConsentMode = 'none' | 'outdated' | 'failed' | 'granted';

const e = vi.hoisted(() => ({
  consentMode: 'none' as 'none' | 'outdated' | 'failed' | 'granted',
  fastLLMCreate: vi.fn(async () => ({ choices: [{ message: { content: '{"hint":"野菜を足しましょう","ingredients":["卵"]}' } }] })),
  generateGeminiJson: vi.fn(async () => ({ data: { weight: 60 }, model: 'test-model', rawText: '{}' })),
  analyzeWithEvidence: vi.fn(async () => ({ dishes: [], totalCalories: 0 })),
  /** global fetch のうち、AI 事業者へ送ったもの */
  aiFetch: vi.fn((_url: string) => undefined),
  // #1177 / #1149: AI 利用回数の上限の判定と記録 (DB を呼ぶ境目だけを差し替える。既定は許可)
  consumeEdgeAiUsage: vi.fn(async (_req: Request, _userId: string, _feature: string): Promise<AiUsageResult> => ({
    allowed: true,
    metered: true,
    usageDate: '2026-10-11',
    limit: 10,
    used: 1,
  })),
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

/** AI 事業者の宛先 (global fetch で数える) */
const AI_URL_PATTERN = /api\.openai\.com|generativelanguage\.googleapis\.com|api\.x\.ai|api\.perplexity\.ai|api\.aimlapi\.com/;

/** AI へ送る口の全部 (どれか 1 つでも、記録より先に呼ばれたら順番の誤り) */
const SENDERS = { fastLLM: e.fastLLMCreate, gemini: e.generateGeminiJson, nutritionPipeline: e.analyzeWithEvidence, fetch: e.aiFetch };

function aiSendCount(): number {
  return Object.values(SENDERS).reduce((sum, fn) => sum + fn.mock.calls.length, 0);
}

/** 記録 (consumeEdgeAiUsage) が、AI へ送る口のどれよりも先に呼ばれたか (#1177: 同意の判定 → 記録 → 送信) */
function recordedBeforeEverySend(): { ok: boolean; detail: string } {
  const recordOrders = e.consumeEdgeAiUsage.mock.invocationCallOrder;
  const firstRecord = Math.min(...recordOrders);
  const early = Object.entries(SENDERS).flatMap(([label, fn]) =>
    fn.mock.invocationCallOrder.filter((order) => order < firstRecord).map(() => label),
  );
  return {
    ok: recordOrders.length > 0 && early.length === 0,
    detail: `記録する前に送った口: ${early.join(', ') || 'なし'} / 記録した回数: ${recordOrders.length}`,
  };
}

function consentResult(): { data: unknown; error: unknown } {
  switch (e.consentMode) {
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

function fakeQuery(table: string): unknown {
  const result = () => (table === AI_CONSENT_TABLE ? consentResult() : { data: [], error: null });
  const builder: unknown = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === 'then') return (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(result()).then(res, rej);
        if (prop === 'single' || prop === 'maybeSingle') return () => Promise.resolve({ data: null, error: null });
        return () => builder;
      },
    },
  );
  return builder;
}

vi.mock('@supabase/supabase-js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@supabase/supabase-js')>()),
  createClient: () => ({
    auth: { getUser: async () => ({ data: { user: { id: USER } }, error: null }) },
    from: (table: string) => fakeQuery(table),
    rpc: async () => ({ data: [], error: null }),
    storage: {
      from: () => ({
        upload: async () => ({ data: { path: 'p' }, error: null }),
        getPublicUrl: () => ({ data: { publicUrl: 'https://storage.example.test/p.jpg' } }),
      }),
    },
  }),
}));
vi.mock('../supabase/functions/_shared/auth.ts', () => ({ requireAuth: vi.fn(async () => ({ userId: USER })) }));
vi.mock('../supabase/functions/_shared/db-logger.ts', () => ({
  createLogger: () => ({ ...e.logger, withUser: () => e.logger }),
  generateRequestId: () => 'req_test',
}));
vi.mock('../supabase/functions/_shared/fast-llm.ts', () => ({
  createFastLLMClient: () => ({ chat: { completions: { create: e.fastLLMCreate } } }),
  getFastLLMModel: () => 'test-model',
  getFastLLMApiKey: () => 'test-key',
  getFastLLMBaseUrl: () => 'https://api.x.ai/v1',
  getFastLLMChatCompletionsUrl: () => 'https://api.x.ai/v1/chat/completions',
  getFastLLMFetchHeaders: () => ({ 'Content-Type': 'application/json' }),
}));
vi.mock('../supabase/functions/_shared/gemini-json.ts', () => ({ generateGeminiJson: e.generateGeminiJson }));
vi.mock('../supabase/functions/_shared/nutrition-pipeline.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../supabase/functions/_shared/nutrition-pipeline.ts')>()),
  analyzeWithEvidence: e.analyzeWithEvidence,
}));
// LLM の使用量計測 (fetch を包んで DB へ書く) は、中身をそのまま実行するだけにする
vi.mock('../supabase/functions/_shared/llm-usage.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../supabase/functions/_shared/llm-usage.ts')>()),
  withOpenAIUsageContext: async <T,>(_ctx: unknown, fn: () => Promise<T>) => fn(),
  generateExecutionId: () => 'exec_test',
}));
vi.mock('../supabase/functions/_shared/ai-usage.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../supabase/functions/_shared/ai-usage.ts')>()),
  consumeEdgeAiUsage: e.consumeEdgeAiUsage,
}));

type Handler = (req: Request) => Promise<Response>;
const handlers: Record<string, Handler> = {};
const ORIGIN = 'https://homegohan.app';

const userRequest = (name: string, body: BodyInit, contentType: string | null = 'application/json') =>
  new Request(`http://localhost/functions/v1/${name}`, {
    method: 'POST',
    headers: { Authorization: 'Bearer user-token', Origin: ORIGIN, ...(contentType ? { 'Content-Type': contentType } : {}) },
    body,
  });

/**
 * 実際のハンドラを呼ぶ代表の関数。AI の送り口の形 (OpenAI 互換のクライアント・Gemini・栄養の解析・fetch) と、
 * 記録の形 (JWT を確かめた直後のブロック / directJwtUserId の if) の両方を含むように選ぶ。
 * どれも「未同意なら送らず記録しない・同意済みなら 1 回記録してから送る」を、呼ばれた順番で確かめる
 */
const EDGE_CASES: Array<{ name: string; load: () => Promise<unknown>; request: () => Request }> = [
  {
    name: 'analyze-fridge',
    load: () => import('../supabase/functions/analyze-fridge/index.ts'),
    request: () =>
      userRequest('analyze-fridge', JSON.stringify({ imageUrl: 'https://project.supabase.co/storage/v1/object/public/fridge-images/u1/fridge.jpg' })),
  },
  {
    name: 'analyze-health-photo',
    load: () => import('../supabase/functions/analyze-health-photo/index.ts'),
    request: () => {
      const form = new FormData();
      form.append('image_base64', 'aGVsbG8=');
      form.append('device_type', 'weight_scale');
      return userRequest('analyze-health-photo', form, null);
    },
  },
  {
    name: 'analyze-meal-photo',
    load: () => import('../supabase/functions/analyze-meal-photo/index.ts'),
    request: () => userRequest('analyze-meal-photo', JSON.stringify({ imageBase64: 'aGVsbG8=', mimeType: 'image/jpeg' })),
  },
  {
    name: 'generate-hint',
    load: () => import('../supabase/functions/generate-hint/index.ts'),
    request: () => userRequest('generate-hint', JSON.stringify({ cookRate: 50, avgCal: 1800 })),
  },
  {
    // fetch (fetchWithRetry) で送る形。AI へ送る処理は同じファイルのヘルパー関数 (callOpenAI) の中にある
    name: 'normalize-shopping-list',
    load: () => import('../supabase/functions/normalize-shopping-list/index.ts'),
    request: () => userRequest('normalize-shopping-list', JSON.stringify({ ingredients: [{ name: '卵', amount: '2個', count: 1 }] })),
  },
  {
    // JWT を確かめたブロックで directJwtUserId に代入し、あとの if (directJwtUserId) の中で記録する形
    name: 'knowledge-gpt',
    load: () => import('../supabase/functions/knowledge-gpt/index.ts'),
    request: () => userRequest('knowledge-gpt', JSON.stringify({ messages: [{ role: 'user', content: '夕食の相談' }] })),
  },
];

const ENV: Record<string, string> = {
  SUPABASE_URL: 'https://project.supabase.test',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
  SUPABASE_ANON_KEY: 'anon-key',
  XAI_API_KEY: 'test-xai-key',
  DATASET_EMBEDDING_API_KEY: 'test-embedding-key',
};

async function loadHandler(name: string, load: () => Promise<unknown>): Promise<void> {
  vi.stubGlobal('Deno', {
    serve: (fn: Handler) => {
      handlers[name] = fn;
    },
    env: { get: (key: string) => ENV[key] },
  });
  await load();
}

beforeAll(async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (AI_URL_PATTERN.test(url)) e.aiFetch(url);
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"items":[]}' } }], data: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }),
  );
  for (const c of EDGE_CASES) await loadHandler(c.name, c.load);
  const fetchStub = globalThis.fetch;
  vi.stubGlobal('Deno', { serve: () => undefined, env: { get: (key: string) => ENV[key] } });
  vi.stubGlobal('fetch', fetchStub);
});

afterAll(() => {
  vi.unstubAllGlobals();
  removeMutants();
});

beforeEach(() => {
  for (const fn of [...Object.values(SENDERS), e.consumeEdgeAiUsage]) fn.mockClear();
  e.consumeEdgeAiUsage.mockResolvedValue(AI_USAGE_ALLOWED);
});

const DENIED: Array<[ConsentMode, number, string]> = [
  ['none', 403, AI_CONSENT_REQUIRED_CODE],
  ['outdated', 403, AI_CONSENT_REQUIRED_CODE],
  ['failed', 503, AI_CONSENT_CHECK_FAILED_CODE],
];

describe.each(EDGE_CASES)('Edge Function $name (実際のハンドラ)', (c) => {
  it.each(DENIED)('同意が %s: AI へ 1 回も送らず、%i を返す。記録もしない', async (mode, status, code) => {
    e.consentMode = mode;
    const res = await handlers[c.name](c.request());
    expect(aiSendCount()).toBe(0);
    expect(res.status).toBe(status);
    await expect(res.json()).resolves.toMatchObject({ code });
    // ブラウザから読めるよう、許可したオリジンには CORS ヘッダーを付けたまま止める
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
    // #1177: 同意が無くて止めた呼び出しは、AI の利用回数に記録しない (同意の判定 → 記録 → 送信の順)
    expect(e.consumeEdgeAiUsage).not.toHaveBeenCalled();
  });

  it('同意済み: AI へ送る (上の 0 回が空振りでないことの確かめ)。記録は 1 回で、JWT の利用者と一覧の機能名で、AI へ送るより前', async () => {
    e.consentMode = 'granted';
    await handlers[c.name](c.request());
    expect(aiSendCount()).toBeGreaterThanOrEqual(1);
    expect(e.consumeEdgeAiUsage).toHaveBeenCalledTimes(1);
    const [req, userId, feature] = e.consumeEdgeAiUsage.mock.calls[0];
    expect(req).toBeInstanceOf(Request);
    expect(userId).toBe(USER);
    const usage = ENFORCED_EDGE[c.name].usage;
    expect('record' in usage ? usage.record : []).toContain(feature);
    const order = recordedBeforeEverySend();
    expect(order.ok, order.detail).toBe(true);
  });
});

describe.each(EDGE_CASES)('Edge Function $name: 上限に達していたら (#1149)', (c) => {
  it('AI へ 1 回も送らず、429 AI_DAILY_LIMIT を返す (CORS ヘッダーと Retry-After つき)', async () => {
    e.consentMode = 'granted';
    e.consumeEdgeAiUsage.mockResolvedValue(AI_USAGE_DENIED);

    const res = await handlers[c.name](c.request());

    expect(e.consumeEdgeAiUsage).toHaveBeenCalledTimes(1);
    expect(aiSendCount()).toBe(0);
    expect(res.status).toBe(429);
    await expect(res.json()).resolves.toMatchObject({ code: 'AI_DAILY_LIMIT', limit: AI_USAGE_DENIED.limit });
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
    expect(Number(res.headers.get('Retry-After'))).toBeGreaterThan(0);
  });
});

describe('回帰 (R3 指摘 1・4): Edge Function で、記録を AI へ送ったあとへ動かすと、上の順番の検査が落ちる', () => {
  it('normalize-shopping-list の記録を、AI への送信 (callOpenAI) のあとへ動かした写しでは、記録より先に送っている', async () => {
    const recordLines = /\n(\s*)const aiUsage = await consumeEdgeAiUsage\(req, authResult\.userId, "shopping_list"\);\n\s*if \(!aiUsage\.allowed\) return aiDailyLimitEdgeResponse\(aiUsage, corsHeaders\);\n/;
    const mutant = writeMutant('supabase/functions/normalize-shopping-list/index.ts', (source) => {
      const match = source.match(recordLines);
      if (!match) return source;
      const without = source.replace(recordLines, '\n');
      return without.replace(
        /(\n\s*const rawItems = await withOpenAIUsageContext\([\s\S]*?\n\s*\}\);\n)/,
        `$1${match[1]}await consumeEdgeAiUsage(req, authResult.userId, "shopping_list");\n`,
      );
    });
    await loadHandler('normalize-shopping-list:mutant', () => import(/* @vite-ignore */ mutant));
    e.consentMode = 'granted';
    await handlers['normalize-shopping-list:mutant'](userRequest('normalize-shopping-list', JSON.stringify({ ingredients: [{ name: '卵', count: 1 }] })));
    expect(e.consumeEdgeAiUsage).toHaveBeenCalledTimes(1);
    expect(recordedBeforeEverySend().ok).toBe(false);
  });
});
