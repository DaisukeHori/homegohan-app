/**
 * WebView 認証ブリッジ (#1036 / #1158)
 *
 * 旧実装は access_token / refresh_token を `/auth/native-bridge?access_token=…&refresh_token=…` の
 * URL に直接載せ、さらに localStorage へ全 origin で注入していた。URL は Vercel のアクセスログ・
 * Referer・WebView の履歴へ残り、注入スクリプトは外部サイトへ遷移した先でも実行される。
 *
 * 新実装:
 *   1. ネイティブが Bearer 認証で `POST {WEB}/api/auth/native-bridge/code` を呼び、
 *      単一使用・60 秒有効のワンタイム code を受け取る (refresh_token は HTTPS のリクエスト body のみ)
 *   2. WebView は `{WEB}/auth/native-bridge?code=…&next=…` だけを開く。URL に載るのは code のみ
 *   3. Web 側が code を消費して Cookie セッションを張り、next へ 307 する
 *   4. localStorage 注入は廃止 (Web クライアントは Cookie を読むため元から不要だった)
 *
 * このファイルは副作用の少ない関数だけを持つ (React / supabase クライアントに依存しない)。
 * 失敗時は常に「トークンを含まない直接 URL」へ倒す。旧方式 (トークン付き URL) には決してフォールバックしない。
 */
import 'react-native-url-polyfill/auto';

import { Linking, Platform } from 'react-native';

import { readExpoAppVersion } from './app-version';
import { DEFAULT_WEB_URL } from './webBaseUrl';

// ── 定数 ──────────────────────────────────────────────────────────────────────

/**
 * EXPO_PUBLIC_WEB_URL が未設定・不正なときの Web オリジン。
 * 既定値は webBaseUrl.ts の DEFAULT_WEB_URL の 1 か所だけに置く (#1159: ダウンロードの送信元の確認と食い違わないように)
 */
export const DEFAULT_WEB_ORIGIN = DEFAULT_WEB_URL;
/** 遷移先が不正・未指定のときの既定パス (タブ側が渡す trusted な path が無い場合の最後の砦) */
export const DEFAULT_WEB_PATH = '/home';
/** bridge の next が不正なときの既定。Web 側 native-bridge の既定値と揃える */
export const DEFAULT_BRIDGE_NEXT_PATH = '/home?mode=app';
/** WebView が最初に表示する空ページ */
export const ABOUT_BLANK = 'about:blank';

export const BRIDGE_PAGE_PATH = '/auth/native-bridge';
export const BRIDGE_CODE_PATH = '/api/auth/native-bridge/code';
/** code 発行リクエストの打ち切り時間。超えたら直接 URL へフォールバックする */
export const BRIDGE_REQUEST_TIMEOUT_MS = 8000;

/**
 * Web 側が code 発行時に要求する、access_token の有効期限までの最低残り秒数 (秒)。
 * これ未満の access_token には、Web 側は必ず 401 AUTH_TOKEN_EXPIRING を返す。
 *
 * **Web 側の MIN_ACCESS_TOKEN_REMAINING_SECONDS (src/lib/auth/native-bridge-code.ts) と必ず同じ値にすること。**
 * Web 側は「code の有効期間 60 秒 + supabase-js が getSession() で更新を始める余裕 90 秒」の 150 秒で、
 * どちらかが変わったらこの値も変える。OTA が無効なので、配布済みのアプリの値は後から直せない。
 * 食い違うと、その区間では bridge が失敗して WebView がログイン画面になる (#1036)。
 * __tests__/lib/webViewBridge.supabase.test.ts が、この値と本物の supabase-js の更新条件の組み合わせを確かめる。
 */
export const BRIDGE_SERVER_MIN_TOKEN_TTL_SEC = 150;
/**
 * BRIDGE_SERVER_MIN_TOKEN_TTL_SEC に足す余裕 (秒)。
 *   - 残りを確かめてから Web 側が判定するまでの通信時間 (最大 BRIDGE_REQUEST_TIMEOUT_MS = 8 秒)
 *   - 端末の時計が実時間より遅れている分。端末は expires_at を自分の時計と比べるので、遅れた分だけ残りを多く見積もる
 */
