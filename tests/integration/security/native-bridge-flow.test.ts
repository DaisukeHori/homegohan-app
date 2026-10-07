/**
 * #1036 モバイル WebView 認証ブリッジ: アクセストークン / リフレッシュトークンを URL に載せない方式の
 * 結合テスト (Next の API ルート + 実 Supabase Auth)
 *
 * 修正前:
 *   - GET /auth/native-bridge?access_token=...&refresh_token=...&next=... がトークンを URL で受け取っていた。
 *     URL はアクセスログに残るため、有効なトークンがそのままログに漏れる (critical)。
 *   - `next` の検証が不完全で、`//evil.example/x` や `/\evil.example/x` を同一オリジンのパスとして通し、
 *     認証済みのまま外部へリダイレクトした (オープンリダイレクト)。
 * 修正後:
 *   - ネイティブは POST /api/auth/native-bridge/code (Bearer JWT + body の refresh_token) で 60 秒・1 回限りの
 *     コードをもらい、WebView は GET /auth/native-bridge?code=... だけを開く。トークンは URL にも
 *     リダイレクト先にも出ない。
 *   - `next` は同一オリジンの相対パスだけを許可する。
 *   - 旧方式 (トークンを URL で渡す GET) は旧アプリ向けに期限つきで残す。期限後は 426。
 *
 * 期待する挙動:
 *   - コード発行は Bearer JWT 必須 (Cookie だけの認証は 401)。body が不正なら 400。凍結アカウントは 403
 *   - 発行したコードで /auth/native-bridge を開くと Cookie セッションができ (sb-* と is_native_app)、
 *     next へ 307。Location にもレスポンス本文にもトークンが無い。Cache-Control は no-store
 *   - 同じコードの 2 回目は /login へ。ただし同じ WebView が既に Cookie セッションを持っていれば next へ続く
 *   - Cookie だけで認証が通る (WebView 側に localStorage の注入が要らないことの証明)
 *   - 壊れたコード・他人の user_id に紐づく行は拒否し、セッション Cookie を残さない
 *   - `next` に外部 URL / プロトコル相対 URL / バックスラッシュ / エンコードした `//` を入れても外へ出ない
 *
 * 実行 (ローカル Supabase + ローカルの Next dev サーバが必要):
 *   bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local
 *   npm run dev &
 *   INTEGRATION_BASE_URL=http://localhost:3000 \
 *     npx vitest run --config vitest.integration.config.ts tests/integration/security/native-bridge-flow.test.ts
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { createHash } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import ws from 'ws';
import { apiCall } from '../helpers/api';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!url || !anonKey || !serviceKey) {
  throw new Error(
    'NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY が未設定です。',
  );
}

// このテストはローカルの dev サーバだけを対象にする (本番や共有環境へ誤って向けない。トークンを送るため)。
// apiCall ヘルパー (tests/integration/helpers/api.ts) と同じ順序で接続先を決める。
const BASE_URL = process.env.INTEGRATION_BASE_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';
const baseHost = new URL(BASE_URL).hostname;
if (baseHost !== 'localhost' && baseHost !== '127.0.0.1') {
  throw new Error(
    `INTEGRATION_BASE_URL (未設定なら NEXT_PUBLIC_APP_URL) はローカルの dev サーバを指してください (現在: ${BASE_URL})`,
  );
}

/**
 * 旧方式 (トークンを URL で渡す GET) の受け付け期限。src/lib/auth/native-bridge-code.ts の LEGACY_SUNSET_AT と同じ値に保つ
 * (オーナーの確認待ちの仮置き。変えたらここも変える)。期限後は 426 になるのが正しい挙動。
 */
const LEGACY_SUNSET_AT = '2026-12-31T00:00:00+09:00';
const legacyStillAllowed = Date.now() < Date.parse(LEGACY_SUNSET_AT);

function client(key: string): SupabaseClient {
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
    realtime: { transport: ws as unknown as typeof WebSocket },
  });
}

const srAdmin = client(serviceKey);
const anon = () => client(anonKey);

interface TestUser {
  id: string;
  email: string;
  accessToken: string;
  refreshToken: string;
}

const TS = Date.now();
const PASSWORD = 'TestPass!2026-sec';
const createdUserIds: string[] = [];

