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
 *   - 同意画面の route の扱い (同意を待つ / ログアウトの後の案内 / それ以外) と、取り除く操作を止めるか (usePreventRemove)
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
 * ルートの Stack を同意画面 1 つに畳む (navigationRef.dispatch。完全な state の RESET) のに使う
 */
export const LEGAL_CONSENT_SCREEN_ROUTE_NAME = "legal-consent";

/**
 * navigationRef.getCurrentRoute() が返す route から名前を読む (前面の route の名前。route が無ければ undefined)。
 * expo-router 58 の navigationRef は型付きの route の名前の一覧が空で、getCurrentRoute() の戻り値の型が never になり、
 * その場で ?.name と書くと型エラーになる。引数を名前だけの構造の型にして受ける (LegalConsentGate・AccountFrozenGate が使う)
 */
export function routeNameOf(route: { readonly name: string } | undefined): string | undefined {
  return route?.name;
}

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
 * navigationRef.dispatch に渡す action の type (expo-router 58 の CommonActions.reset が作る action と同じ値)。
 * LegalConsentGate がルートの Stack を同意画面 1 つに畳む (畳み直す) 操作の action の type に使う
 */
const RESET_ACTION_TYPE = "RESET";

/** 畳んだ state の前面の route の位置。route は 1 つだけなので、その位置 (先頭) */
const COLLAPSED_STACK_INDEX = 0;

/**
 * 同意画面の route (app/legal-consent.tsx) の今の扱い。
 *   awaiting-consent   サインイン中で同意が要る (required)。取り除く操作を全部止める (ゲートの畳み直しは同意画面の route を key ごと再利用するので、取り除かれない)
 *   signed-out-notice  同意を待っていた間にログアウトした (Web の「同意しない」「登録をやめる」・同意の前の退会 (Web の /legal-consent/account。#1901) の後)。
 *                      Web の案内 (退会と書き出しの画面へのログイン・請求の画面・「登録をやめました」・「退会しました」) を出したまま残し、「閉じる」で入口へ移る。取り除く操作は全部止める
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

/**
 * 同意画面の route を取り除く操作を止めるか (expo-router の usePreventRemove の第 1 引数)。
 *   awaiting-consent   同意が要る間は全部止める (ログインの直後の routeAfterSignIn の REPLACE など)。
 *                      同意のゲートの畳み直し (RESET) は同意画面の route を key ごと再利用するので、同意画面は取り除かれず、ここには来ない
 *   signed-out-notice  ログアウトの後の案内。全部止める (「閉じる」でだけ閉じる)
 *   free               何も止めない
 * closing = 同意画面が自分で閉じる途中 (「閉じる」・未ログインで開かれたとき・afterSignOut)。止めない
 * accountFrozen = アカウントが凍結中 (useAccountFrozen の state が frozen。#1861)。止めない (凍結が先)。
 *   凍結のゲートの畳み直し (RESET。ルートの Stack を凍結の画面 1 つに) は同意画面の route を取り除く。expo-router 58 は、取り除かれる route の
 *   1 つでも止めていれば RESET ごと捨てるので、止めたままだと凍結中の利用者が同意画面に残る
 */
export function legalConsentScreenPreventsRemoval(
  mode: LegalConsentScreenMode,
  closing: boolean,
  accountFrozen: boolean,
): boolean {
  if (closing || accountFrozen) return false;
  return mode !== "free";
}

/**
 * ナビゲーターの state のうち、畳むのに読む欄 (expo-router 58 の NavigationState / PartialState の部分型。
 * 入れ子の navigator の state は routes[].state。rehydrate 前の state は stale: true で key・routeKeySeq を持たないことがある)
 */
export type NavigatorStateLike = {
  readonly key?: string;
  readonly index?: number;
  readonly type?: string;
  readonly routeNames?: readonly string[];
  readonly routeKeySeq?: number;
  readonly stale?: boolean;
  readonly routes: ReadonlyArray<{ readonly key?: string; readonly name: string; readonly state?: NavigatorStateLike }>;
};

/** 畳む先の route の持ち主の navigator の state (完全な state を作るのに要る key・routeNames・routeKeySeq がそろったもの) */
export type StackOwnerState = NavigatorStateLike & {
  readonly key: string;
  readonly routeNames: readonly string[];
  readonly routeKeySeq: number;
};

