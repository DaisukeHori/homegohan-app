/**
 * T15 (#1154) 未同意の利用者のデータを、外国の AI 事業者へ送らない
 *
 * 1. 判定の本体 (supabase/functions/_shared/ai-consent.ts の runAiConsentCheck / decideAiConsent)
 *    - 全事業者 (AI_CONSENT_PROVIDERS) について、現行の版 (AI_CONSENT_VERSION) の有効な同意があるときだけ送ってよい
 *    - 一度も同意していない・撤回した・古い版に同意した・1 社でも欠けている → not_consented (403 AI_CONSENT_REQUIRED)
 *    - 読み取りに失敗した・応答の形が違う・userId が空・例外 → check_failed (503 AI_CONSENT_CHECK_FAILED)。送らない
 *    - 応答の本文に内部の詳細 (テーブル名・DB のエラー文) を出さない (#1172)
 * 2. 送る経路の一覧 (棚卸し): AI へ送るコードに届く API Route・Edge Function・cron は、すべて判定を呼ぶか、
 *    利用者のデータを送らない理由つきで除外されている。新しく経路を足して判定を呼び忘れると、このテストが落ちる
 * 3. 実際の route (analyze-fridge) で、本人の有効な行を読んで判定すること (判定は差し替えない)。
 *    送る手前で判定する全経路を実際に呼ぶ検査は tests/ai-consent-enforcement-routes.test.ts (API Route) と
 *    tests/ai-consent-enforcement-edge.test.ts (Edge Functions) にある。ここの棚卸しは「判定を import して呼んでいる」までしか見ない
 * 4. cron (献立の生成のキュー) で、未同意の利用者のリクエストは Edge Function を呼ばずに失敗にすること
 * 5. Edge Functions 側の部品 (_shared/ai-consent-guard.ts)
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ENFORCED_EDGE, ENFORCED_ROUTES } from './helpers/ai-consent-enforced-paths';
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

const ROOT = path.resolve(__dirname, '..');
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

/** ファイルの import (相対パスと @/ ) を辿って、AI へ送るコードに届くかを調べる */
const AI_LEAF_PATTERN =
  /api\.openai\.com|generativelanguage\.googleapis\.com|api\.x\.ai|api\.perplexity\.ai|api\.aimlapi\.com|@google\/genai|from ['"]openai['"]|functions\/v1\/|functions\.invoke\(|dataset-embedding\.mjs|getFastLLM|createFastLLMClient|callV4FastLLM|generateGeminiJson/;

function readIfExists(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function resolveImport(from: string, spec: string): string | null {
  let base: string | null = null;
  if (spec.startsWith('@/')) {
    for (const prefix of ['src', '.']) {
      const candidate = path.join(ROOT, prefix, spec.slice(2));
      for (const ext of ['', '.ts', '.tsx', '/index.ts', '/index.tsx', '.mjs']) {
        if (fs.existsSync(candidate + ext) && fs.statSync(candidate + ext).isFile()) return candidate + ext;
      }
    }
    return null;
  }
  if (spec.startsWith('.')) base = path.resolve(path.dirname(from), spec);
  if (!base) return null;
  for (const ext of ['', '.ts', '.tsx', '/index.ts', '/index.tsx', '.mjs']) {
    if (fs.existsSync(base + ext) && fs.statSync(base + ext).isFile()) return base + ext;
  }
  return null;
}

/** コメントを外す (コメントに書いた送信先の説明で、送っていないファイルを送るものと数えないため。https:// の // は残す) */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

function reachesAi(file: string, seen = new Set<string>()): boolean {
  if (seen.has(file)) return false;
  seen.add(file);
  const raw = readIfExists(file);
  if (raw === null) return false;
  const text = stripComments(raw);
  if (AI_LEAF_PATTERN.test(text)) return true;
  for (const match of text.matchAll(/(?:from|import\()\s*['"]([^'"]+)['"]/g)) {
    const resolved = resolveImport(file, match[1]);
    if (resolved && reachesAi(resolved, seen)) return true;
  }
  return false;
}

function listRouteFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listRouteFiles(full));
    else if (entry.name === 'route.ts') out.push(full);
  }
  return out;
}

const rel = (file: string) => path.relative(ROOT, file).split(path.sep).join('/');

/**
 * 自分では AI へ送らず、キュー (weekly_menu_requests) に積むだけの route。積んだ行は cron (process-menu-queue) が
 * Edge Function generate-menu-v5 に渡して AI へ送る。積む前にも判定する (未同意なら積まない) ので ENFORCED_ROUTES に載せるが、
 * import を辿っても AI へ送るコードには届かない
 */