const BRIDGE_TOKEN_TTL_MARGIN_SEC = 60;
/**
 * access_token の残りがこれ未満なら、code 発行前に refreshSession する (秒)。
 *
 * 端末の supabase-js は、getSession() が残り 90 秒を切るまで自動更新しない。そのため bridge の時点の
 * access_token の残りは 90〜3600 秒になり、90〜150 秒の区間は Web 側が必ず 401 にする。
 * 閾値を Web 側の下限ちょうどにすると、通信時間や時計のずれでその下限を割るので、余裕を足す
 * (これで refreshSession が走るのは、1 時間のうち約 3% のタブ表示)。
 */
export const BRIDGE_MIN_TOKEN_TTL_SEC = BRIDGE_SERVER_MIN_TOKEN_TTL_SEC + BRIDGE_TOKEN_TTL_MARGIN_SEC;

/** initialPath は deep link 由来で長さを制御できないため上限を設ける */
const MAX_WEB_PATH_LENGTH = 4096;
/** safe-redirect.ts と同じ。多重 percent-encoding の難読化を吸収する回数 */
const MAX_DECODE_ITERATIONS = 3;
/** Web 側が返す code (現状 base64url 43 文字) の形式検査。長さは将来の変更に備えて緩くしてある */
const BRIDGE_CODE_PATTERN = /^[A-Za-z0-9_-]{16,256}$/;
/** スキーム付き URL (`https:`, `javascript:` 等) */
const SCHEME_PATTERN = /^[a-zA-Z][a-zA-Z\d+.-]*:/;

// ── URL 解析 ──────────────────────────────────────────────────────────────────

function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function isHttpUrl(value: string): boolean {
  const parsed = parseUrl(value);
  return parsed !== null && (parsed.protocol === 'https:' || parsed.protocol === 'http:');
}

/**
 * ホスト名を ASCII の範囲だけ小文字化する。
 * RN の URL polyfill (whatwg-url-without-unicode) は標準のパーサと違ってホストを小文字化しないため、
 * 大文字を含む設定値 (EXPO_PUBLIC_WEB_URL) とネイティブが報告する小文字の URL が食い違わないようにする。
 * toLowerCase() は使わない (Unicode のケルビン記号 K 等が ASCII の k に化けるのを避ける)。
 */
function asciiLowerCase(value: string): string {
  return value.replace(/[A-Z]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) + 32));
}

let warnedInvalidWebUrl = false;

/**
 * 本番ビルド (`__DEV__` が false) でも http: を許す開発用ホスト。
 * 端末自身のループバックと、Android エミュレータ (標準 / Genymotion) からホスト PC を指す別名で、
 * どれも端末の外へは出ない。
 */
const DEV_HTTP_HOSTNAMES: readonly string[] = ['localhost', '127.0.0.1', '[::1]', '10.0.2.2', '10.0.3.2'];

function isDevBuild(): boolean {
  return typeof __DEV__ !== 'undefined' && __DEV__ === true;
}

/**
 * EXPO_PUBLIC_WEB_URL の値をオリジンとして採用してよいか。
 *
 * requestBridgeCode はこのオリジンへ refresh_token を POST する。
 * 本番ビルドで EXPO_PUBLIC_WEB_URL を http:// に誤設定しても、平文で送らないようにする
 * (iOS の ATS / Android の cleartext 制限が止める可能性は高いが、それに頼らない)。
 *   - https: は常に可
 *   - http: は開発ビルド (`__DEV__`: 実機向けの LAN 上の開発サーバーなど) か、DEV_HTTP_HOSTNAMES のホストに限る
 */
function isAcceptableWebOrigin(parsed: URL): boolean {
  if (parsed.hostname === '' || parsed.username !== '' || parsed.password !== '') return false;
  if (parsed.protocol === 'https:') return true;
  if (parsed.protocol !== 'http:') return false;
  return isDevBuild() || DEV_HTTP_HOSTNAMES.includes(asciiLowerCase(parsed.hostname));
}

/**
 * WebView に読み込ませる Web のオリジン (`https://host[:port]`、末尾スラッシュ・パス・認証情報なし)。
 * 環境変数は呼び出しのたびに読む (テストで差し替えられるようにするため)。
 * `process.env.EXPO_PUBLIC_*` は Metro がビルド時にインライン展開するので、関数内での参照でも問題ない。
 */