/**
 * expo-router 58 の RESET が受け付ける完全な state の共通の欄。
 * BaseRouter は stale === false のときだけ受け付け、routeNames が持ち主と同じ集合であることを確かめる
 * (それ以外は「Include key, index, routeNames, routeKeySeq, and stale: false」の警告を出して捨てる)
 */
type CollapsedStackBase = {
  readonly key: string;
  readonly index: typeof COLLAPSED_STACK_INDEX;
  readonly routeKeySeq: number;
  readonly routeNames: string[];
  readonly type?: string;
  readonly stale: false;
};

/**
 * route 1 つ (同意画面) に畳んだ完全な state。その route が既にあれば key ごと、無ければ名前だけ
 * (key の無い route には、expo-router の RESET が持ち主の key と routeKeySeq から key を付ける)
 */
export type CollapsedStackState =
  | (CollapsedStackBase & { readonly routes: [{ readonly name: string; readonly key: string }] })
  | (CollapsedStackBase & { readonly routes: [{ readonly name: string }] });

/**
 * navigationRef.dispatch に渡す RESET の action (ゲートが使う)。target は持ち主の navigator の key
 * (expo-router 58 は target の navigator だけに action を渡す。target が無いと前面の navigator から親へ順に試す)
 */
export type CollapseStackAction = {
  readonly type: typeof RESET_ACTION_TYPE;
  readonly target: string;
  readonly payload: CollapsedStackState;
};

/**
 * routeNames に routeName を持つ (= その route の持ち主の) navigator の state を、ルートから前面の枝を降りて探す。
 * 持ち主が無い・rehydrate 前 (stale・key や routeKeySeq が無い)・root が無い (コンテナの準備の前) なら null
 * (ゲートは何もせず次の描画で試す)
 */
export function findNavigatorOwningRoute(root: NavigatorStateLike | undefined, routeName: string): StackOwnerState | null {
  let current: NavigatorStateLike | undefined = root;
  while (current !== undefined) {
    if (current.routeNames?.includes(routeName)) {
      const { key, routeNames, routeKeySeq } = current;
      if (current.stale === true || key === undefined || routeNames === undefined || routeKeySeq === undefined) return null;
      return { ...current, key, routeNames, routeKeySeq };
    }
    const focusedIndex: number = current.index ?? 0;
    current = current.routes[focusedIndex]?.state;
  }
  return null;
}

/**
 * 持ち主の navigator の state を、routeName の route 1 つに畳んだ完全な state にする。
 * その route が既にあればその key を再利用する (同じ key は同じ画面。取り除かれず、同意画面なら usePreventRemove の止めにも当たらない)
 */
export function collapsedStackState(owner: StackOwnerState, routeName: string): CollapsedStackState {
  const existingKey = owner.routes.find((route) => route.name === routeName)?.key;
  const base: CollapsedStackBase = {
    key: owner.key,
    index: COLLAPSED_STACK_INDEX,
    routeKeySeq: owner.routeKeySeq,
    routeNames: [...owner.routeNames],
    stale: false,
    ...(owner.type === undefined ? {} : { type: owner.type }),
  };
  return existingKey === undefined
    ? { ...base, routes: [{ name: routeName }] }
    : { ...base, routes: [{ name: routeName, key: existingKey }] };
}

/** 持ち主の navigator に宛てた、routeName の route 1 つに畳む RESET の action */
export function collapseStackAction(owner: StackOwnerState, routeName: string): CollapseStackAction {
  return { type: RESET_ACTION_TYPE, target: owner.key, payload: collapsedStackState(owner, routeName) };
}

/**
 * 同意の後に自分から画面を移す部品 (NotificationRouter) が待つ間か。状態が分かるまで・同意が要る間に加えて、
 * 前面が同意画面の間 (同意の直後で、ゲートの router.replace('/') がまだ流れていない・ログアウトの後の案内を出している) も待つ。
 * 同じ描画で replace と push が積まれると、expo-router の routingQueue が積んだ順に流し、行き先が狂うため
 */
export function isNavigationHeldForLegalConsent(state: LegalConsentState, pathname: string): boolean {
  return state === "loading" || state === "required" || pathname === LEGAL_CONSENT_SCREEN_PATH;
}
