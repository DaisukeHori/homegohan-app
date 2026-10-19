import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { LEGAL_DOCUMENTS } from '@homegohan/shared';

// #1136 GET /api/cron/push-outbox — Push 通知の送信待ちを Expo に送る worker の route。
// DB (Supabase の RPC と表)・Expo への fetch・メンテナンスの判定・ロガーは作り物にし、route と worker の本体 (src/lib/push/*) は実物を通す。
// 本物の Expo には送らない (fetch は vi.fn)。値はすべてテスト用のダミー。設計: docs/design/mobile/06-push-send.md §6.6・§9・§10

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  from: vi.fn(),
  getSupabaseAdmin: vi.fn(),
  isMaintenanceFlagOn: vi.fn(),
  waitUntil: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: mocks.getSupabaseAdmin,
}));

vi.mock('@/lib/maintenance-mode', () => ({
  isMaintenanceFlagOn: mocks.isMaintenanceFlagOn,
}));

vi.mock('@/lib/db-logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: mocks.logInfo,
    warn: mocks.logWarn,
    error: mocks.logError,
    withUser: () => ({ debug: vi.fn(), info: mocks.logInfo, warn: mocks.logWarn, error: mocks.logError }),
  }),
  generateRequestId: () => 'req_test',
}));

vi.mock('@vercel/functions', () => ({
  waitUntil: mocks.waitUntil,
}));

const { GET } = await import('@/app/api/cron/push-outbox/route');

const SECRET = 'dummy-cron-secret-0123456789abcdef';
const EXPO_TOKEN_VALUE = 'dummy-expo-access-token-value';
const USER_ID = '00000000-0000-4000-8000-000000000001';
const PUSH_TOKEN = 'ExponentPushToken[dummyroute0001]';
const REQUEST_ID = '00000000-0000-4000-8000-000000000777';

const claimedRow = {
  id: '00000000-0000-4000-8000-000000000101',
  user_id: USER_ID,
  push_token_id: '00000000-0000-4000-8000-000000000201',
  expo_push_token: PUSH_TOKEN,
  kind: 'weekly_menu_completed',
  payload: { request_id: REQUEST_ID, start_date: '2026-10-20', mode: 'v5' },
  attempts: 0,
  created_at: new Date().toISOString(),
  status: 'queued',
};

type RpcResult = { data: unknown; error: { code?: string; message: string } | null };
let rpcResults: Record<string, RpcResult>;

/** from(table).select(cols).in(col, ids) の作り物。表ごとの行を返す */
function tableReturning(rows: Record<string, unknown[]>) {
  return (table: string) => ({
    select: () => ({ in: async () => ({ data: rows[table] ?? [], error: null }) }),
    delete: () => ({ eq: async () => ({ count: 1, error: null }) }),
  });
}

function makeRequest(authorization?: string) {
  return new Request('http://localhost/api/cron/push-outbox', {
    headers: authorization === undefined ? {} : { authorization },
  });
}
const authed = () => makeRequest(`Bearer ${SECRET}`);
const rpcNames = () => mocks.rpc.mock.calls.map(([name]) => name);

let consoleError: MockInstance<typeof console.error>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('CRON_SECRET', SECRET);
  vi.stubEnv('CRON_SECRET_PREVIOUS', undefined);
  vi.stubEnv('EXPO_ACCESS_TOKEN', EXPO_TOKEN_VALUE);
  vi.stubEnv('PUSH_OUTBOX_MAX_ATTEMPTS', undefined);
  vi.stubEnv('PUSH_OUTBOX_BATCH_SIZE', undefined);
  vi.stubEnv('LEGAL_CONSENT_ENFORCE', undefined);
  vi.stubGlobal('fetch', mocks.fetch);
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

  rpcResults = {
    claim_push_outbox: { data: [], error: null },
    claim_push_receipts: { data: [], error: null },
    complete_push_outbox: { data: true, error: null },
    fail_push_outbox: { data: 'dead', error: null },
    cleanup_push_outbox: { data: [{ expired: 2, sent_deleted: 3, dead_deleted: 4 }], error: null },
  };
  mocks.isMaintenanceFlagOn.mockResolvedValue(false);
  mocks.getSupabaseAdmin.mockReturnValue({ rpc: mocks.rpc, from: mocks.from });
  mocks.rpc.mockImplementation(async (name: string) => {
    const result = rpcResults[name];
    if (!result) throw new Error(`想定外の RPC: ${name}`);
    return result;
  });
  mocks.from.mockImplementation(tableReturning({ user_profiles: [], notification_preferences: [] }));
  mocks.fetch.mockImplementation(async () => {
    throw new Error('このテストでは Expo を呼ばない');
  });
});

