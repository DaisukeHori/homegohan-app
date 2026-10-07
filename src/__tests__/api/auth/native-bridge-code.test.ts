/**
 * #1036 POST /api/auth/native-bridge/code の単体テスト
 *
 * カバレッジ:
 *   1. 認証: Authorization: Bearer 必須 (無い / 形式違い / Cookie だけ / 不正な JWT は 401)。
 *      JWT は引数つき getUser(jwt) で検証する (Cookie のセッションを見ない)
 *   2. 入力: body が JSON でない / refresh_token が無い・空・文字列でない・長すぎる は 400
 *   3. アクセストークンの残り有効期間が 60 秒未満は 401 (AUTH_TOKEN_EXPIRING)。リフレッシュトークンのローテーションを避ける
 *   4. 凍結中のアカウントは 403 (一時 BAN の期限切れは通す)。確認できないときは 503
 *   5. 発行: 43 文字の base64url コード + expires_in 60 + no-store。RPC には sha256(コード) を渡し、コード本体は渡さない
 *   6. RPC の失敗は 503。ログには body・コード・トークンを出さない
 */

import { createHash } from 'node:crypto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── モック ────────────────────────────────────────────────────────────────────
const { mockGetUser, mockMaybeSingle, mockRpc, mockFrom, mockGetSupabaseAdmin } = vi.hoisted(() => ({
  mockGetUser: vi.fn(),
  mockMaybeSingle: vi.fn(),
  mockRpc: vi.fn(),
  mockFrom: vi.fn(),
  mockGetSupabaseAdmin: vi.fn(),
}));

vi.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: mockGetSupabaseAdmin,
}));

// 構造化ログ (5xx は createLogger(...).withUser(user.id).error(...) で記録される)
const { mockLogError, mockLogInfo, mockLogWarn, mockWithUser, mockRootError } = vi.hoisted(() => {
  const mockLogError = vi.fn();
  const mockLogInfo = vi.fn();
  const mockLogWarn = vi.fn();
  const mockRootError = vi.fn();
  const mockWithUser = vi.fn(() => ({
    debug: vi.fn(),
    info: mockLogInfo,
    warn: mockLogWarn,
    error: mockLogError,
  }));
  return { mockLogError, mockLogInfo, mockLogWarn, mockWithUser, mockRootError };
});

// vi.fn ではなく素の関数にして、ほかのテストの mockReset / restore で実装が消えないようにする
vi.mock('@/lib/db-logger', () => ({
  createLogger: () => ({
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: mockRootError,
    withUser: mockWithUser,
  }),
  generateRequestId: () => 'req_test',
}));

import { POST } from '@/app/api/auth/native-bridge/code/route';

// ── フィクスチャ ──────────────────────────────────────────────────────────────
const NOW_MS = Date.parse('2026-10-07T12:00:00Z');
const NOW_SEC = Math.floor(NOW_MS / 1000);
const USER_ID = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';
const REFRESH_TOKEN = 'refresh-token-value-that-must-not-leak';

const b64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

/** exp を指定した JWT 形式の文字列 (署名の検証は getUser のモックが担うので、署名部は何でもよい) */
function makeJwt(exp: number | null, extra: Record<string, unknown> = {}): string {
  const payload: Record<string, unknown> = { sub: USER_ID, role: 'authenticated', ...extra };
  if (exp !== null) payload.exp = exp;
  return `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url(payload)}.signature-that-must-not-leak`;
}

/** 有効期限が 1 時間先の JWT (通常のアクセストークン) */
const validJwt = () => makeJwt(NOW_SEC + 3600);

interface RequestOptions {
  authorization?: string | null;
  cookie?: string;
  body?: unknown;
  rawBody?: string;
  headers?: Record<string, string>;
}

function postRequest(options: RequestOptions = {}) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...(options.headers ?? {}) };
  if (options.authorization !== null) {
    headers.Authorization = options.authorization ?? `Bearer ${validJwt()}`;
  }
  if (options.cookie) headers.Cookie = options.cookie;
  const body =
    options.rawBody !== undefined
      ? options.rawBody
      : JSON.stringify(options.body === undefined ? { refresh_token: REFRESH_TOKEN } : options.body);
  return new Request('http://localhost/api/auth/native-bridge/code', { method: 'POST', headers, body });
}

const sha256Hex = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