export function getWebOrigin(): string {
  const configured = process.env.EXPO_PUBLIC_WEB_URL;
  if (configured) {
    const parsed = parseUrl(configured);
    if (parsed && isAcceptableWebOrigin(parsed)) {
      return `${parsed.protocol}//${asciiLowerCase(parsed.host)}`;
    }
    if (!warnedInvalidWebUrl) {
      warnedInvalidWebUrl = true;
      console.warn(
        '[webViewBridge] EXPO_PUBLIC_WEB_URL is invalid (https is required outside development). Falling back to the default web origin.',
      );
    }
  }
  return DEFAULT_WEB_ORIGIN;
}

/**
 * url が自アプリの Web オリジンかを厳密に判定する。
 *
 * originWhitelist (react-native-webview) は「scheme://authority」に対する未アンカーの前方一致なので、
 * `https://homegohan-app.vercel.app.evil.com` や `https://homegohan-app.vercel.app@evil.com` も通してしまう。
 * そのため URL を実際にパースし、スキーム・ホスト(ポート込み)の完全一致と認証情報なしを要求する。
 * (blob: のように origin プロパティだけが自オリジンを指す URL を通さないよう、origin ではなく protocol / host を比べる)
 *
 * `about:blank` は false を返す。WebView 内の about:blank は外部ページからも作れ、
 * そこから postMessage されても「自アプリのページ」とは言えないため。
 * ナビゲーション判定でだけ about:blank を許可する (decideNavigation を参照)。
 */
export function isOwnOrigin(url: unknown): boolean {
  if (typeof url !== 'string' || url.length === 0) return false;
  const target = parseUrl(url);
  const own = parseUrl(getWebOrigin());
  if (!target || !own) return false;
  return (
    target.protocol === own.protocol &&
    asciiLowerCase(target.host) === asciiLowerCase(own.host) &&
    target.username === '' &&
    target.password === ''
  );
}

// ── パスの検証・組み立て ──────────────────────────────────────────────────────

function hasControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function stripControlChars(value: string): string {
  let result = '';
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code > 0x1f && code !== 0x7f) result += value[i];
  }
  return result;
}

/**
 * WHATWG URL パーサは `\` を `/` とみなし、タブ・改行を無視する。
 * その正規化後に「単一の `/` で始まる」(= `//host` や `scheme:` に化けない) かを調べる。
 */
function startsWithSingleSlash(candidate: string): boolean {
  const normalized = stripControlChars(candidate).split('\\').join('/');
  if (SCHEME_PATTERN.test(normalized)) return false;
  return normalized.startsWith('/') && !normalized.startsWith('//');
}

/** パスの `?` / `#` より前の部分 */
export function pathnameOf(path: string): string {
  const end = path.search(/[?#]/);
  return end === -1 ? path : path.slice(0, end);
}

/**
 * Web 側へ渡すパス (deep link の initialPath、tab-navigate の fullPath 等) を検証する。
 * 安全なら入力をそのまま、そうでなければ fallback を返す (fallback は呼び出し側が信頼できる値を渡すこと)。
 *
 * 拒否: 先頭が単一の `/` でないもの (`//host`、`scheme:`、`@host`)、`\`、パス部分 (`?` / `#` より前) の `@`、制御文字、
 *       percent-encoding で上記に化けるもの (`/%2F/evil`、`/%5Cevil`、二重エンコード含む)。
 * `@` を見るのはパス部分だけ。先頭が単一の `/` なら authority は `/` の手前で確定しているので、後ろの `@` は userinfo にならない。
 * WHATWG URL はクエリ・ハッシュ中の `@` をエンコードしないため、tab-navigate が渡す fullPath (pathname + search) が
 * `/menus/weekly?q=a@b` のような形になり得る。ここで弾くとタブの既定パスに黙って戻り、クエリが失われてしまう。
 * `src/lib/auth/safe-redirect.ts` と同じ考え方だが、こちらは入力を書き換えず(デコードせず)そのまま返す。
 * expo-router のクエリは `string | string[]` になり得るので、配列なら先頭要素だけを見る。
 */
export function sanitizeWebPath(raw: unknown, fallback: string): string {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string') return fallback;
  if (value.length === 0 || value.length > MAX_WEB_PATH_LENGTH) return fallback;
  if (hasControlChars(value) || value.includes('\\') || pathnameOf(value).includes('@')) return fallback;
  if (!startsWithSingleSlash(value)) return fallback;

  let current = value;
  for (let i = 0; i < MAX_DECODE_ITERATIONS; i++) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(current);
    } catch {
      break; // 不正なエンコードはデコードしても結果が変わらないので、ここまでの検査で打ち切る
    }
    if (decoded === current) break;
    current = decoded;
    if (!startsWithSingleSlash(current)) return fallback;
  }
  return value;
}

