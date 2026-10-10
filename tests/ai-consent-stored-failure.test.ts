// @vitest-environment node
//
// Edge Function の本体を読み込むので node 環境で動かす (jsdom では Edge Runtime の型宣言の import を空のモジュールに差し替えられない)
/**
 * T15 (#1154) 受け付けたあとに同意の判定で止めた失敗を、画面に「コード」ではなく人向けの文で残す (書く側)
 *
 * 献立の生成・買い物リストの作り直しは、受け付けたあと (キュー・続きの工程・Edge Function の呼び出し) にも同意を確かめ、
 * 未同意 (撤回済み) や判定を読めないときは送らずにリクエストの行を失敗にする。画面はその行の失敗の欄
 * (weekly_menu_requests.error_message / shopping_list_requests.result.error) をそのまま出すので、
 * 欄にはコード (AI_CONSENT_REQUIRED) ではなく人向けの文 (AI_CONSENT_REQUIRED_MESSAGE など。#1172) を書く。
 * 画面はこの文を見分けて同意画面へ案内する (読む側は tests/ai-consent-stored-failure-readers.test.ts)。
 *
 *   1. 共有の部品: 書く文・文の見分け・止めた応答の見分け
 *   2. 書く側の実際のハンドラ: generate-menu-v4 / generate-menu-v5 / regenerate-shopping-list-v2 の Edge Function が、
 *      止めたときに行へ書く値 (cron は tests/cron-process-menu-queue-ai-consent.test.ts)
 *   3. 続きの工程: 呼んだ先 (続きの工程) が止めたとき、呼ぶ側は再試行せず、例外も投げない
 *      (投げると、前の工程の catch が error_message を「triggerNextStep:... failed: 403 - {...}」で上書きしていた)
 *   4. Next.js から Edge Function を呼ぶ側: 呼んだ先が止めたとき、再試行せず、errorMessage を人向けの文にする
 *      (呼び出し元は markWeeklyMenuRequestFailed でこの値を error_message に書く。以前は状態コードと本文を書いていた)
 *   5. 構文木の検査: Edge Function が献立生成の Edge Function を呼び直す場所は、どれも 3 の部品 (invokeMenuContinuation) を使う
 */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AI_CONSENT_CHECK_FAILED_CODE,
  AI_CONSENT_CHECK_FAILED_MESSAGE,
  AI_CONSENT_CHECK_FAILED_STATUS,
  AI_CONSENT_PROVIDERS,
  AI_CONSENT_REQUIRED_CODE,
  AI_CONSENT_REQUIRED_MESSAGE,
  AI_CONSENT_REQUIRED_STATUS,
  AI_CONSENT_TABLE,
  AI_CONSENT_VERSION,
  aiConsentDeniedPayload,
  aiConsentDeniedStoredMessage,
  aiConsentDeniedStoredMessageOfResponse,
  aiConsentReasonOfStoredError,
  type AiConsentDecision,
} from '../supabase/functions/_shared/ai-consent';

// Edge Runtime の型宣言だけの import (node_modules に無い)。中身は無いので空のモジュールにする
vi.mock('@supabase/functions-js/edge-runtime.d.ts', () => ({}));

const NOT_CONSENTED: Extract<AiConsentDecision, { allowed: false }> = { allowed: false, reason: 'not_consented' };
const CHECK_FAILED: Extract<AiConsentDecision, { allowed: false }> = { allowed: false, reason: 'check_failed' };

/** 止めたときの応答の本文 (Edge Function / Next.js の API Route が返す JSON) */
const deniedBodyText = (decision: Extract<AiConsentDecision, { allowed: false }>) =>
  JSON.stringify(aiConsentDeniedPayload(decision).body);

// ─────────────────────────────────────────────
// 1. 共有の部品
// ─────────────────────────────────────────────

