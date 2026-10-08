/**
 * web-view-auth-messages.test.ts
 * apps/mobile/src/lib/webViewAuthMessages.ts のテスト (#1038 F7-04 / F7-05)
 *
 * Web (WebView) から届く { type: 'sign-out' } / { type: 'session-expired' } をネイティブに反映する。
 *   - sign-out        : Web でログアウトされたら、ネイティブも push token の削除 → 端末データの削除 → サインアウトして、
 *                       ウェルカム画面へ戻る (Web とネイティブの状態の食い違いを無くす)
 *   - session-expired : Web のセッションが切れたら、ネイティブのセッションを確かめたうえで、WebView を読み込み直す。
 *                       ネイティブも失効していれば、読み込み直さずログアウトを揃える
 */

const mockGetSession = jest.fn();
const mockGetUser = jest.fn();
const mockSignOutWithCleanup = jest.fn();

jest.mock('expo-router', () => ({
  useLocalSearchParams: () => ({}),
  useNavigation: () => ({}),
  useRouter: () => ({ replace: jest.fn() }),
}));
jest.mock('../../src/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: (...args: unknown[]) => mockGetSession(...args),
      getUser: (...args: unknown[]) => mockGetUser(...args),
    },
  },
}));
jest.mock('../../src/lib/signOut', () => ({
  signOutWithCleanup: (...args: unknown[]) => mockSignOutWithCleanup(...args),
}));

import {
  createRebridgeLimiter,
  handleWebAuthMessage,
  isFromWebOrigin,
  parseWebAuthMessage,
  withRebridgeNonce,
  type WebAuthHandlerDeps,
} from '../../src/lib/webViewAuthMessages';

const WEB_ORIGIN = 'https://homegohan-app.vercel.app';
const PAGE = `${WEB_ORIGIN}/settings`;

function makeDeps(overrides: Partial<WebAuthHandlerDeps> = {}) {
  const rebridge = jest.fn();
  const goToWelcome = jest.fn();
  const deps: WebAuthHandlerDeps = {
    rebridge,
    goToWelcome,
    limiter: { tryAcquire: () => true },
    ...overrides,
  };
  return { deps, rebridge, goToWelcome };
}

function authError(name: string, status: number | undefined, message: string, code?: string) {
  return Object.assign(new Error(message), { name, status, code });
}

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.EXPO_PUBLIC_WEB_URL;
  mockGetSession.mockResolvedValue({ data: { session: { user: { id: 'user-1' } } } });
  mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null });
  mockSignOutWithCleanup.mockResolvedValue({ error: null });
});

describe('parseWebAuthMessage', () => {
  it('sign-out / session-expired だけを受け付ける', () => {
    expect(parseWebAuthMessage({ type: 'sign-out' })).toEqual({ type: 'sign-out' });
    expect(parseWebAuthMessage({ type: 'session-expired', extra: 'ignored' })).toEqual({ type: 'session-expired' });
  });

  it.each([null, undefined, 'sign-out', 42, [], {}, { type: 'download' }, { type: 'tab-navigate' }, { type: 123 }])(
    'それ以外 (%j) は null',
    (value) => {
      expect(parseWebAuthMessage(value)).toBeNull();
    },
  );
});

describe('isFromWebOrigin', () => {
  it('自分の Web と同じオリジンのページから届いたものを認める (既定の Web URL)', () => {
    expect(isFromWebOrigin(`${WEB_ORIGIN}/settings`)).toBe(true);
    expect(isFromWebOrigin(`${WEB_ORIGIN}/profile?mode=app#top`)).toBe(true);
    expect(isFromWebOrigin('HTTPS://HOMEGOHAN-APP.VERCEL.APP/home')).toBe(true);
  });

  it('EXPO_PUBLIC_WEB_URL を設定していればそのオリジン (ポート込み) と比べる', () => {
    process.env.EXPO_PUBLIC_WEB_URL = 'http://localhost:3000';
    expect(isFromWebOrigin('http://localhost:3000/settings')).toBe(true);
    expect(isFromWebOrigin('http://localhost:3001/settings')).toBe(false);
    expect(isFromWebOrigin(`${WEB_ORIGIN}/settings`)).toBe(false);
  });

  it.each([
    ['別のホスト', 'https://evil.example/settings'],
    ['前方一致でしかないホスト', 'https://homegohan-app.vercel.app.evil.example/settings'],
    ['ユーザー情報で偽装したホスト', 'https://homegohan-app.vercel.app@evil.example/settings'],
    ['認証情報つき', 'https://user:pass@homegohan-app.vercel.app/settings'],
    ['スキームが違う', 'http://homegohan-app.vercel.app/settings'],
    ['ポートが違う', 'https://homegohan-app.vercel.app:8443/settings'],
    ['about:blank', 'about:blank'],
    ['javascript:', 'javascript:alert(1)'],
    ['URL でない文字列', 'not a url'],
    ['空文字', ''],
  ])('%s は認めない', (_label, url) => {
    expect(isFromWebOrigin(url)).toBe(false);
  });

  it('送り元が分からない (undefined / 文字列でない) ときは認めない', () => {
    expect(isFromWebOrigin(undefined)).toBe(false);
    expect(isFromWebOrigin(null)).toBe(false);
    expect(isFromWebOrigin(123)).toBe(false);
  });
});

