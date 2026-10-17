// @vitest-environment node
/**
 * #1560 Edge Function cron-secret-probe のハンドラ (supabase/functions/cron-secret-probe/index.ts)
 *
 * GET /api/cron/app-log-alerts が DB の public.send_cron_secret_probe() から Vault の app_cron_secret で呼ぶ、cron の共有シークレットの確認。
 * 設計: docs/design/operator/12-cron-secret-drift-monitor.md §6.2 / §11.2 (PE-1〜PE-6)
 *   - 認証 (requireServiceRole。本物) を通らない要求は、ほかのバッチ関数と同じ 401 / 503
 *   - 通ったら照合の結果だけを、キー 4 つの JSON で返す。本文は読まない・秘密の値は返さない・CORS は付けない
 *
 * 値はすべてテスト用のダミー。本物のシークレットは使わない。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveHeavyUnitTimeouts } from './helpers/heavy-unit-test-timeout';

type Handler = (req: Request) => Promise<Response>;

vi.mock('@supabase/supabase-js', () => ({ createClient: vi.fn() }));

const CURRENT_SECRET = 'dummy-current-cron-secret-0123456789abcdef';
const PREVIOUS_SECRET = 'dummy-previous-cron-secret-fedcba9876543210';
const ENDPOINT = 'https://example.supabase.co/functions/v1/cron-secret-probe';

let handler: Handler | null = null;
let env: Record<string, string | undefined> = {};

/**
 * Edge Function の本体を動的に読み込むフック (beforeEach) の時間切れ (#1605)。負荷の高い機械で、Edge Function の動的 import が
 * フックの既定の 10 秒を超えたことがある。読み込みのフックにだけ同じ値 (環境変数で上書き可) を使う (tests/purge-hidden-content-edge.test.ts と同じ形)
 */
const EDGE_IMPORT_HOOK_TIMEOUT_MS = resolveHeavyUnitTimeouts(process.env).hookTimeout;

beforeEach(async () => {
  env = { CRON_SECRET: CURRENT_SECRET };
  vi.stubGlobal('Deno', {
    env: { get: (key: string) => env[key] },
    serve: (fn: Handler) => {
      handler = fn;
    },
  });
  if (!handler) await import('../supabase/functions/cron-secret-probe/index.ts');
}, EDGE_IMPORT_HOOK_TIMEOUT_MS);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function call(auth?: string, method = 'POST'): Promise<Response> {
  if (!handler) throw new Error('handler was not registered by Deno.serve');
  return handler(
    new Request(ENDPOINT, {
      method,
      headers: auth === undefined ? {} : { Authorization: auth },
      // pg_net は { probe_id } を送るが、ハンドラは本文を読まない
      body: method === 'GET' ? undefined : JSON.stringify({ probe_id: 41 }),
    }),
  );
}

