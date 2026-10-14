/**
 * T02: /auth/native-bridge route 単体テスト
 * Issue #844 — RN↔Web 認証ブリッジテスト
 * Issue #1036 — トークンを URL に載せない方式 (ワンタイムコード) への移行
 *
 * カバレッジ:
 *   1. access_token / refresh_token 不在 → /login redirect
 *   2. cross-origin next パラメータ ブロック
 *   3. is_native_app Cookie セット確認
 *   4. setSession エラー時の fallback 動作
 *   5. 旧方式 (トークンを URL で渡す) の正常フロー
 *   6. オープンリダイレクト対策 (next)
 *   7. コード方式: 成功 (保存されたトークンで setSession・URL のトークンは使わない)
 *   8. コード方式: 形式不正 / 無効 / 使用済み / DB 障害 (既に Cookie セッションがあれば続ける)
 *   9. コード方式: setSession の失敗・ユーザーの不一致 (Cookie を消して拒否)
 *  10. コードが旧方式のトークンより優先される
 *  11. 旧方式の期限 (LEGACY_SUNSET_AT) と NATIVE_BRIDGE_LEGACY_GET=off → 426
 *  12. 旧方式の使用ログ (トークンを含めない)
 *  13. 全応答の共通ヘッダ / トークンがリダイレクト先・本文に出ないこと
 *  14. Web の Cookie セッションに入れる refresh_token は実際の値ではなく使えない値 (#1038 F7-05)
 *      NATIVE_BRIDGE_SHARE_REFRESH_TOKEN=on で従来の動作 (実際の値) に戻せる
 */

import { createHash } from 'node:crypto';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

// ── モック (vi.hoisted: vi.mock のファクトリから参照するため) ────────────────────
const mocks = vi.hoisted(() => ({
  setSession: vi.fn(),
  getUser: vi.fn(),
  rpc: vi.fn(),
  cookieGetAll: vi.fn(),
  cookieDelete: vi.fn(),
  rootWarn: vi.fn(),
  rootError: vi.fn(),
  userWarn: vi.fn(),
  userError: vi.fn(),
  withUser: vi.fn(),
}));

// ── supabase/server モック ────────────────────────────────────────────────────
const supabaseClient = {
  auth: {
    setSession: mocks.setSession,
    getUser: mocks.getUser,
  },
};

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => supabaseClient,
  // コードの発行 / 消費 RPC (src/lib/auth/native-bridge-code.ts) は service_role 経由
  getSupabaseAdmin: () => ({ rpc: mocks.rpc }),
}));

// ── next/headers の cookies() モック ─────────────────────────────────────────
vi.mock('next/headers', () => ({
  cookies: () => ({
    getAll: mocks.cookieGetAll,
    delete: mocks.cookieDelete,
  }),
}));

// ── 構造化ログ (素の関数にして mockReset で実装が消えないようにする) ──────────
vi.mock('@/lib/db-logger', () => ({
  createLogger: () => ({
    debug: () => {},
    info: () => {},
    warn: mocks.rootWarn,
    error: mocks.rootError,
    withUser: mocks.withUser,
  }),
  generateRequestId: () => 'req_test',
}));

// ── Route handler import ──────────────────────────────────────────────────────
import { GET } from '../../src/app/(auth)/auth/native-bridge/route';
import { NATIVE_BRIDGE_WEB_REFRESH_TOKEN_PLACEHOLDER } from '../../src/lib/auth/native-bridge-code';

// ── ヘルパー ──────────────────────────────────────────────────────────────────
const BASE = 'https://homegohan-app.vercel.app';

function makeRequest(params: Record<string, string>, baseUrl = BASE, headers?: Record<string, string>) {
  const url = new URL('/auth/native-bridge', baseUrl);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }
  return new Request(url.toString(), { headers }) as any;
}

const USER_ID = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';
const OTHER_USER_ID = 'b1eebc99-9c0b-4ef8-bb6d-6bb9bd380a22';

// コード方式で DB (consume_native_bridge_code) に保存されているトークン。URL に載る値とは別物にしておく
const STORED_ACCESS = 'stored-access-token';
const STORED_REFRESH = 'stored-refresh-token';

const sha256Hex = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

/** 43 文字の base64url (形式として正しいコード) */
const VALID_CODE = 'Abcdefghijklmnopqrstuvwxyz0123456789-_ABCDE';

/** consume_native_bridge_code が 1 行返す (有効なコード) */
function consumeReturnsRow(userId = USER_ID) {
  mocks.rpc.mockResolvedValue({
    data: [{ user_id: userId, access_token: STORED_ACCESS, refresh_token: STORED_REFRESH }],
    error: null,
  });
}

