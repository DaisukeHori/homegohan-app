/**
 * Web (WebView) からのログアウト・セッション失効の通知を、ネイティブに反映する (#1038 F7-04 / F7-05)
 *
 * ログイン状態の持ち主はネイティブ。WebView の Web 側は、ネイティブが張った借り物の Cookie セッションで動く。
 * Web 側でセッションが終わったときは、Web が次のメッセージを送ってくる (Web 側は src/lib/native-auth-bridge.ts):
 *
 *   { type: 'sign-out' }
 *     利用者が Web 側 (設定・マイページ) でログアウトする。Web は supabase.auth.signOut() の「前」に送る
 *     (signOut() の途中の SIGNED_OUT が session-expired として先に届くのを避けるため。理由は native-auth-bridge.ts の notifyNativeSignOut)。
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
 *
 * ## ログアウトで push token を消すために、処理の最初にセッションを控える (#1038 F7-10)
 * 利用者が Web でログアウトすると、Web の signOut() は全端末のセッションをサーバーで失効させる。
 * 失効したあとにネイティブが auth-js (2.105) で getUser() を呼ぶと、サーバーは 403 session_not_found を返し、
 * auth-js はそれを AuthSessionMissingError にして、端末のセッションを消す (_removeSession)。
 * auth-js の処理はロックで直列になるので、そのあとに動く getSession() は null を返し、
 *   - ユーザー ID が分からず、push token の削除を諦める (skipped)
 *   - 削除の通信が anon キーで送られ、RLS で 0 行になる (エラーにならない)
 * のどちらかになって、この端末の user_push_tokens の行が残ってしまう。
 * そこで、メッセージを処理する最初に getSession() で { userId, accessToken } を控え (takeSessionSnapshot)、
 * 失効と分かったあとのログアウトでも、その値で push token を DELETE する。Authorization ヘッダーを明示した DELETE は、
 * セッションが失効済みでも、アクセストークンが期限内なら RLS を通る (PostgREST は JWT の署名と期限しか見ない)。
 * session-expired と sign-out が同時に動いても控えを失わないよう、処理中のメッセージ同士で同じ控えを使い回す。
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

/** 完了したログアウトの回数。確認の通信をしている間にログアウトが済んだかどうかを見分けるのに使う */
let completedSignOuts = 0;

// ── ログアウトに使うセッションの控え ─────────────────────────────────────────

/** ログアウトで push token を消すために控える、ネイティブのセッションの情報 */
type SessionSnapshot = { userId: string; accessToken: string | null };

/** 処理中のメッセージの数。0 になったら、控えは捨てる */
let messagesInFlight = 0;

/**
 * 処理中のメッセージが共有する、ネイティブのセッションの控え (null = ネイティブも未ログイン、または読めなかった)。
 * 最初に必要としたメッセージが getSession() で取り、同時に動く他のメッセージは同じ値を使い回す。
 * メッセージごとに getSession() を呼ぶと、先に動いている session-expired の getUser() が端末のセッションを消したあとで、
 * 後から来た sign-out の getSession() が null を受け取ってしまう (上の「ログアウトで push token を消すために…」を参照)。
 */
let sharedSnapshot: Promise<SessionSnapshot | null> | null = null;

async function readSessionSnapshot(): Promise<SessionSnapshot | null> {
  try {
    const { data } = await supabase.auth.getSession();
    const session = data.session;
    const userId = session?.user?.id;
    return userId ? { userId, accessToken: session?.access_token ?? null } : null;
  } catch {
    return null;
  }
}

function takeSessionSnapshot(): Promise<SessionSnapshot | null> {
  if (!sharedSnapshot) sharedSnapshot = readSessionSnapshot();
  return sharedSnapshot;
}

async function performNativeSignOut(deps: WebAuthHandlerDeps): Promise<WebAuthResult> {
  if (signOutInFlight) return "ignored";
  signOutInFlight = true;
  try {
    // 控えは、session-expired が getUser() の前に取ったものがあればそれ (getUser() が端末のセッションを消したあとでも使える)
    const snapshot = await takeSessionSnapshot();
    try {
      // push token の削除 → 端末データの削除 → サインアウト。失敗してもログアウトは続ける
      await signOutWithCleanup(snapshot?.userId ?? null, { accessToken: snapshot?.accessToken });
    } catch {
      // ignore
    }
    deps.goToWelcome();
    completedSignOuts += 1;
    return "signed-out";
  } finally {
    signOutInFlight = false;
    // 古いセッションの控えを、後から来るメッセージが使わないようにする
    sharedSnapshot = null;
  }
}

async function handleSessionExpired(deps: WebAuthHandlerDeps): Promise<WebAuthResult> {
  if (signOutInFlight) return "ignored";
  const signOutsAtStart = completedSignOuts;
  /** 待っている間に、ログアウトが始まった・済んだら、読み込み直しもログアウトもしない (ログアウトしたのに読み込み直させない) */
  const supersededBySignOut = () => signOutInFlight || completedSignOuts !== signOutsAtStart;

  // ネイティブも未ログインなら、読み込み直しても意味がない (ログアウト処理の直後に届いた通知など)。
  // この控えは getUser() の前に取る。getUser() が失効を見つけると端末のセッションを消すので、そのあとでは取れない
  const snapshot = await takeSessionSnapshot();
  if (!snapshot) return "no-session";
  if (supersededBySignOut()) return "ignored";

  // ネイティブ自身のセッションをサーバーで確かめる。失効していれば (Web のログアウトで全端末のセッションが失効した後など)、
  // 読み込み直しても Web は復帰できないので、ログアウトを揃える。通信失敗など失効と断定できないときは、読み込み直しを試みる。
  try {
    const { error } = await supabase.auth.getUser();
    if (supersededBySignOut()) return "ignored";
    if (error && classifyAuthError(error) === "invalid") {
      return performNativeSignOut(deps);
    }
  } catch {
    // 通信エラー等
  }
  if (supersededBySignOut()) return "ignored";

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

  // 同時に処理するメッセージ同士で、セッションの控えを使い回す (処理中のメッセージが無くなったら捨てる)
  messagesInFlight += 1;
  try {
    return message.type === "sign-out" ? await performNativeSignOut(deps) : await handleSessionExpired(deps);
  } catch {
    return "ignored";
  } finally {
    messagesInFlight -= 1;
    if (messagesInFlight === 0) sharedSnapshot = null;
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
