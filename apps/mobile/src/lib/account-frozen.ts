/**
 * アカウントの凍結 (BAN) (#1861): アプリ側の共通の部品 (純粋な関数と定数だけ。RN の API は使わない)。
 *
 * サーバー (lib/supabase/middleware.ts の /api の分岐) は、凍結中の利用者の /api を、凍結中も呼べる API
 * (src/lib/auth/frozen.ts の FROZEN_ALLOWED_API_PATHS = 退会・書き出し・有料プランの解約の 5 本と、それとは別に判定する
 * 通知のトークンの claim (src/lib/push-tokens.ts の isPushTokenClaimApiPath)・ネイティブ認証ブリッジのコード
 * (src/lib/auth/frozen.ts の isNativeBridgeCodeApiPath)) を除いて 403 AUTH_ACCOUNT_FROZEN で止める。本文と状態は packages/shared の account-frozen.ts。
 * このファイルは、
 *   - その 403 を見分け、固定の文の例外 (AccountFrozenError) に置き換える。getApi() (src/lib/api.ts の withFriendlyErrors) と
 *     生の fetch (src/lib/failed-response.ts の errorOfFailedResponse) の両方がここを通る
 *   - 止められたこと (frozen) を AccountFrozenProvider に知らせる (notify / subscribe)。Provider は状態を frozen にし、
 *     ルートのゲート (AccountFrozenGate) がルートの Stack を凍結の画面 1 つに畳む
 *   - 凍結の画面の route のパスと名前 (app/frozen.tsx = Web の /frozen を WebViewScreen で開く画面)
 *   - ゲートの対象外のパス (認証の途中・公開ページ。Web の凍結の差し戻しの対象外 (/auth/*・/terms・/privacy・/contact) と同じ考え)
 *   - 凍結の状態の型と、利用者ごとの記録から状態を決める純粋な関数 (AccountFrozenProvider が使う)
 *   - 凍結の判定に使う API (FROZEN_PROBE_API_PATH)
 * を持つ。
 *
 * 凍結中でも退会・データの書き出しを許すのは、#1445 のオーナーの選択 (2026-10-12)。アプリでは、凍結の画面 (Web の /frozen) から
 * 退会・書き出しの画面 (/frozen/account)・有料プランの解約の画面 (/frozen/billing)・お問い合わせ (/contact) へ進む (どれも Web の画面のまま。2 か所に持たない)。
 */
import {
  ACCOUNT_FROZEN_MESSAGE,
  ACCOUNT_FROZEN_STATUS,
  LEGAL_CONSENT_STATUS_API_PATH,
  isAccountFrozenBody,
} from "@homegohan/shared";

/**
 * アプリの凍結の画面 (Web の /frozen を WebView で開く route。app/frozen.tsx) のパス。
 * Web の凍結の画面 (src/app/frozen/page.tsx) と同じ値 (tests/mobile-account-frozen-contract.test.ts が固定する)
 */
export const FROZEN_SCREEN_PATH = "/frozen";

/**
 * 凍結の画面の route の名前 (ルートの Stack の中の名前。app/frozen.tsx のファイル名で、app/_layout.tsx の
 * <Stack.Screen name="frozen" /> と同じ値)。AccountFrozenGate が、前面が凍結の画面かを見るのと、
 * ルートの Stack を凍結の画面 1 つに畳む (navigationRef.dispatch。完全な state の RESET) のに使う
 */
export const FROZEN_SCREEN_ROUTE_NAME = "frozen";

/**
 * 凍結しているかを確かめる API。凍結中は middleware が 403 AUTH_ACCOUNT_FROZEN で止める (凍結中も呼べる API の一覧に無い) ので、
 * 応答が 2xx なら凍結していない。規約の同意の状況を返す既存の API で、本文は使わない (サインイン中の利用者なら誰でも 200。
 * 規約の同意ゲートの対象外なので、未同意でも 403 LEGAL_CONSENT_REQUIRED にならない)。
 * 凍結中も通す API (FROZEN_ALLOWED_API_PATHS・claim・ブリッジのコード) のどれにも入っていないこと (入ると判定が常に clear になり、
 * 凍結の画面へ移らなくなる) は tests/mobile-account-frozen-contract.test.ts が見張る
 */
export const FROZEN_PROBE_API_PATH = LEGAL_CONSENT_STATUS_API_PATH;

// "HTTP 403 Forbidden: {...}" / HTTP/2 で statusText が空の "HTTP 403 : {...}" / 生の fetch の "HTTP 403: {...}"
// (src/lib/legal-consent.ts・src/lib/service-unavailable.ts と同じ形)
const HTTP_ERROR_PATTERN = /^HTTP (\d{3})[^:]*:\s*([\s\S]+)$/;

/** サーバーに「アカウントが凍結されています」で止められたことを表す例外。message は画面にそのまま出せる固定の文 (Web の凍結の画面の見出しと同じ) */
export class AccountFrozenError extends Error {
  constructor() {
    super(ACCOUNT_FROZEN_MESSAGE);
    this.name = "AccountFrozenError";
  }
}

export function isAccountFrozenError(error: unknown): error is AccountFrozenError {
  return error instanceof AccountFrozenError;
}

type AccountFrozenListener = () => void;
const listeners = new Set<AccountFrozenListener>();