/** setSession が成功し、指定ユーザーのセッションを返す */
function setSessionSucceeds(userId: string | null = USER_ID) {
  mocks.setSession.mockResolvedValue({
    data: userId ? { user: { id: userId }, session: { user: { id: userId } } } : { user: null, session: null },
    error: null,
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  // 期限 (2026-12-31) の前に固定する。Date だけを偽装し、タイマーは本物のまま
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-07T00:00:00+09:00'));

  // デフォルト: setSession 成功 (旧方式のテスト。data は無くても成功扱い)
  mocks.setSession.mockResolvedValue({ error: null });
  // デフォルト: この WebView に Cookie セッションは無い
  mocks.getUser.mockResolvedValue({ data: { user: null }, error: null });
  mocks.rpc.mockResolvedValue({ data: [], error: null });
  mocks.cookieGetAll.mockReturnValue([]);
  mocks.withUser.mockReturnValue({ debug: () => {}, info: () => {}, warn: mocks.userWarn, error: mocks.userError });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

// ─────────────────────────────────────────────────────────────────────────────
// ケース 1: access_token / refresh_token 不在 → /login redirect
// ─────────────────────────────────────────────────────────────────────────────
describe('ケース1: トークン不在 → /login redirect', () => {
  it('access_token も refresh_token もない場合 /login へリダイレクトする', async () => {
    const req = makeRequest({});
    const res = await GET(req);
    expect(res.status).toBe(307);
    const location = res.headers.get('location');
    expect(location).toContain('/login');
  });

  it('access_token のみある場合 /login へリダイレクトする', async () => {
    const req = makeRequest({ access_token: 'tok-access' });
    const res = await GET(req);
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toContain('/login');
  });

  it('refresh_token のみある場合 /login へリダイレクトする', async () => {
    const req = makeRequest({ refresh_token: 'tok-refresh' });
    const res = await GET(req);
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toContain('/login');
  });

  it('トークンが片方だけのときは setSession を呼ばない', async () => {
    await GET(makeRequest({ access_token: 'tok-access' }));
    await GET(makeRequest({ refresh_token: 'tok-refresh' }));
    expect(mocks.setSession).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ケース 2: cross-origin next パラメータ ブロック
// ─────────────────────────────────────────────────────────────────────────────
describe('ケース2: cross-origin next パラメータ ブロック', () => {
  it('next が別オリジンの絶対 URL のとき /home?mode=app へフォールバックする', async () => {
    const req = makeRequest({
      access_token: 'tok-access',
      refresh_token: 'tok-refresh',
      next: 'https://evil.example.com/steal',
    });
    const res = await GET(req);
    expect(res.status).toBe(307);
    const location = res.headers.get('location')!;
    // evil.example.com には飛ばない
    expect(location).not.toContain('evil.example.com');
    // フォールバック先は /home?mode=app
    expect(location).toContain('/home');
    expect(location).toContain('mode=app');
  });

  it('next が同一オリジンの絶対 URL のとき許可してそこへリダイレクトする', async () => {
    const req = makeRequest({
      access_token: 'tok-access',
      refresh_token: 'tok-refresh',
      next: 'https://homegohan-app.vercel.app/menus',
    });
    const res = await GET(req);
    expect(res.status).toBe(307);
    const location = res.headers.get('location')!;
    expect(location).toContain('/menus');
  });

  it('next が相対パス (/ 始まり) のとき同一オリジンとして許可する', async () => {
    const req = makeRequest({
      access_token: 'tok-access',
      refresh_token: 'tok-refresh',
      next: '/profile?mode=app',
    });
    const res = await GET(req);
    expect(res.status).toBe(307);
    const location = res.headers.get('location')!;
    expect(location).toContain('/profile');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ケース 3: is_native_app Cookie セット確認
// ─────────────────────────────────────────────────────────────────────────────
describe('ケース3: is_native_app Cookie セット', () => {
  it('setSession 成功時に is_native_app=1 Cookie がセットされる', async () => {
    const req = makeRequest({
      access_token: 'tok-access',
      refresh_token: 'tok-refresh',
      next: '/home?mode=app',
    });
    const res = await GET(req);
    expect(res.status).toBe(307);
    // Set-Cookie ヘッダに is_native_app=1 が含まれること
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('is_native_app=1');
  });

  it('is_native_app Cookie には maxAge (30日相当) が設定されている', async () => {
    const req = makeRequest({
      access_token: 'tok-access',
      refresh_token: 'tok-refresh',
    });
    const res = await GET(req);
    const setCookie = res.headers.get('set-cookie') ?? '';
    // 30日 = 2592000秒
    expect(setCookie).toMatch(/max-age=2592000/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ケース 4: setSession エラー時の fallback 動作
// ─────────────────────────────────────────────────────────────────────────────
describe('ケース4: setSession エラー時 fallback', () => {
  it('setSession がエラーを返したとき /login へリダイレクトする', async () => {
    mocks.setSession.mockResolvedValue({ error: { message: 'invalid token' } });
    const req = makeRequest({
      access_token: 'invalid-access',
      refresh_token: 'invalid-refresh',
    });
    const res = await GET(req);
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toContain('/login');
  });

  it('setSession エラー時は is_native_app Cookie がセットされない', async () => {
    mocks.setSession.mockResolvedValue({ error: { message: 'session expired' } });
    const req = makeRequest({
      access_token: 'expired-access',
      refresh_token: 'expired-refresh',
    });
    const res = await GET(req);
    const setCookie = res.headers.get('set-cookie') ?? '';
    // エラー時は Cookie 不要 (is_native_app は設定しない)
    expect(setCookie).not.toContain('is_native_app=1');
  });

  it('setSession が例外を投げても 500 にせず /login へリダイレクトする', async () => {
    mocks.setSession.mockRejectedValue(new Error('network down'));
    const res = await GET(makeRequest({ access_token: 'valid-access', refresh_token: 'valid-refresh' }));
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toContain('/login');
    expect(res.headers.get('set-cookie') ?? '').not.toContain('is_native_app');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ケース 5: 正常フロー end-to-end (旧方式)
// ─────────────────────────────────────────────────────────────────────────────
describe('ケース5: 正常フロー (旧方式)', () => {
  it('両トークンあり setSession 成功 → next パスへリダイレクト', async () => {
    const req = makeRequest({
      access_token: 'valid-access',
      refresh_token: 'valid-refresh',
      next: '/home?mode=app',
    });
    const res = await GET(req);
    expect(res.status).toBe(307);
    const location = res.headers.get('location')!;
    expect(location).toContain('/home');
    // setSession が正しい引数で呼ばれたこと
    expect(mocks.setSession).toHaveBeenCalledWith({
      access_token: 'valid-access',
      refresh_token: 'valid-refresh',
    });
  });

  it('next 省略時のデフォルトは /home?mode=app', async () => {
    const req = makeRequest({
      access_token: 'valid-access',
      refresh_token: 'valid-refresh',
    });
    const res = await GET(req);
    const location = res.headers.get('location')!;
    expect(location).toContain('/home');
    expect(location).toContain('mode=app');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ケース 6: オープンリダイレクト対策 (#1036 で発見)
//   修正前は next が '/' で始まれば何でも new URL(next, req.url) に渡していたため、
//   `//evil.com/x` と `/\evil.com/x` が https://evil.com/x に解決され、認証済みのまま外部へ飛ばされた
// ─────────────────────────────────────────────────────────────────────────────
describe('ケース6: オープンリダイレクト (next) の対策', () => {
  const evilNexts = [
    ['プロトコル相対 URL', '//evil.com/x'],
    ['バックスラッシュ', '/\\evil.com/x'],
    ['エンコードした //', '/%2F/evil.com/x'],
    ['二重エンコードした //', '/%252F%252Fevil.com/x'],
    ['エンコードしたバックスラッシュ', '/%5Cevil.com/x'],
    ['タブを挟んだ //', '/\t/evil.com/x'],
    ['改行を挟んだ //', '/\n/evil.com/x'],
    ['先頭が空白の //', ' //evil.com/x'],
    ['外部の絶対 URL', 'https://evil.com/x'],
    ['userinfo で偽装した絶対 URL', 'https://homegohan-app.vercel.app@evil.com/x'],
    ['バックスラッシュで偽装した絶対 URL', 'https://evil.com\\@homegohan-app.vercel.app/'],
    ['同一ホスト名を前方に持つ別ドメイン', 'https://homegohan-app.vercel.app.evil.com/x'],
    ['スキームだけ変えた同一ホスト (別オリジン)', 'http://homegohan-app.vercel.app/x'],
    ['javascript: スキーム', 'javascript:alert(1)'],
    ['data: スキーム', 'data:text/html,<script>alert(1)</script>'],
    ['プロトコル相対の絶対 URL 化', 'https:///evil.com/x'],
  ] as const;

  function expectStaysOnOrigin(res: Response) {
    expect(res.status).toBe(307);
    const location = res.headers.get('location')!;
    const resolved = new URL(location, BASE);
    expect(resolved.origin).toBe(BASE);
    expect(location).not.toContain('evil.com');
    // 既定の遷移先に落ちる
    expect(resolved.pathname).toBe('/home');
    expect(resolved.search).toBe('?mode=app');
  }

  it.each(evilNexts)('旧方式: next=%s は外へ出ず /home?mode=app になる', async (_label, evil) => {
    const res = await GET(makeRequest({ access_token: 'valid-access', refresh_token: 'valid-refresh', next: evil }));
    expectStaysOnOrigin(res);
  });

  it.each(evilNexts)('コード方式: next=%s は外へ出ず /home?mode=app になる', async (_label, evil) => {
    consumeReturnsRow();
    setSessionSucceeds();
    const res = await GET(makeRequest({ code: VALID_CODE, next: evil }));
    expectStaysOnOrigin(res);
  });

  it.each(evilNexts)('コードが無効でも (Cookie セッションあり) next=%s は外へ出ない', async (_label, evil) => {
    mocks.getUser.mockResolvedValue({ data: { user: { id: USER_ID } }, error: null });
    const res = await GET(makeRequest({ code: VALID_CODE, next: evil }));
    expectStaysOnOrigin(res);
  });

  it('正当な相対パス・同一オリジンの絶対 URL はそのまま通る (クエリ・ハッシュも保持)', async () => {
    consumeReturnsRow();
    setSessionSucceeds();

    const rel = await GET(makeRequest({ code: VALID_CODE, next: '/menus/weekly?date=2026-10-07&mode=app' }));
    expect(new URL(rel.headers.get('location')!, BASE).pathname).toBe('/menus/weekly');
    expect(new URL(rel.headers.get('location')!, BASE).search).toBe('?date=2026-10-07&mode=app');

    const abs = await GET(makeRequest({ code: VALID_CODE, next: `${BASE}/meals/today?mode=app#top` }));
    const resolved = new URL(abs.headers.get('location')!, BASE);
    expect(resolved.origin).toBe(BASE);
    expect(resolved.pathname).toBe('/meals/today');
    expect(resolved.search).toBe('?mode=app');
    expect(resolved.hash).toBe('#top');
  });

  it('next が空文字・空白のみのときは既定の遷移先', async () => {
    consumeReturnsRow();
    setSessionSucceeds();
    for (const next of ['', '   ']) {
      const res = await GET(makeRequest({ code: VALID_CODE, next }));
      const resolved = new URL(res.headers.get('location')!, BASE);
      expect(resolved.pathname).toBe('/home');
      expect(resolved.search).toBe('?mode=app');
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ケース 7: コード方式 — 成功
// ─────────────────────────────────────────────────────────────────────────────
describe('ケース7: コード方式の成功フロー', () => {
  it('コードを 1 回だけ引き換え、保存されたトークンで setSession し、next へ 307', async () => {
    consumeReturnsRow();
    setSessionSucceeds();

    const res = await GET(makeRequest({ code: VALID_CODE, next: '/home?mode=app' }));

    expect(res.status).toBe(307);
    const location = new URL(res.headers.get('location')!, BASE);
    expect(location.origin).toBe(BASE);
    expect(location.pathname).toBe('/home');
    expect(location.search).toBe('?mode=app');

    // RPC にはコードの sha256 を渡す (コード本体は渡さない)
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    expect(mocks.rpc).toHaveBeenCalledWith('consume_native_bridge_code', { p_code_hash: sha256Hex(VALID_CODE) });
    expect(JSON.stringify(mocks.rpc.mock.calls)).not.toContain(VALID_CODE);

    // setSession には DB から引き換えた access_token を渡す。
    // refresh_token は実際の値ではなく使えない値にする (ネイティブとフォークして強制ログアウトしないため。#1038 F7-05)
    expect(mocks.setSession).toHaveBeenCalledTimes(1);
    expect(mocks.setSession).toHaveBeenCalledWith({
      access_token: STORED_ACCESS,
      refresh_token: NATIVE_BRIDGE_WEB_REFRESH_TOKEN_PLACEHOLDER,
    });
  });

  it('URL に旧方式のトークンが付いていても、setSession に渡すのは保存されたトークンだけ', async () => {
    consumeReturnsRow();
    setSessionSucceeds();

    await GET(
      makeRequest({
        code: VALID_CODE,
        access_token: 'query-access-token',
        refresh_token: 'query-refresh-token',
      }),
    );

    expect(mocks.setSession).toHaveBeenCalledTimes(1);
    expect(mocks.setSession).toHaveBeenCalledWith({
      access_token: STORED_ACCESS,
      refresh_token: NATIVE_BRIDGE_WEB_REFRESH_TOKEN_PLACEHOLDER,
    });
    expect(JSON.stringify(mocks.setSession.mock.calls)).not.toContain('query-');
  });

  it('is_native_app=1 (30 日) を設定する', async () => {
    consumeReturnsRow();
    setSessionSucceeds();

    const res = await GET(makeRequest({ code: VALID_CODE }));

    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('is_native_app=1');
    expect(setCookie).toMatch(/max-age=2592000/i);
  });

  it('next 省略時のデフォルトは /home?mode=app', async () => {
    consumeReturnsRow();
    setSessionSucceeds();

    const res = await GET(makeRequest({ code: VALID_CODE }));

    const location = new URL(res.headers.get('location')!, BASE);
    expect(location.pathname).toBe('/home');
    expect(location.search).toBe('?mode=app');
  });

  it('リダイレクト先にもレスポンス本文にも、トークンとコードが出ない', async () => {
    consumeReturnsRow();
    setSessionSucceeds();

    const res = await GET(makeRequest({ code: VALID_CODE, next: '/home?mode=app' }));

    const everything = `${res.headers.get('location')}\n${await res.text()}\n${[...res.headers.entries()].join('\n')}`;
    for (const secret of [STORED_ACCESS, STORED_REFRESH, VALID_CODE]) {
      expect(everything).not.toContain(secret);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ケース 8: コード方式 — 無効なコード
// ─────────────────────────────────────────────────────────────────────────────
describe('ケース8: 無効なコード (形式不正 / 存在しない / 期限切れ / 使用済み / DB 障害)', () => {
  it.each([
    ['空文字', ''],
    ['短い', 'abc'],
    ['42 文字', 'A'.repeat(42)],
    ['44 文字', 'A'.repeat(44)],
    ['base64 のパディング', `${'A'.repeat(42)}=`],
    ['使えない記号', `${'A'.repeat(42)}!`],
    ['空白を含む', `${'A'.repeat(42)} `],
  ])('形式が不正 (%s): DB に問い合わせず /login へ。setSession も呼ばない', async (_label, code) => {
    const res = await GET(makeRequest({ code }));

    expect(res.status).toBe(307);
    expect(new URL(res.headers.get('location')!, BASE).pathname).toBe('/login');
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.setSession).not.toHaveBeenCalled();
    expect(res.headers.get('set-cookie') ?? '').not.toContain('is_native_app');
  });

  it('存在しない / 期限切れ / 使用済み (RPC が 0 行): /login へ。setSession も is_native_app も無し', async () => {
    mocks.rpc.mockResolvedValue({ data: [], error: null });

    const res = await GET(makeRequest({ code: VALID_CODE }));

    expect(res.status).toBe(307);
    expect(new URL(res.headers.get('location')!, BASE).pathname).toBe('/login');
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    expect(mocks.setSession).not.toHaveBeenCalled();
    expect(res.headers.get('set-cookie') ?? '').not.toContain('is_native_app');
  });

  it('同じコードの 2 回目は /login へ (1 回しか使えない)', async () => {
    consumeReturnsRow();
    setSessionSucceeds();
    const first = await GET(makeRequest({ code: VALID_CODE }));
    expect(new URL(first.headers.get('location')!, BASE).pathname).toBe('/home');

    // 2 回目: DB の行は消えているので 0 行
    mocks.rpc.mockResolvedValue({ data: [], error: null });
    mocks.setSession.mockClear();
    const second = await GET(makeRequest({ code: VALID_CODE }));

    expect(new URL(second.headers.get('location')!, BASE).pathname).toBe('/login');
    expect(mocks.setSession).not.toHaveBeenCalled();
  });

  it('無効なコードでも、この WebView が既に Cookie セッションを持っていれば next へ続く (リロード・二重読み込み)', async () => {
    mocks.rpc.mockResolvedValue({ data: [], error: null });
    mocks.getUser.mockResolvedValue({ data: { user: { id: USER_ID } }, error: null });

    const res = await GET(makeRequest({ code: VALID_CODE, next: '/menus?mode=app' }));

    expect(res.status).toBe(307);
    const location = new URL(res.headers.get('location')!, BASE);
    expect(location.pathname).toBe('/menus');
    expect(location.search).toBe('?mode=app');
    // セッションは作っていないので setSession も is_native_app も無し
    expect(mocks.setSession).not.toHaveBeenCalled();
    expect(res.headers.get('set-cookie') ?? '').not.toContain('is_native_app');
  });

  it('形式が不正でも、Cookie セッションがあれば next へ続く (DB には問い合わせない)', async () => {
    mocks.getUser.mockResolvedValue({ data: { user: { id: USER_ID } }, error: null });

    const res = await GET(makeRequest({ code: 'abc', next: '/menus?mode=app' }));

    expect(new URL(res.headers.get('location')!, BASE).pathname).toBe('/menus');
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it('Cookie セッションの確認が例外になっても /login へ (500 にしない)', async () => {
    mocks.rpc.mockResolvedValue({ data: [], error: null });
    mocks.getUser.mockRejectedValue(new Error('network down'));

    const res = await GET(makeRequest({ code: VALID_CODE }));

    expect(res.status).toBe(307);
    expect(new URL(res.headers.get('location')!, BASE).pathname).toBe('/login');
  });

  it('DB 障害 (RPC エラー): 無効扱いで /login へ。エラーはログに残すが、コードは含めない', async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code: '57014', message: `timeout for ${VALID_CODE}` } });

    const res = await GET(makeRequest({ code: VALID_CODE }));

    expect(res.status).toBe(307);
    expect(new URL(res.headers.get('location')!, BASE).pathname).toBe('/login');
    expect(mocks.setSession).not.toHaveBeenCalled();
    expect(mocks.rootError).toHaveBeenCalledTimes(1);
    expect(mocks.rootError.mock.calls[0][0]).toBe('consume_native_bridge_code failed');
    expect(mocks.rootError.mock.calls[0][2]).toEqual({ pg_code: '57014' });
    const logged = JSON.stringify(mocks.rootError.mock.calls, (_k, v) =>
      v instanceof Error ? `${v.name}:${v.message}:${v.stack}` : v,
    );
    expect(logged).not.toContain(VALID_CODE);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ケース 9: コード方式 — setSession の失敗・ユーザーの不一致
// ─────────────────────────────────────────────────────────────────────────────
describe('ケース9: setSession の失敗とユーザーの不一致', () => {
  it('setSession がエラー: /login へ。is_native_app は付けない', async () => {
    consumeReturnsRow();
    mocks.setSession.mockResolvedValue({ data: { user: null, session: null }, error: { message: 'Invalid Refresh Token' } });

    const res = await GET(makeRequest({ code: VALID_CODE }));

    expect(res.status).toBe(307);
    expect(new URL(res.headers.get('location')!, BASE).pathname).toBe('/login');
    expect(res.headers.get('set-cookie') ?? '').not.toContain('is_native_app');
    expect(mocks.cookieDelete).not.toHaveBeenCalled();
  });

  it('setSession が例外を投げても 500 にせず /login へ (コードは引き換え済み)。is_native_app は付けない', async () => {
    consumeReturnsRow();
    mocks.setSession.mockRejectedValue(new Error('network down'));

    const res = await GET(makeRequest({ code: VALID_CODE }));

    expect(res.status).toBe(307);
    expect(new URL(res.headers.get('location')!, BASE).pathname).toBe('/login');
    expect(res.headers.get('set-cookie') ?? '').not.toContain('is_native_app');
  });

  it('コードの持ち主とセッションのユーザーが違う: /login へ。sb-* の Cookie を消し、is_native_app は付けない', async () => {
    consumeReturnsRow(USER_ID);
    setSessionSucceeds(OTHER_USER_ID);
    // setSession が書いた直後の Cookie (リクエストの Cookie と合わせて getAll に出る)
    mocks.cookieGetAll.mockReturnValue([
      { name: 'sb-abcdefgh-auth-token.0', value: 'chunk0' },
      { name: 'sb-abcdefgh-auth-token.1', value: 'chunk1' },
      { name: 'is_native_app', value: '1' },
      { name: 'theme', value: 'dark' },
      { name: 'sb-abcdefgh-auth-token-code-verifier', value: 'verifier' },
    ]);

    const res = await GET(makeRequest({ code: VALID_CODE, next: '/home?mode=app' }));

    expect(res.status).toBe(307);
    expect(new URL(res.headers.get('location')!, BASE).pathname).toBe('/login');
    expect(res.headers.get('set-cookie') ?? '').not.toContain('is_native_app');

    // セッションの Cookie だけを、設定時と同じ path (/) で消す。ほかの Cookie には触れない
    expect(mocks.cookieDelete).toHaveBeenCalledTimes(2);
    expect(mocks.cookieDelete).toHaveBeenCalledWith({ name: 'sb-abcdefgh-auth-token.0', path: '/' });
    expect(mocks.cookieDelete).toHaveBeenCalledWith({ name: 'sb-abcdefgh-auth-token.1', path: '/' });

    // 整合性違反は error ログ (コードの持ち主のユーザー ID つき)。トークン・コードは含めない
    expect(mocks.withUser).toHaveBeenCalledWith(USER_ID);
    expect(mocks.userError).toHaveBeenCalledTimes(1);
    expect(mocks.userError.mock.calls[0][0]).toBe('native bridge code user mismatch');
    const logged = JSON.stringify(mocks.userError.mock.calls, (_k, v) =>
      v instanceof Error ? `${v.name}:${v.message}` : v,
    );
    for (const secret of [STORED_ACCESS, STORED_REFRESH, VALID_CODE]) expect(logged).not.toContain(secret);
  });

  it('単一の Cookie 名 (sb-<ref>-auth-token、分割なし) も消す', async () => {
    consumeReturnsRow(USER_ID);
    setSessionSucceeds(OTHER_USER_ID);
    mocks.cookieGetAll.mockReturnValue([{ name: 'sb-abcdefgh-auth-token', value: 'whole' }]);

    await GET(makeRequest({ code: VALID_CODE }));

    expect(mocks.cookieDelete).toHaveBeenCalledWith({ name: 'sb-abcdefgh-auth-token', path: '/' });
  });

  it('setSession の結果にユーザーが無い (成功扱いだが user が null) も不一致として拒否する', async () => {
    consumeReturnsRow();
    setSessionSucceeds(null);
    mocks.cookieGetAll.mockReturnValue([{ name: 'sb-abcdefgh-auth-token', value: 'whole' }]);

    const res = await GET(makeRequest({ code: VALID_CODE }));

    expect(new URL(res.headers.get('location')!, BASE).pathname).toBe('/login');
    expect(mocks.cookieDelete).toHaveBeenCalledTimes(1);
    expect(res.headers.get('set-cookie') ?? '').not.toContain('is_native_app');
  });

  it('不一致のときは signOut を呼ばない (他人の実セッションをサーバ側で失効させない)', async () => {
    // supabaseClient.auth に signOut は無い。呼べば TypeError で 500 になるので、307 が返ること自体が証拠になる
    consumeReturnsRow(USER_ID);
    setSessionSucceeds(OTHER_USER_ID);

    const res = await GET(makeRequest({ code: VALID_CODE }));

    expect(res.status).toBe(307);
    expect((supabaseClient.auth as Record<string, unknown>).signOut).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ケース 10: コードは旧方式のトークンより優先される
// ─────────────────────────────────────────────────────────────────────────────
describe('ケース10: code があれば旧方式のトークンは使わない', () => {
  it('コードが無効なら、有効なトークンが同時に付いていても /login へ (旧方式にフォールバックしない)', async () => {
    mocks.rpc.mockResolvedValue({ data: [], error: null });

    const res = await GET(
      makeRequest({ code: VALID_CODE, access_token: 'valid-access', refresh_token: 'valid-refresh' }),
    );

    expect(new URL(res.headers.get('location')!, BASE).pathname).toBe('/login');
    expect(mocks.setSession).not.toHaveBeenCalled();
  });

  it('形式が不正なコード + 有効なトークンでも、トークンでセッションを作らない', async () => {
    const res = await GET(makeRequest({ code: 'abc', access_token: 'valid-access', refresh_token: 'valid-refresh' }));

    expect(new URL(res.headers.get('location')!, BASE).pathname).toBe('/login');
    expect(mocks.setSession).not.toHaveBeenCalled();
  });

  it('NATIVE_BRIDGE_LEGACY_GET=off でも、コード方式は動く', async () => {
    vi.stubEnv('NATIVE_BRIDGE_LEGACY_GET', 'off');
    consumeReturnsRow();
    setSessionSucceeds();

    const res = await GET(makeRequest({ code: VALID_CODE }));

    expect(res.status).toBe(307);
    expect(new URL(res.headers.get('location')!, BASE).pathname).toBe('/home');
  });

  it('旧方式の期限後でも、コード方式は動く', async () => {
    vi.setSystemTime(new Date('2027-01-01T00:00:00+09:00'));
    consumeReturnsRow();
    setSessionSucceeds();

    const res = await GET(makeRequest({ code: VALID_CODE }));

    expect(res.status).toBe(307);
    expect(new URL(res.headers.get('location')!, BASE).pathname).toBe('/home');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ケース 11: 旧方式の期限と NATIVE_BRIDGE_LEGACY_GET=off
// ─────────────────────────────────────────────────────────────────────────────
describe('ケース11: 旧方式 (トークンを URL で渡す GET) を閉じる', () => {
  const legacyParams = { access_token: 'legacy-access', refresh_token: 'legacy-refresh', next: '/home?mode=app' };

  async function expectClosed(res: Response) {
    expect(res.status).toBe(426);
    expect(res.headers.get('content-type')).toContain('text/html');
    const body = await res.text();
    expect(body).toContain('アプリを最新版に更新してください');
    // セッションは作らない
    expect(mocks.setSession).not.toHaveBeenCalled();
    expect(res.headers.get('set-cookie') ?? '').toBe('');
    expect(res.headers.get('location')).toBeNull();
    // トークンをレスポンスに反映しない
    expect(body).not.toContain('legacy-access');
    expect(body).not.toContain('legacy-refresh');
  }

  it('NATIVE_BRIDGE_LEGACY_GET=off: 426 の更新案内ページ。setSession を呼ばない', async () => {
    vi.stubEnv('NATIVE_BRIDGE_LEGACY_GET', 'off');
    await expectClosed(await GET(makeRequest(legacyParams)));
  });

  it('期限 (2026-12-31 00:00 JST) の直前は動く', async () => {
    vi.setSystemTime(new Date('2026-12-30T23:59:59+09:00'));
    const res = await GET(makeRequest(legacyParams));
    expect(res.status).toBe(307);
    expect(mocks.setSession).toHaveBeenCalledTimes(1);
  });

  it('期限ちょうどから 426', async () => {
    vi.setSystemTime(new Date('2026-12-31T00:00:00+09:00'));
    await expectClosed(await GET(makeRequest(legacyParams)));
  });

  it('期限後は 426', async () => {
    vi.setSystemTime(new Date('2027-03-01T12:00:00+09:00'));
    await expectClosed(await GET(makeRequest(legacyParams)));
  });

  it('閉じている間も、トークンが片方だけなら従来どおり /login へ (426 にしない)', async () => {
    vi.stubEnv('NATIVE_BRIDGE_LEGACY_GET', 'off');
    const res = await GET(makeRequest({ access_token: 'legacy-access' }));
    expect(res.status).toBe(307);
    expect(new URL(res.headers.get('location')!, BASE).pathname).toBe('/login');
  });

  it('閉じている間は DB ログを書かない (認証なしで到達できるため、書き込みの増幅を避ける)', async () => {
    vi.stubEnv('NATIVE_BRIDGE_LEGACY_GET', 'off');
    await GET(makeRequest(legacyParams));
    expect(mocks.rootWarn).not.toHaveBeenCalled();
    expect(mocks.withUser).not.toHaveBeenCalled();
  });

  it.each(['on', 'true', ''])('NATIVE_BRIDGE_LEGACY_GET=%j は旧方式を閉じない (期限前)', async (value) => {
    vi.stubEnv('NATIVE_BRIDGE_LEGACY_GET', value);
    const res = await GET(makeRequest(legacyParams));
    expect(res.status).toBe(307);
    expect(mocks.setSession).toHaveBeenCalledTimes(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ケース 12: 旧方式の使用ログ
// ─────────────────────────────────────────────────────────────────────────────
describe('ケース12: 旧方式が使われるたびに警告ログを残す (トークンの値は含めない)', () => {
  it('ユーザーが分かれば withUser(id).warn、user-agent だけを metadata に載せる', async () => {
    setSessionSucceeds(USER_ID);

    await GET(
      makeRequest(
        { access_token: 'legacy-access-secret', refresh_token: 'legacy-refresh-secret' },
        BASE,
        { 'user-agent': 'homegohan/0.1.0 (iPhone; iOS 18)' },
      ),
    );

    expect(mocks.withUser).toHaveBeenCalledWith(USER_ID);
    expect(mocks.userWarn).toHaveBeenCalledTimes(1);
    expect(mocks.userWarn).toHaveBeenCalledWith('legacy token-in-query bridge used', {
      ua: 'homegohan/0.1.0 (iPhone; iOS 18)',
    });

    const logged = JSON.stringify([...mocks.userWarn.mock.calls, ...mocks.rootWarn.mock.calls, ...mocks.withUser.mock.calls]);
    expect(logged).not.toContain('legacy-access-secret');
    expect(logged).not.toContain('legacy-refresh-secret');
  });

  it('ユーザーが分からなくても (setSession の結果に user が無い) ログは残す', async () => {
    mocks.setSession.mockResolvedValue({ error: null });

    await GET(makeRequest({ access_token: 'legacy-access', refresh_token: 'legacy-refresh' }));

    expect(mocks.rootWarn).toHaveBeenCalledWith('legacy token-in-query bridge used', { ua: '' });
  });

  it('user-agent は 200 文字までに切り詰める', async () => {
    setSessionSucceeds(USER_ID);

    await GET(
      makeRequest({ access_token: 'legacy-access', refresh_token: 'legacy-refresh' }, BASE, {
        'user-agent': 'x'.repeat(500),
      }),
    );

    expect(mocks.userWarn.mock.calls[0][1].ua).toHaveLength(200);
  });

  it('setSession が失敗した旧方式のアクセスでは DB ログを書かない (偽トークンで書き込みを増幅させない)', async () => {
    mocks.setSession.mockResolvedValue({ error: { message: 'invalid token' } });

    await GET(makeRequest({ access_token: 'forged', refresh_token: 'forged' }));

    expect(mocks.withUser).not.toHaveBeenCalled();
    expect(mocks.rootWarn).not.toHaveBeenCalled();
  });

  it('コード方式では旧方式の使用ログを書かない', async () => {
    consumeReturnsRow();
    setSessionSucceeds();

    await GET(makeRequest({ code: VALID_CODE }));

    expect(mocks.userWarn).not.toHaveBeenCalled();
    expect(mocks.rootWarn).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ケース 13: 全応答の共通ヘッダ / トークンが漏れないこと
// ─────────────────────────────────────────────────────────────────────────────
describe('ケース13: どの応答も no-store / no-referrer で、トークンをリダイレクト先・本文に出さない', () => {
  type Scenario = [string, () => Promise<Response>];

  const scenarios: Scenario[] = [
    ['パラメータなし (/login)', () => GET(makeRequest({}))],
    ['旧方式の成功', () => GET(makeRequest({ access_token: 'legacy-access', refresh_token: 'legacy-refresh', next: '/home?mode=app' }))],
    [
      '旧方式の setSession 失敗',
      async () => {
        mocks.setSession.mockResolvedValue({ error: { message: 'invalid token' } });
        return GET(makeRequest({ access_token: 'legacy-access', refresh_token: 'legacy-refresh' }));
      },
    ],
    [
      '旧方式を閉じている (426)',
      async () => {
        vi.stubEnv('NATIVE_BRIDGE_LEGACY_GET', 'off');
        return GET(makeRequest({ access_token: 'legacy-access', refresh_token: 'legacy-refresh' }));
      },
    ],
    [
      'コード方式の成功',
      async () => {
        consumeReturnsRow();
        setSessionSucceeds();
        return GET(makeRequest({ code: VALID_CODE, next: '/home?mode=app' }));
      },
    ],
    ['コード方式の形式不正', () => GET(makeRequest({ code: 'abc' }))],
    ['コード方式の無効なコード', () => GET(makeRequest({ code: VALID_CODE }))],
    [
      'コード方式のユーザー不一致',
      async () => {
        consumeReturnsRow(USER_ID);
        setSessionSucceeds(OTHER_USER_ID);
        return GET(makeRequest({ code: VALID_CODE }));
      },
    ],
    [
      '無効なコード + Cookie セッションあり',
      async () => {
        mocks.getUser.mockResolvedValue({ data: { user: { id: USER_ID } }, error: null });
        return GET(makeRequest({ code: VALID_CODE, next: '/menus?mode=app' }));
      },
    ],
  ];

  it.each(scenarios)('%s', async (_label, run) => {
    const res = await run();

    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');

    const everything = `${res.headers.get('location') ?? ''}\n${await res.text()}`;
    for (const secret of [
      STORED_ACCESS,
      STORED_REFRESH,
      VALID_CODE,
      'legacy-access',
      'legacy-refresh',
    ]) {
      expect(everything).not.toContain(secret);
    }
  });
});


// ─────────────────────────────────────────────────────────────────────────────
// ケース 14: Web の Cookie セッションに入れる refresh_token (#1038 F7-05)
// ─────────────────────────────────────────────────────────────────────────────
describe('ケース14: Web の Cookie セッションの refresh_token は使えない値 (#1038 F7-05)', () => {
  it('既定: ネイティブの実際の refresh_token は setSession に渡さない (Web が更新してフォークするのを防ぐ)', async () => {
    consumeReturnsRow();
    setSessionSucceeds();

    await GET(makeRequest({ code: VALID_CODE }));

    const [arg] = mocks.setSession.mock.calls[0];
    expect(arg.access_token).toBe(STORED_ACCESS);
    expect(arg.refresh_token).toBe(NATIVE_BRIDGE_WEB_REFRESH_TOKEN_PLACEHOLDER);
    expect(arg.refresh_token).not.toBe(STORED_REFRESH);
    expect(JSON.stringify(mocks.setSession.mock.calls)).not.toContain(STORED_REFRESH);
  });

  it('使えない値は、実在しそうな長いトークンではなく、一目で分かる固定値', () => {
    // Supabase に存在しないので、更新は必ず失敗する。ログに出ても問題ない (秘密ではない)
    expect(NATIVE_BRIDGE_WEB_REFRESH_TOKEN_PLACEHOLDER).toMatch(/^[a-z-]+$/);
    expect(NATIVE_BRIDGE_WEB_REFRESH_TOKEN_PLACEHOLDER.length).toBeGreaterThan(10);
  });

  it.each(['on', 'ON', '  On  '])(
    'NATIVE_BRIDGE_SHARE_REFRESH_TOKEN=%j: 従来の動作 (実際の refresh_token を渡す) に戻せる',
    async (value) => {
      vi.stubEnv('NATIVE_BRIDGE_SHARE_REFRESH_TOKEN', value);
      consumeReturnsRow();
      setSessionSucceeds();

      await GET(makeRequest({ code: VALID_CODE }));

      expect(mocks.setSession).toHaveBeenCalledWith({ access_token: STORED_ACCESS, refresh_token: STORED_REFRESH });
    },
  );

  it.each(['', 'off', 'true', '1', 'yes'])(
    'NATIVE_BRIDGE_SHARE_REFRESH_TOKEN=%j: "on" 以外は切り替わらない (使えない値のまま)',
    async (value) => {
      vi.stubEnv('NATIVE_BRIDGE_SHARE_REFRESH_TOKEN', value);
      consumeReturnsRow();
      setSessionSucceeds();

      await GET(makeRequest({ code: VALID_CODE }));

      expect(mocks.setSession).toHaveBeenCalledWith({
        access_token: STORED_ACCESS,
        refresh_token: NATIVE_BRIDGE_WEB_REFRESH_TOKEN_PLACEHOLDER,
      });
    },
  );

  it('旧方式 (トークンを URL で渡す GET) は変えない: 旧アプリは再ブリッジの仕組みを持たないので、実際の refresh_token のまま', async () => {
    setSessionSucceeds();

    const res = await GET(makeRequest({ access_token: 'legacy-access', refresh_token: 'legacy-refresh', next: '/home?mode=app' }));

    expect(res.status).toBe(307);
    expect(mocks.setSession).toHaveBeenCalledWith({ access_token: 'legacy-access', refresh_token: 'legacy-refresh' });
  });
});
