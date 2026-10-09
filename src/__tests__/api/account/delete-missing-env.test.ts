// @vitest-environment node
/**
 * POST /api/account/delete の 500 の本文に、環境変数名も DB のエラー文も出さないことのテスト (#1172 / #1182)
 *
 * 以前この route は service_role のクライアントを自前で作り、環境変数が欠けていると
 * 'Supabase admin env is missing (NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)' を投げ、
 * catch がその error.message をそのまま 500 の本文に返していた。middleware は service_role キーを検査しないので、
 * service_role キーだけが欠けた環境では、ログイン済みの利用者が {confirm:true} を送るだけで変数名を受け取れた。
 *
 * いまは lib/supabase/server.ts の getSupabaseAdmin() (欠けていれば MissingEnvError。message は固定の文) を使い、
 * 500 は internalError() で返す。確かめること:
 *   1. 必須の変数が欠けていても、未ログインなら 401 (設定の不足を教えない)
 *   2. ログイン済みで欠けていれば、汎用の 500。本文・ヘッダに変数名が無い。変数名は構造化ログと、サーバーのログの 1 行に残る
 *   3. 設定がそろっていて削除が失敗しても、DB のエラー文を本文に出さない (構造化ログには元のエラーが渡る)
 *   4. 成功すれば 200 { success: true } (切り替えで成功の経路を壊していない)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetUser = vi.fn();

// lib/supabase/server.ts の getSupabaseAdmin は本物を使う (環境変数の取り出しを含めて確かめる)。
// cookie を読む createClient だけを差し替える
vi.mock('@/lib/supabase/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/supabase/server')>();
  return {
    ...actual,
    createClient: vi.fn(async () => ({ auth: { getUser: mockGetUser } })),
  };
});

// service_role のクライアント (getSupabaseAdmin の中の createClient)。DB には触れない
const mockDeleteUser = vi.fn();
const mockRpc = vi.fn();
const mockAdminFrom = vi.fn();
const mockCreateAdminClient = vi.fn((_url: string, _key: string, _options: unknown) => ({
  from: mockAdminFrom,
  rpc: mockRpc,
  auth: { admin: { deleteUser: mockDeleteUser } },
}));
vi.mock('@supabase/supabase-js', () => ({
  createClient: (url: string, key: string, options: unknown) => mockCreateAdminClient(url, key, options),
}));

// internalError() が使う構造化ログ。変数名・元のエラーがここに渡ることを見る
const mockLoggerError = vi.fn();
const mockWithUser = vi.fn();
vi.mock('@/lib/db-logger', () => ({
  createLogger: vi.fn(() => {
    const logger = { withUser: mockWithUser, error: mockLoggerError, warn: vi.fn() };
    mockWithUser.mockReturnValue(logger);
    return logger;
  }),
  generateRequestId: vi.fn(() => 'req-test'),
}));

import { POST } from '@/app/api/account/delete/route';
import { MISSING_ENV_SERVER_LOG_PREFIX } from '@/lib/env-required';

const USER_ID = '00000000-0000-4000-8000-0000000000aa';
const URL_VALUE = 'https://account-delete-test.supabase.co';
const SERVICE_VALUE = 'service-role-value-must-not-leak';
const REQUIRED_NAMES = ['NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'] as const;
const GENERIC_BODY = { error: '処理中にエラーが発生しました', code: 'INTERNAL_ERROR' };
/** DB (auth) が返しうる生のエラー文。本文に出てはいけない */
const RAW_DB_ERROR = 'update or delete on table "users" violates foreign key constraint "x_user_id_fkey"';

/** select().eq().limit() / delete().eq() / update().eq() のどれにも答える、空の結果を返すクエリ */
function emptyQuery() {
  const result = { data: [], error: null };
  const query: Record<string, unknown> = {};
  for (const method of ['select', 'eq', 'delete', 'update']) query[method] = vi.fn(() => query);
  query.limit = vi.fn(async () => result);
  query.then = (resolve: (value: typeof result) => unknown) => resolve(result);
  return query;
}

