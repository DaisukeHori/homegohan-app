/**
 * Web (WebView) からのログアウト・セッション失効の通知を、ネイティブに反映する (#1038 F7-04 / F7-05)
 *
 * ログイン状態の持ち主はネイティブ。WebView の Web 側は、ネイティブが張った借り物の Cookie セッションで動く。
 * Web 側でセッションが終わったときは、Web が次のメッセージを送ってくる (Web 側は src/lib/native-auth-bridge.ts):
 *
 *   { type: 'sign-out' }
 *     利用者が Web 側 (設定・マイページ) でログアウトした。
 *     ネイティブも、push token の削除 → 端末データの削除 → サインアウトを行い、ウェルカム画面へ戻る。
 *     これが無いと、Web だけがログアウトし、ネイティブは保存済みのセッションを持ったまま
 *     (Web の signOut は全端末のセッションを失効させるので、最大 1 時間後の更新で突然ログアウトする) になる (F7-04)。
 *
 *   { type: 'session-expired' }
 *     Web 側のセッションが切れた・切れそう。Web 側は refresh_token を持たず自分では更新しない
 *     (native-bridge が使えない値を入れる) ので、ネイティブが新しい bridge で WebView を読み込み直す。
 *     同じ refresh_token を Web とネイティブが別々にローテーションして、再利用検知でセッションごと失効する
 *     「ランダムな強制ログアウト」を防ぐため、更新の持ち主をネイティブだけにしている (F7-05)。
 *     読み込み直す前に、ネイティブ自身のセッションが生きているかをサーバーに確かめる。失効していれば
 *     (Web のログアウトで全端末のセッションが失効した後など) 読み込み直さず、ログアウトを揃える。
 *
 * メッセージは「自分のアプリの Web オリジンのページから」届いたものだけを処理する
 * (window.ReactNativeWebView はどのオリジンのページにも存在し、外部ページからも送れてしまうため)。
 */

import { useCallback, useRef } from "react";
import { useLocalSearchParams, useNavigation, useRouter } from "expo-router";

import { classifyAuthError } from "./authErrors";
import { signOutWithCleanup } from "./signOut";
import { supabase } from "./supabase";
import { getWebBaseUrl } from "./webBaseUrl";

export type WebAuthMessage = { type: "sign-out" } | { type: "session-expired" };

export type WebAuthResult =
  /** メッセージの形式が違う、または自分の Web オリジンから届いたものではない */
  | "ignored"
  /** ログアウトした (ウェルカム画面へ戻した) */
  | "signed-out"
  /** WebView を読み込み直させた */
  | "rebridged"
  /** 読み込み直しの回数制限に達しているので、何もしなかった */
  | "rate-limited"
  /** ネイティブ側も未ログインなので、何もしなかった */
  | "no-session";

export function parseWebAuthMessage(data: unknown): WebAuthMessage | null {
  if (!data || typeof data !== "object") return null;
  const type = (data as { type?: unknown }).type;
  return type === "sign-out" || type === "session-expired" ? { type } : null;
}

/**
 * メッセージの送り元ページ (event.nativeEvent.url) が、自分の Web と同じオリジンか。
 * スキーム・ホスト (ポート込み) が一致し、認証情報 (user:pass@) を含まないものだけを認める。
 * 前方一致ではなく URL を解釈して比べる (https://homegohan-app.vercel.app.evil.example のようなものを通さない)。
 * 自分の Web のオリジンは、WebViewScreen が開く URL・download の送信元確認と同じ getWebBaseUrl() (webBaseUrl.ts) から決める
 * (既定値を 2 か所に持たない)。
 */
export function isFromWebOrigin(senderUrl: unknown, webUrl: string = getWebBaseUrl()): boolean {
  if (typeof senderUrl !== "string" || senderUrl === "") return false;
  try {
    const sender = new URL(senderUrl);
    const own = new URL(webUrl);
    return (
      sender.protocol.toLowerCase() === own.protocol.toLowerCase() &&
      sender.host.toLowerCase() === own.host.toLowerCase() &&
      sender.username === "" &&
      sender.password === ""
    );
  } catch {
    return false;
  }
}