/**
 * onboardingCompleted: true にすると、オンボーディング完了済みのユーザーになる。
 * 未完了のユーザーは、Cookie セッションを持つリクエストが middleware (lib/onboarding-routing.ts) によって
 * /auth/native-bridge を含む全ての非オンボーディングパスから /onboarding/welcome へ飛ばされ、
 * ルートハンドラに届かない。ブリッジのルート自身の挙動 (S-7) を確かめるときは完了済みのユーザーを使う。
 */
async function createUser(label: string, options: { onboardingCompleted?: boolean } = {}): Promise<TestUser> {
  const email = `sec-1036-${label}-${TS}@homegohan.test`;
  const { data, error } = await srAdmin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw new Error(`createUser ${label}: ${error?.message}`);
  createdUserIds.push(data.user.id);
  const now = new Date().toISOString();
  const { error: profileError } = await srAdmin.from('user_profiles').upsert(
    {
      id: data.user.id,
      nickname: `bridge-${label}`,
      age_group: '30s',
      gender: 'other',
      ...(options.onboardingCompleted ? { onboarding_started_at: now, onboarding_completed_at: now } : {}),
    },
    { onConflict: 'id' },
  );
  if (profileError) throw new Error(`profile ${label}: ${profileError.message}`);
  return signIn(email, data.user.id);
}

/** サインインは使い捨てのクライアントで行う (srAdmin でサインインすると service_role でなくなる) */
async function signIn(email: string, id: string): Promise<TestUser> {
  const res = await anon().auth.signInWithPassword({ email, password: PASSWORD });
  if (res.error || !res.data.session) throw new Error(`signIn ${email}: ${res.error?.message}`);
  return {
    id,
    email,
    accessToken: res.data.session.access_token,
    refreshToken: res.data.session.refresh_token,
  };
}

interface CodeResponse {
  code?: string;
  expires_in?: number;
  error?: { code: string; message: string };
}

/** ネイティブアプリ相当: Bearer JWT + refresh_token でコードを発行してもらう */
async function issueCode(user: TestUser) {
  return apiCall<CodeResponse>('POST', '/api/auth/native-bridge/code', user.accessToken, {
    refresh_token: user.refreshToken,
  });
}

/** WebView 相当: リダイレクトを追わずに /auth/native-bridge を GET する */
async function bridge(params: Record<string, string>, cookie?: string): Promise<Response> {
  const target = new URL('/auth/native-bridge', BASE_URL);
  for (const [k, v] of Object.entries(params)) target.searchParams.set(k, v);
  return fetch(target, { redirect: 'manual', headers: cookie ? { Cookie: cookie } : {} });
}

interface ParsedCookie {
  name: string;
  value: string;
  raw: string;
}

function setCookies(res: Response): ParsedCookie[] {
  return res.headers.getSetCookie().map((raw) => {
    const pair = raw.split(';')[0];
    const eq = pair.indexOf('=');
    return { name: pair.slice(0, eq), value: pair.slice(eq + 1), raw };
  });
}

/** Set-Cookie のうち、中身のある sb-* (Supabase セッション) を Cookie ヘッダ形式にする */
function sessionCookieHeader(res: Response): string {
  return setCookies(res)
    .filter((c) => c.name.startsWith('sb-') && c.value !== '')
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
}

