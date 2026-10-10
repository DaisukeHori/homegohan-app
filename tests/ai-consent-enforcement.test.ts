/**
 * T15 (#1154) 未同意の利用者のデータを、外国の AI 事業者へ送らない
 *
 * 1. 判定の本体 (supabase/functions/_shared/ai-consent.ts の runAiConsentCheck / decideAiConsent)
 *    - 全事業者 (AI_CONSENT_PROVIDERS) について、現行の版 (AI_CONSENT_VERSION) の有効な同意があるときだけ送ってよい
 *    - 一度も同意していない・撤回した・古い版に同意した・1 社でも欠けている → not_consented (403 AI_CONSENT_REQUIRED)
 *    - 読み取りに失敗した・応答の形が違う・userId が空・例外 → check_failed (503 AI_CONSENT_CHECK_FAILED)。送らない
 *    - 応答の本文に内部の詳細 (テーブル名・DB のエラー文) を出さない (#1172)
 * 2. 送る経路の一覧 (棚卸し): AI へ送るコードに届く route ハンドラ (src/app 全体)・Edge Function・cron は、すべて判定を呼ぶか、
 *    利用者のデータを送らない理由つきで除外されている。新しく経路を足して判定を呼び忘れると、このテストが落ちる。
 *    一覧 (tests/helpers/ai-consent-enforced-paths.ts) と検出器 (tests/helpers/ai-reach.ts) は、AI の利用回数の記録 (#1177) と共用する
 * 3. 実際の route (analyze-fridge) で、本人の有効な行を読んで判定すること (判定は差し替えない)。
 *    送る手前で判定する全経路を実際に呼ぶ検査は tests/ai-consent-enforcement-routes.test.ts (API Route) と
 *    tests/ai-consent-enforcement-edge.test.ts (Edge Functions) にある。ここの棚卸しは「判定を import して呼んでいる」までしか見ない
 * 4. cron (献立の生成のキュー) で、未同意の利用者のリクエストは Edge Function を呼ばずに失敗にすること
 * 5. Edge Functions 側の部品 (_shared/ai-consent-guard.ts)
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ENFORCED_EDGE, ENFORCED_ROUTES, EXEMPT_EDGE, EXEMPT_ROUTES, QUEUE_ONLY_ROUTES } from './helpers/ai-consent-enforced-paths';
import { AI_LEAF_PATTERN, ROOT, listEdgeFunctions, listFiles, listRouteFiles, reachesAi, rel, stripComments } from './helpers/ai-reach';
import {
  AI_CONSENT_CHECK_FAILED_CODE,
  AI_CONSENT_CHECK_FAILED_STATUS,
  AI_CONSENT_PROVIDERS,
  AI_CONSENT_REQUIRED_CODE,
  AI_CONSENT_REQUIRED_STATUS,
  AI_CONSENT_TABLE,
  AI_CONSENT_VERSION,
  aiConsentDeniedPayload,
  aiConsentSkippedField,
  decideAiConsent,
  isAiConsentRequiredBody,
  runAiConsentCheck,
} from '../supabase/functions/_shared/ai-consent';

const USER = '11111111-1111-4111-8111-111111111111';

function grantedRows(version: string | null = AI_CONSENT_VERSION) {
  return AI_CONSENT_PROVIDERS.map((provider) => ({ provider, consented: true, policy_version: version }));
}

// ─────────────────────────────────────────────
// 1. 判定の本体
// ─────────────────────────────────────────────

describe('判定の本体: decideAiConsent / runAiConsentCheck', () => {
  it('全事業者が現行の版に同意していれば、送ってよい', () => {
    expect(decideAiConsent({ data: grantedRows(), error: null })).toEqual({ allowed: true });
  });

  it('一度も同意していない (行が無い) なら not_consented', () => {
    expect(decideAiConsent({ data: [], error: null })).toEqual({ allowed: false, reason: 'not_consented' });
  });

  it('1 社でも欠けていれば not_consented (Perplexity / AI/ML API を含む全社が要る)', () => {
    for (const missing of AI_CONSENT_PROVIDERS) {
      const rows = grantedRows().filter((r) => r.provider !== missing);
      expect(decideAiConsent({ data: rows, error: null }), missing).toEqual({ allowed: false, reason: 'not_consented' });
    }
  });

  it('古い版・版の無い行への同意は not_consented (版を上げたら、もう一度同意が要る)', () => {
    expect(decideAiConsent({ data: grantedRows('draft-2026-10-08'), error: null })).toEqual({
      allowed: false,
      reason: 'not_consented',
    });
    expect(decideAiConsent({ data: grantedRows(null), error: null })).toEqual({ allowed: false, reason: 'not_consented' });
  });

  it('拒否の行 (consented = false) は同意として数えない', () => {
    const rows = grantedRows().map((r) => (r.provider === 'google' ? { ...r, consented: false } : r));
    expect(decideAiConsent({ data: rows, error: null })).toEqual({ allowed: false, reason: 'not_consented' });
  });

  it('読み取りのエラー・想定外の形は check_failed (送らない)', () => {
    expect(decideAiConsent({ data: null, error: { message: 'boom' } })).toEqual({ allowed: false, reason: 'check_failed' });
    expect(decideAiConsent({ data: null, error: null })).toEqual({ allowed: false, reason: 'check_failed' });
    expect(decideAiConsent({ data: { provider: 'xai' }, error: null })).toEqual({ allowed: false, reason: 'check_failed' });
    expect(decideAiConsent({ data: [...grantedRows(), { provider: 'xai' }], error: null })).toEqual({
      allowed: false,
      reason: 'check_failed',
    });
  });

  it('runAiConsentCheck: 本人の有効な行だけを読む。userId が空なら読まずに check_failed。例外も check_failed', async () => {
    const read = vi.fn(async (id: string) => ({ data: id === USER ? grantedRows() : [], error: null }));
    await expect(runAiConsentCheck(USER, read)).resolves.toEqual({ allowed: true });
    expect(read).toHaveBeenCalledWith(USER);

    read.mockClear();
    await expect(runAiConsentCheck('', read)).resolves.toEqual({ allowed: false, reason: 'check_failed' });
    await expect(runAiConsentCheck('   ', read)).resolves.toEqual({ allowed: false, reason: 'check_failed' });
    await expect(runAiConsentCheck(null, read)).resolves.toEqual({ allowed: false, reason: 'check_failed' });
    await expect(runAiConsentCheck(undefined, read)).resolves.toEqual({ allowed: false, reason: 'check_failed' });
    expect(read).not.toHaveBeenCalled();

    await expect(
      runAiConsentCheck(USER, async () => {
        throw new Error('network down');
      }),
    ).resolves.toEqual({ allowed: false, reason: 'check_failed' });
  });

  it('止めたときの応答: 未同意は 403 AI_CONSENT_REQUIRED、読めなかったときは 503 AI_CONSENT_CHECK_FAILED。内部の詳細は出さない', () => {
    const required = aiConsentDeniedPayload({ allowed: false, reason: 'not_consented' });
    expect(required.status).toBe(AI_CONSENT_REQUIRED_STATUS);
    expect(AI_CONSENT_REQUIRED_STATUS).toBe(403);
    expect(required.body.code).toBe(AI_CONSENT_REQUIRED_CODE);
    expect(isAiConsentRequiredBody(required.body)).toBe(true);

    const failed = aiConsentDeniedPayload({ allowed: false, reason: 'check_failed' });
    expect(failed.status).toBe(AI_CONSENT_CHECK_FAILED_STATUS);
    expect(AI_CONSENT_CHECK_FAILED_STATUS).toBe(503);
    expect(failed.body.code).toBe(AI_CONSENT_CHECK_FAILED_CODE);
    expect(isAiConsentRequiredBody(failed.body)).toBe(false);

    for (const body of [required.body, failed.body]) {
      expect(Object.keys(body).sort()).toEqual(['code', 'error']);
      expect(body.error).not.toMatch(/external_data_consents|policy_version|user_id|provider|supabase|SQL/i);
    }
  });

  it('aiConsentSkippedField: 送ってよいなら何も足さず、止めたならコードを aiSkipped に入れる', () => {
    expect(aiConsentSkippedField({ allowed: true })).toEqual({});
    expect(aiConsentSkippedField(null)).toEqual({});
    expect(aiConsentSkippedField({ allowed: false, reason: 'not_consented' })).toEqual({ aiSkipped: AI_CONSENT_REQUIRED_CODE });
    expect(aiConsentSkippedField({ allowed: false, reason: 'check_failed' })).toEqual({
      aiSkipped: AI_CONSENT_CHECK_FAILED_CODE,
    });
  });

  it('isAiConsentRequiredBody: { code } と { error: { code } } の両方を見分ける', () => {
    expect(isAiConsentRequiredBody({ code: AI_CONSENT_REQUIRED_CODE })).toBe(true);
    expect(isAiConsentRequiredBody({ error: { code: AI_CONSENT_REQUIRED_CODE } })).toBe(true);
    expect(isAiConsentRequiredBody({ code: 'OTHER' })).toBe(false);
    expect(isAiConsentRequiredBody(null)).toBe(false);
    expect(isAiConsentRequiredBody('AI_CONSENT_REQUIRED')).toBe(false);
  });
});

// ─────────────────────────────────────────────
// 2. 送る経路の一覧 (棚卸し)
// ─────────────────────────────────────────────

/**
 * route ハンドラ以外のファイル (ページ・レイアウト・サーバーアクション・middleware) で、AI に届くものの全数と理由。
 * ここに無いのに AI に届くファイルができたら、一覧に載っていない入口 (サーバーアクションなど) の疑い
 */