// ── 再ブリッジの回数制限 ─────────────────────────────────────────────────────

export type RebridgeLimiter = { tryAcquire: (now?: number) => boolean };

export type RebridgeLimiterOptions = {
  /** 続けて読み込み直す最小の間隔 (ミリ秒) */
  minIntervalMs: number;
  /** 回数を数える期間 (ミリ秒) */
  windowMs: number;
  /** 期間内に読み込み直してよい最大回数 */
  maxInWindow: number;
};

const DEFAULT_LIMITER_OPTIONS: RebridgeLimiterOptions = {
  minIntervalMs: 10_000,
  windowMs: 5 * 60_000,
  maxInWindow: 3,
};

/**
 * 再ブリッジ (WebView の読み込み直し) の回数制限。
 * ブリッジがうまくいかない状況 (オフラインなど) で、ログイン画面 → session-expired → 読み込み直し → ログイン画面…
 * を延々と繰り返さないための歯止め。通常の運用では、1 つのタブで 1 時間に 1 回ほど。
 * タブごとに 1 つ持つ (全タブで共有すると、同時に切れた 5 つのタブのうち 1 つしか復帰できない)。
 */
export function createRebridgeLimiter(options: Partial<RebridgeLimiterOptions> = {}): RebridgeLimiter {
  const { minIntervalMs, windowMs, maxInWindow } = { ...DEFAULT_LIMITER_OPTIONS, ...options };
  const history: number[] = [];
  return {
    tryAcquire(now: number = Date.now()) {
      while (history.length > 0 && now - history[0] >= windowMs) history.shift();
      const last = history[history.length - 1];
      if (last !== undefined && now - last < minIntervalMs) return false;
      if (history.length >= maxInWindow) return false;
      history.push(now);
      return true;
    },
  };
}

// ── 再ブリッジの合図 ─────────────────────────────────────────────────────────

/** WebView を読み込み直させるために、初期パスに付ける使い捨ての値のクエリ名 */
const REBRIDGE_NONCE_KEY = "_rb";

/**
 * WebViewScreen は initialPath (ルートのパラメータ) が変わると bridge をやり直して読み込み直す。
 * 同じパスのまま読み込み直させるため、使い捨ての値 (_rb) を付けた (または付け替えた) パスを返す。
 * Web 側はこのクエリを使わない。
 */
export function withRebridgeNonce(path: string, nonce: number | string = Date.now()): string {
  const hashIndex = path.indexOf("#");
  const hash = hashIndex >= 0 ? path.slice(hashIndex) : "";
  const withoutHash = hashIndex >= 0 ? path.slice(0, hashIndex) : path;
  const queryIndex = withoutHash.indexOf("?");
  const pathname = queryIndex >= 0 ? withoutHash.slice(0, queryIndex) : withoutHash;
  const query = queryIndex >= 0 ? withoutHash.slice(queryIndex + 1) : "";
  const params = query
    .split("&")
    .filter((part) => part !== "" && part !== REBRIDGE_NONCE_KEY && !part.startsWith(`${REBRIDGE_NONCE_KEY}=`));
  params.push(`${REBRIDGE_NONCE_KEY}=${nonce}`);
  return `${pathname}?${params.join("&")}${hash}`;
}

// ── 処理 ─────────────────────────────────────────────────────────────────────

export type WebAuthHandlerDeps = {
  /** WebView を新しい bridge で読み込み直す */
  rebridge: () => void;
  /** ログアウト後にウェルカム画面へ戻る */
  goToWelcome: () => void;
  limiter: RebridgeLimiter;
};

/** ログアウト処理中か。5 つのタブの WebView が同時に sign-out / session-expired を送ってくるので、1 回だけ行う */
let signOutInFlight = false;