/** Set-Cookie の sb-*-auth-token(.N) をつなげて、セッション JSON を取り出す */
function readSession(res: Response): { user?: { id?: string }; access_token?: string; refresh_token?: string } | null {
  const chunks = setCookies(res)
    .filter((c) => /^sb-.+-auth-token(\.\d+)?$/.test(c.name) && c.value !== '')
    .sort((a, b) => {
      const ia = Number(a.name.split('.')[1] ?? -1);
      const ib = Number(b.name.split('.')[1] ?? -1);
      return ia - ib;
    });
  if (chunks.length === 0) return null;
  try {
    return JSON.parse(chunks.map((c) => decodeURIComponent(c.value)).join(''));
  } catch {
    return null;
  }
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Location を BASE_URL 基準で解決する */
function locationOf(res: Response): URL {
  const location = res.headers.get('location');
  if (!location) throw new Error(`Location ヘッダがありません (status=${res.status})`);
  return new URL(location, BASE_URL);
}

let userA: TestUser;
let userB: TestUser;
/** オンボーディング完了済み (middleware に先回りされずに、ブリッジのルート自身の挙動を確かめる用) */
let userDone: TestUser;

beforeAll(async () => {
  [userA, userB, userDone] = await Promise.all([
    createUser('a'),
    createUser('b'),
    createUser('done', { onboardingCompleted: true }),
  ]);
}, 60_000);

afterAll(async () => {
  for (const id of createdUserIds) {
    await srAdmin.from('native_bridge_codes').delete().eq('user_id', id);
    await srAdmin.from('user_profiles').update({ frozen_at: null, unban_at: null }).eq('id', id);
  }
  for (const id of createdUserIds) {
    await srAdmin.auth.admin.deleteUser(id);
  }
}, 30_000);

// ================================================================
// コード発行 API
// ================================================================
describe('#1036 POST /api/auth/native-bridge/code', () => {
  it('S-1: Authorization が無い / Bearer が不正なら 401 (AUTH_UNAUTHENTICATED)。コードは作られない', async () => {
    const before = await srAdmin.from('native_bridge_codes').select('code_hash', { count: 'exact', head: true });
    expect(before.error).toBeNull();

    const none = await apiCall<CodeResponse>('POST', '/api/auth/native-bridge/code', null, { refresh_token: 'x' });
    expect(none.status).toBe(401);
    expect(none.body.error?.code).toBe('AUTH_UNAUTHENTICATED');

    const garbage = await apiCall<CodeResponse>('POST', '/api/auth/native-bridge/code', 'not-a-jwt', {
      refresh_token: 'x',
    });
    expect(garbage.status).toBe(401);
    expect(garbage.body.error?.code).toBe('AUTH_UNAUTHENTICATED');

    // anon キー (JWT だがユーザーではない) も通らない
    const anonJwt = await apiCall<CodeResponse>('POST', '/api/auth/native-bridge/code', anonKey, {
      refresh_token: 'x',
    });
    expect(anonJwt.status).toBe(401);

    const after = await srAdmin.from('native_bridge_codes').select('code_hash', { count: 'exact', head: true });
    expect(after.count).toBe(before.count);
  });

  it('S-2: body が不正なら 400 (NATIVE_BRIDGE_BAD_REQUEST)', async () => {
    const send = async (body: unknown) => apiCall<CodeResponse>('POST', '/api/auth/native-bridge/code', userA.accessToken, body);

    for (const bad of [
      {},
      { refresh_token: '' },
      { refresh_token: 12345 },
      { refresh_token: 'x'.repeat(1025) },
      { access_token: userA.accessToken },
    ]) {
      const res = await send(bad);
      expect(res.status, JSON.stringify(Object.keys(bad))).toBe(400);
      expect(res.body.error?.code).toBe('NATIVE_BRIDGE_BAD_REQUEST');
    }

    // JSON でない body
    const raw = await fetch(new URL('/api/auth/native-bridge/code', BASE_URL), {
      method: 'POST',
      headers: { Authorization: `Bearer ${userA.accessToken}`, 'Content-Type': 'application/json' },
      body: 'this is not json',
    });
    expect(raw.status).toBe(400);
  });

  it('S-3: 正常系: 43 文字の base64url コードを返し (no-store)、DB には sha256 だけが保存される', async () => {
    const res = await issueCode(userA);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toContain('no-store');
    expect(res.body.expires_in).toBe(60);
    const code = res.body.code!;
    expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const stored = await srAdmin
      .from('native_bridge_codes')
      .select('code_hash, user_id, refresh_token')
      .eq('code_hash', sha256Hex(code))
      .single();
    expect(stored.error).toBeNull();
    expect(stored.data?.user_id).toBe(userA.id);
    expect(stored.data?.refresh_token).toBe(userA.refreshToken);
    // コード本体は表のどこにも保存されない
    const leaked = await srAdmin.from('native_bridge_codes').select('code_hash').eq('code_hash', code);
    expect(leaked.data ?? []).toEqual([]);
  });

  it('S-4: 凍結中のアカウントには発行しない (403 AUTH_ACCOUNT_FROZEN)', async () => {
    const frozen = await createUser('frozen');
    const { error } = await srAdmin
      .from('user_profiles')
      .update({ frozen_at: new Date().toISOString(), unban_at: null })
      .eq('id', frozen.id);
    expect(error).toBeNull();

    const res = await issueCode(frozen);
    expect(res.status).toBe(403);
    expect(res.body.error?.code).toBe('AUTH_ACCOUNT_FROZEN');

    const rows = await srAdmin.from('native_bridge_codes').select('code_hash').eq('user_id', frozen.id);
    expect(rows.data ?? []).toEqual([]);
  });
});

// ================================================================
// ブリッジ (コード -> Cookie セッション)
// ================================================================
describe('#1036 GET /auth/native-bridge?code=...', () => {
  it('S-5: コードで Cookie セッションができ、next へ 307。URL にもレスポンスにもトークンが無い', async () => {
    const issued = await issueCode(userA);
    expect(issued.status).toBe(200);
    const code = issued.body.code!;

    const res = await bridge({ code, next: '/home?mode=app' });
    expect(res.status).toBe(307);

    const location = locationOf(res);
    expect(location.origin).toBe(new URL(BASE_URL).origin);
    expect(location.pathname).toBe('/home');
    expect(location.search).toBe('?mode=app');

    // 共有キャッシュや履歴に残さない
    expect(res.headers.get('cache-control')).toContain('no-store');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');

    // セッション Cookie (sb-*) と is_native_app が付く
    const cookies = setCookies(res);
    expect(cookies.some((c) => c.name.startsWith('sb-') && c.value !== '')).toBe(true);
    expect(cookies.find((c) => c.name === 'is_native_app')?.value).toBe('1');

    // セッションは発行したユーザーのもの
    expect(readSession(res)?.user?.id).toBe(userA.id);

    // トークンは Location にもレスポンス本文にも出ない
    const body = await res.text();
    for (const secret of [userA.accessToken, userA.refreshToken]) {
      expect(res.headers.get('location') ?? '').not.toContain(secret);
      expect(body).not.toContain(secret);
    }
    // コード自体も Location に出ない
    expect(res.headers.get('location') ?? '').not.toContain(code);
  });

  it('S-6: 使用済みのコードは再利用できない (/login へ。セッション Cookie も is_native_app も付かない)', async () => {
    const code = (await issueCode(userA)).body.code!;
    const first = await bridge({ code });
    expect(first.status).toBe(307);
    expect(sessionCookieHeader(first)).not.toBe('');

    const replay = await bridge({ code });
    expect(replay.status).toBe(307);
    expect(locationOf(replay).pathname).toBe('/login');
    expect(sessionCookieHeader(replay)).toBe('');
    expect(setCookies(replay).some((c) => c.name === 'is_native_app')).toBe(false);
    expect(replay.headers.get('cache-control')).toContain('no-store');
  });

  it('S-7: 同じ WebView が既に Cookie セッションを持っていれば、使用済みコードの再読み込みは next へ続く', async () => {
    const code = (await issueCode(userDone)).body.code!;
    const first = await bridge({ code, next: '/menus?mode=app' });
    const cookie = sessionCookieHeader(first);
    expect(cookie).not.toBe('');

    // リロード / 二重読み込み: コードは使用済みだが、Cookie セッションはある
    const reload = await bridge({ code, next: '/menus?mode=app' }, cookie);
    expect(reload.status).toBe(307);
    const location = locationOf(reload);
    expect(location.pathname).toBe('/menus');
    expect(location.search).toBe('?mode=app');
    // セッションを作り直してはいない (コードは使用済み) ので、セッション Cookie も is_native_app も付かない
    expect(sessionCookieHeader(reload)).toBe('');
    expect(setCookies(reload).some((c) => c.name === 'is_native_app')).toBe(false);
    expect(reload.headers.get('cache-control')).toContain('no-store');
  });

  it('S-7b: オンボーディング未完了のユーザーは、Cookie があると middleware が先に /onboarding/welcome へ飛ばす (従来どおり。/login にはならない)', async () => {
    const code = (await issueCode(userA)).body.code!;
    const first = await bridge({ code });
    const cookie = sessionCookieHeader(first);
    expect(cookie).not.toBe('');

    const reload = await bridge({ code, next: '/menus?mode=app' }, cookie);
    expect(reload.status).toBe(307);
    expect(locationOf(reload).pathname).toBe('/onboarding/welcome');
  });

  it('S-8: Cookie だけで認証が通る (WebView へ localStorage を注入しなくてよい)', async () => {
    const code = (await issueCode(userA)).body.code!;
    const res = await bridge({ code });
    const cookie = sessionCookieHeader(res);
    expect(cookie).not.toBe('');

    // Authorization ヘッダなし・Cookie だけで、セッション同期 API が 200 になる
    const sync = await fetch(new URL('/api/auth/session-sync', BASE_URL), {
      method: 'POST',
      headers: { Cookie: cookie },
    });
    expect(sync.status).toBe(200);
    expect(await sync.json()).toEqual({ ok: true });

    // 認証が必要なページに入れる (ログインへ飛ばされない)。初回コンパイルが遅いため時間を長めに取る
    const page = await fetch(new URL('/home', BASE_URL), { redirect: 'manual', headers: { Cookie: cookie } });
    if (page.status >= 300 && page.status < 400) {
      expect(locationOf(page).pathname).not.toBe('/login');
    } else {
      expect(page.status).toBe(200);
    }
  }, 120_000);

  it('S-9: Cookie だけではコードを発行できない (Bearer 必須。CSRF の面を作らない)', async () => {
    const code = (await issueCode(userA)).body.code!;
    const bridged = await bridge({ code });
    const cookie = sessionCookieHeader(bridged);
    expect(cookie).not.toBe('');

    const res = await fetch(new URL('/api/auth/native-bridge/code', BASE_URL), {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: userA.refreshToken }),
    });
    expect(res.status).toBe(401);
  });

  it('S-10: 壊れたコード / 存在しないコードは /login へ。セッション Cookie は付かない', async () => {
    for (const code of ['', 'abc', 'x'.repeat(42), 'x'.repeat(44), `${'A'.repeat(42)}!`, 'A'.repeat(43)]) {
      const res = await bridge({ code });
      expect(res.status, `code="${code}"`).toBe(307);
      expect(locationOf(res).pathname).toBe('/login');
      expect(sessionCookieHeader(res)).toBe('');
    }
  });

  it('S-11: コードがあれば、同時に付いた旧方式のトークンは使わない (code 優先)', async () => {
    // 有効なトークンを付けても、コードが無効なら /login (旧方式にフォールバックしない)
    const res = await bridge({
      code: 'A'.repeat(43),
      access_token: userB.accessToken,
      refresh_token: userB.refreshToken,
    });
    expect(res.status).toBe(307);
    expect(locationOf(res).pathname).toBe('/login');
    expect(sessionCookieHeader(res)).toBe('');
  });

  it('S-12: 行の user_id とトークンの持ち主が食い違うコードは拒否し、セッション Cookie を残さない', async () => {
    // 正規の経路では作れない状態 (DB の行の改ざん) を service_role で作る: user_id は B、トークンは A のもの
    const code = `${'B'.repeat(42)}A`;
    const inserted = await srAdmin.from('native_bridge_codes').insert({
      code_hash: sha256Hex(code),
      user_id: userB.id,
      access_token: userA.accessToken,
      refresh_token: userA.refreshToken,
    });
    expect(inserted.error).toBeNull();

    const res = await bridge({ code, next: '/home?mode=app' });
    expect(res.status).toBe(307);
    expect(locationOf(res).pathname).toBe('/login');
    // 中身のあるセッション Cookie は残らない (setSession が書いた分は削除される)
    expect(sessionCookieHeader(res)).toBe('');
    expect(setCookies(res).some((c) => c.name === 'is_native_app')).toBe(false);
    // 削除の Set-Cookie は Path=/ つき (Path が違うとブラウザは消さない)
    const deletions = setCookies(res).filter((c) => c.name.startsWith('sb-') && c.value === '');
    expect(deletions.length).toBeGreaterThan(0);
    for (const d of deletions) expect(d.raw.toLowerCase()).toContain('path=/');

    // 行は消費済み (再利用できない)
    const left = await srAdmin.from('native_bridge_codes').select('code_hash').eq('code_hash', sha256Hex(code));
    expect(left.data ?? []).toEqual([]);
    // A の実セッションは失効していない (signOut で巻き添えにしない)
    const stillValid = await srAdmin.auth.getUser(userA.accessToken);
    expect(stillValid.data.user?.id).toBe(userA.id);
  });
});

