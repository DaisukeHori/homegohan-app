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

import Constants from 'expo-constants';
import { Linking, Platform } from 'react-native';

// ── 定数 ──────────────────────────────────────────────────────────────────────

/** EXPO_PUBLIC_WEB_URL が未設定・不正なときの Web オリジン (#1049 F7-19 で別途見直すため現状維持) */
export const DEFAULT_WEB_ORIGIN = 'https://homegohan-app.vercel.app';
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
/** access_token の残り有効期間がこれ未満なら、code 発行前に refreshSession する (秒) */
export const BRIDGE_MIN_TOKEN_TTL_SEC = 120;

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
 * WebView に読み込ませる Web のオリジン (`https://host[:port]`、末尾スラッシュ・パス・認証情報なし)。
 * 環境変数は呼び出しのたびに読む (テストで差し替えられるようにするため)。
 * `process.env.EXPO_PUBLIC_*` は Metro がビルド時にインライン展開するので、関数内での参照でも問題ない。
 */
export function getWebOrigin(): string {
  const configured = process.env.EXPO_PUBLIC_WEB_URL;
  if (configured) {
    const parsed = parseUrl(configured);
    if (
      parsed &&
      (parsed.protocol === 'https:' || parsed.protocol === 'http:') &&
      parsed.hostname !== '' &&
      parsed.username === '' &&
      parsed.password === ''
    ) {
      return `${parsed.protocol}//${asciiLowerCase(parsed.host)}`;
    }
    if (!warnedInvalidWebUrl) {
      warnedInvalidWebUrl = true;
      console.warn('[webViewBridge] EXPO_PUBLIC_WEB_URL is invalid. Falling back to the default web origin.');
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

/**
 * Web 側へ渡すパス (deep link の initialPath、tab-navigate の fullPath 等) を検証する。
 * 安全なら入力をそのまま、そうでなければ fallback を返す (fallback は呼び出し側が信頼できる値を渡すこと)。
 *
 * 拒否: 先頭が単一の `/` でないもの (`//host`、`scheme:`、`@host`)、`\`、`@`、制御文字、
 *       percent-encoding で上記に化けるもの (`/%2F/evil`、`/%5Cevil`、二重エンコード含む)。
 * `src/lib/auth/safe-redirect.ts` と同じ考え方だが、こちらは入力を書き換えず(デコードせず)そのまま返す。
 * expo-router のクエリは `string | string[]` になり得るので、配列なら先頭要素だけを見る。
 */
export function sanitizeWebPath(raw: unknown, fallback: string): string {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string') return fallback;
  if (value.length === 0 || value.length > MAX_WEB_PATH_LENGTH) return fallback;
  if (hasControlChars(value) || value.includes('\\') || value.includes('@')) return fallback;
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
  /** Android は送ってこない場合がある。false が明示されたときだけサブフレームとみなす */
  isTopFrame?: boolean;
}

export interface NavigationDecision {
  allow: boolean;
  /** 他オリジンへのトップフレーム遷移は WebView に載せず、OS の既定ブラウザで開く */
  openExternal?: string;
}

/**
 * onShouldStartLoadWithRequest 用の判定。
 *   - 自オリジン / about:blank: 許可
 *   - 他オリジンの http(s) トップフレーム遷移: 遮断して外部ブラウザで開く
 *   - それ以外 (他オリジンのサブフレーム、非 http(s)): 黙って遮断
 *
 * Android の shouldOverrideUrlLoading は JS の応答を最大 250ms 待って許可に倒れるため、
 * このガードだけを境界にしてはいけない。本命の防御は「ページから参照できるトークンが存在しない」こと。
 */
export function decideNavigation(request: NavigationRequestLike): NavigationDecision {
  const url = request.url;
  if (typeof url !== 'string') return { allow: false };
  if (url === ABOUT_BLANK || isOwnOrigin(url)) return { allow: true };
  const isTopFrame = request.isTopFrame !== false;
  if (isTopFrame && isHttpUrl(url)) return { allow: false, openExternal: url };
  return { allow: false };
}

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

/** 現在の WebView を url へ遷移させるスクリプト (オリジンガード付き)。tabPress のリセットと onOpenWindow で使う */
export function buildNavigateScript(url: string, method: 'assign' | 'replace' = 'assign'): string {
  return `
(function() {
  ${buildOriginGuardScript()}
  window.location.${method}(${JSON.stringify(url)});
})();
true;
`;
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

/**
 * bridge に使うセッションを返す。例外は投げず、取れなければ null。
 *
 * access_token の残りが BRIDGE_MIN_TOKEN_TTL_SEC 未満なら先に refreshSession する。
 * Web 側の setSession は期限切れの access_token を見ると refresh_token を使って更新 (=ローテーション) してしまい、
 * ネイティブ側が持つ refresh_token が失効して強制ログアウトになり得るため。
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

    try {
      const { data: refreshed } = await auth.refreshSession();
      const refreshedTokens = toBridgeSession(refreshed?.session);
      if (refreshedTokens) return refreshedTokens;
    } catch {
      // 更新に失敗しても、まだ有効な access_token ならそのまま使う (サーバー側が最終判断する)
    }
    return remainingSec > 0 ? currentTokens : null;
  } catch {
    return null;
  }
}

/** サーバー側のバージョン分布把握用 (これまでアプリのバージョンを判別する手段が無かった) */
function appInfoHeaders(): Record<string, string> {
  const headers: Record<string, string> = { 'X-App-Platform': Platform.OS };
  try {
    const version = Constants.expoConfig?.version;
    if (version) headers['X-App-Version'] = version;
  } catch {
    // バージョンが取れなくても code 発行は続行する
  }
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