/**
 * `.` / `..` のセグメントを含むか。`\` も区切りとして扱い、percent-encoding (`%2e%2e` や多重エンコード) はデコードしながら調べる。
 * WHATWG URL のパーサはこれらのセグメントを解決するため、`/menus/../auth/native-bridge` のように
 * prefix 配下に見えて、実際には別のパスへ抜ける形になる。
 *
 * 実際の遷移は生の文字列を解決するが、デコードしてから解決する経路があっても抜けられないよう、
 * デコードした各段階で「URL として解決したときのパス」(`?` / `#` 以降は除き、タブ・改行は無視される) を調べる。
 */
function hasDotSegment(pathname: string): boolean {
  let current = pathname;
  for (let i = 0; ; i++) {
    const resolvedPath = stripControlChars(pathnameOf(current));
    if (resolvedPath.split(/[\\/]/).some((segment) => segment === '.' || segment === '..')) return true;
    if (i >= MAX_DECODE_ITERATIONS) return false;
    let decoded: string;
    try {
      decoded = decodeURIComponent(current);
    } catch {
      return false; // 不正なエンコードはこれ以上デコードできない。ここまでの検査で打ち切る
    }
    if (decoded === current) return false;
    current = decoded;
  }
}

/**
 * path のパス部分が、prefixes のどれかの配下 (完全一致、または `prefix/` で始まる) か。
 * タブ intercept スクリプトの matchTab と同じ判定で、前方一致だけの紛らわしいもの (`/homepage` は `/home` の配下ではない) は除く。
 * デコードしない生のパスで調べ、`.` / `..` を含むもの (prefix の外へ抜け得る) は配下とみなさない。
 */