describe('createRebridgeLimiter', () => {
  it('最初は許可し、最小間隔の内は許可しない。間隔が過ぎたら許可する', () => {
    const limiter = createRebridgeLimiter({ minIntervalMs: 10_000, windowMs: 300_000, maxInWindow: 5 });

    expect(limiter.tryAcquire(0)).toBe(true);
    expect(limiter.tryAcquire(9_999)).toBe(false);
    expect(limiter.tryAcquire(10_000)).toBe(true);
  });

  it('期間内の回数に上限がある。期間を過ぎた古い記録は数えない', () => {
    const limiter = createRebridgeLimiter({ minIntervalMs: 1_000, windowMs: 60_000, maxInWindow: 3 });

    expect(limiter.tryAcquire(0)).toBe(true);
    expect(limiter.tryAcquire(2_000)).toBe(true);
    expect(limiter.tryAcquire(4_000)).toBe(true);
    expect(limiter.tryAcquire(6_000)).toBe(false); // 期間内に 3 回使い切り
    expect(limiter.tryAcquire(59_999)).toBe(false);
    expect(limiter.tryAcquire(60_000)).toBe(true); // 最初の 1 回が期間から外れた
  });

  it('既定値: 10 秒以上空け、5 分で 3 回まで', () => {
    const limiter = createRebridgeLimiter();

    expect(limiter.tryAcquire(0)).toBe(true);
    expect(limiter.tryAcquire(5_000)).toBe(false);
    expect(limiter.tryAcquire(10_000)).toBe(true);
    expect(limiter.tryAcquire(20_000)).toBe(true);
    expect(limiter.tryAcquire(30_000)).toBe(false);
    expect(limiter.tryAcquire(300_000)).toBe(true);
  });

  it('許可しなかった呼び出しは回数に数えない', () => {
    const limiter = createRebridgeLimiter({ minIntervalMs: 10_000, windowMs: 100_000, maxInWindow: 2 });

    expect(limiter.tryAcquire(0)).toBe(true);
    for (let t = 1; t < 10_000; t += 1_000) expect(limiter.tryAcquire(t)).toBe(false);
    expect(limiter.tryAcquire(10_000)).toBe(true);
  });
});

describe('withRebridgeNonce', () => {
  it('クエリが無いパスには ?_rb=... を付ける', () => {
    expect(withRebridgeNonce('/home', 123)).toBe('/home?_rb=123');
  });

  it('既存のクエリは順序もそのまま残し、末尾に付ける', () => {
    expect(withRebridgeNonce('/menus/weekly?mode=app&view=day', 7)).toBe('/menus/weekly?mode=app&view=day&_rb=7');
  });

  it('既に付いている _rb は付け替える (増えていかない)', () => {
    const once = withRebridgeNonce('/home?mode=app', 1);
    const twice = withRebridgeNonce(once, 2);
    expect(twice).toBe('/home?mode=app&_rb=2');
    expect(withRebridgeNonce('/home?_rb=1&mode=app', 5)).toBe('/home?mode=app&_rb=5');
    expect(withRebridgeNonce('/home?_rb&x=1', 5)).toBe('/home?x=1&_rb=5');
  });

  it('ハッシュは最後に残す', () => {
    expect(withRebridgeNonce('/home?mode=app#section', 9)).toBe('/home?mode=app&_rb=9#section');
    expect(withRebridgeNonce('/home#section', 9)).toBe('/home?_rb=9#section');
  });

  it('値を指定しなければ現在時刻の数値を使う (呼ぶたびに別の値になりうる)', () => {
    expect(withRebridgeNonce('/home')).toMatch(/^\/home\?_rb=\d+$/);
  });
});

