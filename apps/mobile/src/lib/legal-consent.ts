/**
 * 利用規約・プライバシーポリシーの同意 (#1442): アプリ側の共通の部品 (純粋な関数と定数だけ。RN の API は使わない)。
 *
 *   - サーバーに「同意が必要です」(403 LEGAL_CONSENT_REQUIRED。lib/supabase/middleware.ts の /api の分岐) で止められたことを見分け、
 *     固定の文の例外 (LegalConsentRequiredError) に置き換える。getApi() (src/lib/api.ts の withFriendlyErrors) と
 *     生の fetch (src/lib/failed-response.ts の errorOfFailedResponse) の両方がここを通る
 *   - 止められたこと (required) と、Web の同意画面で同意が記録できたこと (accepted) を LegalConsentProvider に知らせる (notify / subscribe)。
 *     Provider は state を動かし、ルートのゲート (LegalConsentGate) がルートの Stack を同意画面 1 つに畳む・同意画面から入口へ移す
 *   - 同意画面の route のパスと名前 (app/legal-consent.tsx = Web の /legal-consent を WebViewScreen で開く画面)・入口のパスと、
 *     Web の同意画面がネイティブへ送るメッセージの type
 *   - ゲートの対象外のパス (認証の途中・公開ページ・同意画面そのもの。Web の isLegalConsentExemptPath と同じ基準)
 *   - 同意の状態の型と、利用者ごとの記録から状態を決める純粋な関数 (LegalConsentProvider が使う)
 *   - 同意画面の route の扱い (同意を待つ / ログアウトの後の案内 / それ以外) と、取り除く操作 (beforeRemove) を通すか止めるか
 *   - 同意の後に自分から画面を移す部品 (NotificationRouter) が待つ条件
 *
 * AI 同意 (src/lib/ai-consent.ts) と違い、各画面に呼び出しを足さない。止められたらゲートが同意画面だけにするので、
 * 画面は自分のエラー表示をそのままにしてよい (出るのは固定の文だけ)。
 */
import {
  LEGAL_CONSENT_REQUIRED_MESSAGE,
  LEGAL_CONSENT_REQUIRED_STATUS,
  isLegalConsentRequiredBody,
  type LegalConsentStatus,
} from "@homegohan/shared";

/**
 * アプリの同意画面 (Web の /legal-consent を WebView で開く route。app/legal-consent.tsx) のパス。
 * Web の同意画面のパス LEGAL_CONSENT_PATH (lib/onboarding-routing.ts) と同じ値 (tests/legal-consent-mobile-contract.test.ts が固定する)
 */
export const LEGAL_CONSENT_SCREEN_PATH = "/legal-consent";

/**
 * 同意画面の route の名前 (ルートの Stack の中の名前。app/legal-consent.tsx のファイル名で、app/_layout.tsx の
 * <Stack.Screen name="legal-consent" /> と同じ値。__tests__/app/root-layout-config.test.tsx が固定する)。
 * LegalConsentGate が、今のナビゲーションの state の前面 (navigationRef.getCurrentRoute()) が同意画面かを見るのと、
 * ルートの Stack を同意画面 1 つに畳む (navigationRef.reset) のに使う
 */
export const LEGAL_CONSENT_SCREEN_ROUTE_NAME = "legal-consent";

/**
 * Web の同意画面 (src/app/legal-consent/LegalConsentForm.tsx) が、同意を記録できた直後にネイティブへ送るメッセージの type
 * (src/lib/native-auth-bridge.ts の notifyNativeLegalConsentAccepted と同じ値。同じテストが固定する)
 */
export const LEGAL_CONSENT_ACCEPTED_MESSAGE_TYPE = "legal-consent-accepted";

/**
 * 入口 (app/index.tsx) のパス。未ログインならウェルカム、サインイン中なら初期設定かホームへ Redirect する。
 * 同意の後とログアウトの後の案内を閉じたときに、ゲートと同意画面が移る先。
 * 通知の行き先へ移るのを、入口の Redirect が流れるまで待つ (NotificationRouter) のにも使う
 */
export const ENTRY_SCREEN_PATH = "/";

// "HTTP 403 Forbidden: {...}" / HTTP/2 で statusText が空の "HTTP 403 : {...}" / 生の fetch の "HTTP 403: {...}"
// (src/lib/ai-consent.ts・src/lib/api-error.ts と同じ形)
const HTTP_ERROR_PATTERN = /^HTTP (\d{3})[^:]*:\s*([\s\S]+)$/;

/** サーバーに「同意が必要です」で止められたことを表す例外。message は画面にそのまま出せる固定の文 */
export class LegalConsentRequiredError extends Error {
  constructor() {
    super(LEGAL_CONSENT_REQUIRED_MESSAGE);
    this.name = "LegalConsentRequiredError";
  }
}

