/**
 * T15 (#1154) cron (献立の生成のキュー) は、未同意の利用者のリクエストを AI へ送らない
 *
 * キューに積まれたあとに同意を撤回した利用者 (または同意の状況を読めない場合) のリクエストは、
 * Edge Function generate-menu-v5 を呼ばずに失敗にする。error_message は画面がそのまま出すので、コードではなく人向けの文
 * (AI_CONSENT_REQUIRED_MESSAGE / AI_CONSENT_CHECK_FAILED_MESSAGE) を書く (画面はこの文を見分けて同意画面へ案内する)。
 * 判定に使う user_id は、利用者が書き換えられる generated_data ではなく、行の user_id。
 * 判定は差し替えない (src/lib/ai/consent-guard.ts をそのまま使う)。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AI_CONSENT_CHECK_FAILED_CODE,
  AI_CONSENT_CHECK_FAILED_MESSAGE,
  AI_CONSENT_PROVIDERS,
  AI_CONSENT_REQUIRED_CODE,
  AI_CONSENT_REQUIRED_MESSAGE,
  AI_CONSENT_VERSION,
} from '../supabase/functions/_shared/ai-consent';

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  fetch: vi.fn(),
  consentResult: { data: [] as unknown, error: null as unknown },
  consentUserIds: [] as unknown[],
  updates: [] as Array<{ values: Record<string, unknown>; filters: Array<[string, string, unknown]> }>,
}));

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    rpc: mocks.rpc,
    from: (table: string) => ({
      select: () => ({
        eq: (_column: string, value: unknown) => {
          mocks.consentUserIds.push(value);
          return { is: async () => (table === 'external_data_consents' ? mocks.consentResult : { data: null, error: null }) };
        },
      }),
      update: (values: Record<string, unknown>) => {
        const entry = { values, filters: [] as Array<[string, string, unknown]> };
        mocks.updates.push(entry);
        const chain = {
          eq: (column: string, value: unknown) => {
            entry.filters.push(['eq', column, value]);
            return chain;
          },
          in: async (column: string, value: unknown) => {
            entry.filters.push(['in', column, value]);
            return { data: null, error: null };
          },
        };
        return chain;
      },
    }),
  })),
}));

vi.mock('@/lib/db-logger', () => ({
  createLogger: () => ({
    withUser: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

const { GET } = await import('@/app/api/cron/process-menu-queue/route');

const ROW_USER = '11111111-1111-4111-8111-111111111111';

function claimed() {
  return {
    id: 'req-1',
    user_id: ROW_USER,
    status: 'processing',
    attempt_count: 1,
    current_step: 1,
    // 利用者が書き換えられる generated_data の userId は判定に使わない
    generated_data: { userId: '22222222-2222-4222-8222-222222222222' },
  };
}

function call() {
  return GET(new Request('http://localhost/api/cron/process-menu-queue', { headers: { authorization: 'Bearer cron-secret' } }));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.consentUserIds.length = 0;
  mocks.updates.length = 0;
  vi.stubEnv('CRON_SECRET', 'cron-secret');
  vi.stubEnv('CRON_SECRET_PREVIOUS', undefined);
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://example.supabase.co');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-role-key');
  vi.stubGlobal('fetch', mocks.fetch);
  mocks.fetch.mockImplementation(async () => new Response(JSON.stringify({ status: 'processing' }), { status: 202 }));
  mocks.rpc.mockResolvedValue({ data: claimed(), error: null });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('cron/process-menu-queue: 同意の判定', () => {
  it('未同意: Edge Function を呼ばず、行を「同意が必要です」の文で失敗にする (自分が取った行・処理中の行だけ)', async () => {
    mocks.consentResult = { data: [], error: null };
    const res = await call();

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ skipped: 'req-1', code: 'AI_CONSENT_REQUIRED' });
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.consentUserIds).toEqual([ROW_USER]);
    expect(mocks.updates).toHaveLength(1);
    expect(mocks.updates[0].values).toMatchObject({ status: 'failed', error_message: AI_CONSENT_REQUIRED_MESSAGE });
    // コードそのもの (画面に英字のまま出てしまう) は書かない
    expect(mocks.updates[0].values.error_message).not.toBe(AI_CONSENT_REQUIRED_CODE);
    expect(mocks.updates[0].filters).toEqual(
      expect.arrayContaining([
        ['eq', 'id', 'req-1'],
        ['in', 'status', ['queued', 'processing']],
      ]),
    );
  });

  it('同意の状況を読めない: Edge Function を呼ばず、「一時的に使えません」の文で失敗にする (fail-closed)', async () => {
    mocks.consentResult = { data: null, error: { message: 'boom' } };
    const res = await call();
    await expect(res.json()).resolves.toEqual({ skipped: 'req-1', code: 'AI_CONSENT_CHECK_FAILED' });
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.updates[0].values).toMatchObject({ status: 'failed', error_message: AI_CONSENT_CHECK_FAILED_MESSAGE });
    expect(mocks.updates[0].values.error_message).not.toBe(AI_CONSENT_CHECK_FAILED_CODE);
  });

  it('同意済み: Edge Function generate-menu-v5 を呼ぶ', async () => {
    mocks.consentResult = {
      data: AI_CONSENT_PROVIDERS.map((provider) => ({ provider, consented: true, policy_version: AI_CONSENT_VERSION })),
      error: null,
    };
    const res = await call();
    expect(res.status).toBe(200);
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(String(mocks.fetch.mock.calls[0][0])).toBe('https://example.supabase.co/functions/v1/generate-menu-v5');
    expect(mocks.updates).toHaveLength(0);
  });
});