afterEach(() => {
  consoleError.mockRestore();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('GET /api/cron/push-outbox (#1136)', () => {
  it('CRON_SECRET が合わなければ 401', async () => {
    for (const request of [makeRequest(), makeRequest('Bearer wrong-secret'), makeRequest(SECRET)]) {
      const res = await GET(request);
      expect(res.status).toBe(401);
    }
    expect(mocks.isMaintenanceFlagOn).not.toHaveBeenCalled();
    expect(mocks.getSupabaseAdmin).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
    // CRON_SECRET が未設定なら 503
    vi.stubEnv('CRON_SECRET', undefined);
    expect((await GET(authed())).status).toBe(503);
  });

  it('EXPO_ACCESS_TOKEN が無ければ claim も Expo もせず cleanup_push_outbox だけを呼び、not_configured と掃除の件数を返す (S-07・R-12)', async () => {
    for (const missing of [undefined, '']) {
      vi.clearAllMocks();
      mocks.rpc.mockImplementation(async (name: string) => rpcResults[name]);
      vi.stubEnv('EXPO_ACCESS_TOKEN', missing);

      const res = await GET(authed());

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({ status: 'not_configured', cleaned_expired: 2, cleaned_sent: 3, cleaned_dead: 4 });
      expect(rpcNames()).toEqual(['cleanup_push_outbox']);
      expect(mocks.from).not.toHaveBeenCalled();
      expect(mocks.fetch).not.toHaveBeenCalled();
      expect(mocks.logWarn).toHaveBeenCalledWith('EXPO_ACCESS_TOKEN が未設定のため、Push 通知を送りません (掃除だけをしました)', {
        expired: 2,
        sent: 3,
        dead: 4,
      });
      expect(mocks.waitUntil).toHaveBeenCalledTimes(1);
    }
  });

  it('メンテナンス中は鍵の有無に依らず DB に触れず maintenance を返す (S-15)', async () => {
    mocks.isMaintenanceFlagOn.mockResolvedValue(true);
    for (const token of [EXPO_TOKEN_VALUE, undefined]) {
      vi.stubEnv('EXPO_ACCESS_TOKEN', token);
      const res = await GET(authed());
      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({ status: 'maintenance' });
    }
    expect(mocks.getSupabaseAdmin).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.from).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('要約を返し、変数名・文面・token の全体を応答に出さない (R-15)', async () => {
    rpcResults.claim_push_outbox = { data: [claimedRow], error: null };
    mocks.from.mockImplementation(
      tableReturning({
        user_profiles: [
          { id: USER_ID, frozen_at: null, unban_at: null, terms_version_accepted: LEGAL_DOCUMENTS.terms_of_service.version, privacy_version_accepted: LEGAL_DOCUMENTS.privacy_policy.version },
        ],
        notification_preferences: [],
      }),
    );
    mocks.fetch.mockImplementation(
      async () => new Response(JSON.stringify({ data: [{ status: 'ok', id: 'ticket-route-1' }] }), { status: 200 }),
    );

    const res = await GET(authed());

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      status: 'processed',
      claimed: 1,
      sent: 1,
      dead: 0,
      receipts_claimed: 0,
      cleaned_expired: 2,
      cleaned_sent: 3,
      cleaned_dead: 4,
      stopped_early: null,
    });
    // Expo には鍵を付けて 1 回だけ送り、complete に ticket の ID を渡す
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = mocks.fetch.mock.calls[0]!;
    expect(url).toBe('https://exp.host/--/api/v2/push/send');
    expect((init as RequestInit).headers).toMatchObject({ authorization: `Bearer ${EXPO_TOKEN_VALUE}` });
    expect(mocks.rpc).toHaveBeenCalledWith('complete_push_outbox', {
      p_id: claimedRow.id,
      p_worker_id: expect.any(String),
      p_receipt_id: 'ticket-route-1',
    });
    const text = JSON.stringify(body);
    for (const secret of ['EXPO_ACCESS_TOKEN', EXPO_TOKEN_VALUE, PUSH_TOKEN, '献立ができました', '10月20日', REQUEST_ID, USER_ID]) {
      expect(text).not.toContain(secret);
    }
    expect(mocks.logInfo).toHaveBeenCalledWith('Push の送信待ちを処理しました', expect.objectContaining({ claimed: 1, sent: 1 }));

    // 何も無い回は idle (掃除の件数は summary に入る)
    rpcResults.claim_push_outbox = { data: [], error: null };
    rpcResults.cleanup_push_outbox = { data: [{ expired: 0, sent_deleted: 0, dead_deleted: 0 }], error: null };
    const idle = await GET(authed());
    await expect(idle.json()).resolves.toMatchObject({ status: 'idle', claimed: 0, receipts_claimed: 0, cleaned_expired: 0 });
  });

  it('不正な PUSH_OUTBOX_* は既定値に戻し、変数名だけを warn に残す', async () => {
    vi.stubEnv('PUSH_OUTBOX_MAX_ATTEMPTS', '99');
    vi.stubEnv('PUSH_OUTBOX_BATCH_SIZE', '42');

    const res = await GET(authed());

    expect(res.status).toBe(200);
    expect(mocks.logWarn).toHaveBeenCalledWith('Push の送信待ちの環境変数の値が正しくないため、既定値を使います', {
      ignored_env: ['PUSH_OUTBOX_MAX_ATTEMPTS'],
    });
    expect(mocks.rpc).toHaveBeenCalledWith('claim_push_outbox', expect.objectContaining({ p_limit: 42 }));
  });

  it('RPC の失敗は 500 の汎用の本文', async () => {
    rpcResults.claim_push_outbox = { data: null, error: { code: '42501', message: 'permission denied for function claim_push_outbox' } };

    const res = await GET(authed());

    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toContain('permission denied');
    expect(text).not.toContain('claim_push_outbox');
    expect(mocks.logError).toHaveBeenCalled();

    // 鍵が無い回の掃除の失敗も 500
    vi.stubEnv('EXPO_ACCESS_TOKEN', undefined);
    rpcResults.cleanup_push_outbox = { data: null, error: { code: 'XX000', message: 'cleanup failed' } };
    const cleanupFailed = await GET(authed());
    expect(cleanupFailed.status).toBe(500);
    expect(await cleanupFailed.text()).not.toContain('cleanup failed');
  });
});
