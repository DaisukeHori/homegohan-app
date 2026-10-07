/**
 * webViewBridge.test.ts
 * src/lib/webViewBridge.ts のテスト (#1036 / #1158)
 *
 * カバレッジ:
 *   - getWebOrigin / isOwnOrigin: 「自アプリのオリジン」判定 (originWhitelist の未アンカー一致を突く類似ホストを含む)
 *   - sanitizeWebPath: deep link の initialPath などから来るパスの検証 (open redirect / authority 注入)
 *   - withAppMode / buildWebUrl / buildBridgeUrl: URL に載るのは code と next だけでトークンは載らない
 *   - decideNavigation / decideOpenWindow / openExternalUrl: WebView を自オリジンに固定し外部は既定ブラウザへ
 *   - buildOriginGuardScript / buildNavigateScript: 注入スクリプトのオリジンガード
 *   - getSessionForBridge: access_token の残りが少ないときの事前 refresh
 *   - requestBridgeCode: Bearer 認証の POST、失敗時は null、ログにトークンを出さない
 */

import * as vm from 'vm';
import { Linking } from 'react-native';

// バージョンヘッダ検証のため expo-constants を固定値にする
jest.mock('expo-constants', () => ({
  __esModule: true,
  default: { expoConfig: { version: '1.2.3' } },
}));

import {
  ABOUT_BLANK,
  BRIDGE_MIN_TOKEN_TTL_SEC,
  BRIDGE_REQUEST_TIMEOUT_MS,
  DEFAULT_WEB_ORIGIN,
  buildBridgeUrl,
  buildNavigateScript,
  buildOriginGuardScript,
  buildWebUrl,
  decideNavigation,
  decideOpenWindow,
  getSessionForBridge,
  getWebOrigin,
  isOwnOrigin,
  openExternalUrl,
  requestBridgeCode,
  sanitizeInitialPath,
  sanitizeWebPath,
  withAppMode,
} from '../../src/lib/webViewBridge';

const ORIGIN = 'https://homegohan-app.vercel.app';

// babel-preset-expo は `process.env` を `expo/virtual/env` の `env` (= ロード時点の process.env) に置き換える。
// process.env オブジェクトごと差し替えると実装側から見えなくなるため、キー単位で設定・復元する。
const ENV_KEYS = ['EXPO_PUBLIC_WEB_URL', 'EXPO_PUBLIC_API_BASE_URL'] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  jest.clearAllMocks();
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  process.env.EXPO_PUBLIC_WEB_URL = ORIGIN;
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  jest.restoreAllMocks();
  jest.useRealTimers();
});