const NON_ROUTE_FILES_REACHING_AI: Record<string, string> = {};

const GUARD_CALL_PATTERN = /\b(requireAiConsent|checkUserAiConsent|requireAiConsentForUser|checkAiConsent)\(/;

describe('送る経路の一覧 (棚卸し)', () => {
  const routeFiles = listRouteFiles();
  const reaching = routeFiles.filter((file) => reachesAi(path.join(ROOT, file)));

  it('AI へ送るコードに届く route ハンドラ (src/app 全体。api の外も含む) は、すべて判定を呼ぶか、理由つきで除外されている', () => {
    const unlisted = reaching.filter((file) => !(file in ENFORCED_ROUTES) && !(file in EXEMPT_ROUTES));
    expect(unlisted, '判定を呼ぶ (src/lib/ai/consent-guard.ts) か、利用者のデータを送らない理由を EXEMPT_ROUTES に書くこと').toEqual([]);
  });

  it.each(Object.keys(ENFORCED_ROUTES))('%s は判定を import して呼んでいる (送らないことは ai-consent-enforcement-routes.test.ts)', (file) => {
    const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
    expect(text).toMatch(/from '@\/lib\/ai\/consent-guard'/);
    expect(text).toMatch(GUARD_CALL_PATTERN);
  });

  it('一覧が古くなっていない (載せたファイルが実在し、AI へ送るコードに届く)', () => {
    for (const file of [...Object.keys(ENFORCED_ROUTES), ...Object.keys(EXEMPT_ROUTES)]) {
      expect(fs.existsSync(path.join(ROOT, file)), file).toBe(true);
      if (QUEUE_ONLY_ROUTES.has(file)) {
        expect(reaching, `${file} は AI へ送るコードに届くようになった。QUEUE_ONLY_ROUTES から外すこと`).not.toContain(file);
        continue;
      }
      expect(reaching, `${file} は AI へ送るコードに届かない。一覧から外すこと`).toContain(file);
    }
  });

  it('ログイン (#1165) は、環境変数の一覧 (src/lib/env.ts) を通ってだけ AI へ送るコードに届く (除外の理由のとおり。env.ts を辿らなければ届かない)', () => {
    const login = path.join(ROOT, 'src/app/api/auth/login/route.ts');
    expect(reaching).toContain('src/app/api/auth/login/route.ts');
    expect(reachesAi(login, new Set([path.join(ROOT, 'src/lib/env.ts')]))).toBe(false);
  });

  it('route ハンドラ以外のファイル (ページ・レイアウト・サーバーアクション・middleware) は、AI へ送るコードに届かない', () => {
    const others = [
      ...listFiles(path.join(ROOT, 'src/app'), (name) => /\.(ts|tsx)$/.test(name) && !/^route\.tsx?$/.test(name)),
      ...['src/middleware.ts', 'middleware.ts'].map((file) => path.join(ROOT, file)).filter((file) => fs.existsSync(file)),
    ]
      .filter((file) => reachesAi(file))
      .map(rel)
      .sort();
    expect(others).toEqual(Object.keys(NON_ROUTE_FILES_REACHING_AI).sort());
  });

  const edgeFunctions = listEdgeFunctions();
  const reachingEdge = edgeFunctions.filter((name) => reachesAi(path.join(ROOT, 'supabase/functions', name, 'index.ts')));

  it('AI へ送るコードに届く Edge Function は、すべて判定を呼ぶか、理由つきで除外されている', () => {
    const unlisted = reachingEdge.filter((name) => !(name in ENFORCED_EDGE) && !(name in EXEMPT_EDGE));
    expect(unlisted, '判定を呼ぶ (_shared/ai-consent-guard.ts) か、利用者のデータを送らない理由を EXEMPT_EDGE に書くこと').toEqual([]);
  });

  it.each(Object.keys(ENFORCED_EDGE))('Edge Function %s は判定を import して呼んでいる (送る手前で止めることは ai-consent-enforcement-edge.test.ts)', (name) => {
    const text = fs.readFileSync(path.join(ROOT, 'supabase/functions', name, 'index.ts'), 'utf8');
    expect(text).toMatch(/from ['"]\.\.\/_shared\/ai-consent-guard\.ts['"]/);
    expect(text).toMatch(GUARD_CALL_PATTERN);
  });

  it('Edge Function の一覧が古くなっていない', () => {
    for (const name of [...Object.keys(ENFORCED_EDGE), ...Object.keys(EXEMPT_EDGE)]) {
      expect(edgeFunctions, name).toContain(name);
    }
    for (const name of Object.keys(ENFORCED_EDGE)) {
      expect(reachingEdge, `${name} は AI へ送るコードに届かない。一覧から外すこと`).toContain(name);
    }
  });

  it('Vercel の cron は、判定を呼ぶ route か、AI へ送らない route だけ', () => {
    const vercel = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8')) as { crons?: Array<{ path: string }> };
    for (const cron of vercel.crons ?? []) {
      const file = `src/app${cron.path}/route.ts`;
      if (reaching.includes(file)) expect(ENFORCED_ROUTES, file).toHaveProperty([file]);
    }
  });

  it('検出器の確かめ: 提供元の URL・SDK・API キーの環境変数・Edge Function の呼び出しを AI の印とし、コメントの中は拾わない', () => {
    for (const text of [
      "fetch('https://api.openai.com/v1/chat/completions')",
      "import { GoogleGenAI } from '@google/genai';",
      "import OpenAI from 'openai';",
      "import OpenAI from 'npm:openai@4';",
      "import Anthropic from '@anthropic-ai/sdk';",
      'const key = process.env.XAI_API_KEY;',
      "const key = Deno.env.get('GEMINI_API_KEY');",
      "await supabase.functions.invoke('generate-menu-v5', {});",
    ]) {
      expect(AI_LEAF_PATTERN.test(stripComments(text)), text).toBe(true);
    }
    for (const text of ["// fetch('https://api.openai.com/v1')", '/* process.env.OPENAI_API_KEY */', "const url = '/api/ai/menu';"]) {
      expect(AI_LEAF_PATTERN.test(stripComments(text)), text).toBe(false);
    }
  });
});

// ─────────────────────────────────────────────
// 3. 実際の route (判定は差し替えない)
// ─────────────────────────────────────────────

const routeMocks = vi.hoisted(() => ({
  consentResult: { data: [] as unknown, error: null as unknown },
  consentReads: [] as Array<{ table: string; columns: string; filters: Array<[string, string, unknown]> }>,
  generateGeminiJson: vi.fn(),
  checkRateLimit: vi.fn(async () => ({ success: true })),
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(() => ({
    auth: { getUser: async () => ({ data: { user: { id: '11111111-1111-4111-8111-111111111111' } }, error: null }) },
    from: (table: string) => ({
      select: (columns: string) => {
        const read = { table, columns, filters: [] as Array<[string, string, unknown]> };
        routeMocks.consentReads.push(read);
        return {
          eq: (column: string, value: unknown) => {
            read.filters.push(['eq', column, value]);
            return {
              is: async (column2: string, value2: unknown) => {
                read.filters.push(['is', column2, value2]);
                return routeMocks.consentResult;
              },
            };
          },
        };
      },
    }),
  })),
  getSupabaseAdmin: vi.fn(),
}));

vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: routeMocks.checkRateLimit,
  rateLimitExceededResponse: vi.fn(),
}));

