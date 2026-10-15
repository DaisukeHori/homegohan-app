// @vitest-environment node
/**
 * #1538 Edge Function purge-hidden-content のハンドラ (supabase/functions/purge-hidden-content/index.ts)
 *
 * 本体 (purgeExpiredHiddenContent) は差し替え、ハンドラの約束だけを確かめる (本体は tests/hidden-content-purge.test.ts と
 * tests/integration/security/purge-hidden-content.test.ts):
 *   - 認証 (requireServiceRole。本物) を通らない要求は 401 で、本体を呼ばない
 *   - 成功は 200 と結果。期限を決める時刻は実行した時刻で、本文の値では動かない
 *   - 失敗は 500 と固定の文 (例外の文は返さず、ログにだけ残す #1444)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveHeavyUnitTimeouts } from './helpers/heavy-unit-test-timeout';

type Handler = (req: Request) => Promise<Response>;

const mocks = vi.hoisted(() => ({
  purge: vi.fn(),
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@supabase/supabase-js', () => ({ createClient: () => ({}) }));
vi.mock('../supabase/functions/_shared/db-logger.ts', () => ({
  createLogger: () => mocks.logger,
  generateRequestId: () => 'req_test',
}));
vi.mock('../supabase/functions/_shared/hidden-content-purge.ts', () => ({
  purgeExpiredHiddenContent: mocks.purge,
}));

const SECRET = 'cron-secret-for-test';
let handler: Handler | null = null;
let env: Record<string, string | undefined> = {};

/**
 * Edge Function の本体を動的に読み込むフック (beforeEach) の時間切れ (#1605)。負荷の高い機械で、Edge Function の動的 import が
 * フックの既定の 10 秒を超えたことがある。読み込みのフックにだけ同じ値 (環境変数で上書き可) を使う (tests/edge-function-cors.test.ts と同じ形)
 */
const EDGE_IMPORT_HOOK_TIMEOUT_MS = resolveHeavyUnitTimeouts(process.env).hookTimeout;

beforeEach(async () => {
  env = { CRON_SECRET: SECRET };
  mocks.purge.mockReset();
  mocks.logger.error.mockReset();
  vi.stubGlobal('Deno', {
    env: { get: (key: string) => env[key] },
    serve: (fn: Handler) => {
      handler = fn;
    },
  });
  if (!handler) await import('../supabase/functions/purge-hidden-content/index.ts');
}, EDGE_IMPORT_HOOK_TIMEOUT_MS);

afterEach(() => {
  vi.unstubAllGlobals();
});

function call(auth?: string): Promise<Response> {
  if (!handler) throw new Error('handler was not registered by Deno.serve');
  return handler(
    new Request('https://example.supabase.co/functions/v1/purge-hidden-content', {
      method: 'POST',
      headers: auth ? { Authorization: auth } : {},
      // 本文の now は読まない (期限を呼び出しで動かせない) ことを確かめるため、遠い未来を送る
      body: JSON.stringify({ now: '2099-01-01T00:00:00Z' }),
    }),
  );
}

describe('Edge Function purge-hidden-content', () => {
  it('CRON_SECRET が無い・違う要求は 401 で、何も消さない', async () => {
    expect((await call()).status).toBe(401);
    expect((await call('Bearer wrong')).status).toBe(401);
    expect(mocks.purge).not.toHaveBeenCalled();
  });

  it('CRON_SECRET が未設定なら 503 で、何も消さない', async () => {
    env = {};
    expect((await call(`Bearer ${SECRET}`)).status).toBe(503);
    expect(mocks.purge).not.toHaveBeenCalled();
  });

  it('成功したら 200 と結果を返す。時刻は本文ではなく実行した時刻', async () => {
    const summary = {
      cutoff: '2026-07-17T00:00:00.000Z',
      deleted_rows: { meals: 1, recipes: 0 },
      removed_objects: 1,
      skipped_unowned_objects: 0,
      skipped_referenced_objects: 0,
      completed: true,
    };
    mocks.purge.mockResolvedValue(summary);
    const before = Date.now();

    const res = await call(`Bearer ${SECRET}`);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, ...summary });
    expect(mocks.purge).toHaveBeenCalledTimes(1);
    const options = mocks.purge.mock.calls[0][1] as { now: Date };
    expect(options.now.getTime()).toBeGreaterThanOrEqual(before);
    expect(options.now.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('失敗したら 500 と固定の文を返す (例外の文は返さず、ログにだけ残す)', async () => {
    mocks.purge.mockRejectedValue(new Error('relation "meals" internal detail'));

    const res = await call(`Bearer ${SECRET}`);

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({ success: false, error: 'purge failed' });
    expect(JSON.stringify(body)).not.toContain('internal detail');
    expect(mocks.logger.error).toHaveBeenCalledTimes(1);
  });
});
