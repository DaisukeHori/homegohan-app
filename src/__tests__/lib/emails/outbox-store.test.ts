import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createOutboxStore } from '@/lib/emails/outbox-store';
import type { EmailOutboxClaimedRow } from '@/lib/emails/outbox';

// #1193 送信待ち (email_outbox) の DB の読み書き (RPC 3 本)。設計: docs/design/operator/10-logs-and-mail-retry.md §6.4・§12。
// service role の client は引数で渡す (getSupabaseAdmin を呼ばせない)
const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  getSupabaseAdmin: vi.fn(),
}));

vi.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: mocks.getSupabaseAdmin,
}));

type AdminArg = Parameters<typeof createOutboxStore>[0];
const admin = { rpc: mocks.rpc } as unknown as AdminArg;

const ROW: EmailOutboxClaimedRow = {
  id: '00000000-0000-4000-8000-000000000001',
  template: 'family_invite',
  to_email: 'test@example.com',
  from_email: 'noreply@example.test',
  reply_to: null,
  subject: '件名',
  text_body: '本文',
  html_body: null,
  idempotency_key: 'idem-1',
  attempts: 2,
  created_at: '2026-10-16T00:00:00.000Z',
  redact_after_send: false,
};
const FAILURE = { code: 'application_error', message: 'Service Unavailable', statusCode: 503, retryable: true };
const POLICY = { maxAttempts: 6, retryAfterSeconds: 300 };
/** DB の生のエラー文 (例外の message に入れてはいけない目印) */
const RAW_DB_MESSAGE = 'permission denied for function claim_email_outbox (secret detail)';

beforeEach(() => {
  mocks.rpc.mockReset();
  mocks.getSupabaseAdmin.mockReset();
});

describe('createOutboxStore', () => {
  it('引数の client が無ければ getSupabaseAdmin を使う', () => {
    mocks.getSupabaseAdmin.mockReturnValue({ rpc: mocks.rpc });

    createOutboxStore();

    expect(mocks.getSupabaseAdmin).toHaveBeenCalledTimes(1);
  });
});

describe('claim', () => {
  it('RPC の引数と応答の検証: claim_email_outbox を worker_id・件数・リースで呼び、行を検証して返す', async () => {
    mocks.rpc.mockResolvedValueOnce({ data: [{ ...ROW, status: 'queued', worker_id: 'w-1' }], error: null });

    const rows = await createOutboxStore(admin).claim('w-1', 20, 120);

    expect(mocks.rpc).toHaveBeenCalledWith('claim_email_outbox', { p_worker_id: 'w-1', p_limit: 20, p_lease_seconds: 120 });
    expect(rows).toEqual([ROW]);
  });

  it('応答の形が違えば例外 (黙って 0 件にしない)', async () => {
    mocks.rpc.mockResolvedValueOnce({ data: [{ id: 'x' }], error: null });

    await expect(createOutboxStore(admin).claim('w-1', 20, 120)).rejects.toThrow();
  });
});

describe('complete', () => {
  it('complete_email_outbox を id・worker_id・Resend の ID で呼び、true / false を返す', async () => {
    mocks.rpc.mockResolvedValueOnce({ data: true, error: null }).mockResolvedValueOnce({ data: false, error: null });
    const store = createOutboxStore(admin);

    await expect(store.complete(ROW.id, 'w-1', 'resend-1')).resolves.toBe(true);
    await expect(store.complete(ROW.id, 'w-1', 'resend-1')).resolves.toBe(false);
    expect(mocks.rpc).toHaveBeenCalledWith('complete_email_outbox', { p_id: ROW.id, p_worker_id: 'w-1', p_resend_message_id: 'resend-1' });
  });

  it('true 以外の値 (null など) は false', async () => {
    mocks.rpc.mockResolvedValueOnce({ data: null, error: null });

    await expect(createOutboxStore(admin).complete(ROW.id, 'w-1', 'resend-1')).resolves.toBe(false);
  });
});

describe('fail', () => {
  it("fail_email_outbox を失敗の中身と方針で呼び、'queued' / 'dead' を返す", async () => {
    mocks.rpc.mockResolvedValueOnce({ data: 'queued', error: null }).mockResolvedValueOnce({ data: 'dead', error: null });
    const store = createOutboxStore(admin);

    await expect(store.fail(ROW.id, 'w-1', FAILURE, POLICY)).resolves.toBe('queued');
    await expect(store.fail(ROW.id, 'w-1', FAILURE, POLICY)).resolves.toBe('dead');
    expect(mocks.rpc).toHaveBeenCalledWith('fail_email_outbox', {
      p_id: ROW.id,
      p_worker_id: 'w-1',
      p_error_code: 'application_error',
      p_error_message: 'Service Unavailable',
      p_status_code: 503,
      p_retryable: true,
      p_max_attempts: 6,
      p_retry_after_seconds: 300,
    });
  });

  it("statusCode が null の失敗は p_status_code に null を渡す", async () => {
    mocks.rpc.mockResolvedValueOnce({ data: 'dead', error: null });

    await createOutboxStore(admin).fail(ROW.id, 'w-1', { ...FAILURE, statusCode: null, retryable: false }, POLICY);

    expect(mocks.rpc.mock.calls[0][1]).toMatchObject({ p_status_code: null, p_retryable: false });
  });

  it.each([['ignored'], [null], ['sent'], [42]])("それ以外 (%s) は 'ignored'", async (data) => {
    mocks.rpc.mockResolvedValueOnce({ data, error: null });

    await expect(createOutboxStore(admin).fail(ROW.id, 'w-1', FAILURE, POLICY)).resolves.toBe('ignored');
  });
});

describe('RPC の error', () => {
  it.each([
    ['claim', (store: ReturnType<typeof createOutboxStore>) => store.claim('w-1', 20, 120), 'claim_email_outbox'],
    ['complete', (store: ReturnType<typeof createOutboxStore>) => store.complete(ROW.id, 'w-1', 'r'), 'complete_email_outbox'],
    ['fail', (store: ReturnType<typeof createOutboxStore>) => store.fail(ROW.id, 'w-1', FAILURE, POLICY), 'fail_email_outbox'],
  ])('%s: RPC の error は例外 (DB の文は message に入れない。コードだけ)', async (_label, call, rpcName) => {
    mocks.rpc.mockResolvedValueOnce({ data: null, error: { message: RAW_DB_MESSAGE, code: '42501' } });

    const error = await call(createOutboxStore(admin)).then(
      () => null,
      (err: unknown) => err,
    );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(`${rpcName} failed: 42501`);
    expect((error as Error).message).not.toContain('secret detail');
  });

  it('コードが無い error は unknown', async () => {
    mocks.rpc.mockResolvedValueOnce({ data: null, error: { message: RAW_DB_MESSAGE } });

    await expect(createOutboxStore(admin).claim('w-1', 20, 120)).rejects.toThrow('claim_email_outbox failed: unknown');
  });
});