vi.mock('@/lib/ai/gemini-json', () => ({
  generateGeminiJson: routeMocks.generateGeminiJson,
  fetchImageAsBase64: vi.fn(),
}));

describe('実際の route: POST /api/ai/analyze-fridge', () => {
  beforeEach(() => {
    routeMocks.consentReads.length = 0;
    routeMocks.generateGeminiJson.mockReset();
    routeMocks.generateGeminiJson.mockResolvedValue({
      data: { ingredients: [{ name: '卵', quantity: '2個' }], summary: '卵があります', suggestions: [] },
      model: 'test-model',
    });
  });

  async function call() {
    const { POST } = await import('@/app/api/ai/analyze-fridge/route');
    return POST(
      new Request('http://localhost/api/ai/analyze-fridge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ imageBase64: 'aGVsbG8=', mimeType: 'image/jpeg' }),
      }),
    );
  }

  it('同意していない: 403 AI_CONSENT_REQUIRED を返し、AI (Google) を呼ばない', async () => {
    routeMocks.consentResult = { data: [], error: null };
    const res = await call();
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({ code: AI_CONSENT_REQUIRED_CODE });
    expect(routeMocks.generateGeminiJson).not.toHaveBeenCalled();
    // 本人の有効な行を読んでいる
    expect(routeMocks.consentReads).toEqual([
      {
        table: AI_CONSENT_TABLE,
        columns: 'provider, consented, policy_version',
        filters: [
          ['eq', 'user_id', USER],
          ['is', 'revoked_at', null],
        ],
      },
    ]);
  });

  it('撤回後・古い版への同意: 403 で、AI を呼ばない', async () => {
    routeMocks.consentResult = { data: grantedRows('draft-2026-10-08'), error: null };
    const res = await call();
    expect(res.status).toBe(403);
    expect(routeMocks.generateGeminiJson).not.toHaveBeenCalled();
  });

  it('同意の状況を読めない: 503 AI_CONSENT_CHECK_FAILED を返し、AI を呼ばない (fail-closed)。DB のエラー文は出さない', async () => {
    routeMocks.consentResult = { data: null, error: { message: 'relation external_data_consents does not exist' } };
    const res = await call();
    expect(res.status).toBe(503);
    const body = (await res.json()) as { code: string; error: string };
    expect(body.code).toBe(AI_CONSENT_CHECK_FAILED_CODE);
    expect(body.error).not.toContain('external_data_consents');
    expect(routeMocks.generateGeminiJson).not.toHaveBeenCalled();
  });

  it('同意済み: AI を呼んで 200', async () => {
    routeMocks.consentResult = { data: grantedRows(), error: null };
    const res = await call();
    expect(res.status).toBe(200);
    expect(routeMocks.generateGeminiJson).toHaveBeenCalledTimes(1);
  });
});

