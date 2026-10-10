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
 * 2. 実際のハンドラ (代表の 3 本: analyze-fridge = xAI、analyze-health-photo = Google、generate-hint = xAI):
 *    Deno.serve に渡された関数へ要求を流し、同意の状況ごとに AI のクライアントの呼び出し回数を数える。
 *    判定 (_shared/ai-consent-guard.ts / _shared/ai-consent.ts) は差し替えず、Supabase のクライアントだけを作り物にする。
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

// Edge Runtime の型宣言だけの import (node_modules に無い)。中身は無いので空のモジュールにする
vi.mock("@supabase/functions-js/edge-runtime.d.ts", () => ({}));

const ROOT = path.resolve(__dirname, '..');
const FUNCTIONS_DIR = path.join(ROOT, 'supabase/functions');

// ─────────────────────────────────────────────
// 1. 構文木の検査
// ─────────────────────────────────────────────

/** 判定の部品 (_shared/ai-consent-guard.ts) の関数 */
const GUARD_CALLEES = new Set(['requireAiConsentForUser', 'requireAiConsent', 'checkAiConsent']);

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
  if (callee === 'checkAiConsent') {
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
    expect(sites.length, '判定を呼んでいない').toBeGreaterThan(0);
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
  // #1177: AI 利用回数の記録 (DB を呼ぶ境目だけを差し替える。429 の応答を作る関数は本物)
  consumeEdgeAiQuota: vi.fn(async () => ({ allowed: true, remaining: null })),
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

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
}));
vi.mock('../supabase/functions/_shared/gemini-json.ts', () => ({ generateGeminiJson: e.generateGeminiJson }));
vi.mock('../supabase/functions/_shared/quota.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../supabase/functions/_shared/quota.ts')>()),
  consumeEdgeAiQuota: e.consumeEdgeAiQuota,
}));

type Handler = (req: Request) => Promise<Response>;
const handlers: Record<string, Handler> = {};
const ORIGIN = 'https://homegohan.app';

const EDGE_CASES: Array<{
  name: string;
  load: () => Promise<unknown>;
  request: () => Request;
  sends: () => number;
  /** AI へ送る口 (数えたあとで呼ばれることを確かめる。#1177) */
  sender: { mock: { invocationCallOrder: number[] } };
}> = [
  {
    name: 'analyze-fridge',
    load: () => import('../supabase/functions/analyze-fridge/index.ts'),
    request: () =>
      new Request('http://localhost/functions/v1/analyze-fridge', {
        method: 'POST',
        headers: { Authorization: 'Bearer user-token', 'Content-Type': 'application/json', Origin: ORIGIN },
        body: JSON.stringify({ imageUrl: 'https://project.supabase.co/storage/v1/object/public/fridge-images/u1/fridge.jpg' }),
      }),
    sends: () => e.fastLLMCreate.mock.calls.length,
    sender: e.fastLLMCreate,
  },
  {
    name: 'analyze-health-photo',
    load: () => import('../supabase/functions/analyze-health-photo/index.ts'),
    request: () => {
      const form = new FormData();
      form.append('image_base64', 'aGVsbG8=');
      form.append('device_type', 'weight_scale');
      return new Request('http://localhost/functions/v1/analyze-health-photo', {
        method: 'POST',
        headers: { Authorization: 'Bearer user-token', Origin: ORIGIN },
        body: form,
      });
    },
    sends: () => e.generateGeminiJson.mock.calls.length,
    sender: e.generateGeminiJson,
  },
  {
    name: 'generate-hint',
    load: () => import('../supabase/functions/generate-hint/index.ts'),
    request: () =>
      new Request('http://localhost/functions/v1/generate-hint', {
        method: 'POST',
        headers: { Authorization: 'Bearer user-token', 'Content-Type': 'application/json', Origin: ORIGIN },
        body: JSON.stringify({ cookRate: 50, avgCal: 1800 }),
      }),
    sends: () => e.fastLLMCreate.mock.calls.length,
    sender: e.fastLLMCreate,
  },
];