describe('共有の部品 (supabase/functions/_shared/ai-consent.ts)', () => {
  it('行に書く文は、応答の本文と同じ人向けの文で、コードではない', () => {
    expect(aiConsentDeniedStoredMessage(NOT_CONSENTED)).toBe(AI_CONSENT_REQUIRED_MESSAGE);
    expect(aiConsentDeniedStoredMessage(CHECK_FAILED)).toBe(AI_CONSENT_CHECK_FAILED_MESSAGE);
    for (const decision of [NOT_CONSENTED, CHECK_FAILED]) {
      expect(aiConsentDeniedStoredMessage(decision)).not.toMatch(/AI_CONSENT_[A-Z_]+/);
    }
  });

  it('書いた文を見分けられる (書く側と読む側が同じ定義を使う)', () => {
    expect(aiConsentReasonOfStoredError(aiConsentDeniedStoredMessage(NOT_CONSENTED))).toBe('consent_required');
    expect(aiConsentReasonOfStoredError(aiConsentDeniedStoredMessage(CHECK_FAILED))).toBe('check_failed');
  });

  it('ほかの失敗の文・コードそのもの・空・文字列でない値は見分けない', () => {
    for (const stored of ['stale_request_timeout', '中止しました', AI_CONSENT_REQUIRED_CODE, AI_CONSENT_CHECK_FAILED_CODE, '', null, undefined, 403]) {
      expect(aiConsentReasonOfStoredError(stored)).toBeNull();
    }
  });

  it('止めた応答 (403 + AI_CONSENT_REQUIRED / 503 + AI_CONSENT_CHECK_FAILED) から、行に書く文を返す', () => {
    expect(aiConsentDeniedStoredMessageOfResponse(AI_CONSENT_REQUIRED_STATUS, deniedBodyText(NOT_CONSENTED))).toBe(
      AI_CONSENT_REQUIRED_MESSAGE,
    );
    expect(aiConsentDeniedStoredMessageOfResponse(AI_CONSENT_CHECK_FAILED_STATUS, deniedBodyText(CHECK_FAILED))).toBe(
      AI_CONSENT_CHECK_FAILED_MESSAGE,
    );
  });

  it('止めた応答でないもの (状態コードとコードの組が違う・ほかの 403/503・JSON でない・空) は null', () => {
    expect(aiConsentDeniedStoredMessageOfResponse(AI_CONSENT_CHECK_FAILED_STATUS, deniedBodyText(NOT_CONSENTED))).toBeNull();
    expect(aiConsentDeniedStoredMessageOfResponse(AI_CONSENT_REQUIRED_STATUS, deniedBodyText(CHECK_FAILED))).toBeNull();
    expect(aiConsentDeniedStoredMessageOfResponse(403, JSON.stringify({ error: 'Forbidden' }))).toBeNull();
    expect(aiConsentDeniedStoredMessageOfResponse(503, 'Service Unavailable')).toBeNull();
    expect(aiConsentDeniedStoredMessageOfResponse(403, '')).toBeNull();
    expect(aiConsentDeniedStoredMessageOfResponse(null, deniedBodyText(NOT_CONSENTED))).toBeNull();
  });
});

// ─────────────────────────────────────────────
// 2. 書く側の実際のハンドラ (Edge Functions)
// ─────────────────────────────────────────────

const USER = '11111111-1111-4111-8111-111111111111';
const REQUEST_ID = '22222222-2222-4222-8222-222222222222';
const SERVICE_ROLE_KEY = 'service-role-key';

