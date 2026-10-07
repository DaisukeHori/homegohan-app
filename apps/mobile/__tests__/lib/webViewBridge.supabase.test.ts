/**
 * webViewBridge.supabase.test.ts
 * getSessionForBridge を、本物の supabase-js (GoTrueClient) と Web 側の判定を模したサーバーに通して検証する (#1036)
 *
 * 背景:
 *   Web 側 (src/lib/auth/native-bridge-code.ts) は、code 発行時に access_token の残りが 150 秒以上あることを要求し、
 *   足りなければ 401 AUTH_TOKEN_EXPIRING を返す。150 秒は「code の有効期間 60 秒 + auth-js が getSession() で更新を始める余裕 90 秒」。
 *   一方、端末の supabase-js は getSession() が残り 90 秒を切るまで自動更新しない。
 *   そのため bridge の時点の access_token の残りは 90〜3600 秒になり、モバイル側の事前 refresh の閾値が Web 側の下限より低いと、
 *   その差の区間で Web 側が必ず 401 を返す。code が取れなければ WebView はトークン無しの直接 URL を開くので、
 *   その WebView に有効な Cookie セッションが無ければ、タブにログイン画面が出たままになる。
 *   (例: 閾値が 120 秒だと、残り 120〜150 秒の区間 = 1 時間のうち 30 秒に当たるタブ表示がこれになる)
 *
 * スタブの auth ではこの食い違いが見えない (スタブは「更新しない条件」を自分で決めてしまう) ので、
 * ここでは本物の GoTrueClient (保存先と fetch だけ差し替え) を使い、サーバー側の下限と組み合わせて確かめる。
 * supabase-js の更新条件が変わった (ライブラリの更新) ときも、このテストが気付かせる。
 */

import { createClient } from '@supabase/supabase-js';

import {
  BRIDGE_MIN_TOKEN_TTL_SEC,
  BRIDGE_REQUEST_TIMEOUT_MS,
  BRIDGE_SERVER_MIN_TOKEN_TTL_SEC,
  getSessionForBridge,
} from '../../src/lib/webViewBridge';

// ── Web 側との契約 (src/lib/auth/native-bridge-code.ts) ──────────────────────────
// モバイルの定数ではなく数値で持つ。Web 側の値が変わったら、ここと BRIDGE_SERVER_MIN_TOKEN_TTL_SEC を一緒に直す。
/** NATIVE_BRIDGE_CODE_TTL_SECONDS */
const WEB_CODE_TTL_SEC = 60;
/** AUTH_JS_EXPIRY_MARGIN_SECONDS (= supabase-js の EXPIRY_MARGIN_MS) */
const AUTH_JS_EXPIRY_MARGIN_SEC = 90;
/** MIN_ACCESS_TOKEN_REMAINING_SECONDS: これ未満の access_token には code を発行しない (401 AUTH_TOKEN_EXPIRING) */
const WEB_MIN_ACCESS_TOKEN_REMAINING_SEC = WEB_CODE_TTL_SEC + AUTH_JS_EXPIRY_MARGIN_SEC;

const base64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

/** Web 側は JWT の exp (署名は別途検証済み) で残りを判定する */
function makeJwt(exp: number): string {
  return `${base64url({ alg: 'HS256', typ: 'JWT' })}.${base64url({ sub: 'user-1', exp })}.signature`;
}

function jwtExp(jwt: string): number {
  return JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8')).exp;
}

const nowSec = () => Math.floor(Date.now() / 1000);

/** POST /api/auth/native-bridge/code が、この access_token に code を発行するか (arrivalSec: リクエストが Web 側に届く時刻) */
function webIssuesCode(accessToken: string, arrivalSec: number): boolean {
  return jwtExp(accessToken) - arrivalSec >= WEB_MIN_ACCESS_TOKEN_REMAINING_SEC;
}

const USER = {
  id: 'user-1',
  aud: 'authenticated',
  email: 'a@example.com',
  app_metadata: {},
  user_metadata: {},
  created_at: '2026-01-01T00:00:00Z',
};

/**
 * 端末の supabase-js (本物の GoTrueClient)。保存先はメモリ、refresh のエンドポイントは fetch のモック。
 *
 * @param remainingSec アクセストークンの、実時間での残り秒数 (JWT の exp = 今 + remainingSec)
 * @param clockBehindSec 端末の時計が実時間より遅れている秒数。
 *   端末は expires_at を自分の時計と比べるので、遅れた分だけ「残りが多い」と見積もる。
 *   端末の時計は実時間のままにして、expires_at をその分だけ先に置くことで再現する。
 */
