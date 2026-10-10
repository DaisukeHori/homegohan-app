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
 *
 * 退会の本体は src/lib/account-deletion.ts の deleteAccount (#1175)。route は入口の確認と結果の変換だけを行う。
 * deleteAccount は prepare_account_deletion (rpc) → release_user_membership (rpc) → Storage の掃除 → deleteUser の順に進み、
 * 失敗したら元のエラーを自分の構造化ログ (step 付き) に残して ACCOUNT_DELETE_FAILED を返す。route はそれを internalError で 500 にする。
 * そのため削除が失敗したときの構造化ログは 2 件 (lib の元のエラー + route の 500) になる。
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
// 退会の完了メール (#1152) の宛先を、削除の前に引く
const mockGetUserById = vi.fn();
const mockRpc = vi.fn();
const mockAdminFrom = vi.fn();
// Storage の掃除 (src/lib/account-deletion-storage.ts)。本人のフォルダは空 (一覧が空なら remove は呼ばれない)
const mockStorageList = vi.fn();
const mockStorageRemove = vi.fn();
const mockStorageFrom = vi.fn((_bucket: string) => ({ list: mockStorageList, remove: mockStorageRemove }));
const mockCreateAdminClient = vi.fn((_url: string, _key: string, _options: unknown) => ({
  from: mockAdminFrom,
  rpc: mockRpc,
  storage: { from: mockStorageFrom },
  auth: { admin: { deleteUser: mockDeleteUser, getUserById: mockGetUserById } },
}));
vi.mock('@supabase/supabase-js', () => ({
  createClient: (url: string, key: string, options: unknown) => mockCreateAdminClient(url, key, options),
}));

// 退会の完了メール (#1152) の送信。Resend には送らない
const mockSendEmail = vi.fn();
vi.mock('@/lib/emails/send', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/emails/send')>();
  return { ...actual, sendEmail: (...args: unknown[]) => mockSendEmail(...args) };
});

// internalError() が使う構造化ログ。変数名・元のエラーがここに渡ることを見る
const mockLoggerError = vi.fn();
const mockLoggerWarn = vi.fn();
const mockLoggerInfo = vi.fn();
const mockWithUser = vi.fn();
const mockCreateLogger = vi.fn();
vi.mock('@/lib/db-logger', () => ({
  createLogger: vi.fn((functionName: string, requestId: string) => {
    mockCreateLogger(functionName, requestId);
    const logger = { withUser: mockWithUser, error: mockLoggerError, warn: mockLoggerWarn, info: mockLoggerInfo };
    mockWithUser.mockReturnValue(logger);
    return logger;
  }),
  generateRequestId: vi.fn(() => 'req-test'),
}));

import { POST } from '@/app/api/account/delete/route';
import { MISSING_ENV_SERVER_LOG_PREFIX } from '@/lib/env-required';

const USER_ID = '00000000-0000-4000-8000-0000000000aa';
const USER_EMAIL = 'leaving-user@example.com';
const URL_VALUE = 'https://account-delete-test.supabase.co';
const SERVICE_VALUE = 'service-role-value-must-not-leak';
const REQUIRED_NAMES = ['NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'] as const;
const GENERIC_BODY = { error: '処理中にエラーが発生しました', code: 'INTERNAL_ERROR' };
/** DB (auth) が返しうる生のエラー文。本文に出てはいけない */
const RAW_DB_ERROR = 'update or delete on table "users" violates foreign key constraint "x_user_id_fkey"';

/** route / deleteAccount の構造化ログの function_name */
const ROUTE_LOG_NAME = 'POST /api/account/delete';
const LIB_LOG_NAME = 'lib/account-deletion';

/**
 * select().eq().limit() / delete().eq() / update().eq() と、Storage の掃除が使う
 * select().eq().not().order().range() のどれにも答える、空の結果を返すクエリ
 */
function emptyQuery() {
  const result = { data: [], error: null };
  const query: Record<string, unknown> = {};
  for (const method of ['select', 'eq', 'delete', 'update', 'not', 'order', 'range']) query[method] = vi.fn(() => query);
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
  mockGetUserById.mockResolvedValue({ data: { user: { id: USER_ID, email: USER_EMAIL } }, error: null });
  mockSendEmail.mockResolvedValue({ ok: true, id: 'email-1', attempts: 1, skipped: false, error: null });
  mockStorageList.mockResolvedValue({ data: [], error: null });
  mockStorageRemove.mockResolvedValue({ data: [], error: null });
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
    // 段階・request_id も本文に出さない (ログにだけ残す)
    expect(text).not.toContain('delete_user');
    expect(text).not.toContain('req-test');
    // 構造化ログは 2 件: deleteAccount が元のエラーを step 付きで残し、route が 500 を返したことを残す
    expect(mockLoggerError).toHaveBeenCalledTimes(2);
    expect(mockCreateLogger).toHaveBeenCalledWith(LIB_LOG_NAME, 'req-test');
    expect(mockCreateLogger).toHaveBeenCalledWith(ROUTE_LOG_NAME, 'req-test');
    const [libCall, routeCall] = mockLoggerError.mock.calls;
    // 1 件目 (deleteAccount): 元の DB のエラー文がそのまま渡る
    expect(libCall[0]).toBe('account deletion failed at step: delete_user');
    expect((libCall[1] as Error).message).toBe(RAW_DB_ERROR);
    expect(libCall[2]).toMatchObject({ step: 'delete_user', request_id: 'req-test' });
    // 2 件目 (route の internalError): 段階は渡るが、元の DB のエラー文は二重に載せない
    expect((routeCall[1] as Error).message).toBe('account deletion failed at step: delete_user');
    expect(routeCall[2]).toMatchObject({ step: 'delete_user' });
    for (const call of mockLoggerError.mock.calls) {
      expect(call[1]).not.toMatchObject({ name: 'MissingEnvError' });
    }
    // 削除前のログは利用者に紐づける (user_id)
    expect(mockWithUser).toHaveBeenCalledWith(USER_ID);
    // 退会が失敗したので、完了メール (#1152) は送らない
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it('成功すれば 200 { success: true }。service_role のクライアントは共通の getSupabaseAdmin が環境変数の値で作る', async () => {
    const response = await POST(makeRequest());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true });
    expect(mockCreateAdminClient).toHaveBeenCalledTimes(1);
    expect(mockCreateAdminClient.mock.calls[0][0]).toBe(URL_VALUE);
    expect(mockCreateAdminClient.mock.calls[0][1]).toBe(SERVICE_VALUE);
    expect(mockDeleteUser).toHaveBeenCalledWith(USER_ID);
    // deleteAccount の流れを通っている: メールアドレスを伏せる準備 → 席の解放 → Storage の掃除 → deleteUser
    expect(mockRpc).toHaveBeenCalledWith('prepare_account_deletion', { p_user_id: USER_ID });
    expect(mockRpc).toHaveBeenCalledWith('release_user_membership', { p_user_id: USER_ID });
    expect(mockStorageList).toHaveBeenCalled();
    expect(mockLoggerError).not.toHaveBeenCalled();
    // Storage の URL の読み出しも含めて、どの段階も警告なしで通る
    expect(mockLoggerWarn).not.toHaveBeenCalled();
    expect(mockLoggerInfo).toHaveBeenCalledWith('account deleted', expect.objectContaining({ request_id: 'req-test' }));
    // 退会の完了メール (#1152) を、削除の前に引いた本人のアドレスへ 1 通送る
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    expect(mockSendEmail.mock.calls[0][0]).toMatchObject({ to: USER_EMAIL, template: 'account_deleted' });
  });
});