// ================================================================
// オープンリダイレクト (next)
// ================================================================
describe('#1036 /auth/native-bridge の next は同一オリジンの相対パスだけ', () => {
  const evilNexts = [
    ['プロトコル相対 URL', '//evil.example/x'],
    ['バックスラッシュ', '/\\evil.example/x'],
    ['エンコードした //', '/%2F/evil.example/x'],
    ['二重エンコードした //', '/%252F%252Fevil.example/x'],
    ['タブを挟んだ //', '/\t/evil.example/x'],
    ['外部の絶対 URL', 'https://evil.example/x'],
    ['userinfo で偽装した絶対 URL', 'https://localhost@evil.example/x'],
    ['javascript: スキーム', 'javascript:alert(1)'],
  ] as const;

  it.each(evilNexts)('S-13: コード方式: next=%s は外へ出ず、既定の /home?mode=app になる', async (_label, evil) => {
    const code = (await issueCode(userA)).body.code!;
    const res = await bridge({ code, next: evil });
    expect(res.status).toBe(307);
    const location = locationOf(res);
    expect(location.origin).toBe(new URL(BASE_URL).origin);
    expect(location.href).not.toContain('evil.example');
    expect(location.pathname).toBe('/home');
    expect(location.search).toBe('?mode=app');
  });

  it.each(evilNexts)('S-14: 旧方式でも next=%s は外へ出ない (修正前はオープンリダイレクト)', async (_label, evil) => {
    if (!legacyStillAllowed) return; // 期限後は 426 (S-16)
    const res = await bridge({ access_token: userB.accessToken, refresh_token: userB.refreshToken, next: evil });
    expect(res.status).toBe(307);
    const location = locationOf(res);
    expect(location.origin).toBe(new URL(BASE_URL).origin);
    expect(location.href).not.toContain('evil.example');
  });

  it('S-15: 同一オリジンの絶対 URL と正当な相対パスはそのまま通る', async () => {
    const abs = await bridge({ code: (await issueCode(userA)).body.code!, next: `${BASE_URL}/menus?x=1` });
    expect(abs.status).toBe(307);
    expect(locationOf(abs).pathname).toBe('/menus');
    expect(locationOf(abs).search).toBe('?x=1');

    const rel = await bridge({ code: (await issueCode(userA)).body.code!, next: '/profile?mode=app' });
    expect(rel.status).toBe(307);
    expect(locationOf(rel).pathname).toBe('/profile');
    expect(locationOf(rel).search).toBe('?mode=app');
  });
});