async function performNativeSignOut(deps: WebAuthHandlerDeps): Promise<WebAuthResult> {
  if (signOutInFlight) return "ignored";
  signOutInFlight = true;
  try {
    let userId: string | null = null;
    try {
      const { data } = await supabase.auth.getSession();
      userId = data.session?.user?.id ?? null;
    } catch {
      userId = null;
    }
    try {
      // push token の削除 → 端末データの削除 → サインアウト。失敗してもログアウトは続ける
      await signOutWithCleanup(userId);
    } catch {
      // ignore
    }
    deps.goToWelcome();
    return "signed-out";
  } finally {
    signOutInFlight = false;
  }
}

async function handleSessionExpired(deps: WebAuthHandlerDeps): Promise<WebAuthResult> {
  if (signOutInFlight) return "ignored";

  // ネイティブも未ログインなら、読み込み直しても意味がない (ログアウト処理の直後に届いた通知など)
  let hasSession = false;
  try {
    const { data } = await supabase.auth.getSession();
    hasSession = !!data.session;
  } catch {
    hasSession = false;
  }
  if (!hasSession) return "no-session";

  // ネイティブ自身のセッションをサーバーで確かめる。失効していれば (Web のログアウトで全端末のセッションが失効した後など)、
  // 読み込み直しても Web は復帰できないので、ログアウトを揃える。通信失敗など失効と断定できないときは、読み込み直しを試みる。
  try {
    const { error } = await supabase.auth.getUser();
    if (error && classifyAuthError(error) === "invalid") {
      return performNativeSignOut(deps);
    }
  } catch {
    // 通信エラー等
  }

  if (!deps.limiter.tryAcquire()) return "rate-limited";
  deps.rebridge();
  return "rebridged";
}

/**
 * Web から届いたメッセージを処理する。例外は投げない。
 * @param data       JSON.parse 済みのメッセージ本体
 * @param senderUrl  送り元ページの URL (event.nativeEvent.url)
 */
export async function handleWebAuthMessage(
  data: unknown,
  senderUrl: unknown,
  deps: WebAuthHandlerDeps,
): Promise<WebAuthResult> {
  const message = parseWebAuthMessage(data);
  if (!message) return "ignored";
  if (!isFromWebOrigin(senderUrl)) return "ignored";

  try {
    return message.type === "sign-out" ? await performNativeSignOut(deps) : await handleSessionExpired(deps);
  } catch {
    return "ignored";
  }
}

/**
 * WebViewScreen から使う。onMessage に届いたメッセージを渡すと、sign-out / session-expired を処理する。
 *
 * @param path この WebView のタブの既定のパス ('/home' など)。再ブリッジで開き直すパスの基準になる
 * @returns (data, senderUrl) => void。sign-out / session-expired 以外のメッセージは何もしない
 */
export function useWebAuthMessages(path: string): (data: unknown, senderUrl: unknown) => void {
  const navigation = useNavigation();
  const router = useRouter();
  const params = useLocalSearchParams<{ initialPath?: string }>();

  const limiterRef = useRef<RebridgeLimiter | null>(null);
  if (limiterRef.current === null) limiterRef.current = createRebridgeLimiter();

  // 再ブリッジで開き直すパス。deep link や tab-navigate で指定された initialPath があればそれ、無ければタブの既定のパス。
  // initialPath が単一の "/" で始まる絶対パスでない (壊れた値) ときは使わない
  const initialPath = typeof params.initialPath === "string" ? params.initialPath : undefined;
  const basePath = initialPath && /^\/(?![/\\])/.test(initialPath) ? initialPath : path;

  // 最新の値を ref で持ち、返す関数の identity を変えない
  const basePathRef = useRef(basePath);
  basePathRef.current = basePath;
  const navigationRef = useRef(navigation);
  navigationRef.current = navigation;
  const routerRef = useRef(router);
  routerRef.current = router;

  return useCallback((data: unknown, senderUrl: unknown) => {
    void handleWebAuthMessage(data, senderUrl, {
      limiter: limiterRef.current as RebridgeLimiter,
      rebridge: () => {
        const nav = navigationRef.current as unknown as { setParams?: (params: Record<string, string>) => void };
        nav.setParams?.({ initialPath: withRebridgeNonce(basePathRef.current) });
      },
      goToWelcome: () => {
        routerRef.current.replace("/");
      },
    });
  }, []);
}