/** knowledge-gpt (AI 相談の Edge Function)。JWT を確かめたブロックで同意を判定してから、数える対象の利用者を決める形 (#1177) */
const KNOWLEDGE_GPT = {
  load: () => import('../supabase/functions/knowledge-gpt/index.ts'),
  request: () =>
    new Request('http://localhost/functions/v1/knowledge-gpt', {
      method: 'POST',
      headers: { Authorization: 'Bearer user-token', 'Content-Type': 'application/json', Origin: ORIGIN },
      body: JSON.stringify({ messages: [{ role: 'user', content: '夕食の相談' }] }),
    }),
};

const ENV: Record<string, string> = {
  SUPABASE_URL: 'https://project.supabase.test',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
  SUPABASE_ANON_KEY: 'anon-key',
};

beforeAll(async () => {
  for (const c of EDGE_CASES) {
    vi.stubGlobal('Deno', {
      serve: (fn: Handler) => {
        handlers[c.name] = fn;
      },
      env: { get: (key: string) => ENV[key] },
    });
    await c.load();
  }
  vi.stubGlobal('Deno', {
    serve: (fn: Handler) => {
      handlers['knowledge-gpt'] = fn;
    },
    env: { get: (key: string) => ENV[key] },
  });
  await KNOWLEDGE_GPT.load();
  vi.stubGlobal('Deno', { serve: () => undefined, env: { get: (key: string) => ENV[key] } });
});

afterAll(() => {
  vi.unstubAllGlobals();
});

beforeEach(() => {
  e.fastLLMCreate.mockClear();
  e.generateGeminiJson.mockClear();
  e.consumeEdgeAiQuota.mockClear();
});

const DENIED: Array<[ConsentMode, number, string]> = [
  ['none', 403, AI_CONSENT_REQUIRED_CODE],
  ['outdated', 403, AI_CONSENT_REQUIRED_CODE],
  ['failed', 503, AI_CONSENT_CHECK_FAILED_CODE],
];

describe.each(EDGE_CASES)('Edge Function $name (実際のハンドラ)', (c) => {
  it.each(DENIED)('同意が %s: AI のクライアントを 1 回も呼ばず、%i を返す', async (mode, status, code) => {
    e.consentMode = mode;
    const res = await handlers[c.name](c.request());
    expect(c.sends()).toBe(0);
    expect(res.status).toBe(status);
    await expect(res.json()).resolves.toMatchObject({ code });
    // ブラウザから読めるよう、許可したオリジンには CORS ヘッダーを付けたまま止める
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
    // #1177: 同意が無くて止めた呼び出しは、AI の利用回数に数えない (同意の判定 → 記録 → 送信の順)
    expect(e.consumeEdgeAiQuota).not.toHaveBeenCalled();
  });

  it('同意済み: AI のクライアントを呼ぶ (上の 0 回が空振りでないことの確かめ)。数えるのは 1 回で、AI へ送る前', async () => {
    e.consentMode = 'granted';
    await handlers[c.name](c.request());
    expect(c.sends()).toBeGreaterThanOrEqual(1);
    expect(e.consumeEdgeAiQuota).toHaveBeenCalledTimes(1);
    expect(e.consumeEdgeAiQuota.mock.calls[0][1]).toBe(USER);
    expect(e.consumeEdgeAiQuota.mock.invocationCallOrder[0]).toBeLessThan(c.sender.mock.invocationCallOrder[0]);
  });
});

describe('Edge Function knowledge-gpt (実際のハンドラ): 同意の判定 → 利用回数の記録 (#1177)', () => {
  it.each(DENIED)('同意が %s: 数えずに %i を返す', async (mode, status, code) => {
    e.consentMode = mode;
    const res = await handlers['knowledge-gpt'](KNOWLEDGE_GPT.request());
    expect(res.status).toBe(status);
    await expect(res.json()).resolves.toMatchObject({ code });
    expect(e.consumeEdgeAiQuota).not.toHaveBeenCalled();
  });

  it('同意済み: ユーザーの JWT で直接呼ばれたので、その利用者で 1 回数える (上の 0 回が空振りでないことの確かめ)', async () => {
    e.consentMode = 'granted';
    await handlers['knowledge-gpt'](KNOWLEDGE_GPT.request());
    expect(e.consumeEdgeAiQuota).toHaveBeenCalledTimes(1);
    expect(e.consumeEdgeAiQuota.mock.calls[0][1]).toBe(USER);
    expect(e.consumeEdgeAiQuota.mock.calls[0][2]).toBe('consultation');
  });
});