// ================================================================
// 旧方式 (トークンを URL で渡す GET)
// ================================================================
describe('#1036 旧方式 (access_token / refresh_token を URL で渡す GET) の扱い', () => {
  it('S-16: 期限内は従来どおり動き、期限後 (または NATIVE_BRIDGE_LEGACY_GET=off) は 426 でセッションを作らない', async () => {
    const res = await bridge({ access_token: userB.accessToken, refresh_token: userB.refreshToken, next: '/home?mode=app' });
    const body = await res.text();
    if (legacyStillAllowed) {
      expect(res.status).toBe(307);
      expect(locationOf(res).pathname).toBe('/home');
      expect(readSession(res)?.user?.id).toBe(userB.id);
    } else {
      expect(res.status).toBe(426);
      expect(sessionCookieHeader(res)).toBe('');
      expect(body).toContain('更新');
    }
    expect(res.headers.get('cache-control')).toContain('no-store');
    // どちらの場合もトークンを Location やレスポンス本文に出さない
    for (const secret of [userB.accessToken, userB.refreshToken]) {
      expect(res.headers.get('location') ?? '').not.toContain(secret);
      expect(body).not.toContain(secret);
    }
  });

  it('S-17: トークンが片方だけなら /login へ', async () => {
    const onlyAccess = await bridge({ access_token: userB.accessToken });
    expect(onlyAccess.status).toBe(307);
    expect(locationOf(onlyAccess).pathname).toBe('/login');

    const onlyRefresh = await bridge({ refresh_token: userB.refreshToken });
    expect(onlyRefresh.status).toBe(307);
    expect(locationOf(onlyRefresh).pathname).toBe('/login');
  });
});