/** ログ・コンソールに出た内容をまとめて文字列にする (秘密情報が混ざっていないかの検査用) */
function everythingLogged(consoleSpies: Array<ReturnType<typeof vi.spyOn>>): string {
  const calls = [
    ...mockRootError.mock.calls,
    ...mockLogError.mock.calls,
    ...mockLogInfo.mock.calls,
    ...mockLogWarn.mock.calls,
    ...mockWithUser.mock.calls,
    ...consoleSpies.flatMap((spy) => spy.mock.calls),
  ];
  return JSON.stringify(calls, (_key, value) => (value instanceof Error ? `${value.name}:${value.message}:${value.stack}` : value));
}

let consoleSpies: Array<ReturnType<typeof vi.spyOn>>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW_MS);

  mockGetUser.mockReset();
  mockMaybeSingle.mockReset();
  mockRpc.mockReset();
  mockFrom.mockReset();
  mockGetSupabaseAdmin.mockReset();
  mockLogError.mockClear();
  mockLogInfo.mockClear();
  mockLogWarn.mockClear();
  mockWithUser.mockClear();
  mockRootError.mockClear();

  // 既定: 認証 OK・凍結なし・RPC 成功
  mockGetUser.mockResolvedValue({ data: { user: { id: USER_ID } }, error: null });
  const eq = vi.fn(() => ({ maybeSingle: mockMaybeSingle }));
  const select = vi.fn(() => ({ eq }));
  mockFrom.mockReturnValue({ select });
  mockMaybeSingle.mockResolvedValue({ data: { frozen_at: null, unban_at: null }, error: null });
  mockRpc.mockResolvedValue({ data: '2026-10-07T12:01:00.000Z', error: null });
  mockGetSupabaseAdmin.mockReturnValue({ auth: { getUser: mockGetUser }, from: mockFrom, rpc: mockRpc });

  consoleSpies = [
    vi.spyOn(console, 'log').mockImplementation(() => {}),
    vi.spyOn(console, 'info').mockImplementation(() => {}),
    vi.spyOn(console, 'warn').mockImplementation(() => {}),
    vi.spyOn(console, 'error').mockImplementation(() => {}),
  ];
});