const e = vi.hoisted(() => ({
  consentMode: 'none' as 'none' | 'failed' | 'granted',
  updates: [] as Array<{ table: string; values: Record<string, unknown> }>,
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

function consentResult(): { data: unknown; error: unknown } {
  if (e.consentMode === 'granted') {
    return { data: AI_CONSENT_PROVIDERS.map((provider) => ({ provider, consented: true, policy_version: AI_CONSENT_VERSION })), error: null };
  }
  if (e.consentMode === 'failed') return { data: null, error: { message: 'connection refused' } };
  return { data: [], error: null };
}

/** Supabase のクエリの作り物。update の値を記録し、同意の表だけ consentResult を返す。行の持ち主は USER */
function fakeQuery(table: string): unknown {
  const result = () => (table === AI_CONSENT_TABLE ? consentResult() : { data: null, error: null });
  const builder: unknown = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === 'then') return (res: (v: unknown) => unknown, rej: (err: unknown) => unknown) => Promise.resolve(result()).then(res, rej);
        if (prop === 'single' || prop === 'maybeSingle') return () => Promise.resolve({ data: { user_id: USER, current_step: 1 }, error: null });
        if (prop === 'update') {
          return (values: Record<string, unknown>) => {
            e.updates.push({ table, values });
            return builder;
          };
        }
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
    rpc: async () => ({ data: null, error: null }),
  }),
}));
vi.mock('../supabase/functions/_shared/db-logger.ts', () => ({
  createLogger: () => ({ ...e.logger, withUser: () => e.logger }),
  generateRequestId: () => 'req_test',
}));

type Handler = (req: Request) => Promise<Response>;
const handlers: Record<string, Handler> = {};

const ENV: Record<string, string> = {
  SUPABASE_URL: 'https://project.supabase.test',
  SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE_KEY,
  SUPABASE_ANON_KEY: 'anon-key',
};

const WRITERS: Array<{ name: string; table: string; load: () => Promise<unknown>; body: Record<string, unknown>; stored: (values: Record<string, unknown>) => unknown }> = [
  {
    name: 'generate-menu-v4',
    table: 'weekly_menu_requests',
    load: () => import('../supabase/functions/generate-menu-v4/index.ts'),
    body: { requestId: REQUEST_ID, userId: USER, targetSlots: [{ date: '2026-10-10', mealType: 'dinner' }] },
    stored: (values) => values.error_message,
  },
  {
    name: 'generate-menu-v5',
    table: 'weekly_menu_requests',
    load: () => import('../supabase/functions/generate-menu-v5/index.ts'),
    body: { requestId: REQUEST_ID, userId: USER, targetSlots: [{ date: '2026-10-10', mealType: 'dinner' }] },
    stored: (values) => values.error_message,
  },
  {
    name: 'regenerate-shopping-list-v2',
    table: 'shopping_list_requests',
    load: () => import('../supabase/functions/regenerate-shopping-list-v2/index.ts'),
    body: { requestId: REQUEST_ID, userId: USER, startDate: '2026-10-10', endDate: '2026-10-11' },
    stored: (values) => (values.result as { error?: unknown } | undefined)?.error,
  },
];

beforeAll(async () => {
  for (const w of WRITERS) {
    vi.stubGlobal('Deno', {
      serve: (fn: Handler) => {
        handlers[w.name] = fn;
      },
      env: { get: (key: string) => ENV[key] },
    });
    await w.load();
  }
  vi.stubGlobal('Deno', { serve: () => undefined, env: { get: (key: string) => ENV[key] } });
});

afterAll(() => {
  vi.unstubAllGlobals();
});

beforeEach(() => {
  e.updates = [];
});