describe('handleWebAuthMessage — 受け付けないメッセージ', () => {
  it('形式の違うメッセージは何もしない', async () => {
    const { deps, rebridge, goToWelcome } = makeDeps();

    expect(await handleWebAuthMessage({ type: 'download' }, PAGE, deps)).toBe('ignored');
    expect(await handleWebAuthMessage(null, PAGE, deps)).toBe('ignored');

    expect(mockSignOutWithCleanup).not.toHaveBeenCalled();
    expect(rebridge).not.toHaveBeenCalled();
    expect(goToWelcome).not.toHaveBeenCalled();
  });

  it.each([
    ['外部のページ', 'https://evil.example/phish'],
    ['送り元が不明', undefined],
    ['about:blank', 'about:blank'],
  ])('%s から届いた sign-out / session-expired は処理しない (外部ページからログアウトさせられない)', async (_label, sender) => {
    const { deps, rebridge, goToWelcome } = makeDeps();

    expect(await handleWebAuthMessage({ type: 'sign-out' }, sender, deps)).toBe('ignored');
    expect(await handleWebAuthMessage({ type: 'session-expired' }, sender, deps)).toBe('ignored');

    expect(mockSignOutWithCleanup).not.toHaveBeenCalled();
    expect(mockGetUser).not.toHaveBeenCalled();
    expect(rebridge).not.toHaveBeenCalled();
    expect(goToWelcome).not.toHaveBeenCalled();
  });
});

describe('handleWebAuthMessage — sign-out (#1038 F7-04)', () => {
  it('Web でログアウトされたら、ネイティブもユーザー ID を渡して共通のログアウト処理を行い、ウェルカム画面へ戻る', async () => {
    const { deps, goToWelcome, rebridge } = makeDeps();

    const result = await handleWebAuthMessage({ type: 'sign-out' }, PAGE, deps);

    expect(result).toBe('signed-out');
    expect(mockSignOutWithCleanup).toHaveBeenCalledTimes(1);
    expect(mockSignOutWithCleanup).toHaveBeenCalledWith('user-1');
    expect(goToWelcome).toHaveBeenCalledTimes(1);
    expect(rebridge).not.toHaveBeenCalled();
  });

  it('サインアウトより先にウェルカム画面へ戻らない (戻る時点で、端末のセッションは消えている)', async () => {
    const order: string[] = [];
    mockSignOutWithCleanup.mockImplementation(async () => {
      order.push('signOut');
      return { error: null };
    });
    const { deps } = makeDeps({ goToWelcome: () => order.push('goToWelcome') });

    await handleWebAuthMessage({ type: 'sign-out' }, PAGE, deps);

    expect(order).toEqual(['signOut', 'goToWelcome']);
  });

  it('ネイティブのセッションを読めなくても (ユーザー ID 不明)、ログアウトは行う', async () => {
    mockGetSession.mockRejectedValue(new Error('storage unavailable'));
    const { deps, goToWelcome } = makeDeps();

    expect(await handleWebAuthMessage({ type: 'sign-out' }, PAGE, deps)).toBe('signed-out');

    expect(mockSignOutWithCleanup).toHaveBeenCalledWith(null);
    expect(goToWelcome).toHaveBeenCalledTimes(1);
  });

  it('ログアウト処理が例外を投げても、ウェルカム画面へ戻す', async () => {
    mockSignOutWithCleanup.mockRejectedValue(new Error('boom'));
    const { deps, goToWelcome } = makeDeps();

    expect(await handleWebAuthMessage({ type: 'sign-out' }, PAGE, deps)).toBe('signed-out');

    expect(goToWelcome).toHaveBeenCalledTimes(1);
  });

  it('5 つのタブの WebView が同時に sign-out を送ってきても、ログアウトは 1 回だけ行う', async () => {
    let finishSignOut: (value: { error: null }) => void = () => {};
    mockSignOutWithCleanup.mockReturnValue(new Promise((resolve) => (finishSignOut = resolve)));
    const tabs = Array.from({ length: 5 }, () => makeDeps());

    const pending = tabs.map(({ deps }) => handleWebAuthMessage({ type: 'sign-out' }, PAGE, deps));
    await Promise.resolve();
    await Promise.resolve();
    finishSignOut({ error: null });
    const results = await Promise.all(pending);

    expect(mockSignOutWithCleanup).toHaveBeenCalledTimes(1);
    expect(results.filter((r) => r === 'signed-out')).toHaveLength(1);
    expect(tabs.filter(({ goToWelcome }) => goToWelcome.mock.calls.length > 0)).toHaveLength(1);
  });

  it('ログアウトが終わった後なら、次の sign-out もまた処理できる (処理中フラグが残らない)', async () => {
    const { deps } = makeDeps();

    expect(await handleWebAuthMessage({ type: 'sign-out' }, PAGE, deps)).toBe('signed-out');
    expect(await handleWebAuthMessage({ type: 'sign-out' }, PAGE, deps)).toBe('signed-out');
    expect(mockSignOutWithCleanup).toHaveBeenCalledTimes(2);
  });
});