/** Provider が購読する。戻り値で解除する */
export function subscribeAccountFrozen(listener: AccountFrozenListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 「アカウントが凍結されています」で止められたことを知らせる。購読者が居なければ何もしない */
export function notifyAccountFrozen(): void {
  for (const listener of listeners) listener();
}

/** テスト用: 購読を全部外す */
export function resetAccountFrozenListenersForTests(): void {
  listeners.clear();
}

/**
 * API クライアントが投げた Error が 403 AUTH_ACCOUNT_FROZEN なら、Provider に知らせて AccountFrozenError を返す。
 * それ以外 (ほかの 403 (規約の同意・AI 同意を含む)・JSON でない本文・通信の失敗) は null。例外は投げない
 */
export function accountFrozenErrorOf(error: unknown): AccountFrozenError | null {
  if (isAccountFrozenError(error)) return error;
  const message = (error as { message?: unknown } | null | undefined)?.message;
  if (typeof message !== "string") return null;
  const match = HTTP_ERROR_PATTERN.exec(message);
  if (!match || Number(match[1]) !== ACCOUNT_FROZEN_STATUS) return null;
  try {
    if (!isAccountFrozenBody(JSON.parse(match[2]))) return null;
  } catch {
    return null;
  }
  notifyAccountFrozen();
  return new AccountFrozenError();
}

/**
 * ゲートの対象外のパス (apps/mobile/app の (auth) と (public) の画面と、凍結の画面そのもの)。そのものか `${path}/` 以下。
 * Web の凍結の差し戻しの対象外 (認証の途中 /auth/*・規約 /terms・/privacy・お問い合わせ /contact・/frozen) と同じ考えで、
 * 認証の途中と公開ページは止めない。規約の同意画面 (/legal-consent) は入れない (凍結が先。Web の middleware の順と同じ)。
 * 一覧が画面のファイルと一致することは __tests__/lib/account-frozen.test.ts が確かめる
 */
export const MOBILE_FROZEN_EXEMPT_PATHS: readonly string[] = [
  "/login",
  "/signup",
  "/auth",
  "/about",
  "/privacy",
  "/terms",
  FROZEN_SCREEN_PATH,
];

export function isMobileFrozenExemptPath(pathname: string): boolean {
  return MOBILE_FROZEN_EXEMPT_PATHS.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

/**
 * 凍結の状態 (#1861)。
 *   loading  サインイン中で、今の利用者を確かめ終えていない (入口・タブ・初期設定は中身を描かずに待つ)
 *   clear    凍結していない (判定の API が 2xx を返した)、または未ログイン
 *   frozen   凍結中 (判定の API か、ほかの /api が 403 AUTH_ACCOUNT_FROZEN を返した)。ゲートが凍結の画面だけにする
 *   unknown  確かめられなかった (通信の失敗・サーバーの 500)。止めない (サーバーの fail-open と同じ)。次の API 呼び出しの 403 で frozen になる
 */
export type AccountFrozenState = "loading" | "clear" | "frozen" | "unknown";

/** 利用者ごとの記録 (AccountFrozenProvider の state)。loading は「今の利用者の記録が無い」ことで表すので、記録には持たない */
export type AccountFrozenEntry = {
  userId: string;
  state: Exclude<AccountFrozenState, "loading">;
};

/**
 * 今の利用者 (userId) と記録から、描画のその場で状態を決める。記録が別の利用者のもの・まだ無いなら loading
 * (ログインの直後や利用者の切り替えの直後の描画で、effect を待たずに loading にする。clear の描画を 1 回も挟まない)
 */
export function accountFrozenStateOf(userId: string | null, entry: AccountFrozenEntry | null): AccountFrozenState {
  if (userId === null) return "clear";
  if (entry === null || entry.userId !== userId) return "loading";
  return entry.state;
}

/**
 * 判定の API の結果から記録を作る。
 *   ok      2xx → clear (凍結が解けた後の取り直しでも、ここで clear に戻る)
 *   frozen  403 AUTH_ACCOUNT_FROZEN → frozen
 *   failed  それ以外の失敗 → 今の利用者の記録があれば保ち (frozen を保つ)、無ければ (loading だった) unknown
 * 今の利用者の記録が同じ状態なら、その記録をそのまま返す (知らせが続けて届いても、描画を増やさない)
 */
export function accountFrozenEntryAfterProbe(
  prev: AccountFrozenEntry | null,
  userId: string,
  result: "ok" | "frozen" | "failed",
): AccountFrozenEntry {
  const current = prev !== null && prev.userId === userId ? prev : null;
  if (result === "failed") return current ?? { userId, state: "unknown" };
  const state = result === "ok" ? "clear" : "frozen";
  return current !== null && current.state === state ? current : { userId, state };
}

/**
 * 通知のタップなどで自分から画面を移す部品 (NotificationRouter) が待つ間か。状態が分かるまで・凍結中・前面が凍結の画面の間
 * (凍結が解けた直後で、ゲートの router.replace('/') がまだ流れていない) は待つ。
 * 凍結の画面の上に push を重ねると、ゲートがすぐ畳み直すため
 */
export function isNavigationHeldForAccountFrozen(state: AccountFrozenState, pathname: string): boolean {
  return state === "loading" || state === "frozen" || pathname === FROZEN_SCREEN_PATH;
}