afterEach(() => {
  vi.useRealTimers();
  for (const spy of consoleSpies) spy.mockRestore();
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. 認証
// ─────────────────────────────────────────────────────────────────────────────
describe('認証: Authorization: Bearer が必須', () => {
  it('Authorization が無い: 401 AUTH_UNAUTHENTICATED。Auth API も DB も呼ばない', async () => {
    const res = await POST(postRequest({ authorization: null }));
    const json = await res.json();

    expect(res.status).toBe(401);
    expect(json.error.code).toBe('AUTH_UNAUTHENTICATED');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(mockGetUser).not.toHaveBeenCalled();
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it.each([
    ['Basic 認証', 'Basic dXNlcjpwYXNz'],
    ['スキームのみ', 'Bearer'],
    ['スキームと空白のみ', 'Bearer   '],
    ['スキームなし', makeJwt(NOW_SEC + 3600)],
    ['トークンに空白を含む', 'Bearer abc def'],
  ])('Authorization の形式が不正 (%s): 401', async (_label, authorization) => {
    const res = await POST(postRequest({ authorization }));
    expect(res.status).toBe(401);
    expect(mockGetUser).not.toHaveBeenCalled();
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('Cookie のセッションだけ (Authorization なし): 401。Cookie 認証は受け付けない', async () => {
    const res = await POST(
      postRequest({ authorization: null, cookie: 'sb-abcdefgh-auth-token=%7B%22access_token%22%3A%22x%22%7D' }),
    );
    expect(res.status).toBe(401);
    expect(mockGetUser).not.toHaveBeenCalled();
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('JWT が不正 (Auth API が拒否): 401 AUTH_UNAUTHENTICATED。getUser にはヘッダの JWT を明示して渡す', async () => {
    const jwt = validJwt();
    mockGetUser.mockResolvedValue({
      data: { user: null },
      error: { name: 'AuthApiError', status: 401, message: 'invalid JWT' },
    });

    const res = await POST(postRequest({ authorization: `Bearer ${jwt}` }));
    const json = await res.json();

    expect(res.status).toBe(401);
    expect(json.error.code).toBe('AUTH_UNAUTHENTICATED');
    expect(mockGetUser).toHaveBeenCalledTimes(1);
    expect(mockGetUser).toHaveBeenCalledWith(jwt);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('Auth API がユーザーを返さない (user: null, error: null): 401', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null });
    const res = await POST(postRequest());
    expect(res.status).toBe(401);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it.each([
    ['ネットワーク断 (AuthRetryableFetchError)', { name: 'AuthRetryableFetchError', status: 0, message: 'fetch failed' }],
    ['Auth API の 5xx', { name: 'AuthApiError', status: 502, message: 'bad gateway' }],
  ])('Auth 基盤の障害 (%s): 401 ではなく 503 NATIVE_BRIDGE_UNAVAILABLE', async (_label, authError) => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: authError });
    const res = await POST(postRequest());
    const json = await res.json();
    expect(res.status).toBe(503);
    expect(json.error.code).toBe('NATIVE_BRIDGE_UNAVAILABLE');
    expect(mockRpc).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. 入力
// ─────────────────────────────────────────────────────────────────────────────
describe('入力: body は { refresh_token: 1〜1024 文字の文字列 }', () => {
  it.each([
    ['JSON でない', { rawBody: 'this is not json' }],
    ['空の body', { rawBody: '' }],
    ['空のオブジェクト', { body: {} }],
    ['refresh_token が空文字', { body: { refresh_token: '' } }],
    ['refresh_token が数値', { body: { refresh_token: 12345 } }],
    ['refresh_token が null', { body: { refresh_token: null } }],
    ['refresh_token が配列', { body: { refresh_token: ['a'] } }],
    ['refresh_token が 1025 文字', { body: { refresh_token: 'x'.repeat(1025) } }],
    ['body が配列', { body: ['refresh_token'] }],
    ['body が null', { body: null }],
    ['body が文字列', { body: 'refresh_token' }],
    ['access_token だけ (refresh_token なし)', { body: { access_token: 'x' } }],
    ['body が大きすぎる', { rawBody: JSON.stringify({ refresh_token: 'x', padding: 'y'.repeat(5000) }) }],
  ] as Array<[string, RequestOptions]>)('%s: 400 NATIVE_BRIDGE_BAD_REQUEST。Auth API も DB も呼ばない', async (_label, options) => {
    const res = await POST(postRequest(options));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error.code).toBe('NATIVE_BRIDGE_BAD_REQUEST');
    expect(mockGetUser).not.toHaveBeenCalled();
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('refresh_token が 1 文字と 1024 文字ちょうどは受け付ける', async () => {
    for (const refresh_token of ['x', 'y'.repeat(1024)]) {
      mockRpc.mockClear();
      const res = await POST(postRequest({ body: { refresh_token } }));
      expect(res.status).toBe(200);
      expect(mockRpc.mock.calls[0][1].p_refresh_token).toBe(refresh_token);
    }
  });

  it('body に余計なキーがあっても受け付ける (保存するのは refresh_token だけ)', async () => {
    const res = await POST(postRequest({ body: { refresh_token: REFRESH_TOKEN, platform: 'ios', access_token: 'ignored' } }));
    expect(res.status).toBe(200);
    expect(JSON.stringify(mockRpc.mock.calls)).not.toContain('ignored');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. アクセストークンの残り有効期間
// ─────────────────────────────────────────────────────────────────────────────
describe('アクセストークンの有効期限が近い・読めない場合は発行しない', () => {
  it('残り 30 秒: 401 AUTH_TOKEN_EXPIRING。コードは作らない', async () => {
    const res = await POST(postRequest({ authorization: `Bearer ${makeJwt(NOW_SEC + 30)}` }));
    const json = await res.json();
    expect(res.status).toBe(401);
    expect(json.error.code).toBe('AUTH_TOKEN_EXPIRING');
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('境界: 残り 59 秒は拒否・残り 60 秒ちょうどは通す', async () => {
    const tooShort = await POST(postRequest({ authorization: `Bearer ${makeJwt(NOW_SEC + 59)}` }));
    expect(tooShort.status).toBe(401);
    expect(mockRpc).not.toHaveBeenCalled();

    const enough = await POST(postRequest({ authorization: `Bearer ${makeJwt(NOW_SEC + 60)}` }));
    expect(enough.status).toBe(200);
    expect(mockRpc).toHaveBeenCalledTimes(1);
  });

  it('すでに期限切れ: 401 AUTH_TOKEN_EXPIRING', async () => {
    const res = await POST(postRequest({ authorization: `Bearer ${makeJwt(NOW_SEC - 10)}` }));
    expect(res.status).toBe(401);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('exp が読めない JWT (exp なし): 401 AUTH_UNAUTHENTICATED', async () => {
    const res = await POST(postRequest({ authorization: `Bearer ${makeJwt(null)}` }));
    const json = await res.json();
    expect(res.status).toBe(401);
    expect(json.error.code).toBe('AUTH_UNAUTHENTICATED');
    expect(mockRpc).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. 凍結
// ─────────────────────────────────────────────────────────────────────────────
describe('凍結中のアカウントには発行しない', () => {
  it('frozen_at あり・unban_at なし (無期限): 403 AUTH_ACCOUNT_FROZEN。コードは作らない', async () => {
    mockMaybeSingle.mockResolvedValue({ data: { frozen_at: '2026-10-01T00:00:00Z', unban_at: null }, error: null });

    const res = await POST(postRequest());
    const json = await res.json();

    expect(res.status).toBe(403);
    expect(json.error.code).toBe('AUTH_ACCOUNT_FROZEN');
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockFrom).toHaveBeenCalledWith('user_profiles');
  });

  it('一時 BAN が継続中 (unban_at が未来): 403', async () => {
    mockMaybeSingle.mockResolvedValue({
      data: { frozen_at: '2026-10-01T00:00:00Z', unban_at: '2026-10-08T00:00:00Z' },
      error: null,
    });
    const res = await POST(postRequest());
    expect(res.status).toBe(403);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('一時 BAN の期限が切れている (unban_at が過去): 通す', async () => {
    mockMaybeSingle.mockResolvedValue({
      data: { frozen_at: '2026-10-01T00:00:00Z', unban_at: '2026-10-05T00:00:00Z' },
      error: null,
    });
    const res = await POST(postRequest());
    expect(res.status).toBe(200);
  });

  it('プロフィール行が無い: 凍結されていないものとして通す', async () => {
    mockMaybeSingle.mockResolvedValue({ data: null, error: null });
    const res = await POST(postRequest());
    expect(res.status).toBe(200);
  });

  it('凍結状態を確認できない (DB エラー): 安全側に倒して 503。発行せず、エラーをログに残す', async () => {
    mockMaybeSingle.mockResolvedValue({ data: null, error: { code: '57014', message: 'canceling statement' } });

    const res = await POST(postRequest());
    const json = await res.json();

    expect(res.status).toBe(503);
    expect(json.error.code).toBe('NATIVE_BRIDGE_UNAVAILABLE');
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockWithUser).toHaveBeenCalledWith(USER_ID);
    expect(mockLogError).toHaveBeenCalledTimes(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. 発行
// ─────────────────────────────────────────────────────────────────────────────
describe('発行', () => {
  it('200: 43 文字の base64url コードと expires_in: 60 を返し、Cache-Control: no-store を付ける', async () => {
    const res = await POST(postRequest());
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(json.expires_in).toBe(60);
    expect(Object.keys(json).sort()).toEqual(['code', 'expires_in']);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('RPC には sha256(コード) と検証済みのユーザー ID・ヘッダの JWT・body の refresh_token を渡す。コード本体は渡さない', async () => {
    const jwt = validJwt();
    const res = await POST(postRequest({ authorization: `Bearer ${jwt}` }));
    const json = await res.json();

    expect(mockRpc).toHaveBeenCalledTimes(1);
    const [fn, args] = mockRpc.mock.calls[0];
    expect(fn).toBe('issue_native_bridge_code');
    expect(args).toEqual({
      p_code_hash: sha256Hex(json.code),
      p_user_id: USER_ID,
      p_access_token: jwt,
      p_refresh_token: REFRESH_TOKEN,
      p_ttl_seconds: 60,
    });
    expect(JSON.stringify(mockRpc.mock.calls)).not.toContain(json.code);
  });

  it('user_id は JWT の中身ではなく、Auth API が返したユーザーの ID を使う', async () => {
    const otherId = 'b1eebc99-9c0b-4ef8-bb6d-6bb9bd380a22';
    mockGetUser.mockResolvedValue({ data: { user: { id: otherId } }, error: null });
    const res = await POST(postRequest({ authorization: `Bearer ${makeJwt(NOW_SEC + 3600, { sub: USER_ID })}` }));
    expect(res.status).toBe(200);
    expect(mockRpc.mock.calls[0][1].p_user_id).toBe(otherId);
  });

  it('呼ぶたびに別のコードになる', async () => {
    const a = await (await POST(postRequest())).json();
    const b = await (await POST(postRequest())).json();
    expect(a.code).not.toBe(b.code);
  });

  it('X-App-Platform / X-App-Version があれば info ログに残す (バージョンの手がかり)', async () => {
    const res = await POST(postRequest({ headers: { 'X-App-Platform': 'ios', 'X-App-Version': '0.1.0' } }));
    expect(res.status).toBe(200);
    expect(mockWithUser).toHaveBeenCalledWith(USER_ID);
    expect(mockLogInfo).toHaveBeenCalledWith('native bridge code issued', { platform: 'ios', app_version: '0.1.0' });
  });

  it.each([
    ['空白や記号を含む', { 'X-App-Platform': 'ios; DROP TABLE', 'X-App-Version': '<script>' }],
    ['長すぎる', { 'X-App-Platform': 'a'.repeat(33), 'X-App-Version': '1'.repeat(33) }],
  ])('X-App-* が不正な形式 (%s) なら記録しない', async (_label, headers) => {
    const res = await POST(postRequest({ headers }));
    expect(res.status).toBe(200);
    expect(mockLogInfo).not.toHaveBeenCalled();
  });

  it('X-App-* が無ければ info ログを書かない (タブを開くたびの無駄な書き込みを避ける)', async () => {
    await POST(postRequest());
    expect(mockLogInfo).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. 障害時とログ
// ─────────────────────────────────────────────────────────────────────────────
describe('障害時の応答とログ', () => {
  it('発行 RPC が失敗: 503 NATIVE_BRIDGE_UNAVAILABLE。SQLSTATE をログに残す', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { code: '23503', message: 'insert or update violates foreign key' } });

    const res = await POST(postRequest());
    const json = await res.json();

    expect(res.status).toBe(503);
    expect(json.error.code).toBe('NATIVE_BRIDGE_UNAVAILABLE');
    expect(json.code).toBeUndefined();
    expect(mockWithUser).toHaveBeenCalledWith(USER_ID);
    expect(mockLogError).toHaveBeenCalledTimes(1);
    expect(mockLogError.mock.calls[0][0]).toBe('issue_native_bridge_code failed');
    expect(mockLogError.mock.calls[0][2]).toEqual({ pg_code: '23503' });
  });

  it('service role の環境変数が無い等で getSupabaseAdmin が例外: 503。ログに残す', async () => {
    mockGetSupabaseAdmin.mockImplementation(() => {
      throw new Error('Supabase admin env is missing');
    });
    const res = await POST(postRequest());
    expect(res.status).toBe(503);
    expect(mockRootError).toHaveBeenCalledTimes(1);
  });

  it('どの応答でも body・コード・アクセストークン・リフレッシュトークンをログに出さない', async () => {
    const jwt = validJwt();
    const secrets = [REFRESH_TOKEN, jwt, 'signature-that-must-not-leak'];

    // 成功
    const ok = await POST(postRequest({ authorization: `Bearer ${jwt}`, headers: { 'X-App-Platform': 'ios', 'X-App-Version': '0.1.0' } }));
    const code = (await ok.json()).code as string;
    secrets.push(code);

    // 失敗系: RPC 失敗 / 凍結確認の失敗 / 期限間近 / 不正 JWT / 不正 body
    mockRpc.mockResolvedValueOnce({ data: null, error: { code: '23503', message: `failed for ${REFRESH_TOKEN} ${jwt}` } });
    await POST(postRequest({ authorization: `Bearer ${jwt}` }));
    mockMaybeSingle.mockResolvedValueOnce({ data: null, error: { code: 'XX000', message: `boom ${REFRESH_TOKEN}` } });
    await POST(postRequest({ authorization: `Bearer ${jwt}` }));
    await POST(postRequest({ authorization: `Bearer ${makeJwt(NOW_SEC + 5)}` }));
    mockGetUser.mockResolvedValueOnce({ data: { user: null }, error: { name: 'AuthApiError', status: 401, message: `bad ${jwt}` } });
    await POST(postRequest({ authorization: `Bearer ${jwt}` }));
    await POST(postRequest({ rawBody: `{"refresh_token": 5, "x": "${REFRESH_TOKEN}"` }));

    const logged = everythingLogged(consoleSpies);
    for (const secret of secrets) {
      expect(logged, `ログに秘密情報が含まれている: ${secret.slice(0, 12)}...`).not.toContain(secret);
    }
  });
});