function makeDeviceAuth(remainingSec: number, clockBehindSec = 0) {
  const exp = nowSec() + remainingSec;
  const stored = {
    access_token: makeJwt(exp),
    refresh_token: 'RT-old',
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: exp + clockBehindSec,
    user: USER,
  };
  const store = new Map<string, string>([['sb-test-auth-token', JSON.stringify(stored)]]);
  const storage = {
    getItem: async (key: string) => store.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: async (key: string) => {
      store.delete(key);
    },
  };
  // refresh のエンドポイント。新しい access_token は 1 時間有効
  const fetchMock = jest.fn(async () => {
    const newExp = nowSec() + 3600;
    return new Response(
      JSON.stringify({
        access_token: makeJwt(newExp),
        refresh_token: 'RT-new',
        token_type: 'bearer',
        expires_in: 3600,
        expires_at: newExp,
        user: USER,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  });
  const client = createClient('https://example.supabase.co', 'anon-key', {
    auth: {
      storage,
      storageKey: 'sb-test-auth-token',
      autoRefreshToken: false,
      persistSession: true,
      detectSessionInUrl: false,
    },
    global: { fetch: fetchMock as unknown as typeof fetch },
  });
  return { auth: client.auth, fetchMock, originalAccessToken: stored.access_token };
}

describe('supabase-js の getSession() の自動更新の条件 (Web 側の下限 150 秒 = 60 + 90 の前提)', () => {
  it('残りが約 90 秒を切るまでは更新しない (100 秒では更新せず、80 秒では更新する)', async () => {
    const notExpiring = makeDeviceAuth(100);
    const kept = await notExpiring.auth.getSession();
    expect(kept.data.session?.access_token).toBe(notExpiring.originalAccessToken);
    expect(notExpiring.fetchMock).not.toHaveBeenCalled();

    const expiring = makeDeviceAuth(80);
    const renewed = await expiring.auth.getSession();
    expect(expiring.fetchMock).toHaveBeenCalledTimes(1);
    expect(String((expiring.fetchMock.mock.calls[0] as unknown[])[0])).toContain('grant_type=refresh_token');
    expect(renewed.data.session?.access_token).not.toBe(expiring.originalAccessToken);
  });
});

describe('getSessionForBridge() と Web 側の下限 (本物の supabase-js)', () => {
  // 残り 90 秒未満は getSession() 自身が更新する。90〜150 秒は端末の supabase-js が更新しないのに Web 側が拒否する区間。
  // 120 秒 (旧閾値) や 149 秒 (Web 側の下限の 1 秒前) を含め、境界の前後を並べる。1 秒のずれで結果が変わらない値を選んでいる
  const REMAINING_SEC = [0, 30, 60, 80, 95, 100, 119, 125, 130, 140, 149, 155, 160, 170, 180, 200, 205, 215, 230, 300, 1800, 3600];
  // 端末の時計が実時間より遅れている秒数。0 (正確) と、余裕 (60 秒 - 通信 8 秒) に収まる遅れ
  const CLOCK_BEHIND_SEC = [0, 20, 40];
  // リクエストを送ってから Web 側が判定するまでの最大の時間 (code 発行リクエストの打ち切り時間)
  const WORST_LATENCY_SEC = BRIDGE_REQUEST_TIMEOUT_MS / 1000;

  const CASES = REMAINING_SEC.flatMap((remaining) =>
    CLOCK_BEHIND_SEC.map((behind) => [remaining, behind] as [number, number]),
  );

  it.each(CASES)(
    '実時間の残り %i 秒・端末の時計が %i 秒遅れ: Web 側が code を発行するトークンが返る',
    async (remaining, behind) => {
      const { auth } = makeDeviceAuth(remaining, behind);

      const session = await getSessionForBridge(auth);

      expect(session).not.toBeNull();
      expect(webIssuesCode(session!.access_token, nowSec() + WORST_LATENCY_SEC)).toBe(true);
    },
  );

  it('残りが 130 秒 (旧閾値 120 秒より上で、Web 側の下限 150 秒より下) でも、先に refreshSession してから返す', async () => {
    const { auth, fetchMock, originalAccessToken } = makeDeviceAuth(130);

    const session = await getSessionForBridge(auth);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(session?.access_token).not.toBe(originalAccessToken);
    expect(session?.refresh_token).toBe('RT-new');
  });

  it('十分に残っていれば (1 時間) refreshSession しない', async () => {
    const { auth, fetchMock, originalAccessToken } = makeDeviceAuth(3600);

    const session = await getSessionForBridge(auth);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(session?.access_token).toBe(originalAccessToken);
  });

  it('モバイル側の定数が Web 側との契約 (下限 150 秒 + 余裕) になっている', () => {
    expect(BRIDGE_SERVER_MIN_TOKEN_TTL_SEC).toBe(WEB_MIN_ACCESS_TOKEN_REMAINING_SEC);
    // 余裕は通信時間 (最大 BRIDGE_REQUEST_TIMEOUT_MS) より大きい
    expect(BRIDGE_MIN_TOKEN_TTL_SEC - BRIDGE_SERVER_MIN_TOKEN_TTL_SEC).toBeGreaterThan(BRIDGE_REQUEST_TIMEOUT_MS / 1000);
  });
});