const request = (name: string, body: Record<string, unknown>) =>
  new Request(`http://localhost/functions/v1/${name}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${SERVICE_ROLE_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

describe.each(WRITERS)('Edge Function $name: 止めたときにリクエストの行へ書く値', (w) => {
  it.each([
    ['none', AI_CONSENT_REQUIRED_STATUS, AI_CONSENT_REQUIRED_CODE, AI_CONSENT_REQUIRED_MESSAGE],
    ['failed', AI_CONSENT_CHECK_FAILED_STATUS, AI_CONSENT_CHECK_FAILED_CODE, AI_CONSENT_CHECK_FAILED_MESSAGE],
  ] as const)('同意が %s: 応答は %i + コード、行の失敗の欄には人向けの文を書く', async (mode, status, code, message) => {
    e.consentMode = mode;
    const res = await handlers[w.name](request(w.name, w.body));

    expect(res.status).toBe(status);
    await expect(res.json()).resolves.toMatchObject({ code });
    const failed = e.updates.filter((u) => u.table === w.table && u.values.status === 'failed');
    expect(failed).toHaveLength(1);
    expect(w.stored(failed[0].values)).toBe(message);
    // 画面がそのまま出す欄に、英字のコードを書かない
    expect(JSON.stringify(failed[0].values)).not.toContain(code);
  });
});

// ─────────────────────────────────────────────
// 3. 続きの工程 (Edge Function が自分を _continue で呼び直す)
// ─────────────────────────────────────────────

describe('invokeMenuContinuation (supabase/functions/_shared/ai-consent-guard.ts)', () => {
  const fetchMock = vi.fn();
  let invokeMenuContinuation: typeof import('../supabase/functions/_shared/ai-consent-guard.ts').invokeMenuContinuation;
  let isAiConsentDeniedFetchError: typeof import('../supabase/functions/_shared/ai-consent-guard.ts').isAiConsentDeniedFetchError;
  const URL_ = 'https://project.supabase.test/functions/v1/generate-menu-v4';
  const INIT = { method: 'POST', body: '{}' };
  /** 再試行の待ち時間を短くする (本番は network-retry.ts の既定) */
  const OPTS = { label: 'triggerNextStep:test', retries: 2, baseDelayMs: 1, timeoutMs: 1000 };

  beforeAll(async () => {
    ({ invokeMenuContinuation, isAiConsentDeniedFetchError } = await import('../supabase/functions/_shared/ai-consent-guard.ts'));
  });

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  it.each([
    ['未同意 (403)', AI_CONSENT_REQUIRED_STATUS, NOT_CONSENTED],
    ['判定を読めない (503)', AI_CONSENT_CHECK_FAILED_STATUS, CHECK_FAILED],
  ] as const)('呼んだ先が同意の判定で止めた (%s): 再試行せず、例外も投げずに false を返す', async (_label, status, decision) => {
    fetchMock.mockImplementation(async () => new Response(deniedBodyText(decision), { status }));
    await expect(invokeMenuContinuation(URL_, INIT, OPTS)).resolves.toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('呼べたら true', async () => {
    fetchMock.mockImplementation(async () => new Response('{"status":"processing"}', { status: 202 }));
    await expect(invokeMenuContinuation(URL_, INIT, OPTS)).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('同意と関係ない 503 は、これまでどおり再試行してから例外を投げる (上の検査の空振りでないことの確かめ)', async () => {
    fetchMock.mockImplementation(async () => new Response('Service Unavailable', { status: 503 }));
    await expect(invokeMenuContinuation(URL_, INIT, OPTS)).rejects.toThrow('triggerNextStep:test failed: 503');
    expect(fetchMock).toHaveBeenCalledTimes(OPTS.retries + 1);
  });

  it('fetchWithRetry の例外は、状態コードと本文を持ち、止めた応答かを見分けられる', async () => {
    const { fetchWithRetry } = await import('../supabase/functions/_shared/network-retry.ts');
    fetchMock.mockImplementation(async () => new Response(deniedBodyText(NOT_CONSENTED), { status: AI_CONSENT_REQUIRED_STATUS }));
    const error = await fetchWithRetry(URL_, INIT, { ...OPTS, retries: 0 }).catch((err: unknown) => err);
    expect(error).toMatchObject({ status: AI_CONSENT_REQUIRED_STATUS, body: deniedBodyText(NOT_CONSENTED) });
    expect(isAiConsentDeniedFetchError(error)).toBe(true);
    expect(isAiConsentDeniedFetchError(new Error('boom'))).toBe(false);
  });
});

// ─────────────────────────────────────────────
// 4. Next.js から Edge Function を呼ぶ側
// ─────────────────────────────────────────────

describe('Next.js から献立生成の Edge Function を呼ぶ側 (src/lib/generate-menu-v4-retry.ts / generate-menu-v5-retry.ts)', () => {
  const fetchMock = vi.fn();
  const RETRY = { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 100, timeoutMs: 1_000 };
  const params = { supabaseUrl: 'https://project.supabase.test', serviceRoleKey: SERVICE_ROLE_KEY, payload: { requestId: REQUEST_ID }, retry: RETRY };

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  it.each([
    ['未同意 (403)', AI_CONSENT_REQUIRED_STATUS, NOT_CONSENTED, AI_CONSENT_REQUIRED_MESSAGE],
    ['判定を読めない (503)', AI_CONSENT_CHECK_FAILED_STATUS, CHECK_FAILED, AI_CONSENT_CHECK_FAILED_MESSAGE],
  ] as const)('v4 / v5: 呼んだ先が止めた (%s) ら再試行せず、errorMessage は人向けの文', async (_label, status, decision, message) => {
    const { callGenerateMenuV4WithRetry } = await import('../src/lib/generate-menu-v4-retry');
    const { callGenerateMenuV5WithRetry } = await import('../src/lib/generate-menu-v5-retry');
    for (const call of [callGenerateMenuV4WithRetry, callGenerateMenuV5WithRetry]) {
      fetchMock.mockReset();
      fetchMock.mockImplementation(async () => new Response(deniedBodyText(decision), { status }));
      await expect(call(params)).resolves.toEqual({ ok: false, attempts: 1, status, errorMessage: message });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  });

  it('同意と関係ない 503 は、これまでどおり再試行し、errorMessage は内部の文 (上の検査の空振りでないことの確かめ)', async () => {
    const { callGenerateMenuV4WithRetry } = await import('../src/lib/generate-menu-v4-retry');
    fetchMock.mockImplementation(async () => new Response('Service Unavailable', { status: 503 }));
    const result = await callGenerateMenuV4WithRetry({ ...params, retry: { ...RETRY, maxAttempts: 2 } });
    expect(result).toMatchObject({ ok: false, attempts: 2, status: 503 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('supabase.functions.invoke 経由 (AI 相談の実行): 呼んだ先が止めたら再試行せず、errorMessage は人向けの文', async () => {
    const { invokeGenerateMenuV4WithRetry } = await import('../src/lib/generate-menu-v4-retry');
    const invoke = vi.fn(async () => ({
      data: null,
      error: {
        message: 'Edge Function returned a non-2xx status code',
        context: new Response(deniedBodyText(NOT_CONSENTED), { status: AI_CONSENT_REQUIRED_STATUS }),
      },
    }));
    await expect(invokeGenerateMenuV4WithRetry({ invoke, retry: RETRY })).resolves.toEqual({
      ok: false,
      attempts: 1,
      status: AI_CONSENT_REQUIRED_STATUS,
      errorMessage: AI_CONSENT_REQUIRED_MESSAGE,
    });
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('markWeeklyMenuRequestFailed は、その文をそのまま error_message に書く (詰めたり切ったりしても変わらない)', async () => {
    const { markWeeklyMenuRequestFailed } = await import('../src/lib/generate-menu-v4-retry');
    const writes: Array<Record<string, unknown>> = [];
    const supabase = {
      from: () => ({
        update: (values: Record<string, unknown>) => {
          writes.push(values);
          return { eq: async () => ({ error: null }) };
        },
      }),
    };
    for (const message of [AI_CONSENT_REQUIRED_MESSAGE, AI_CONSENT_CHECK_FAILED_MESSAGE]) {
      await markWeeklyMenuRequestFailed({ supabase, requestId: REQUEST_ID, errorMessage: message });
    }
    expect(writes.map((w) => w.error_message)).toEqual([AI_CONSENT_REQUIRED_MESSAGE, AI_CONSENT_CHECK_FAILED_MESSAGE]);
    expect(writes.map((w) => aiConsentReasonOfStoredError(w.error_message))).toEqual(['consent_required', 'check_failed']);
  });
});

// ─────────────────────────────────────────────
// 5. 構文木の検査: 続きの工程の呼び出しは invokeMenuContinuation を通す
// ─────────────────────────────────────────────

describe('Edge Function が献立生成の Edge Function を呼び直す場所は、どれも invokeMenuContinuation を使う', () => {
  const ROOT = path.resolve(__dirname, '..');
  const FUNCTIONS_DIR = 'supabase/functions';
  /** 呼び直す先の URL の目印 */
  const CONTINUATION_URL = '/functions/v1/generate-menu-v';

  function listIndexFiles(): string[] {
    return fs
      .readdirSync(path.join(ROOT, FUNCTIONS_DIR), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('_'))
      .map((entry) => `${FUNCTIONS_DIR}/${entry.name}/index.ts`)
      .filter((file) => fs.existsSync(path.join(ROOT, file)));
  }

  function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
    visit(node);
    ts.forEachChild(node, (child) => walk(child, visit));
  }

  function isContinuationUrl(node: ts.Node): boolean {
    if (ts.isNoSubstitutionTemplateLiteral(node) || ts.isStringLiteral(node)) return node.text.includes(CONTINUATION_URL);
    if (ts.isTemplateExpression(node)) {
      return [node.head.text, ...node.templateSpans.map((span) => span.literal.text)].some((text) => text.includes(CONTINUATION_URL));
    }
    return false;
  }

  /** 続きの工程の URL を最初の引数に渡している呼び出し → 呼んでいる関数の名前 (と行) */
  function continuationCalls(source: string, file: string): Array<{ callee: string; line: number }> {
    const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const urlVariables = new Set<string>();
    walk(sf, (node) => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && isContinuationUrl(node.initializer)) {
        urlVariables.add(node.name.text);
      }
    });
    const calls: Array<{ callee: string; line: number }> = [];
    walk(sf, (node) => {
      if (!ts.isCallExpression(node) || node.arguments.length === 0) return;
      const first = node.arguments[0];
      const usesUrl = isContinuationUrl(first) || (ts.isIdentifier(first) && urlVariables.has(first.text));
      if (!usesUrl) return;
      calls.push({ callee: node.expression.getText(), line: sf.getLineAndCharacterOfPosition(node.getStart()).line + 1 });
    });
    return calls;
  }

  it('呼び直す場所を見つけている (generate-menu-v4 の次の工程と v5 への引き継ぎ、generate-menu-v5 の次の工程)', () => {
    const found = listIndexFiles().flatMap((file) =>
      continuationCalls(fs.readFileSync(path.join(ROOT, file), 'utf8'), file).map((call) => `${file}::${call.callee}`),
    );
    expect(found.sort()).toEqual(
      [
        'supabase/functions/generate-menu-v4/index.ts::invokeMenuContinuation',
        'supabase/functions/generate-menu-v4/index.ts::invokeMenuContinuation',
        'supabase/functions/generate-menu-v5/index.ts::invokeMenuContinuation',
      ].sort(),
    );
  });

  it('検査そのものの確かめ: fetchWithRetry / fetch で直接呼び直す書き方を見つける', () => {
    const source = `
      async function a(u) { const url = \`\${u}/functions/v1/generate-menu-v4\`; await fetchWithRetry(url, {}, {}); }
      async function b(u) { await fetch(\`\${u}/functions/v1/generate-menu-v5\`, {}); }
      async function c(u) { const url = \`\${u}/functions/v1/generate-menu-v5\`; await invokeMenuContinuation(url, {}, {}); }
    `;
    expect(continuationCalls(source, 'example.ts').map((call) => call.callee)).toEqual(['fetchWithRetry', 'fetch', 'invokeMenuContinuation']);
  });
});