describe('Edge Function cron-secret-probe (#1560)', () => {
  it('PE-1: 正しい Bearer (現行) で 200。本文は { ok: true, matched: "current", previous_configured: false, alias_used: false } だけ (キーが 4 つ)', async () => {
    const res = await call(`Bearer ${CURRENT_SECRET}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/json');
    const body = await res.json();
    expect(body).toEqual({ ok: true, matched: 'current', previous_configured: false, alias_used: false });
    expect(Object.keys(body).sort()).toEqual(['alias_used', 'matched', 'ok', 'previous_configured']);
  });

  it('PE-2: 旧い値 (CRON_SECRET_PREVIOUS) で 200・matched "previous"・previous_configured true。console.warn が 1 回 (requireServiceRole の分だけ。describe は出さない)', async () => {
    env.CRON_SECRET_PREVIOUS = PREVIOUS_SECRET;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const res = await call(`Bearer ${PREVIOUS_SECRET}`);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      ok: true,
      matched: 'previous',
      previous_configured: true,
      alias_used: false,
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('CRON_SECRET_PREVIOUS');
    expect(String(warn.mock.calls[0][0])).not.toContain(PREVIOUS_SECRET);

    // 現行の値で呼べば、previous_configured は true のまま matched は current で、warn は増えない
    const current = await call(`Bearer ${CURRENT_SECRET}`);
    await expect(current.json()).resolves.toEqual({
      ok: true,
      matched: 'current',
      previous_configured: true,
      alias_used: false,
    });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('PE-3: 誤った Bearer・ヘッダー無しは 401 {"error":"Unauthorized"}。現行が無ければ 503 {"error":"Service not configured"} (requireServiceRole と同じ本文)', async () => {
    for (const auth of [undefined, 'Bearer wrong', 'Bearer ']) {
      const res = await call(auth);
      expect(res.status, String(auth)).toBe(401);
      await expect(res.json(), String(auth)).resolves.toEqual({ error: 'Unauthorized' });
    }

    env = {};
    for (const auth of [undefined, `Bearer ${CURRENT_SECRET}`]) {
      const res = await call(auth);
      expect(res.status, String(auth)).toBe(503);
      await expect(res.json(), String(auth)).resolves.toEqual({ error: 'Service not configured' });
    }
  });

  it('PE-4: GET と POST は通り、ほかのメソッド (PUT) は認証のあとで 405', async () => {
    expect((await call(`Bearer ${CURRENT_SECRET}`, 'GET')).status).toBe(200);
    expect((await call(`Bearer ${CURRENT_SECRET}`, 'POST')).status).toBe(200);

    const put = await call(`Bearer ${CURRENT_SECRET}`, 'PUT');
    expect(put.status).toBe(405);
    await expect(put.json()).resolves.toEqual({ error: 'Method not allowed' });

    // 認証が先: 秘密の無い PUT は 405 でなく 401 (メソッドで秘密の有無を探られない)
    const unauthenticatedPut = await call('Bearer wrong', 'PUT');
    expect(unauthenticatedPut.status).toBe(401);
  });

  it('PE-5: 本文を読まない (req.json を呼ばない)。応答の本文に秘密の値が無い', async () => {
    env.CRON_SECRET_PREVIOUS = PREVIOUS_SECRET;
    env.SERVICE_ROLE_JWT = 'dummy-service-role-jwt-aaaaaaaaaaaaaaaa';
    if (!handler) throw new Error('handler was not registered by Deno.serve');

    const req = new Request(ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${CURRENT_SECRET}` },
      body: JSON.stringify({ probe_id: 41, canary: CURRENT_SECRET }),
    });
    const readers = (['json', 'text', 'formData', 'arrayBuffer', 'blob'] as const).map((name) => vi.spyOn(req, name));
    const res = await handler(req);

    expect(res.status).toBe(200);
    for (const reader of readers) expect(reader).not.toHaveBeenCalled();
    expect(req.bodyUsed).toBe(false);

    const text = await res.text();
    for (const secret of [CURRENT_SECRET, PREVIOUS_SECRET, 'dummy-service-role-jwt-aaaaaaaaaaaaaaaa']) {
      expect(text).not.toContain(secret);
    }
    // 失敗の応答にも秘密の値は無い
    const failed = await (await call('Bearer wrong')).text();
    for (const secret of [CURRENT_SECRET, PREVIOUS_SECRET]) {
      expect(failed).not.toContain(secret);
    }
  });

  it('PE-6: Access-Control-* のヘッダーを返さない (成功・401・503・405 のどれにも)', async () => {
    const responses = [await call(`Bearer ${CURRENT_SECRET}`), await call('Bearer wrong'), await call(`Bearer ${CURRENT_SECRET}`, 'PUT')];
    env = {};
    responses.push(await call(`Bearer ${CURRENT_SECRET}`));
    expect(responses.map((res) => res.status)).toEqual([200, 401, 405, 503]);
    for (const res of responses) {
      expect([...res.headers.keys()].filter((name) => name.toLowerCase().startsWith('access-control-'))).toEqual([]);
    }
  });
});