// ─────────────────────────────────────────────────────────────────────────────
// getWebOrigin
// ─────────────────────────────────────────────────────────────────────────────
describe('getWebOrigin()', () => {
  it('EXPO_PUBLIC_WEB_URL が未設定なら既定の本番オリジンを返す', () => {
    delete process.env.EXPO_PUBLIC_WEB_URL;
    expect(getWebOrigin()).toBe(DEFAULT_WEB_ORIGIN);
  });

  it('設定された値のオリジンを返す', () => {
    process.env.EXPO_PUBLIC_WEB_URL = 'https://homegohan.app';
    expect(getWebOrigin()).toBe('https://homegohan.app');
  });

  it('末尾スラッシュ・パス・クエリは落としてオリジンだけにする', () => {
    process.env.EXPO_PUBLIC_WEB_URL = 'https://homegohan.app/some/path/?x=1';
    expect(getWebOrigin()).toBe('https://homegohan.app');
  });

  it('開発用の http://host:port も許可する (ポートを保持)', () => {
    process.env.EXPO_PUBLIC_WEB_URL = 'http://localhost:3000';
    expect(getWebOrigin()).toBe('http://localhost:3000');
  });

  it('大文字を含む設定値はホストを小文字化する (RN の URL polyfill は小文字化しないため)', () => {
    process.env.EXPO_PUBLIC_WEB_URL = 'HTTPS://HomeGohan.App';
    expect(getWebOrigin()).toBe('https://homegohan.app');
    expect(isOwnOrigin('https://homegohan.app/home')).toBe(true);
    expect(isOwnOrigin('https://HOMEGOHAN.APP/home')).toBe(true);
  });

  it.each([
    ['スキーム無し', 'homegohan.app'],
    ['http(s) 以外', 'ftp://homegohan.app'],
    ['javascript:', 'javascript:alert(1)'],
    ['認証情報付き', 'https://user:pass@homegohan.app'],
    ['空文字', ''],
  ])('不正な値 (%s) は既定のオリジンへ倒す', (_label, value) => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.EXPO_PUBLIC_WEB_URL = value;
    expect(getWebOrigin()).toBe(DEFAULT_WEB_ORIGIN);
  });

  /**
   * requestBridgeCode はこのオリジンへ refresh_token を POST する。
   * 本番ビルド (__DEV__ === false) で EXPO_PUBLIC_WEB_URL を http:// に誤設定しても、平文で送らない。
   * (iOS の ATS / Android の cleartext 制限が止める可能性は高いが、それに頼らない)
   */
  describe('http: の扱い', () => {
    const devGlobal = global as unknown as { __DEV__?: boolean };
    const originalDev = devGlobal.__DEV__;

    beforeEach(() => {
      jest.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
      devGlobal.__DEV__ = originalDev;
    });

    function originFor(url: string, dev: boolean): string {
      devGlobal.__DEV__ = dev;
      process.env.EXPO_PUBLIC_WEB_URL = url;
      return getWebOrigin();
    }

    it.each([
      ['http://localhost:3000', 'http://localhost:3000'],
      ['http://127.0.0.1:3000', 'http://127.0.0.1:3000'],
      ['http://[::1]:3000', 'http://[::1]:3000'],
      ['http://10.0.2.2:3000', 'http://10.0.2.2:3000'], // Android エミュレータからホスト PC
      ['http://10.0.3.2:3000', 'http://10.0.3.2:3000'], // Genymotion
      ['http://LOCALHOST:3000', 'http://localhost:3000'],
    ])('本番ビルドでも、端末内ループバック / エミュレータの別名なら許可する: %s', (url, expected) => {
      expect(originFor(url, false)).toBe(expected);
    });

    it.each([
      ['本番ホスト', 'http://homegohan-app.vercel.app'],
      ['任意のホスト', 'http://example.com'],
      ['LAN の IP', 'http://192.168.1.10:3000'],
      ['localhost で始まる別ホスト', 'http://localhost.evil.example'],
      ['エミュレータの別名に似た IP', 'http://10.0.2.20'],
      ['0.0.0.0', 'http://0.0.0.0:3000'],
    ])('本番ビルドでは、それ以外のホストの http は既定の https オリジンへ倒す: %s', (_label, url) => {
      expect(originFor(url, false)).toBe(DEFAULT_WEB_ORIGIN);
    });

    it.each(['http://192.168.1.10:3000', 'http://dev.homegohan.test:3000', 'http://localhost:3000'])(
      '開発ビルド (__DEV__ === true) なら、実機向けの LAN 上の開発サーバーなど任意の http を許可する: %s',
      (url) => {
        expect(originFor(url, true)).toBe(url);
      },
    );

    it('https は本番ビルドでも常に許可する', () => {
      expect(originFor('https://homegohan.app', false)).toBe('https://homegohan.app');
    });

    it('http の誤設定は isOwnOrigin にも反映される (既定の https オリジンだけが自オリジン)', () => {
      originFor('http://homegohan-app.vercel.app', false);
      expect(isOwnOrigin('https://homegohan-app.vercel.app/home')).toBe(true);
      expect(isOwnOrigin('http://homegohan-app.vercel.app/home')).toBe(false);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// isOwnOrigin
// ─────────────────────────────────────────────────────────────────────────────
describe('isOwnOrigin()', () => {
  it.each([
    ORIGIN,
    `${ORIGIN}/`,
    `${ORIGIN}/home?mode=app`,
    `${ORIGIN}/auth/native-bridge?code=abc&next=%2Fhome`,
    `${ORIGIN}:443/home`, // https の既定ポートは同一オリジン
    'HTTPS://HOMEGOHAN-APP.VERCEL.APP/home', // スキーム・ホストの大文字小文字はパーサが正規化する
  ])('自オリジンなら true: %s', (url) => {
    expect(isOwnOrigin(url)).toBe(true);
  });

  it.each([
    ['サフィックス偽装 (.evil.com)', 'https://homegohan-app.vercel.app.evil.com/'],
    ['userinfo 偽装 (@evil.com)', 'https://homegohan-app.vercel.app@evil.com/'],
    ['サブドメイン偽装', 'https://evil.homegohan-app.vercel.app/'],
    ['パス/クエリに自ホストを含む他ホスト', 'https://evil.com/?u=https://homegohan-app.vercel.app'],
    ['末尾ドット付きホスト', 'https://homegohan-app.vercel.app./'],
    ['http スキーム (https のオリジンに対して)', 'http://homegohan-app.vercel.app/'],
    ['HTTP (大文字) スキーム', 'HTTP://homegohan-app.vercel.app/'],
    ['異なるポート', 'https://homegohan-app.vercel.app:8443/'],
    ['認証情報付き (同一ホスト)', 'https://user:pass@homegohan-app.vercel.app/'],
    ['ユーザー名のみ付き (同一ホスト)', 'https://user@homegohan-app.vercel.app/'],
    ['javascript:', 'javascript:alert(1)'],
    ['data:', 'data:text/html,<script>alert(1)</script>'],
    ['blob:', 'blob:https://homegohan-app.vercel.app/3f1c0f0e-0000-0000-0000-000000000000'],
    ['file:', 'file:///etc/passwd'],
    ['about:blank (メッセージ送信元としては認めない)', 'about:blank'],
    ['プロトコル相対', '//homegohan-app.vercel.app/home'],
    ['相対パス', '/home'],
    ['URL でない文字列', 'not a url'],
    ['空文字', ''],
  ])('他オリジンは false: %s', (_label, url) => {
    expect(isOwnOrigin(url)).toBe(false);
  });

  it.each([[undefined], [null], [123], [{}], [['https://homegohan-app.vercel.app']]])(
    '文字列以外 (%p) は false',
    (value) => {
      expect(isOwnOrigin(value)).toBe(false);
    },
  );

  /**
   * 端末では RN の URL polyfill (whatwg-url-without-unicode) で判定する一方、実際に遷移するのは WebKit / Chromium。
   * 両者の解釈がずれて「polyfill は自オリジン、エンジンは別ホスト」になる文字列が無いことを、
   * 紛らわしい記号の総当たりで確かめる (正解は Node 標準の WHATWG URL)。
   */
  it('自オリジンと判定した URL は、Node 標準の URL でも同じ https の自ホストで認証情報なし (総当たり)', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const NodeURL: typeof URL = require('url').URL;
    const HOST = 'homegohan-app.vercel.app';
    // 構造を壊す記号 (深さ 3) と、Unicode の紛らわしい文字・大文字スキーム (深さ 2) の 2 系統で調べる
    const STRUCTURAL = ['https://', 'http://', '//', '/', '\\', '@', ':', '.', '#', '?', '\t', HOST, 'evil.com', '%2e', '%40', ':8443'];
    const EXOTIC = ['HTTPS://', 'https:/', 'https:', '。', '．', 'K', '­', '​', ' ', '\n', HOST, '.', '/', '@'];

    function* combinations(tokens: string[], maxLength: number, prefix = ''): Generator<string> {
      let layer: string[] = [prefix];
      for (let length = 1; length <= maxLength; length++) {
        const next: string[] = [];
        for (const head of layer) for (const token of tokens) next.push(head + token);
        layer = next;
        yield* layer;
      }
    }

    const violations: string[] = [];
    let accepted = 0;
    const check = (candidate: string) => {
      if (!isOwnOrigin(candidate)) return;
      accepted++;
      let reference: URL | null = null;
      try {
        reference = new NodeURL(candidate);
      } catch {
        reference = null;
      }
      const ok =
        reference !== null &&
        reference.protocol === 'https:' &&
        reference.host === HOST &&
        reference.username === '' &&
        reference.password === '';
      if (!ok) violations.push(JSON.stringify(candidate));
    };

    for (const prefix of ['', 'https://', `https://${HOST}`]) {
      for (const candidate of combinations(STRUCTURAL, 3, prefix)) check(candidate);
      for (const candidate of combinations(EXOTIC, 2, prefix)) check(candidate);
    }

    expect(violations).toEqual([]);
    expect(accepted).toBeGreaterThan(50);
  }, 120000);

  it('開発用オリジン (http://localhost:3000) ではそのスキーム・ポートだけが自オリジン', () => {
    process.env.EXPO_PUBLIC_WEB_URL = 'http://localhost:3000';
    expect(isOwnOrigin('http://localhost:3000/home')).toBe(true);
    expect(isOwnOrigin('http://localhost:3001/home')).toBe(false);
    expect(isOwnOrigin('https://localhost:3000/home')).toBe(false);
    expect(isOwnOrigin(`${ORIGIN}/home`)).toBe(false);
  });

  it('ホストの大文字小文字は区別しない (ASCII のみ)。Unicode の大文字小文字畳み込みで ASCII に化ける文字は認めない', () => {
    process.env.EXPO_PUBLIC_WEB_URL = 'https://kitchen.example';
    expect(isOwnOrigin('https://KITCHEN.example/x')).toBe(true);
    // U+212A (ケルビン記号) は toLowerCase() すると ASCII の "k" になる
    expect(isOwnOrigin('https://Kitchen.example/x')).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// sanitizeWebPath
// ─────────────────────────────────────────────────────────────────────────────
describe('sanitizeWebPath()', () => {
  const FALLBACK = '/menus/weekly';

  it.each([
    '/home',
    '/menus/weekly?date=2026-10-07&mode=app',
    '/profile?tab=settings#top',
    '/meals/%E3%81%82', // 日本語の percent-encoding
    '/a/b%2Fc', // 途中の %2F は問題なし
    '/search?q=a b', // 空白
    '/%E3%81', // 不正な UTF-8 の percent-encoding はデコードできないだけで、先頭は安全
  ])('安全なパスはそのまま返す: %s', (path) => {
    expect(sanitizeWebPath(path, FALLBACK)).toBe(path);
  });

  it.each([
    ['プロトコル相対 //host', '//evil.example'],
    ['プロトコル相対 //host/path', '//evil.example/x'],
    ['/ + バックスラッシュ', '/\\evil.example'],
    ['バックスラッシュ始まり', '\\\\evil.example'],
    ['/\\/', '/\\/evil.example'],
    ['authority 注入 (@host)', '@evil.example'],
    ['パス中の @', '/x@evil.example'],
    ['絶対 URL', 'https://evil.example/'],
    ['javascript:', 'javascript:alert(1)'],
    ['data:', 'data:text/html,x'],
    ['スキーム大文字', 'JavaScript:alert(1)'],
    ['相対パス (先頭が / でない)', 'home'],
    ['空文字', ''],
    ['空白のみ', '   '],
    ['先頭空白', ' /home'],
    ['%2F で // に化ける', '/%2Fevil.example'],
    ['/%2F/', '/%2F/evil.example'],
    ['%5C (バックスラッシュ) で // に化ける', '/%5Cevil.example'],
    ['二重エンコード', '/%252Fevil.example'],
    ['三重エンコード', '/%25252Fevil.example'],
    ['%09 (タブ) を挟んで // に化ける', '/%09/evil.example'],
    ['%0A (改行) を挟んで // に化ける', '/%0A/evil.example'],
    ['生のタブ', '/\t/evil.example'],
    ['生の改行', '/\n/evil.example'],
    ['生の CR', '/\r/evil.example'],
    ['DEL 文字', '/\u007f/evil.example'],
    ['NUL 文字', '/\u0000home'],
  ])('危険なパスは fallback へ: %s', (_label, path) => {
    expect(sanitizeWebPath(path, FALLBACK)).toBe(FALLBACK);
  });

  it('上限を超える長さは fallback', () => {
    expect(sanitizeWebPath(`/${'a'.repeat(5000)}`, FALLBACK)).toBe(FALLBACK);
  });

  it('配列 (expo-router の同名クエリ重複) は先頭要素だけを検証して使う', () => {
    expect(sanitizeWebPath(['/menus'], FALLBACK)).toBe('/menus');
    expect(sanitizeWebPath(['/menus', '//evil.example'], FALLBACK)).toBe('/menus');
    expect(sanitizeWebPath(['//evil.example', '/menus'], FALLBACK)).toBe(FALLBACK);
    expect(sanitizeWebPath([], FALLBACK)).toBe(FALLBACK);
    expect(sanitizeWebPath([123], FALLBACK)).toBe(FALLBACK);
  });

  it.each([[undefined], [null], [42], [{}], [true]])('文字列以外 (%p) は fallback', (value) => {
    expect(sanitizeWebPath(value, FALLBACK)).toBe(FALLBACK);
  });

  /**
   * 手書きのケースに頼らず、危険な記号の組み合わせを総当たりして
   * 「受理した文字列は、どう解釈されても自オリジンから出ない」ことを標準の WHATWG URL で確かめる。
   *  (a) オリジンの直後に連結した URL (アプリが組み立てる直接 URL)
   *  (b) Web サーバーが next を new URL(next, base) で解決した結果 (native-bridge の redirect)
   *  (c) percent-decode を最大 3 回かけた文字列を (b) と同様に解決した結果 (Web 側 safe-redirect の挙動)
   * 比較にはテスト環境の URL (RN polyfill に置き換わっている) ではなく Node 標準の URL を使う。
   */
  describe('総当たり検証 (Node 標準の URL を基準)', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const NodeURL: typeof URL = require('url').URL;
    const HOST = 'homegohan-app.vercel.app';
    const TOKENS = [
      '/', '\\', '@', ':', '.', '?', '#', 'a', ' ', '\t', '\n', '\r',
      '%2F', '%2f', '%5C', '%5c', '%09', '%0A', '%0D', '%40', '%252F', '%255C', 'https:', '//', '\u0000', '\u007f',
    ];

    function hostsOf(candidate: string): string[] {
      const hosts: string[] = [];
      const resolve = (input: string, base?: string) => {
        try {
          hosts.push(new NodeURL(input, base).host);
        } catch {
          hosts.push('<invalid>');
        }
      };
      resolve(`https://${HOST}${candidate}`);
      resolve(candidate, `https://${HOST}`);
      let current = candidate;
      for (let i = 0; i < 3; i++) {
        let decoded: string;
        try {
          decoded = decodeURIComponent(current);
        } catch {
          break;
        }
        if (decoded === current) break;
        current = decoded;
        resolve(current, `https://${HOST}`);
      }
      return hosts;
    }

    function* combinations(maxLength: number): Generator<string> {
      let layer: string[] = [''];
      for (let length = 1; length <= maxLength; length++) {
        const next: string[] = [];
        for (const prefix of layer) for (const token of TOKENS) next.push(prefix + token);
        layer = next;
        yield* layer;
      }
    }

    it('受理した文字列はどの解釈でも host が変わらない (長さ 3 までの全組み合わせ + 先頭 "/" 付きで末尾 4 トークンまで)', () => {
      const violations: string[] = [];
      let accepted = 0;
      const check = (candidate: string) => {
        if (sanitizeWebPath(candidate, '\u0001fallback') !== candidate) return;
        accepted++;
        if (hostsOf(candidate).some((h) => h !== HOST)) violations.push(JSON.stringify(candidate));
      };

      for (const candidate of combinations(3)) check(candidate);
      // 受理されやすい "/" 始まりの文字列を、より長い組み合わせで検査する
      for (const tail of combinations(4)) check(`/${tail}`);

      expect(violations).toEqual([]);
      // 検査が空振りしていないこと (安全な文字列が実際に受理されている)
      expect(accepted).toBeGreaterThan(1000);
    }, 120000);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// sanitizeInitialPath
//   deep link (homegohan://home?initialPath=…) からも指定できる initialPath を、タブの prefix 配下に限定する。
//   sanitizeWebPath だけでは /auth/native-bridge?code=<攻撃者の code> を通してしまい、
//   被害者の WebView を攻撃者のアカウントでログインさせられる (login CSRF)。
// ─────────────────────────────────────────────────────────────────────────────
describe('sanitizeInitialPath()', () => {
  const FALLBACK = '/menus/weekly';
  // WebViewScreen の TAB_ROUTES と同じ (各タブの prefix)
  const PREFIXES = ['/menus', '/meals', '/comparison', '/profile', '/home'];
  const sanitize = (raw: unknown) => sanitizeInitialPath(raw, FALLBACK, PREFIXES);

  it.each([
    '/menus',
    '/menus/',
    '/menus/weekly',
    '/menus/weekly?date=2026-10-07&modal=shopping', // tab-navigate が渡す fullPath (pathname + search)
    '/menus?x=1',
    '/menus#top',
    '/meals/new',
    '/meals/abc?mode=app',
    '/comparison',
    '/profile',
    '/profile/settings?tab=a',
    '/home',
    '/home?mode=app',
    '/menus/weekly/%E3%81%82', // 日本語の percent-encoding
    '/menus/a.b', // . を含むだけのセグメントはドットセグメントではない
    '/menus/.hidden',
    '/menus/a..b',
    '/menus/...',
    '/menus/weekly?next=/auth/native-bridge', // パス部分が配下なら、クエリ内の値は見ない (サーバーが解釈するのはパス)
  ])('タブの prefix 配下のパスはそのまま返す: %s', (path) => {
    expect(sanitize(path)).toBe(path);
  });

  it.each([
    ['認証ブリッジ (login CSRF: 攻撃者の code でログインさせる)', '/auth/native-bridge?code=ATTACKERCODEattackercode0123456789ABCDEFG&next=%2Fhome'],
    ['旧方式の認証ブリッジ (攻撃者のトークン)', '/auth/native-bridge?access_token=a&refresh_token=b&next=%2Fhome'],
    ['ログイン画面', '/login'],
    ['ルート', '/'],
    ['タブ外のページ', '/settings'],
    ['API', '/api/auth/session-sync'],
    ['prefix の前方一致だけ (/homepage)', '/homepage'],
    ['prefix の前方一致だけ (/menus-evil/x)', '/menus-evil/x'],
    ['prefix がクエリに含まれるだけ', '/auth/native-bridge?next=/home'],
    ['prefix がハッシュに含まれるだけ', '/login#/home'],
    ['大文字小文字違い (Next.js のルートは大文字小文字を区別する)', '/Menus/weekly'],
    ['prefix の一部を percent-encoding した迂回', '/%6Denus/weekly'],
    ['ドットセグメントで prefix の外へ', '/menus/../auth/native-bridge?code=x'],
    ['連続したドットセグメント', '/menus/weekly/../../auth/native-bridge'],
    ['ドットセグメントが prefix 内に収まる形でも拒否する', '/menus/./weekly'],
    ['末尾のドットセグメント', '/menus/..'],
    ['エンコードされたドットセグメント (%2e%2e)', '/menus/%2e%2e/auth/native-bridge'],
    ['エンコードされたドットセグメント (大文字)', '/menus/%2E%2E/auth/native-bridge'],
    ['エンコードされたドットセグメント (混在)', '/menus/.%2E/auth/native-bridge'],
    ['二重エンコードされたドットセグメント', '/menus/%252e%252e/auth/native-bridge'],
    ['エンコードされた / で prefix を迂回', '/menus%2F..%2Fauth/native-bridge'],
    ['エンコードされた / とドットセグメント', '/menus/..%2Fauth/native-bridge'],
    ['エンコードされた \\ とドットセグメント', '/menus/..%5Cauth/native-bridge'],
  ])('タブの配下に収まらない / 外へ抜けるパスは fallback: %s', (_label, path) => {
    expect(sanitize(path)).toBe(FALLBACK);
  });

  it.each([
    ['プロトコル相対', '//evil.example'],
    ['authority 注入', '@evil.example'],
    ['絶対 URL', 'https://evil.example/'],
    ['バックスラッシュ', '/\\evil.example'],
    ['javascript:', 'javascript:alert(1)'],
    ['エンコードされた //', '/%2Fevil.example'],
    ['空文字', ''],
    ['文字列でない', 42],
    ['undefined', undefined],
  ])('sanitizeWebPath が拒否する値 (%s) は fallback のまま', (_label, raw) => {
    expect(sanitize(raw)).toBe(FALLBACK);
  });

  it('配列 (expo-router の同名クエリ重複) は先頭要素だけを検証して使う', () => {
    expect(sanitize(['/home?x=1', '/auth/native-bridge'])).toBe('/home?x=1');
    expect(sanitize(['/auth/native-bridge', '/home'])).toBe(FALLBACK);
    expect(sanitize([])).toBe(FALLBACK);
  });

  it('fallback と同じ値が渡されたら、その fallback を返す', () => {
    expect(sanitize(FALLBACK)).toBe(FALLBACK);
  });

  it('許可する prefix が空なら何も通さない', () => {
    expect(sanitizeInitialPath('/home', FALLBACK, [])).toBe(FALLBACK);
  });

  /**
   * 手書きのケースに頼らず、ドットセグメント・エンコード・区切り文字の組み合わせを総当たりして
   * 「受理した文字列は、どう解釈されても prefix 配下から出ない」ことを標準の WHATWG URL で確かめる。
   *  (a) 生の文字列を、オリジンに対して URL として解決した結果 (WebView / サーバーが実際に見るパス)
   *  (b) percent-decode を最大 3 回かけた文字列を同様に解決した結果 (デコードしてから解決する実装があっても出られない)
   */
  describe('総当たり検証 (Node 標準の URL を基準)', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const NodeURL: typeof URL = require('url').URL;
    const BASE = 'https://homegohan-app.vercel.app';
    // 構造を壊す記号 (区切り・ドット・クエリ/ハッシュの開始とそのエンコード) と、
    // エンコードや制御文字で紛れ込ませる記号の 2 系統で、それぞれ長さ 4 まで調べる
    const STRUCTURAL = ['/', '..', '.', '%2e', '%2f', '%5c', '\\', '?', '#', '%23', '%3f', 'a', '%09'];
    const DISGUISED = ['/', '..', '.', '%2E', '%252e', '%252f', '%0a', '%0d', '@', '%40', 'a'];

    const underPrefix = (pathname: string) =>
      PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));

    function pathnamesOf(candidate: string): string[] {
      const pathnames: string[] = [];
      const resolve = (input: string) => {
        try {
          pathnames.push(new NodeURL(input, BASE).pathname);
        } catch {
          pathnames.push('<invalid>');
        }
      };
      resolve(candidate);
      let current = candidate;
      for (let i = 0; i < 3; i++) {
        let decoded: string;
        try {
          decoded = decodeURIComponent(current);
        } catch {
          break;
        }
        if (decoded === current) break;
        current = decoded;
        resolve(current);
      }
      return pathnames;
    }

    function* combinations(tokens: string[], maxLength: number): Generator<string> {
      let layer: string[] = [''];
      for (let length = 1; length <= maxLength; length++) {
        const next: string[] = [];
        for (const prefix of layer) for (const token of tokens) next.push(prefix + token);
        layer = next;
        yield* layer;
      }
    }

    it('受理した文字列は、どの解釈でも pathname が prefix 配下に収まる (長さ 4 までの全組み合わせ)', () => {
      const violations: string[] = [];
      let accepted = 0;
      for (const root of ['/menus', '/menus/', '/menus/weekly/', '/home']) {
        for (const tokens of [STRUCTURAL, DISGUISED]) {
          for (const tail of combinations(tokens, 4)) {
            const candidate = `${root}${tail}`;
            if (sanitize(candidate) !== candidate) continue;
            accepted++;
            if (!pathnamesOf(candidate).every(underPrefix)) violations.push(JSON.stringify(candidate));
          }
        }
      }

      expect(violations).toEqual([]);
      // 検査が空振りしていないこと (安全な文字列が実際に受理されている)
      expect(accepted).toBeGreaterThan(1000);
    }, 120000);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// withAppMode
// ─────────────────────────────────────────────────────────────────────────────
describe('withAppMode()', () => {
  it.each([
    ['/home', '/home?mode=app'],
    ['/profile?tab=settings', '/profile?tab=settings&mode=app'],
    ['/home?mode=app', '/home?mode=app'],
    ['/menus?mode=app&x=1', '/menus?mode=app&x=1'],
    ['/menus?x=1&mode=app', '/menus?x=1&mode=app'],
    ['/home#section', '/home?mode=app#section'],
    ['/home?x=1#section', '/home?x=1&mode=app#section'],
    ['/home?mode=app#section', '/home?mode=app#section'],
    ['/x?xmode=app', '/x?xmode=app&mode=app'], // 別名のパラメータを mode=app と取り違えない
  ])('%s → %s', (input, expected) => {
    expect(withAppMode(input)).toBe(expected);
  });

  it('冪等 (2 回適用しても mode=app は 1 つ)', () => {
    const once = withAppMode('/profile?tab=settings');
    expect(withAppMode(once)).toBe(once);
    expect((once.match(/mode=app/g) ?? []).length).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// buildWebUrl / buildBridgeUrl
// ─────────────────────────────────────────────────────────────────────────────
describe('buildWebUrl()', () => {
  it('Web オリジンとパスを連結する', () => {
    expect(buildWebUrl('/home?mode=app')).toBe(`${ORIGIN}/home?mode=app`);
  });

  it('危険なパスは /home に倒し、authority 注入を許さない', () => {
    for (const bad of ['@evil.example', '//evil.example', '/\\evil.example', 'https://evil.example', '']) {
      const built = buildWebUrl(bad);
      expect(built).toBe(`${ORIGIN}/home`);
      expect(isOwnOrigin(built)).toBe(true);
    }
  });

  it('EXPO_PUBLIC_WEB_URL の値に追従する (実行時に読む)', () => {
    process.env.EXPO_PUBLIC_WEB_URL = 'https://homegohan.app';
    expect(buildWebUrl('/home')).toBe('https://homegohan.app/home');
  });
});

describe('buildBridgeUrl()', () => {
  const CODE = 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0U1v';

  it('code と next だけを持つ native-bridge URL を作る', () => {
    const url = buildBridgeUrl(CODE, '/home?mode=app');
    expect(url.startsWith(`${ORIGIN}/auth/native-bridge?`)).toBe(true);

    const parsed = new URL(url);
    expect(parsed.pathname).toBe('/auth/native-bridge');
    expect(parsed.searchParams.get('code')).toBe(CODE);
    expect(parsed.searchParams.get('next')).toBe('/home?mode=app');
    expect(Array.from(parsed.searchParams.keys()).sort()).toEqual(['code', 'next']);
  });

  it('トークン系のキーを URL に含めない', () => {
    const url = buildBridgeUrl(CODE, '/menus/weekly?mode=app');
    expect(url).not.toMatch(/access_token/i);
    expect(url).not.toMatch(/refresh_token/i);
    expect(url).not.toMatch(/[?&]token=/i);
  });

  it('next はエンコードされ、code も念のためエンコードされる', () => {
    const url = buildBridgeUrl('a+b/c=', '/profile?tab=settings&mode=app');
    expect(url).toContain('next=%2Fprofile%3Ftab%3Dsettings%26mode%3Dapp');
    expect(url).toContain('code=a%2Bb%2Fc%3D');
    expect(new URL(url).searchParams.get('next')).toBe('/profile?tab=settings&mode=app');
  });

  it('危険な next は既定の /home?mode=app へ倒す', () => {
    for (const bad of ['//evil.example', '/\\evil.example', '@evil.example', 'https://evil.example/']) {
      const parsed = new URL(buildBridgeUrl(CODE, bad));
      expect(parsed.searchParams.get('next')).toBe('/home?mode=app');
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// decideNavigation / decideOpenWindow / openExternalUrl
// ─────────────────────────────────────────────────────────────────────────────
describe('decideNavigation()', () => {
  it('自オリジンは許可 (外部ブラウザは開かない)', () => {
    expect(decideNavigation({ url: `${ORIGIN}/home?mode=app`, isTopFrame: true })).toEqual({ allow: true });
    expect(decideNavigation({ url: `${ORIGIN}/auth/native-bridge?code=x`, isTopFrame: true })).toEqual({
      allow: true,
    });
  });

  it('自オリジンのサブフレームも許可', () => {
    expect(decideNavigation({ url: `${ORIGIN}/frame`, isTopFrame: false })).toEqual({ allow: true });
  });

  it('about:blank は許可', () => {
    expect(decideNavigation({ url: ABOUT_BLANK, isTopFrame: true })).toEqual({ allow: true });
  });

  it('他オリジンの http(s) トップフレーム遷移は遮断して外部ブラウザで開く', () => {
    expect(decideNavigation({ url: 'https://example.com/recipe/1', isTopFrame: true })).toEqual({
      allow: false,
      openExternal: 'https://example.com/recipe/1',
    });
    expect(decideNavigation({ url: 'http://example.com/', isTopFrame: true })).toEqual({
      allow: false,
      openExternal: 'http://example.com/',
    });
  });

  it('isTopFrame が無い (Android) 場合はトップフレームとして扱う', () => {
    expect(decideNavigation({ url: 'https://example.com/recipe/1' })).toEqual({
      allow: false,
      openExternal: 'https://example.com/recipe/1',
    });
  });

  it('他オリジンのサブフレーム (isTopFrame:false) は黙って遮断する', () => {
    expect(decideNavigation({ url: 'https://example.com/embed', isTopFrame: false })).toEqual({ allow: false });
  });

  it.each([
    ['サフィックス偽装', 'https://homegohan-app.vercel.app.evil.com/x'],
    ['userinfo 偽装', 'https://homegohan-app.vercel.app@evil.com/x'],
    ['http スキーム', 'http://homegohan-app.vercel.app/x'],
    ['異なるポート', 'https://homegohan-app.vercel.app:8443/x'],
  ])('自オリジンに見せかけた URL は許可しない: %s', (_label, url) => {
    const decision = decideNavigation({ url, isTopFrame: true });
    expect(decision.allow).toBe(false);
  });

  it.each([
    'javascript:alert(1)',
    'data:text/html,x',
    'file:///etc/passwd',
    'intent://scan/#Intent;scheme=zxing;end',
    'homegohan://home?initialPath=//evil.example',
    'blob:https://homegohan-app.vercel.app/uuid',
  ])('非 http(s) は遮断し、外部ブラウザにも渡さない: %s', (url) => {
    expect(decideNavigation({ url, isTopFrame: true })).toEqual({ allow: false });
  });

  it('url が文字列でなければ遮断', () => {
    expect(decideNavigation({})).toEqual({ allow: false });
    expect(decideNavigation({ url: 123 })).toEqual({ allow: false });
  });
});

describe('decideOpenWindow()', () => {
  it('自オリジンは現在の WebView 内で開く', () => {
    expect(decideOpenWindow(`${ORIGIN}/meals/1`)).toEqual({ navigateTo: `${ORIGIN}/meals/1` });
  });

  it('他オリジンの http(s) は外部ブラウザで開く', () => {
    expect(decideOpenWindow('https://example.com/recipe')).toEqual({ openExternal: 'https://example.com/recipe' });
  });

  it.each([ABOUT_BLANK, 'javascript:alert(1)', 'data:text/html,x', 'intent://x', '', undefined, null, 5])(
    '何もしない: %p',
    (value) => {
      expect(decideOpenWindow(value)).toEqual({});
    },
  );

  it('類似ホストは自オリジン扱いにしない (外部ブラウザへ)', () => {
    expect(decideOpenWindow('https://homegohan-app.vercel.app.evil.com/x')).toEqual({
      openExternal: 'https://homegohan-app.vercel.app.evil.com/x',
    });
  });
});

describe('openExternalUrl()', () => {
  it('http(s) は Linking.openURL に渡す', async () => {
    const spy = jest.spyOn(Linking, 'openURL').mockResolvedValue(true as never);
    await openExternalUrl('https://example.com/recipe');
    expect(spy).toHaveBeenCalledWith('https://example.com/recipe');
  });

  it.each(['javascript:alert(1)', 'intent://x', 'homegohan://home', 'file:///x', 'tel:0120', ''])(
    '非 http(s) は開かない: %s',
    async (url) => {
      const spy = jest.spyOn(Linking, 'openURL').mockResolvedValue(true as never);
      await openExternalUrl(url);
      expect(spy).not.toHaveBeenCalled();
    },
  );

  it('openURL が失敗しても例外を投げない', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(Linking, 'openURL').mockRejectedValue(new Error('no handler'));
    await expect(openExternalUrl('https://example.com/')).resolves.toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 注入スクリプト
// ─────────────────────────────────────────────────────────────────────────────
describe('buildOriginGuardScript() / buildNavigateScript()', () => {
  function runNavigateScript(script: string, locationOrigin: string) {
    const location = { origin: locationOrigin, assign: jest.fn(), replace: jest.fn() };
    vm.runInNewContext(script, { window: { location } });
    return location;
  }

  it('ガードは自オリジンの JSON リテラルを含む', () => {
    expect(buildOriginGuardScript()).toContain(JSON.stringify(ORIGIN));
  });

  it('自オリジン上では assign / replace を呼ぶ', () => {
    const url = `${ORIGIN}/meals/1?mode=app`;
    const assigned = runNavigateScript(buildNavigateScript(url), ORIGIN);
    expect(assigned.assign).toHaveBeenCalledWith(url);
    expect(assigned.replace).not.toHaveBeenCalled();

    const replaced = runNavigateScript(buildNavigateScript(url, 'replace'), ORIGIN);
    expect(replaced.replace).toHaveBeenCalledWith(url);
    expect(replaced.assign).not.toHaveBeenCalled();
  });

  it('他オリジン上では何も実行しない', () => {
    const location = runNavigateScript(buildNavigateScript(`${ORIGIN}/home`), 'https://evil.example');
    expect(location.assign).not.toHaveBeenCalled();
    expect(location.replace).not.toHaveBeenCalled();
  });

  it('opaque origin ("null") でも何も実行しない', () => {
    const location = runNavigateScript(buildNavigateScript(`${ORIGIN}/home`), 'null');
    expect(location.assign).not.toHaveBeenCalled();
  });

  it('URL 中のクォート・バッククォート・</script> は文字列として扱われコードとして実行されない', () => {
    const nasty = `${ORIGIN}/x?q='+(globalThis.__pwned=1)+'"\`</script> `;
    const sandbox: Record<string, unknown> = { window: { location: { origin: ORIGIN, assign: jest.fn() } } };
    vm.runInNewContext(buildNavigateScript(nasty), sandbox);
    expect(((sandbox.window as any).location.assign as jest.Mock).mock.calls[0][0]).toBe(nasty);
    expect(sandbox.__pwned).toBeUndefined();
  });

  describe('guard オプション (タブ再タップのリセットなど、自オリジン以外でも動かす必要がある場合)', () => {
    const url = `${ORIGIN}/home?mode=app`;
    // 読み込み失敗で残った about:blank (opaque origin) / 外部ページ / http に落ちた同ホスト / origin が取れない異常系
    const NON_OWN_ORIGINS = ['null', 'https://evil.example', 'http://homegohan-app.vercel.app', ''];

    it.each(NON_OWN_ORIGINS)('guard: false なら、自オリジン以外 (%p) の上でも replace を呼ぶ', (origin) => {
      const location = runNavigateScript(buildNavigateScript(url, 'replace', { guard: false }), origin);
      expect(location.replace).toHaveBeenCalledTimes(1);
      expect(location.replace).toHaveBeenCalledWith(url);
      expect(location.assign).not.toHaveBeenCalled();
    });

    it('guard: false でも自オリジン上では従来どおり動く (assign / replace)', () => {
      const assigned = runNavigateScript(buildNavigateScript(url, 'assign', { guard: false }), ORIGIN);
      expect(assigned.assign).toHaveBeenCalledWith(url);
      const replaced = runNavigateScript(buildNavigateScript(url, 'replace', { guard: false }), ORIGIN);
      expect(replaced.replace).toHaveBeenCalledWith(url);
    });

    it('guard: false でも URL は JSON.stringify でリテラル化され、コードとして実行されない', () => {
      const nasty = `${ORIGIN}/x?q='+(globalThis.__pwned2=1)+'"\`</script>`;
      const sandbox: Record<string, unknown> = { window: { location: { origin: 'null', replace: jest.fn() } } };
      vm.runInNewContext(buildNavigateScript(nasty, 'replace', { guard: false }), sandbox);
      expect(((sandbox.window as any).location.replace as jest.Mock).mock.calls[0][0]).toBe(nasty);
      expect(sandbox.__pwned2).toBeUndefined();
    });

    // 既定は安全側。ガードを外せるのは明示的な `false` だけ (呼び忘れ・想定外の値でガードが消えない)
    it.each([
      ['オプション省略', undefined],
      ['空のオプション', {}],
      ['guard: true', { guard: true }],
      ['guard: undefined', { guard: undefined }],
      ['guard が false 以外の値 (0)', { guard: 0 as unknown as boolean }],
      ['guard が false 以外の値 ("false")', { guard: 'false' as unknown as boolean }],
      ['guard が false 以外の値 (null)', { guard: null as unknown as boolean }],
    ])('%s ではガード付きのまま (外部ページ・about:blank では何もしない)', (_label, options) => {
      const script = buildNavigateScript(url, 'replace', options);
      for (const origin of ['null', 'https://evil.example']) {
        const location = runNavigateScript(script, origin);
        expect(location.replace).not.toHaveBeenCalled();
        expect(location.assign).not.toHaveBeenCalled();
      }
      expect(runNavigateScript(script, ORIGIN).replace).toHaveBeenCalledWith(url);
    });

    it('guard: false のスクリプトは自オリジンの URL 以外の情報を持たない (トークン・code を含まない)', () => {
      const script = buildNavigateScript(url, 'replace', { guard: false });
      expect(script).toContain(JSON.stringify(url));
      expect(script).not.toMatch(/token|code=|native-bridge|Authorization|Bearer/i);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getSessionForBridge
// ─────────────────────────────────────────────────────────────────────────────
describe('getSessionForBridge()', () => {
  const NOW_MS = Date.UTC(2026, 9, 7, 12, 0, 0);
  const nowSec = Math.floor(NOW_MS / 1000);

  function makeAuth(opts: {
    session?: Record<string, unknown> | null;
    refreshed?: Record<string, unknown> | null;
    refreshThrows?: boolean;
    getSessionThrows?: boolean;
  }) {
    return {
      getSession: jest.fn(async () => {
        if (opts.getSessionThrows) throw new Error('storage failure');
        return { data: { session: opts.session ?? null } };
      }),
      refreshSession: jest.fn(async () => {
        if (opts.refreshThrows) throw new Error('network');
        return { data: { session: opts.refreshed ?? null } };
      }),
    };
  }

  const fresh = {
    access_token: 'AT-fresh',
    refresh_token: 'RT-fresh',
    expires_at: nowSec + 3600,
    user: { id: 'u1', email: 'a@example.com' },
    provider_token: 'PT',
  };

  it('セッションが無ければ null', async () => {
    expect(await getSessionForBridge(makeAuth({ session: null }), NOW_MS)).toBeNull();
  });

  it.each([
    [{ access_token: '', refresh_token: 'RT', expires_at: nowSec + 3600 }],
    [{ access_token: 'AT', refresh_token: '', expires_at: nowSec + 3600 }],
    [{ access_token: 'AT', expires_at: nowSec + 3600 }],
  ])('トークンが欠けていれば null: %p', async (session) => {
    expect(await getSessionForBridge(makeAuth({ session }), NOW_MS)).toBeNull();
  });

  it('十分に有効なら refresh せず、トークン 2 つだけを返す (user や provider_token は渡さない)', async () => {
    const auth = makeAuth({ session: fresh });
    const result = await getSessionForBridge(auth, NOW_MS);
    expect(result).toEqual({ access_token: 'AT-fresh', refresh_token: 'RT-fresh' });
    expect(auth.refreshSession).not.toHaveBeenCalled();
  });

  it('残りがちょうど閾値なら refresh しない', async () => {
    const auth = makeAuth({
      session: { ...fresh, expires_at: nowSec + BRIDGE_MIN_TOKEN_TTL_SEC },
    });
    await getSessionForBridge(auth, NOW_MS);
    expect(auth.refreshSession).not.toHaveBeenCalled();
  });

  it('残りが閾値未満なら refreshSession して更新後のトークンを返す', async () => {
    const auth = makeAuth({
      session: { ...fresh, expires_at: nowSec + BRIDGE_MIN_TOKEN_TTL_SEC - 1 },
      refreshed: { access_token: 'AT-new', refresh_token: 'RT-new', expires_at: nowSec + 3600 },
    });
    const result = await getSessionForBridge(auth, NOW_MS);
    expect(auth.refreshSession).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ access_token: 'AT-new', refresh_token: 'RT-new' });
  });

  it('期限切れ済みでも refreshSession する', async () => {
    const auth = makeAuth({
      session: { ...fresh, expires_at: nowSec - 30 },
      refreshed: { access_token: 'AT-new', refresh_token: 'RT-new', expires_at: nowSec + 3600 },
    });
    expect(await getSessionForBridge(auth, NOW_MS)).toEqual({ access_token: 'AT-new', refresh_token: 'RT-new' });
  });

  it('refresh に失敗しても、まだ有効な access_token ならそれを使う', async () => {
    const auth = makeAuth({
      session: { ...fresh, expires_at: nowSec + 60 },
      refreshed: null,
    });
    expect(await getSessionForBridge(auth, NOW_MS)).toEqual({ access_token: 'AT-fresh', refresh_token: 'RT-fresh' });
  });

  it('refresh が例外でも、まだ有効な access_token ならそれを使う', async () => {
    const auth = makeAuth({ session: { ...fresh, expires_at: nowSec + 60 }, refreshThrows: true });
    expect(await getSessionForBridge(auth, NOW_MS)).toEqual({ access_token: 'AT-fresh', refresh_token: 'RT-fresh' });
  });

  it('refresh に失敗し、かつ期限切れなら null (無駄な code 発行をしない)', async () => {
    const auth = makeAuth({ session: { ...fresh, expires_at: nowSec - 1 }, refreshed: null });
    expect(await getSessionForBridge(auth, NOW_MS)).toBeNull();
    const throwing = makeAuth({ session: { ...fresh, expires_at: nowSec - 1 }, refreshThrows: true });
    expect(await getSessionForBridge(throwing, NOW_MS)).toBeNull();
  });

  it('expires_at が無ければ refresh しない', async () => {
    const auth = makeAuth({ session: { access_token: 'AT', refresh_token: 'RT' } });
    expect(await getSessionForBridge(auth, NOW_MS)).toEqual({ access_token: 'AT', refresh_token: 'RT' });
    expect(auth.refreshSession).not.toHaveBeenCalled();
  });

  it('getSession が例外でも投げずに null', async () => {
    expect(await getSessionForBridge(makeAuth({ getSessionThrows: true }), NOW_MS)).toBeNull();
  });

  /**
   * 複数のタブがほぼ同時にマウントすると、どのタブも getSession で「残りが少ない」と判断して refreshSession を呼ぶ。
   * 別々に更新すると refresh_token が続けて 2 回ローテーションされ、先に bridge した WebView が持つ分が使用済みになる。
   */
  describe('同時に呼ばれた場合 (複数のタブがほぼ同時にマウントしたとき)', () => {
    const expiring = { ...fresh, expires_at: nowSec + 30 };
    const renewed = { access_token: 'AT-new', refresh_token: 'RT-new', expires_at: nowSec + 3600 };
    // await のたびに次のマイクロタスクへ進めるだけでは足りないので、タイマーを 1 周させて全員が refreshSession に到達するのを待つ
    const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

    type RefreshResult = { data: { session: Record<string, unknown> | null } };

    /** refreshSession の完了を手動で制御できる auth */
    function makeDeferredAuth(session: Record<string, unknown> = expiring) {
      let resolveRefresh: (value: RefreshResult) => void = () => {};
      let rejectRefresh: (reason: unknown) => void = () => {};
      const refreshSession = jest.fn(
        () =>
          new Promise<RefreshResult>((resolve, reject) => {
            resolveRefresh = resolve;
            rejectRefresh = reject;
          }),
      );
      const auth = { getSession: jest.fn(async () => ({ data: { session } })), refreshSession };
      return {
        auth,
        refreshSession,
        finish: (value: Record<string, unknown> | null) => resolveRefresh({ data: { session: value } }),
        fail: (reason: unknown) => rejectRefresh(reason),
      };
    }

    it('refreshSession は 1 回だけ呼ばれ、どちらも同じ更新後のトークンを受け取る', async () => {
      const { auth, refreshSession, finish } = makeDeferredAuth();

      const first = getSessionForBridge(auth, NOW_MS);
      const second = getSessionForBridge(auth, NOW_MS);
      await settle();
      expect(refreshSession).toHaveBeenCalledTimes(1);

      finish(renewed);
      const expected = { access_token: 'AT-new', refresh_token: 'RT-new' };
      expect(await first).toEqual(expected);
      expect(await second).toEqual(expected);
      expect(refreshSession).toHaveBeenCalledTimes(1);
    });

    it('3 つ以上でも 1 回だけ', async () => {
      const { auth, refreshSession, finish } = makeDeferredAuth();

      const all = [1, 2, 3, 4, 5].map(() => getSessionForBridge(auth, NOW_MS));
      await settle();
      finish(renewed);

      const results = await Promise.all(all);
      expect(refreshSession).toHaveBeenCalledTimes(1);
      expect(results.every((r) => r?.access_token === 'AT-new' && r.refresh_token === 'RT-new')).toBe(true);
    });

    it('更新が終わった後の呼び出しは、(残りが少ないままなら) 改めて refreshSession する。結果を使い回し続けない', async () => {
      const { auth, refreshSession, finish } = makeDeferredAuth();

      const first = getSessionForBridge(auth, NOW_MS);
      await settle();
      finish(renewed);
      await first;
      expect(refreshSession).toHaveBeenCalledTimes(1);

      const second = getSessionForBridge(auth, NOW_MS);
      await settle();
      expect(refreshSession).toHaveBeenCalledTimes(2);
      finish({ access_token: 'AT-newer', refresh_token: 'RT-newer', expires_at: nowSec + 3600 });
      expect(await second).toEqual({ access_token: 'AT-newer', refresh_token: 'RT-newer' });
    });

    it('更新が例外で終わっても、待っていた全員が例外なく (まだ有効な access_token で) 続行でき、その後は再試行できる', async () => {
      const { auth, refreshSession, fail, finish } = makeDeferredAuth();

      const first = getSessionForBridge(auth, NOW_MS);
      const second = getSessionForBridge(auth, NOW_MS);
      await settle();
      fail(new Error('network'));

      const fallback = { access_token: 'AT-fresh', refresh_token: 'RT-fresh' };
      expect(await first).toEqual(fallback);
      expect(await second).toEqual(fallback);
      expect(refreshSession).toHaveBeenCalledTimes(1);

      // 失敗した更新を握り続けない: 次の呼び出しは新しく更新を試みる
      const third = getSessionForBridge(auth, NOW_MS);
      await settle();
      expect(refreshSession).toHaveBeenCalledTimes(2);
      finish(renewed);
      expect(await third).toEqual({ access_token: 'AT-new', refresh_token: 'RT-new' });
    });

    it('別の auth クライアントとは更新を共有しない', async () => {
      const a = makeDeferredAuth();
      const b = makeDeferredAuth();

      const fromA = getSessionForBridge(a.auth, NOW_MS);
      const fromB = getSessionForBridge(b.auth, NOW_MS);
      await settle();
      expect(a.refreshSession).toHaveBeenCalledTimes(1);
      expect(b.refreshSession).toHaveBeenCalledTimes(1);

      a.finish({ access_token: 'AT-a', refresh_token: 'RT-a', expires_at: nowSec + 3600 });
      b.finish({ access_token: 'AT-b', refresh_token: 'RT-b', expires_at: nowSec + 3600 });
      expect(await fromA).toEqual({ access_token: 'AT-a', refresh_token: 'RT-a' });
      expect(await fromB).toEqual({ access_token: 'AT-b', refresh_token: 'RT-b' });
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// requestBridgeCode
// ─────────────────────────────────────────────────────────────────────────────
describe('requestBridgeCode()', () => {
  const SESSION = { access_token: 'AT-secret-value', refresh_token: 'RT-secret-value' };
  const CODE = 'Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MGFiY2RlZmdoaWo';
  const originalFetch = global.fetch;

  function jsonResponse(body: unknown, init: { ok?: boolean; status?: number } = {}) {
    return {
      ok: init.ok ?? true,
      status: init.status ?? 200,
      json: async () => body,
    } as unknown as Response;
  }

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('Bearer 認証で POST し、body に refresh_token を載せ、code を返す', async () => {
    const fetchMock = jest.fn().mockResolvedValue(jsonResponse({ code: CODE, expires_in: 60 }));
    global.fetch = fetchMock as unknown as typeof fetch;

    const code = await requestBridgeCode(SESSION);

    expect(code).toBe(CODE);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${ORIGIN}/api/auth/native-bridge/code`);
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe(`Bearer ${SESSION.access_token}`);
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body)).toEqual({ refresh_token: SESSION.refresh_token });
    expect(init.signal).toBeDefined();
  });

  it('URL (クエリ含む) にトークンを載せない / access_token を body に載せない', async () => {
    const fetchMock = jest.fn().mockResolvedValue(jsonResponse({ code: CODE, expires_in: 60 }));
    global.fetch = fetchMock as unknown as typeof fetch;

    await requestBridgeCode(SESSION);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).not.toContain(SESSION.access_token);
    expect(url).not.toContain(SESSION.refresh_token);
    expect(url).not.toContain('?');
    expect(init.body).not.toContain(SESSION.access_token);
  });

  it('EXPO_PUBLIC_WEB_URL のオリジンへ送る (EXPO_PUBLIC_API_BASE_URL ではない)', async () => {
    process.env.EXPO_PUBLIC_WEB_URL = 'https://homegohan.app';
    process.env.EXPO_PUBLIC_API_BASE_URL = 'https://api.example.com';
    const fetchMock = jest.fn().mockResolvedValue(jsonResponse({ code: CODE, expires_in: 60 }));
    global.fetch = fetchMock as unknown as typeof fetch;

    await requestBridgeCode(SESSION);

    expect(fetchMock.mock.calls[0][0]).toBe('https://homegohan.app/api/auth/native-bridge/code');
  });

  it('本番ビルドで EXPO_PUBLIC_WEB_URL が http:// に誤設定されても、refresh_token を平文では送らない (既定の https オリジンへ送る)', async () => {
    const devGlobal = global as unknown as { __DEV__?: boolean };
    const originalDev = devGlobal.__DEV__;
    devGlobal.__DEV__ = false;
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      process.env.EXPO_PUBLIC_WEB_URL = 'http://web.example.com';
      const fetchMock = jest.fn().mockResolvedValue(jsonResponse({ code: CODE, expires_in: 60 }));
      global.fetch = fetchMock as unknown as typeof fetch;

      await requestBridgeCode(SESSION);

      expect(fetchMock.mock.calls[0][0]).toBe(`${DEFAULT_WEB_ORIGIN}/api/auth/native-bridge/code`);
      expect(fetchMock.mock.calls[0][0]).toMatch(/^https:/);
    } finally {
      devGlobal.__DEV__ = originalDev;
    }
  });

  it('プラットフォームとアプリのバージョンをヘッダで送る (サーバー側のバージョン分布把握用)', async () => {
    const fetchMock = jest.fn().mockResolvedValue(jsonResponse({ code: CODE, expires_in: 60 }));
    global.fetch = fetchMock as unknown as typeof fetch;

    await requestBridgeCode(SESSION);

    const headers = fetchMock.mock.calls[0][1].headers;
    expect(headers['X-App-Platform']).toBe('ios');
    expect(headers['X-App-Version']).toBe('1.2.3');
  });

  it.each([400, 401, 403, 429, 500, 503])('HTTP %i は null (例外を投げない)', async (status) => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    global.fetch = jest
      .fn()
      .mockResolvedValue(jsonResponse({ error: { code: 'X' } }, { ok: false, status })) as unknown as typeof fetch;
    await expect(requestBridgeCode(SESSION)).resolves.toBeNull();
  });

  it('ネットワークエラーは null', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    global.fetch = jest.fn().mockRejectedValue(new TypeError('Network request failed')) as unknown as typeof fetch;
    await expect(requestBridgeCode(SESSION)).resolves.toBeNull();
  });

  it('JSON として読めないレスポンスは null', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('Unexpected token <');
      },
    }) as unknown as typeof fetch;
    await expect(requestBridgeCode(SESSION)).resolves.toBeNull();
  });

  it.each([
    ['code が無い', { expires_in: 60 }],
    ['code が文字列でない', { code: 12345678901234567890 }],
    ['code が空', { code: '' }],
    ['code が短すぎる', { code: 'abc' }],
    ['code に URL を壊す文字', { code: 'abcdefghijklmnopqrstuvwxyz&next=//evil.example' }],
    ['code が長すぎる', { code: 'a'.repeat(300) }],
    ['body が null', null],
  ])('不正なレスポンス (%s) は null', async (_label, body) => {
    global.fetch = jest.fn().mockResolvedValue(jsonResponse(body)) as unknown as typeof fetch;
    await expect(requestBridgeCode(SESSION)).resolves.toBeNull();
  });

  it(`${BRIDGE_REQUEST_TIMEOUT_MS}ms 応答が無ければ中断して null`, async () => {
    jest.useFakeTimers();
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    global.fetch = jest.fn(
      (_url: unknown, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    ) as unknown as typeof fetch;

    const promise = requestBridgeCode(SESSION);
    jest.advanceTimersByTime(BRIDGE_REQUEST_TIMEOUT_MS);

    await expect(promise).resolves.toBeNull();
  });

  it('成功・失敗いずれの場合も、トークンや code をログに出さない', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
      jest.spyOn(console, m).mockImplementation(() => {}),
    );

    global.fetch = jest.fn().mockResolvedValue(jsonResponse({ code: CODE, expires_in: 60 })) as unknown as typeof fetch;
    await requestBridgeCode(SESSION);
    global.fetch = jest
      .fn()
      .mockResolvedValue(jsonResponse({}, { ok: false, status: 401 })) as unknown as typeof fetch;
    await requestBridgeCode(SESSION);
    global.fetch = jest
      .fn()
      .mockRejectedValue(new Error(`boom ${SESSION.access_token} ${SESSION.refresh_token}`)) as unknown as typeof fetch;
    await requestBridgeCode(SESSION);

    // Error は JSON.stringify だと "{}" になりメッセージが見えないため、message / stack を展開してから検査する
    const logged = JSON.stringify(
      spies.flatMap((s) => s.mock.calls),
      (_key, value) =>
        value instanceof Error ? { name: value.name, message: value.message, stack: value.stack } : value,
    );
    expect(logged).not.toContain(SESSION.access_token);
    expect(logged).not.toContain(SESSION.refresh_token);
    expect(logged).not.toContain(CODE);
  });
});