const makeRequest = (body: Record<string, unknown> = { confirm: true }) =>
  new Request('http://localhost/api/account/delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

let consoleError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', URL_VALUE);
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', SERVICE_VALUE);
  mockGetUser.mockResolvedValue({ data: { user: { id: USER_ID } }, error: null });
  mockAdminFrom.mockImplementation(() => emptyQuery());
  mockRpc.mockResolvedValue({ error: null });
  mockDeleteUser.mockResolvedValue({ error: null });
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('POST /api/account/delete — 必須の環境変数が欠けたとき (#1172 / #1182)', () => {
  it.each(REQUIRED_NAMES)('%s が未設定でも、未ログインなら 401 (設定の不足を教えない)', async (name) => {
    vi.stubEnv(name, undefined);
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null });

    const response = await POST(makeRequest());
    const text = await response.text();

    expect(response.status).toBe(401);
    for (const varName of REQUIRED_NAMES) expect(text).not.toContain(varName);
    expect(mockCreateAdminClient).not.toHaveBeenCalled();
  });

  it.each(REQUIRED_NAMES)('%s が未設定なら汎用の 500。本文・ヘッダに変数名が無く、変数名は構造化ログとサーバーのログに残る', async (name) => {
    vi.stubEnv(name, undefined);

    const response = await POST(makeRequest());
    const text = await response.text();

    expect(response.status).toBe(500);
    expect(JSON.parse(text)).toEqual(GENERIC_BODY);
    // 以前の本文 'Supabase admin env is missing (NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)' の両方の名前が無い
    for (const varName of REQUIRED_NAMES) {
      expect(text).not.toContain(varName);
      expect(JSON.stringify([...response.headers.entries()])).not.toContain(varName);
    }
    expect(text).not.toContain(SERVICE_VALUE);
    // 構造化ログ (db-logger) に、変数名を持つ MissingEnvError が渡る
    expect(mockLoggerError).toHaveBeenCalledTimes(1);
    expect(mockLoggerError.mock.calls[0][1]).toMatchObject({ name: 'MissingEnvError', envName: name });
    // ログは利用者に紐づける (user_id)
    expect(mockWithUser).toHaveBeenCalledWith(USER_ID);
    // サーバーのログにも変数名の 1 行が出る
    expect(consoleError).toHaveBeenCalledWith(MISSING_ENV_SERVER_LOG_PREFIX, name);
    // 何も削除しない
    expect(mockCreateAdminClient).not.toHaveBeenCalled();
    expect(mockDeleteUser).not.toHaveBeenCalled();
  });
});

describe('POST /api/account/delete — 設定がそろっているとき', () => {
  it('削除が失敗しても、DB のエラー文を本文に出さない (汎用の 500。元のエラーは構造化ログへ)', async () => {
    mockDeleteUser.mockResolvedValue({ error: { message: RAW_DB_ERROR, status: 500 } });

    const response = await POST(makeRequest());
    const text = await response.text();

    expect(response.status).toBe(500);
    expect(JSON.parse(text)).toEqual(GENERIC_BODY);
    expect(text).not.toContain('violates');
    expect(mockLoggerError).toHaveBeenCalledTimes(1);
    expect((mockLoggerError.mock.calls[0][1] as Error).message).toBe(RAW_DB_ERROR);
    expect(mockLoggerError.mock.calls[0][1]).not.toMatchObject({ name: 'MissingEnvError' });
  });

  it('成功すれば 200 { success: true }。service_role のクライアントは共通の getSupabaseAdmin が環境変数の値で作る', async () => {
    const response = await POST(makeRequest());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true });
    expect(mockCreateAdminClient).toHaveBeenCalledTimes(1);
    expect(mockCreateAdminClient.mock.calls[0][0]).toBe(URL_VALUE);
    expect(mockCreateAdminClient.mock.calls[0][1]).toBe(SERVICE_VALUE);
    expect(mockDeleteUser).toHaveBeenCalledWith(USER_ID);
    expect(mockLoggerError).not.toHaveBeenCalled();
  });
});