describe('handleWebAuthMessage — session-expired (#1038 F7-05)', () => {
  it('ネイティブのセッションが生きていれば、サーバーで確かめたうえで WebView を読み込み直させる', async () => {
    const { deps, rebridge, goToWelcome } = makeDeps();

    const result = await handleWebAuthMessage({ type: 'session-expired' }, PAGE, deps);

    expect(result).toBe('rebridged');
    expect(mockGetUser).toHaveBeenCalledTimes(1);
    expect(rebridge).toHaveBeenCalledTimes(1);
    expect(mockSignOutWithCleanup).not.toHaveBeenCalled();
    expect(goToWelcome).not.toHaveBeenCalled();
  });

  it('ネイティブも未ログインなら、何もしない (ログアウト直後に届いた通知など)', async () => {
    mockGetSession.mockResolvedValue({ data: { session: null } });
    const { deps, rebridge } = makeDeps();

    expect(await handleWebAuthMessage({ type: 'session-expired' }, PAGE, deps)).toBe('no-session');

    expect(mockGetUser).not.toHaveBeenCalled();
    expect(rebridge).not.toHaveBeenCalled();
  });

  it('ネイティブのセッションもサーバーで失効していたら (Web のログアウトで全端末が失効した等)、読み込み直さずログアウトを揃える', async () => {
    mockGetUser.mockResolvedValue({
      data: { user: null },
      error: authError('AuthApiError', 403, 'Session from session_id claim in JWT does not exist', 'session_not_found'),
    });
    const { deps, rebridge, goToWelcome } = makeDeps();

    const result = await handleWebAuthMessage({ type: 'session-expired' }, PAGE, deps);

    expect(result).toBe('signed-out');
    expect(mockSignOutWithCleanup).toHaveBeenCalledWith('user-1');
    expect(goToWelcome).toHaveBeenCalledTimes(1);
    expect(rebridge).not.toHaveBeenCalled();
  });

  it.each([
    ['通信できない', authError('AuthRetryableFetchError', 0, 'Network request failed')],
    ['サーバー障害', authError('AuthApiError', 503, 'Service Unavailable')],
  ])('サーバーに確かめられなくても (%s)、失効とは断定できないので、読み込み直しは試みる', async (_label, error) => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error });
    const { deps, rebridge } = makeDeps();

    expect(await handleWebAuthMessage({ type: 'session-expired' }, PAGE, deps)).toBe('rebridged');

    expect(rebridge).toHaveBeenCalledTimes(1);
    expect(mockSignOutWithCleanup).not.toHaveBeenCalled();
  });

  it('getUser() が例外を投げても、読み込み直しを試みる', async () => {
    mockGetUser.mockRejectedValue(new TypeError('Network request failed'));
    const { deps, rebridge } = makeDeps();

    expect(await handleWebAuthMessage({ type: 'session-expired' }, PAGE, deps)).toBe('rebridged');

    expect(rebridge).toHaveBeenCalledTimes(1);
  });

  it('読み込み直しの回数制限に達していたら、何もしない (ブリッジが失敗し続けても、延々と読み込み直さない)', async () => {
    const { deps, rebridge } = makeDeps({ limiter: { tryAcquire: () => false } });

    expect(await handleWebAuthMessage({ type: 'session-expired' }, PAGE, deps)).toBe('rate-limited');

    expect(rebridge).not.toHaveBeenCalled();
  });

  it('実際の制限 (10 秒以上の間隔) で、続けて届いた 2 回目は読み込み直さない', async () => {
    const limiter = createRebridgeLimiter();
    const { deps, rebridge } = makeDeps({ limiter });

    expect(await handleWebAuthMessage({ type: 'session-expired' }, PAGE, deps)).toBe('rebridged');
    expect(await handleWebAuthMessage({ type: 'session-expired' }, PAGE, deps)).toBe('rate-limited');

    expect(rebridge).toHaveBeenCalledTimes(1);
  });

  it('ログアウト処理の最中に届いた session-expired は無視する (ログアウトしたのに読み込み直させない)', async () => {
    let finishSignOut: (value: { error: null }) => void = () => {};
    mockSignOutWithCleanup.mockReturnValue(new Promise((resolve) => (finishSignOut = resolve)));
    const signingOut = makeDeps();
    const other = makeDeps();

    const first = handleWebAuthMessage({ type: 'sign-out' }, PAGE, signingOut.deps);
    await Promise.resolve();
    await Promise.resolve();
    const duringSignOut = await handleWebAuthMessage({ type: 'session-expired' }, PAGE, other.deps);
    finishSignOut({ error: null });
    await first;

    expect(duringSignOut).toBe('ignored');
    expect(other.rebridge).not.toHaveBeenCalled();
  });

  it('ネイティブのセッションを読めなくても例外にしない', async () => {
    mockGetSession.mockRejectedValue(new Error('storage unavailable'));
    const { deps, rebridge } = makeDeps();

    await expect(handleWebAuthMessage({ type: 'session-expired' }, PAGE, deps)).resolves.toBe('no-session');

    expect(rebridge).not.toHaveBeenCalled();
  });
});