function isUnderPathPrefixes(path: string, prefixes: readonly string[]): boolean {
  const pathname = pathnameOf(path);
  if (hasDotSegment(pathname)) return false;
  return prefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

/**
 * initialPath (deep link の `homegohan://home?initialPath=…`、tab-navigate の fullPath、session-expired の再 bridge) 用の検証。
 * sanitizeWebPath に加えて、パス部分が allowedPrefixes (各タブの prefix と、その画面自身の path のパス部分) の配下であることを要求する。
 * 満たさなければ fallback を返す (fallback は呼び出し側が信頼できる値を渡すこと)。
 *
 * これは多層防御。deep link は他のアプリや Web ページからも起動でき、initialPath は WebView が最初に開くパスになる。
 * sanitizeWebPath だけでは `/auth/native-bridge?code=<攻撃者の code>` を通してしまい、
 * 被害者の WebView を攻撃者のアカウントでログインさせられる (login CSRF。入力した食事・健康データが攻撃者側に入る)。
 * tab-navigate が渡す fullPath は必ずどれかのタブの prefix に一致するので、正規の経路は塞がない。
 */
export function sanitizeInitialPath(raw: unknown, fallback: string, allowedPrefixes: readonly string[]): string {
  const safe = sanitizeWebPath(raw, fallback);
  if (safe === fallback) return fallback;
  return isUnderPathPrefixes(safe, allowedPrefixes) ? safe : fallback;
}

/**
 * path に `mode=app` を付与する (既にあれば付けない)。ハッシュがあれば `?` / `&` はハッシュより前に入れる。
 * Web 側は mode=app と is_native_app Cookie でアプリ内表示 (ボトムナビ非表示など) に切り替える。
 */
export function withAppMode(path: string): string {
  const hashIndex = path.indexOf('#');
  const base = hashIndex === -1 ? path : path.slice(0, hashIndex);
  const hash = hashIndex === -1 ? '' : path.slice(hashIndex);
  if (/[?&]mode=app(?:&|$)/.test(base)) return path;
  return `${base}${base.includes('?') ? '&' : '?'}mode=app${hash}`;
}

/** Web オリジンとパスから URL を組み立てる。パスは必ず検証を通す (authority 注入を防ぐ最後の砦) */
export function buildWebUrl(path: string): string {
  return `${getWebOrigin()}${sanitizeWebPath(path, DEFAULT_WEB_PATH)}`;
}

/**
 * WebView に最初に読ませる bridge URL。URL に載るのは code と next だけ。
 * トークン (access / refresh) は決して URL に入れない。
 */
export function buildBridgeUrl(code: string, nextPath: string): string {
  const next = sanitizeWebPath(nextPath, DEFAULT_BRIDGE_NEXT_PATH);
  return `${getWebOrigin()}${BRIDGE_PAGE_PATH}?code=${encodeURIComponent(code)}&next=${encodeURIComponent(next)}`;
}

// ── ナビゲーション判定 ────────────────────────────────────────────────────────

export interface NavigationRequestLike {
  url?: unknown;
  /**
   * false が明示されたときだけサブフレームとみなす。
   * iOS (react-native-webview 13.13.5 の apple/RNCWebViewImpl.m) はサブフレームの読み込みも渡し、実際のフレームを報告する。
   * Android (shouldOverrideUrlLoading) は request.isForMainFrame() を渡さず、isTopFrame を載せない
   * (デバッグ時の代替経路では常に true を載せる)。そのため Android では、他オリジンの iframe の読み込みや
   * iframe 内での遷移が届いた場合、どれもトップフレーム扱いになる。Web の CSP (src/lib/security/csp.ts の frame-src) が
   * 許す埋め込み先 (WEB_VIEW_EMBED_ORIGINS = Turnstile) は、この区別に頼らず許可する (decideNavigation を参照)。
   * Android の WebView が iframe の読み込みをこの判定に渡すかどうかは端末で確かめていない。
   * Turnstile のある画面 (/login、/settings/account のパスワード変更) を Android 実機で確認すること。
   */
  isTopFrame?: boolean;
}

export interface NavigationDecision {
  allow: boolean;
  /** 他オリジンへのトップフレーム遷移は WebView に載せず、OS の既定ブラウザで開く */
  openExternal?: string;
}

/**
 * Web の CSP (src/lib/security/csp.ts の frame-src) が iframe での表示を許している、自オリジン以外の埋め込み先。
 * 今は Cloudflare Turnstile (ログイン・新規登録・パスワード再設定・設定のパスワード変更の bot 対策) のウィジェットだけ。
 * Android は遷移がどのフレームのものかを報告しない (NavigationRequestLike の isTopFrame を参照) ので、
 * ここにある https のオリジンは、フレームを問わず WebView の中で読み込む (既定ブラウザへ回さない)。
 * Web がこのオリジンのページをトップフレームで開くことは無く、開いても WebView にはトークンが無いので漏れるものは無い。
 *
 * src/lib/security/csp.ts の frame-src に他オリジンを足したら、ここにも足す (__tests__/lib/webViewBridge.test.ts が
 * src/lib/security/csp.ts と突き合わせる)。OTA が無効なので、配布済みのアプリの値は後から直せない。
 */
export const WEB_VIEW_EMBED_ORIGINS: readonly string[] = ['https://challenges.cloudflare.com'];

/** url が WEB_VIEW_EMBED_ORIGINS のどれかの https オリジンか (スキーム・ホスト・ポートの完全一致、認証情報なし) */
function isEmbedOrigin(url: string): boolean {
  const parsed = parseUrl(url);
  if (!parsed || parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== '') return false;
  return WEB_VIEW_EMBED_ORIGINS.includes(`${parsed.protocol}//${asciiLowerCase(parsed.host)}`);
}

/**
 * onShouldStartLoadWithRequest 用の判定。
 *   - 自オリジン / about:blank: 許可
 *   - 非 http(s): 黙って遮断
 *   - 他オリジンの http(s) のサブフレーム (isTopFrame が false): 許可。
 *     どの iframe を読み込めるかは Web の CSP (frame-src) が決める。WebView にはページから参照できるトークンが無く、
 *     サブフレームの読み込みでトップフレームのページは変わらない。
 *     ここで止めると、CSP が許す Turnstile の iframe が iOS で読み込めず、ログインや設定のパスワード変更ができなくなる
 *   - WEB_VIEW_EMBED_ORIGINS (Turnstile): フレームを問わず許可 (Android はフレームを報告しないため)
 *   - それ以外の他オリジンの http(s) (トップフレーム、または Android): 遮断して外部ブラウザで開く
 *
 * Android の shouldOverrideUrlLoading は JS の応答を最大 250ms 待って許可に倒れるため、
 * このガードだけを境界にしてはいけない。本命の防御は「ページから参照できるトークンが存在しない」こと。
 */
export function decideNavigation(request: NavigationRequestLike): NavigationDecision {
  const url = request.url;
  if (typeof url !== 'string') return { allow: false };
  if (url === ABOUT_BLANK || isOwnOrigin(url)) return { allow: true };
  if (!isHttpUrl(url)) return { allow: false };
  if (request.isTopFrame === false || isEmbedOrigin(url)) return { allow: true };
  return { allow: false, openExternal: url };
}

/**
 * WebView の originWhitelist。react-native-webview (13.13.5 の WebViewShared.tsx) は、遷移先の
 * 「scheme://authority」がこの一覧のどれにも前方一致しないものを onShouldStartLoadWithRequest に渡さずに遮断し、
 * Linking.openURL で OS に渡す。一致したものだけが onShouldStartLoadWithRequest (decideNavigation) に届く。
 *
 * 自オリジン 1 つに絞らない理由:
 *   - 一致は未アンカーの前方一致なので、`https://homegohan-app.vercel.app.evil.com` も自オリジンの指定に一致し、
 *     境界にならない (境界は decideNavigation の厳密なパースが担う)
 *   - 絞ると、他オリジンの http(s) のサブフレーム (CSP が許す Turnstile の iframe) まで、ライブラリが WebView で読み込まずに
 *     OS のブラウザで開いてしまう (decideNavigation はサブフレームを WebView の中で許可する)
 * http(s) はすべて decideNavigation に渡し、自オリジン以外のトップフレームは decideNavigation が既定ブラウザへ回す。
 * http(s) 以外 (mailto: など。Web の設定画面・問い合わせページのリンク) は従来どおりライブラリが OS に渡す。
 * ライブラリの既定値と同じ中身だが、WebView を自オリジンに固定する仕組みの一部として明示する。
 */
export const WEB_VIEW_ORIGIN_WHITELIST: string[] = ['https://*', 'http://*'];

export interface OpenWindowDecision {
  /** 自オリジンなら現在の WebView 内で開く (iOS の target=_blank の従来挙動を維持) */
  navigateTo?: string;
  /** 他オリジンの http(s) は OS の既定ブラウザで開く */
  openExternal?: string;
}

/** onOpenWindow (target=_blank / window.open) 用の判定。上記以外 (about:blank、非 http(s)) は何もしない */
export function decideOpenWindow(targetUrl: unknown): OpenWindowDecision {
  if (typeof targetUrl !== 'string') return {};
  if (isOwnOrigin(targetUrl)) return { navigateTo: targetUrl };
  if (isHttpUrl(targetUrl)) return { openExternal: targetUrl };
  return {};
}

/** http(s) の URL だけを OS の既定ブラウザで開く。失敗しても例外は投げない */
export async function openExternalUrl(url: string): Promise<void> {
  if (!isHttpUrl(url)) return;
  try {
    await Linking.openURL(url);
  } catch {
    console.warn('[webViewBridge] failed to open an external url');
  }
}

// ── WebView へ注入するスクリプトの部品 ────────────────────────────────────────

/**
 * 注入スクリプトの先頭に置くガード。自アプリのオリジン以外 (外部サイトが万一表示された場合) では何も実行しない。
 * `return` を使うので、関数 (IIFE) の中に置くこと。
 */
export function buildOriginGuardScript(): string {
  return `if (window.location.origin !== ${JSON.stringify(getWebOrigin())}) return;`;
}

/**
 * 任意の注入スクリプトを、自アプリのオリジンのページでだけ動くように包む。
 * injectedJavaScriptBeforeContentLoaded は WebView のすべての読み込み (外部ページが万一載った場合も) で動くため、
 * そこに入れるスクリプトは必ずこれで包む (#1036: 注入はオリジンを確かめてから)。
 * script は単独で完結した文の並び (IIFE など) であること。
 */
export function buildOwnOriginOnlyScript(script: string): string {
  return `
(function() {
  ${buildOriginGuardScript()}
  ${script}
})();
true;
`;
}

export interface NavigateScriptOptions {
  /**
   * true (既定) なら、自アプリのオリジン上でのみ遷移する。`false` を明示したときだけ、どのページの上でも遷移する。
   *
   * `false` にしてよいのは、次の 2 つを両方満たすときだけ。
   *   1. スクリプトが持つのが公開されている自オリジンの URL だけで、トークンも code も含まない
   *      (外部ページ上で実行されても漏れるものが無い)
   *   2. 「WebView が自オリジンのページを表示していないとき」の復帰手段として使う
   *      (タブ再タップのリセット。ガードを付けると、起動時のオフラインで about:blank のまま固まった場合や、
   *       Android のナビゲーションガードが時間切れで許可して外部ページが載った場合に、アプリを終了するまで戻れなくなる)
   */
  guard?: boolean;
}

/**
 * 現在の WebView を url へ遷移させるスクリプト。URL は JSON.stringify でリテラル化する。
 * 既定では自オリジン上でのみ実行する (オリジンガード付き)。onOpenWindow はこの既定のまま使う。
 * tabPress のリセットだけは `{ guard: false }` で呼ぶ (NavigateScriptOptions.guard を参照)。
 */
export function buildNavigateScript(
  url: string,
  method: 'assign' | 'replace' = 'assign',
  options: NavigateScriptOptions = {},
): string {
  // 明示的な false だけがガードを外す (undefined / true / 想定外の値は、安全側のガード付きにする)
  const guardStatement = options.guard === false ? '' : buildOriginGuardScript();
  return `
(function() {
  ${guardStatement}
  window.location.${method}(${JSON.stringify(url)});
})();
true;
`;
}

/**
 * 今開いているページを読み込み直すスクリプト (AI 相談の提案の実行でデータが変わったとき。#2189 W2)。
 * 自オリジンのページでだけ動く (外部ページ・読み込みに失敗した about:blank では何もしない)。
 * 認証ブリッジのページ (BRIDGE_PAGE_PATH) の上では読み込み直さない: URL の code は一度しか使えない (#1036) ので、
 * 同じ URL を読み直すとログインできない (ブリッジは next のパスへ移すので、ふつうはここに留まらない)。
 * スクリプトは URL・トークン・code を持たない
 */
export function buildReloadCurrentPageScript(): string {
  return buildOwnOriginOnlyScript(`
  if (window.location.pathname === ${JSON.stringify(BRIDGE_PAGE_PATH)}) return;
  window.location.reload();`);
}

// ── セッション取得と code 発行 ────────────────────────────────────────────────

export interface BridgeSession {
  access_token: string;
  refresh_token: string;
}

interface SessionLike {
  access_token?: string | null;
  refresh_token?: string | null;
  expires_at?: number | null;
}

/** supabase.auth のうち、このモジュールが使う部分だけ (テストで差し替えやすくするため構造的に定義) */
export interface BridgeAuthClient {
  getSession(): Promise<{ data: { session: SessionLike | null } }>;
  refreshSession(): Promise<{ data: { session: SessionLike | null } }>;
}

function toBridgeSession(session: SessionLike | null | undefined): BridgeSession | null {
  if (!session?.access_token || !session.refresh_token) return null;
  return { access_token: session.access_token, refresh_token: session.refresh_token };
}

/** 実行中の refreshSession。auth クライアントごとに 1 つだけ共有する (終われば消える) */
const inflightRefreshes = new WeakMap<BridgeAuthClient, Promise<SessionLike | null>>();

/**
 * refreshSession を、同じ auth クライアントで実行中のものがあればそれに相乗りして 1 回だけ行う。例外は投げず、失敗なら null。
 *
 * 複数のタブがほぼ同時にマウントすると、どのタブも getSession で「残りが少ない」と判断して refreshSession を呼ぶ。
 * それぞれが別々に更新すると refresh_token が続けて 2 回ローテーションされ、先に bridge した WebView が持つ
 * refresh_token が使用済みになってしまう。
 */
function refreshSessionOnce(auth: BridgeAuthClient): Promise<SessionLike | null> {
  const inflight = inflightRefreshes.get(auth);
  if (inflight) return inflight;

  const refreshing = (async (): Promise<SessionLike | null> => {
    try {
      const { data } = await auth.refreshSession();
      return data?.session ?? null;
    } catch {
      return null; // 呼び出し側が、まだ有効な access_token ならそのまま使う
    }
  })().finally(() => {
    inflightRefreshes.delete(auth);
  });
  inflightRefreshes.set(auth, refreshing);
  return refreshing;
}

/**
 * bridge に使うセッションを返す。例外は投げず、取れなければ null。
 *
 * access_token の残りが BRIDGE_MIN_TOKEN_TTL_SEC 未満なら先に refreshSession する (同時に呼ばれても更新は 1 回)。
 * 理由は 2 つある。
 *   - Web 側は、残りが BRIDGE_SERVER_MIN_TOKEN_TTL_SEC 未満の access_token には code を発行せず 401 を返す。
 *     端末の supabase-js の getSession() は残り 90 秒を切るまで更新しないので、そのままでは下限を割る区間がある
 *   - Web 側の setSession は期限切れの access_token を見ると refresh_token を使って更新 (=ローテーション) してしまい、
 *     ネイティブ側が持つ refresh_token が失効して強制ログアウトになり得る
 *
 * 更新に失敗したときは、残りが BRIDGE_SERVER_MIN_TOKEN_TTL_SEC 以上の access_token ならそのまま使う。
 * それ未満なら null を返す: Web 側が必ず 401 にするので、失敗が確定している POST を省いてすぐ直接 URL へ倒す。
 */
export async function getSessionForBridge(
  auth: BridgeAuthClient,
  nowMs: number = Date.now(),
): Promise<BridgeSession | null> {
  try {
    const { data } = await auth.getSession();
    const current = data?.session ?? null;
    const currentTokens = toBridgeSession(current);
    if (!current || !currentTokens) return null;

    const remainingSec =
      typeof current.expires_at === 'number'
        ? current.expires_at - Math.floor(nowMs / 1000)
        : Number.POSITIVE_INFINITY;
    if (remainingSec >= BRIDGE_MIN_TOKEN_TTL_SEC) return currentTokens;

    const refreshedTokens = toBridgeSession(await refreshSessionOnce(auth));
    if (refreshedTokens) return refreshedTokens;
    // 更新に失敗しても、Web 側が受け付ける残りがあるならそのまま使う (サーバー側が最終判断する)
    return remainingSec >= BRIDGE_SERVER_MIN_TOKEN_TTL_SEC ? currentTokens : null;
  } catch {
    return null;
  }
}

/** サーバー側のバージョン分布把握用 (これまでアプリのバージョンを判別する手段が無かった) */
function appInfoHeaders(): Record<string, string> {
  const headers: Record<string, string> = { 'X-App-Platform': Platform.OS };
  // バージョンが取れなくても code 発行は続行する (readExpoAppVersion は例外を投げず null を返す)
  const version = readExpoAppVersion();
  if (version) headers['X-App-Version'] = version;
  return headers;
}

/**
 * ワンタイム code を発行してもらう。例外は投げず、失敗なら null (呼び出し側は直接 URL へ倒す)。
 * トークン・body・code はログに出さない。
 *
 * code の発行先と消費先 (cookie の張られる先) は同じオリジンでなければならないので、
 * EXPO_PUBLIC_API_BASE_URL ではなく WebView と同じ Web オリジンを使う。
 */
export async function requestBridgeCode(session: BridgeSession): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BRIDGE_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${getWebOrigin()}${BRIDGE_CODE_PATH}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${session.access_token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...appInfoHeaders(),
      },
      body: JSON.stringify({ refresh_token: session.refresh_token }),
      signal: controller.signal,
    });
    if (!response.ok) {
      console.warn(`[webViewBridge] bridge code request rejected (status ${response.status})`);
      return null;
    }
    const body: unknown = await response.json();
    const code = (body as { code?: unknown } | null)?.code;
    return typeof code === 'string' && BRIDGE_CODE_PATTERN.test(code) ? code : null;
  } catch {
    // 例外オブジェクトには URL 等が入り得るので、内容はログに出さない
    console.warn('[webViewBridge] bridge code request failed');
    return null;
  } finally {
    clearTimeout(timer);
  }
}