// ─────────────────────────────────────────────
// 5. Edge Functions 側の部品
// ─────────────────────────────────────────────

describe('Edge Functions の部品: _shared/ai-consent-guard.ts', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function fakeClient(result: { data: unknown; error: unknown }) {
    const reads: Array<[string, string, string, unknown, string, unknown]> = [];
    return {
      reads,
      client: {
        from: (table: string) => ({
          select: (columns: string) => ({
            eq: (column: string, value: unknown) => ({
              is: async (column2: string, value2: unknown) => {
                reads.push([table, columns, column, value, column2, value2]);
                return result;
              },
            }),
          }),
        }),
      },
    };
  }

  it('checkAiConsent: 本人の有効な行を読んで判定し、止めるときは CORS などのヘッダーを付けた 403 を返す', async () => {
    vi.stubGlobal('Deno', { env: { get: () => undefined } });
    const guard = await import('../supabase/functions/_shared/ai-consent-guard');
    const empty = fakeClient({ data: [], error: null });
    const denied = await guard.requireAiConsent(empty.client as never, USER, { 'Access-Control-Allow-Origin': 'https://example.test' });
    expect(denied?.status).toBe(403);
    expect(denied?.headers.get('Access-Control-Allow-Origin')).toBe('https://example.test');
    expect(denied?.headers.get('Content-Type')).toBe('application/json');
    await expect(denied?.json()).resolves.toMatchObject({ code: AI_CONSENT_REQUIRED_CODE });
    expect(empty.reads).toEqual([[AI_CONSENT_TABLE, 'provider, consented, policy_version', 'user_id', USER, 'revoked_at', null]]);

    const granted = fakeClient({ data: grantedRows(), error: null });
    await expect(guard.requireAiConsent(granted.client as never, USER)).resolves.toBeNull();

    const broken = fakeClient({ data: null, error: { message: 'boom' } });
    const failed = await guard.requireAiConsent(broken.client as never, USER);
    expect(failed?.status).toBe(503);
  });

  it('requireAiConsentForUser: service role の環境変数が無ければ判定できないので止める (503)', async () => {
    vi.stubGlobal('Deno', { env: { get: () => undefined } });
    const guard = await import('../supabase/functions/_shared/ai-consent-guard');
    const res = await guard.requireAiConsentForUser(USER, {});
    expect(res?.status).toBe(503);
    await expect(res?.json()).resolves.toMatchObject({ code: AI_CONSENT_CHECK_FAILED_CODE });
  });
});