const QUEUE_ONLY_ROUTES = new Set(['src/app/api/ai/menu/v5/generate/route.ts']);

/** AI へ送るコードに届くが、利用者のデータを送らない API Route → 理由 */
const EXEMPT_ROUTES: Record<string, string> = {
  'src/app/api/admin/catalog/import/route.ts': 'コンビニ商品のカタログの取り込み (運営)。利用者のデータを含まない',
  'src/app/api/super-admin/embeddings/regenerate/route.ts': 'レシピ・食材のデータセットの数値化 (運営)。利用者のデータを含まない',
  'src/app/api/super-admin/plans/[id]/price-change/route.ts': 'Stripe の価格の同期 (Edge Function stripe-price-sync)。AI へは送らない',
  'src/app/api/comparison/trigger/route.ts': '集計 (Edge Function calculate-segment-stats)。AI へは送らない',
  // 料理の画像の作成のジョブを積む (と、処理の Edge Function を起こす) だけの route。AI (Google) へ送るのは
  // Edge Function process-meal-image-jobs で、ジョブごとに献立の持ち主の同意を判定し、未同意なら取り消す (ENFORCED_EDGE)
  'src/app/api/meal-plans/add-from-photo/route.ts': '画像のジョブを取り消すだけ。送るのは process-meal-image-jobs (判定あり)',
  'src/app/api/meal-plans/meals/[id]/route.ts': '画像のジョブを積むだけ。送るのは process-meal-image-jobs (判定あり)',
  'src/app/api/meal-plans/meals/route.ts': '画像のジョブを積むだけ。送るのは process-meal-image-jobs (判定あり)',
  'src/app/api/meals/[id]/route.ts': '画像のジョブを積むだけ。送るのは process-meal-image-jobs (判定あり)',
  'src/app/api/meals/route.ts': '画像のジョブを積むだけ。送るのは process-meal-image-jobs (判定あり)',
};

/** AI へ送るコードに届くが、利用者のデータを送らない Edge Function → 理由 */
const EXEMPT_EDGE: Record<string, string> = {
  'import-convenience-catalog': 'コンビニ商品のカタログ (公開情報) の取り込み',
  'import-familymart-catalog': '同上',
  'import-lawson-catalog': '同上',
  'import-ministop-catalog': '同上',
  'import-natural-lawson-catalog': '同上',
  'import-seven-eleven-catalog': '同上',
  'regenerate-embeddings': 'レシピ・食材のデータセットの数値化 (運営)',
  'backfill-ingredient-embeddings': '食材のデータセットの数値化 (運営)',
  'stripe-price-sync': 'Stripe の価格の同期。AI へは送らない',
};

const GUARD_CALL_PATTERN = /\b(requireAiConsent|checkUserAiConsent|requireAiConsentForUser|checkAiConsent)\(/;

describe('送る経路の一覧 (棚卸し)', () => {
  const routeFiles = listRouteFiles(path.join(ROOT, 'src/app/api'));
  const reaching = routeFiles.filter((file) => reachesAi(file)).map(rel).sort();

  it('AI へ送るコードに届く API Route は、すべて判定を呼ぶか、理由つきで除外されている', () => {
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

  const functionsDir = path.join(ROOT, 'supabase/functions');
  const edgeFunctions = fs
    .readdirSync(functionsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('_') && fs.existsSync(path.join(functionsDir, e.name, 'index.ts')))
    .map((e) => e.name);
  const reachingEdge = edgeFunctions.filter((name) => reachesAi(path.join(functionsDir, name, 'index.ts'))).sort();

  it('AI へ送るコードに届く Edge Function は、すべて判定を呼ぶか、理由つきで除外されている', () => {
    const unlisted = reachingEdge.filter((name) => !(name in ENFORCED_EDGE) && !(name in EXEMPT_EDGE));
    expect(unlisted, '判定を呼ぶ (_shared/ai-consent-guard.ts) か、利用者のデータを送らない理由を EXEMPT_EDGE に書くこと').toEqual([]);
  });

  it.each(Object.keys(ENFORCED_EDGE))('Edge Function %s は判定を import して呼んでいる (送る手前で止めることは ai-consent-enforcement-edge.test.ts)', (name) => {
    const text = fs.readFileSync(path.join(functionsDir, name, 'index.ts'), 'utf8');
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
