/**
 * POST /api/account/delete (src/app/api/account/delete/route.ts, #1175) の単体テスト
 *
 * 退会の本体は src/lib/account-deletion.ts (tests/account-deletion.test.ts で確認)。ここは入口だけを確認する:
 *   - 認証: 未ログインは 401 で、service_role の client を作らず、何も削除しない
 *   - confirm が無ければ 400 (service_role の client を作らない)
 *   - 本人のセッションで確認した user.id だけを、本体に渡す (リクエストの本文の user_id などは見ない)
 *   - 結果の HTTP への変換: 成功は { success: true }、409 は従来と同じ形、
 *     失敗は #1172 の internalError (汎用メッセージと INTERNAL_ERROR だけ。生のエラー文・段階・request_id は本文に出さない)
 *   - service_role の設定が無いときも、生のエラー文を返さず internalError の 500 にする
 *   - Storage の削除に時間がかかるので maxDuration を 60 秒にしてある
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  getSupabaseAdmin: vi.fn(),
  deleteAccount: vi.fn(),
  loggerError: vi.fn(),
  withUser: vi.fn(),
  createLogger: vi.fn(),
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { getUser: mocks.getUser } }),
  getSupabaseAdmin: mocks.getSupabaseAdmin,
}));

vi.mock('@/lib/db-logger', () => ({
  createLogger: (...args: unknown[]) => {
    mocks.createLogger(...args);
    return {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: mocks.loggerError,
      withUser: (userId: string) => {
        mocks.withUser(userId);
        return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: mocks.loggerError };
      },
    };
  },
  generateRequestId: () => 'req_route_test',
}));

// 本体だけを差し替える (HTTP への変換 accountDeletionHttp などは本物を使う)
vi.mock('@/lib/account-deletion', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/lib/account-deletion')>();
  return { ...original, deleteAccount: mocks.deleteAccount };
});

import { POST, maxDuration } from '../src/app/api/account/delete/route';
import { INTERNAL_ERROR_CODE, INTERNAL_ERROR_MESSAGE } from '../src/lib/api/errors';

const USER = { id: '11111111-1111-4111-8111-111111111111', email: 'someone@example.com' };
const ADMIN_CLIENT = { marker: 'service-role-client' };

function request(body?: unknown) {
  return new Request('http://localhost/api/account/delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getUser.mockResolvedValue({ data: { user: USER }, error: null });
  mocks.getSupabaseAdmin.mockReturnValue(ADMIN_CLIENT);
  mocks.deleteAccount.mockResolvedValue({ ok: true });
});

describe('POST /api/account/delete: 入口の確認', () => {
  it('未ログインは 401。service_role の client を作らず、何も削除しない', async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null }, error: { message: 'Auth session missing!' } });
    const res = await POST(request({ confirm: true }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
    expect(mocks.getSupabaseAdmin).not.toHaveBeenCalled();
    expect(mocks.deleteAccount).not.toHaveBeenCalled();
  });

  it('getUser がエラーを返したときも 401', async () => {
    mocks.getUser.mockResolvedValue({ data: { user: USER }, error: { message: 'jwt expired' } });
    expect((await POST(request({ confirm: true }))).status).toBe(401);
    expect(mocks.deleteAccount).not.toHaveBeenCalled();
  });

  it('confirm が無い・false・本文が壊れているときは 400。service_role の client を作らない', async () => {
    for (const body of [{}, { confirm: false }, 'not json', undefined]) {
      const res = await POST(request(body));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'confirm is required' });
    }
    expect(mocks.getSupabaseAdmin).not.toHaveBeenCalled();
    expect(mocks.deleteAccount).not.toHaveBeenCalled();
  });

  it('本体に渡すのは、セッションで確認した user.id と service_role の client だけ (本文の user_id は見ない)', async () => {
    const res = await POST(request({ confirm: true, user_id: '99999999-9999-4999-8999-999999999999', userId: 'x' }));
    expect(res.status).toBe(200);
    expect(mocks.deleteAccount).toHaveBeenCalledTimes(1);
    expect(mocks.deleteAccount).toHaveBeenCalledWith({ userId: USER.id, admin: ADMIN_CLIENT, requestId: 'req_route_test' });
  });

  it('maxDuration は 60 秒 (Storage の削除に時間がかかることがある)', () => {
    expect(maxDuration).toBe(60);
  });
});

describe('POST /api/account/delete: 結果の HTTP への変換', () => {
  it('成功は 200 { success: true }', async () => {
    const res = await POST(request({ confirm: true }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
  });

  it('組織のオーナーは従来と同じ形の 409', async () => {
    mocks.deleteAccount.mockResolvedValue({
      ok: false,
      status: 409,
      error: 'ACCOUNT_DELETE_BLOCKED_ORG_OWNER',
      message: '組織のオーナーです。先にオーナーを譲渡するか組織を解散してください。',
      organization: { id: 'org-1', name: '株式会社テスト' },
    });
    const res = await POST(request({ confirm: true }));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: 'ACCOUNT_DELETE_BLOCKED_ORG_OWNER',
      message: '組織のオーナーです。先にオーナーを譲渡するか組織を解散してください。',
      organization: { id: 'org-1', name: '株式会社テスト' },
    });
  });

  it('家族の代表者は従来と同じ形の 409', async () => {
    mocks.deleteAccount.mockResolvedValue({
      ok: false,
      status: 409,
      error: 'ACCOUNT_DELETE_BLOCKED_FAMILY_REPRESENTATIVE',
      message: '家族グループの代表者です。先に代表者を譲渡するか家族グループを解散してください。',
      family_group: { id: 'fg-1', name: 'うちの家族' },
    });
    const res = await POST(request({ confirm: true }));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: 'ACCOUNT_DELETE_BLOCKED_FAMILY_REPRESENTATIVE',
      message: '家族グループの代表者です。先に代表者を譲渡するか家族グループを解散してください。',
      family_group: { id: 'fg-1', name: 'うちの家族' },
    });
  });

  it('失敗 (ACCOUNT_DELETE_FAILED) は #1172 の internalError: 汎用メッセージと INTERNAL_ERROR だけ (段階・request_id・生のエラー文を出さない)', async () => {
    mocks.deleteAccount.mockResolvedValue({
      ok: false,
      status: 500,
      error: 'ACCOUNT_DELETE_FAILED',
      request_id: 'req_route_test',
      step: 'storage',
    });
    const res = await POST(request({ confirm: true }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({ error: INTERNAL_ERROR_MESSAGE, code: INTERNAL_ERROR_CODE });
    expect(JSON.stringify(body)).not.toContain('storage');
    expect(JSON.stringify(body)).not.toContain('req_route_test');
    // 500 を返したことは、同じ request_id と段階でログに残す (原因は deleteAccount 側のログにある)
    expect(mocks.loggerError).toHaveBeenCalledTimes(1);
    const [, loggedError, metadata] = mocks.loggerError.mock.calls[0];
    expect((loggedError as Error).message).toBe('account deletion failed at step: storage');
    expect(metadata).toMatchObject({ step: 'storage' });
    // 削除後かもしれないので user_id を付けない (app_logs.user_id の外部キーで記録が保存できなくなる)
    expect(mocks.withUser).not.toHaveBeenCalled();
    expect(mocks.createLogger).toHaveBeenCalledWith('POST /api/account/delete', 'req_route_test');
  });

  it('service_role の設定が無いとき (getSupabaseAdmin が例外) も、生のエラー文を返さず internalError の 500 にして、ログに残す', async () => {
    mocks.getSupabaseAdmin.mockImplementation(() => {
      throw new Error('Supabase admin env is missing (NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)');
    });
    const res = await POST(request({ confirm: true }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({ error: INTERNAL_ERROR_MESSAGE, code: INTERNAL_ERROR_CODE });
    expect(JSON.stringify(body)).not.toContain('SUPABASE_SERVICE_ROLE_KEY');
    expect(mocks.deleteAccount).not.toHaveBeenCalled();
    expect(mocks.loggerError).toHaveBeenCalledTimes(1);
    const [, loggedError, metadata] = mocks.loggerError.mock.calls[0];
    expect((loggedError as Error).message).toContain('SUPABASE_SERVICE_ROLE_KEY');
    expect(metadata).toMatchObject({ step: 'init' });
    // まだ削除していないので、本人の user_id を付けてよい
    expect(mocks.withUser).toHaveBeenCalledWith(USER.id);
  });
});