export function isLegalConsentRequiredError(error: unknown): error is LegalConsentRequiredError {
  return error instanceof LegalConsentRequiredError;
}

/** Provider に知らせる事象。required = /api の 403 で止められた / accepted = Web の同意画面で同意が記録できた */
export type LegalConsentEvent = "required" | "accepted";

type LegalConsentListener = (event: LegalConsentEvent) => void;
const listeners = new Set<LegalConsentListener>();

/** Provider が購読する。戻り値で解除する */
export function subscribeLegalConsentEvents(listener: LegalConsentListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function emit(event: LegalConsentEvent): void {
  for (const listener of listeners) listener(event);
}

/** 「同意が必要です」で止められたことを知らせる。購読者が居なければ何もしない */
export function notifyLegalConsentRequired(): void {
  emit("required");
}

/** Web の同意画面で同意が記録できたことを知らせる */
export function notifyLegalConsentAccepted(): void {
  emit("accepted");
}

/** テスト用: 購読を全部外す */
export function resetLegalConsentListenersForTests(): void {
  listeners.clear();
}

/**
 * API クライアントが投げた Error が 403 LEGAL_CONSENT_REQUIRED なら、Provider に知らせて LegalConsentRequiredError を返す。
 * それ以外 (ほかの 403 (AI 同意を含む)・JSON でない本文・通信の失敗) は null。例外は投げない
 */
export function legalConsentRequiredErrorOf(error: unknown): LegalConsentRequiredError | null {
  if (isLegalConsentRequiredError(error)) return error;
  const message = (error as { message?: unknown } | null | undefined)?.message;
  if (typeof message !== "string") return null;
  const match = HTTP_ERROR_PATTERN.exec(message);
  if (!match || Number(match[1]) !== LEGAL_CONSENT_REQUIRED_STATUS) return null;
  try {
    if (!isLegalConsentRequiredBody(JSON.parse(match[2]))) return null;
  } catch {
    return null;
  }
  notifyLegalConsentRequired();
  return new LegalConsentRequiredError();
}

/** WebView の onMessage に届いた JSON が、同意が記録できたことの合図か (送り元の検査は WebViewScreen の onMessage の先頭で済んでいる) */
export function parseLegalConsentMessage(data: unknown): { type: typeof LEGAL_CONSENT_ACCEPTED_MESSAGE_TYPE } | null {
  if (!data || typeof data !== "object") return null;
  const type = (data as { type?: unknown }).type;
  return type === LEGAL_CONSENT_ACCEPTED_MESSAGE_TYPE ? { type } : null;
}

/**
 * ゲートの対象外のパス (apps/mobile/app の (auth) と (public) の画面と、同意画面そのもの)。そのものか `${path}/` 以下。
 * Web の isLegalConsentExemptPath (認証の途中 /auth/*・規約 /terms・/privacy・同意画面 /legal-consent) と同じ基準。
 * 一覧が画面のファイルと一致することは __tests__/lib/legal-consent.test.ts が確かめる
 */
export const MOBILE_LEGAL_CONSENT_EXEMPT_PATHS: readonly string[] = [
  "/login",
  "/signup",
  "/auth",
  "/about",
  "/privacy",
  "/terms",
  LEGAL_CONSENT_SCREEN_PATH,
];

export function isMobileLegalConsentExemptPath(pathname: string): boolean {
  return MOBILE_LEGAL_CONSENT_EXEMPT_PATHS.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

/**
 * 同意の状態 (#1442)。
 *   loading  サインイン中で、今の利用者の status をまだ取れていない (入口・タブ・初期設定は中身を描かずに待つ)
 *   clear    同意画面を出す必要が無い (同意済み、強制していない、または未ログイン)
 *   required 同意画面を出す (未同意・旧版・生年月日なし・保護者の同意のつながりの無い 18 歳未満で、強制中)
 *   unknown  status を取れなかった (通信の失敗・サーバーの 500)。止めない。次の API 呼び出しの 403 で required になる
 */
export type LegalConsentState = "loading" | "clear" | "required" | "unknown";

/** 利用者ごとの記録 (LegalConsentProvider の state)。loading は「今の利用者の記録が無い」ことで表すので、記録には持たない */
export type LegalConsentEntry = {
  userId: string;
  state: Exclude<LegalConsentState, "loading">;
  status: LegalConsentStatus | null;
};

/**
 * 今の利用者 (userId) と記録から、描画のその場で状態を決める。記録が別の利用者のもの・まだ無いなら loading
 * (ログインの直後や利用者の切り替えの直後の描画で、effect を待たずに loading にする。clear の描画を 1 回も挟まない)
 */
export function legalConsentStateOf(userId: string | null, entry: LegalConsentEntry | null): LegalConsentState {
  if (userId === null) return "clear";
  if (entry === null || entry.userId !== userId) return "loading";
  return entry.state;
}

/** status を取れなかった (通信の失敗・500・形が違う) ときの記録: 今の利用者の記録があれば保ち (required を保つ)、無ければ (loading だった) unknown */
export function legalConsentEntryAfterFailure(prev: LegalConsentEntry | null, userId: string): LegalConsentEntry {
  if (prev !== null && prev.userId === userId) return prev;
  return { userId, state: "unknown", status: null };
}

/** 合図 (required = /api の 403 / accepted = Web の同意画面で同意できた) を受けたときの記録。status は今の利用者のものだけ残す */
export function legalConsentEntryAfterEvent(
  prev: LegalConsentEntry | null,
  userId: string,
  event: LegalConsentEvent,
): LegalConsentEntry {
  return {
    userId,
    state: event === "required" ? "required" : "clear",
    status: prev !== null && prev.userId === userId ? prev.status : null,
  };
}

/**
 * navigationRef.reset() の action の type (@react-navigation の CommonActions.reset)。
 * LegalConsentGate がルートの Stack を同意画面 1 つに畳む (畳み直す) 操作で、同意を待つ同意画面はこれだけを通す
 */
const RESET_ACTION_TYPE = "RESET";

/**
 * 同意画面の route (app/legal-consent.tsx) の今の扱い。
 *   awaiting-consent   サインイン中で同意が要る (required)。ゲートの畳み直し (RESET) のほかの取り除く操作を止める
 *   signed-out-notice  同意を待っていた間にログアウトした (Web の「同意しない」「登録をやめる」の後)。Web の案内 (削除の依頼先・
 *                      請求の画面・「登録をやめました」) を出したまま残し、「閉じる」で入口へ移る。取り除く操作は全部止める
 *   free               それ以外 (同意が済んだ・required でない・未ログインのまま開いた)。何も止めない (ゲートか同意画面自身が入口へ移す)
 */
export type LegalConsentScreenMode = "awaiting-consent" | "signed-out-notice" | "free";

/**
 * 同意画面の route が、サインイン中に required を見たか (sawRequired)。描画のたびに前の値から次の値を作る。
 * サインイン中は required の間だけ立て (同意が済んだら外す)、ログアウトの後は前の値を保つ
 */
export function legalConsentScreenSawRequired(prev: boolean, signedIn: boolean, state: LegalConsentState): boolean {
  if (!signedIn) return prev;
  return state === "required";
}

export function legalConsentScreenModeOf(
  signedIn: boolean,
  state: LegalConsentState,
  sawRequired: boolean,
): LegalConsentScreenMode {
  if (signedIn) return state === "required" ? "awaiting-consent" : "free";
  return sawRequired ? "signed-out-notice" : "free";
}

/** 同意画面の route を取り除く操作 (beforeRemove) をどうするか。allow = 通す / block = 止める (preventDefault) */
export type LegalConsentScreenRemovalDecision = "allow" | "block";

/**
 * awaiting-consent: ゲートの畳み直し (RESET) だけを通す。ほかの操作 (GO_BACK・POP・POP_TO_TOP・REPLACE・NAVIGATE など。
 *   例: ログインの直後の routeAfterSignIn の router.replace) は止める (同意画面を前面に残す。止めた置き換えの行き先は、
 *   同意の後に入口が profile から決め直す)。
 * signed-out-notice: 全部止める (案内を残す。ゲートは session 無しでは畳まない)。
 *   同意画面が自分で入口へ移るとき (「閉じる」など) は、この判定の前に通す (app/legal-consent.tsx の closingRef)。
 * free: 何も止めない
 */
export function legalConsentScreenRemovalDecision(
  mode: LegalConsentScreenMode,
  actionType: string,
): LegalConsentScreenRemovalDecision {
  if (mode === "awaiting-consent") return actionType === RESET_ACTION_TYPE ? "allow" : "block";
  if (mode === "signed-out-notice") return "block";
  return "allow";
}

/**
 * 同意の後に自分から画面を移す部品 (NotificationRouter) が待つ間か。状態が分かるまで・同意が要る間に加えて、
 * 前面が同意画面の間 (同意の直後で、ゲートの router.replace('/') がまだ流れていない・ログアウトの後の案内を出している) も待つ。
 * 同じ描画で replace と push が積まれると、expo-router の routingQueue が積んだ順に流し、行き先が狂うため
 */
export function isNavigationHeldForLegalConsent(state: LegalConsentState, pathname: string): boolean {
  return state === "loading" || state === "required" || pathname === LEGAL_CONSENT_SCREEN_PATH;
}
