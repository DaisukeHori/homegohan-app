// src/lib/membership/operator-screen-messages.ts
// 運営のメンバーシップの画面 (/operator/membership 配下) の、読み込み・強制譲渡・強制解散の通信と失敗の文 (#2080 U5)。
//
// 以前の画面は、fetch の reject (オフライン・接続が切れたなど) を捕まえず、ブラウザの英字の例外の文 (Failed to fetch など) を
// 確認の枠にそのまま出していた。本文に message の無い失敗 (プロキシの 502 など) は「HTTP 502」と英字だけで出していた。
// また、強制譲渡・強制解散はサーバーが済ませてから応答が切れることもあるのに、画面は前の状態のままだった。
//
// ここでは:
//   - 画面に出してよい日本語の文を OperatorScreenError で投げる。確認の枠 (ForceActionConfirmModal) は、この例外の文だけを出し、
//     それ以外の例外 (ブラウザの英字の文など) は固定の日本語の文にする
//   - 書き込み (強制譲渡・強制解散) の通信が切れたら 'no-response' を返す。画面は対象を読み直し、済んでいれば一覧へ戻す。
//     済んでいなければ・読み直せなければ、その事実に合う文を出す (「できませんでした」とは言わない。済んでいたときにも事実と合うように)
//   - 本文に API の文が無い 502 / 503 / 504 (手前のプロキシ・ホスティングの応答。route の応答ではない) も 'no-response' と同じに扱う (#2086 V1)。
//     譲渡の route は RPC の commit のあとに監査と全メンバーへの通知メールを待つので、その間の時間切れでは譲渡は済んでいる。
//     失敗と見せて押し直させると、同じ人への譲渡がもう一度通り、監査と通知メールが二重になる
//   - 読み直しにも失敗して済んだか分からないときは、画面は確認の枠を閉じ、読み直せるまで同じ操作を押させない (#2086 V1)
//   - 強制譲渡で、譲渡先がすでに今の代表者 / オーナーの 409 (route が押し直しを止めた) は、済んでいたものとして 'already-done' を返す (#2086 V1)
//   - 401 (ログインが切れた) は、読み込みも書き込み (強制譲渡・強制解散) も、本文の文 (「認証が必要です」) ではなく
//     ほかの運営の画面と同じ「ログインし直してください」(UNAUTHENTICATED_SCREEN_MESSAGE) にする (読み込みは #2093 W6・書き込みは #2112 Z4)
//
// このファイルはブラウザからも読むので、サーバー専用のものを import しない。

import { UNAUTHENTICATED_SCREEN_MESSAGE, extractApiErrorCode, extractApiErrorMessage } from '@/lib/admin/api-error-message';
import {
  OPERATOR_FORCE_TRANSFER_ALREADY_DONE_STATUS,
  OPERATOR_FORCE_TRANSFER_ALREADY_OWNER_CODE,
  OPERATOR_FORCE_TRANSFER_ALREADY_REPRESENTATIVE_CODE,
} from '@/lib/membership/operator-force-transfer-result';

/** 画面にそのまま出してよい日本語の文を持つ例外 */
export class OperatorScreenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OperatorScreenError';
  }
}

/**
 * 読み込みが、読み込み直しても変わらない理由で断られた (401 ログインが切れた・403 権限が外れた) ことを表す例外 (#2101 X4)。
 * 文は画面にそのまま出してよい理由の文 (401 は「ログインし直してください」、403 は本文の API の文)。
 * 画面はこれを受けたら「再試行」を出さない (押しても必ず同じ理由で断られる)
 */
export class OperatorLoadUnavailableError extends OperatorScreenError {
  constructor(message: string) {
    super(message);
    this.name = 'OperatorLoadUnavailableError';
  }
}

/** 例外から画面に出す文を決める。OperatorScreenError の文だけを出し、それ以外 (ブラウザの英字の文など) は fallback */
export function displayableOperatorError(err: unknown, fallback: string): string {
  return err instanceof OperatorScreenError ? err.message : fallback;
}

/** 強制の操作の名前 */
export const OPERATOR_FORCE_ACTION_LABELS = {
  transfer: '強制譲渡',
  dissolve: '強制解散',
} as const;

export type OperatorForceAction = keyof typeof OPERATOR_FORCE_ACTION_LABELS;

/** 読み込みが失敗したときの文。status が null なら通信そのものの失敗 (fetch の reject・応答の本文が読めない) */
export function operatorLoadFailedMessage(subject: string, status: number | null): string {
  if (status === null) return `${subject}を読み込めませんでした（通信エラー）`;
  return `${subject}を読み込めませんでした (HTTP ${status})`;
}

/** 強制の操作が失敗の応答を返し、本文に文が無いときの文 (プロキシの 502 など) */
export function operatorForceActionHttpFailedMessage(action: OperatorForceAction, status: number): string {
  return `${OPERATOR_FORCE_ACTION_LABELS[action]}に失敗しました (HTTP ${status})`;
}

/** 強制の操作の確認の枠で、例外の文が出せないときの固定の文 */
export function operatorForceActionFailedFallback(action: OperatorForceAction): string {
  return `${OPERATOR_FORCE_ACTION_LABELS[action]}に失敗しました`;
}

/**
 * 強制の操作の応答を受け取れなかったときの文の頭。
 * status が null なら通信そのものの失敗 (fetch の reject)、数ならプロキシなどが返した本文に API の文の無い 502 / 503 / 504
 */
export function operatorForceActionNoResponseSummary(action: OperatorForceAction, status: number | null): string {
  if (status === null) return `${OPERATOR_FORCE_ACTION_LABELS[action]}の応答を受け取れませんでした（通信エラー）`;
  return `${OPERATOR_FORCE_ACTION_LABELS[action]}の応答を受け取れませんでした (HTTP ${status})`;
}

/** 強制譲渡: 候補を読み直したら、選んだメンバーがまだ譲渡先の候補にいた (代表者・オーナーになっていない) ときに続ける文 */
export const FORCE_TRANSFER_NOT_DONE_GUIDE =
  '候補を読み込み直したところ、選んだメンバーはまだ譲渡先の候補にいて、譲渡されていません。必要ならもう一度実行してください';

/** 強制譲渡: 候補の読み直しにも失敗したときに続ける文。画面は確認の枠を閉じ、「再試行」で候補を読み直せるまで譲渡を押させない (#2086 V1) */
export const FORCE_TRANSFER_RELOAD_FAILED_GUIDE =
  '候補も読み込めなかったため、譲渡が済んだか分かりません。「再試行」で候補を読み込み直して確かめるまで、もう一度は実行できません';

/**
 * 強制譲渡: 候補の読み直しが 401 / 403 で断られたときに続ける文 (#2101 X4)。このあとに理由の文 (「ログインし直してください」など) を続ける。
 * 画面は確認の枠を閉じ、候補と「強制譲渡を実行」を出さず、「再試行」も出さない (読み込み直しても変わらないため)
 */
export const FORCE_TRANSFER_RELOAD_UNAVAILABLE_GUIDE = '候補も読み込めなかったため、譲渡が済んだか分かりません';

/** 強制解散: 一覧を読み直したら、対象がまだ解散されずに一覧にあったときに続ける文 */
export const FORCE_DISSOLVE_NOT_DONE_GUIDE =
  '一覧を読み込み直したところ、まだ解散されていません。必要ならもう一度実行してください';

/** 強制解散: 一覧の読み直しにも失敗したときに続ける文。画面は確認の枠を閉じて一覧を出さず、「更新」で読み直せるまで解散を押させない (#2086 V1) */
export const FORCE_DISSOLVE_RELOAD_FAILED_GUIDE =
  '一覧も読み込めなかったため、解散が済んだか分かりません。「更新」で一覧を読み込み直して状態を確かめてから、必要ならもう一度操作してください';

/**
 * 強制解散: 一覧の読み直しが 401 / 403 で断られたときに続ける文 (#2101 X4)。このあとに理由の文を続ける
 * (「更新」で読み込み直すよう促さない。読み込み直しても変わらないため)
 */
export const FORCE_DISSOLVE_RELOAD_UNAVAILABLE_GUIDE = '一覧も読み込めなかったため、解散が済んだか分かりません';

/** 文の頭と、読み直しの結果に合わせた続きの文をつなぐ。status は operatorForceActionNoResponseSummary と同じ */
export function operatorForceActionNoResponseMessage(
  action: OperatorForceAction,
  status: number | null,
  guide: string,
): string {
  return `${operatorForceActionNoResponseSummary(action, status)}。${guide}`;
}

/**
 * 応答を受け取れなかったあとの読み直しが失敗したときの文 (#2101 X4)。
 * 読み直しの例外が OperatorLoadUnavailableError (401 / 403) なら unavailableGuide に理由の文を続け、retryable は false
 * (画面は「再試行」を出さない)。それ以外 (500・通信の失敗・壊れた応答) は reloadFailedGuide (「再試行」で確かめる文) で retryable は true
 */
export function operatorForceActionReloadFailure(
  action: OperatorForceAction,
  status: number | null,
  reloadError: unknown,
  guides: { readonly reloadFailedGuide: string; readonly unavailableGuide: string },
): { readonly message: string; readonly retryable: boolean } {
  if (reloadError instanceof OperatorLoadUnavailableError) {
    // 理由の文 (「ログインし直してください」・403 の本文の文) は OperatorScreenError の画面に出してよい文
    const reason = displayableOperatorError(reloadError, guides.reloadFailedGuide);
    return {
      message: operatorForceActionNoResponseMessage(action, status, `${guides.unavailableGuide}。${reason}`),
      retryable: false,
    };
  }
  return { message: operatorForceActionNoResponseMessage(action, status, guides.reloadFailedGuide), retryable: true };
}

/** 401 (ログインが切れた) の HTTP ステータス */
const HTTP_UNAUTHORIZED = 401;
/** 403 (権限が外れた・二段階認証の確認が要る) の HTTP ステータス */
const HTTP_FORBIDDEN = 403;

/**
 * 運営の API を GET で読み、JSON の本文を返す。
 * 通信の失敗・失敗の応答・JSON でない本文は、どれも画面に出せる日本語の文の OperatorScreenError を投げる
 * (失敗の応答の本文に API の文があればそれを、無ければ HTTP のステータスを添えた固定の文)。
 * 401 (ログインが切れた) は、本文の文 (「認証が必要です」) や「読み込めませんでした (HTTP 401)」ではなく、
 * ほかの運営の画面の読み直しと同じ「ログインし直してください」にする (UNAUTHENTICATED_SCREEN_MESSAGE。#2093 W6)。
 * 401 と 403 は、読み込み直しても変わらないので OperatorLoadUnavailableError (OperatorScreenError の子) で投げる (画面は「再試行」を出さない。#2101 X4)
 */
export async function fetchOperatorJson(url: string, subject: string): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url);
  } catch {
    throw new OperatorScreenError(operatorLoadFailedMessage(subject, null));
  }
  if (res.status === HTTP_UNAUTHORIZED) throw new OperatorLoadUnavailableError(UNAUTHENTICATED_SCREEN_MESSAGE);
  const body: unknown = await res.json().catch(() => null);
  if (res.status === HTTP_FORBIDDEN) {
    // 読み込み直しても変わらない (#2101 X4)。文は従来どおり本文の API の文 (無ければ「読み込めませんでした (HTTP 403)」)
    throw new OperatorLoadUnavailableError(extractApiErrorMessage(body) ?? operatorLoadFailedMessage(subject, res.status));
  }
  if (!res.ok) {
    throw new OperatorScreenError(extractApiErrorMessage(body) ?? operatorLoadFailedMessage(subject, res.status));
  }
  if (body === null) throw new OperatorScreenError(operatorLoadFailedMessage(subject, null));
  return body;
}

/**
 * 運営の API の一覧 ({ data: [...] }) を読む。data が配列でない応答は読み込めなかったものとして扱う
 * (壊れた応答を「0 件」と見せない)。失敗は fetchOperatorJson と同じく OperatorScreenError を投げる。
 */
export async function fetchOperatorRows<T>(url: string, subject: string): Promise<T[]> {
  const body = await fetchOperatorJson(url, subject);
  const data = typeof body === 'object' && body !== null ? (body as { data?: unknown }).data : undefined;
  if (!Array.isArray(data)) throw new OperatorScreenError(operatorLoadFailedMessage(subject, null));
  return data as T[];
}

/**
 * 強制譲渡の通信が切れたあと、読み直した譲渡先の候補から、譲渡が済んだかを決める (#2080 U5)。
 * 候補の API は、今の代表者 (家族。family_members.role = 'representative') ・オーナー (組織。user_profiles.org_role = 'owner') を
 * 候補から外す。選んだメンバーが候補にいなければ、譲渡が済んで代表者・オーナーになっている。
 * (同じ間に選んだメンバーが家族・組織を抜けたときも候補から外れる。そのときもこの画面から同じメンバーへ譲渡し直すことはできないので、
 * 一覧へ戻して一覧の今の状態を見せる)
 */
export function isForceTransferDone(candidates: readonly { id: string }[], selectedId: string): boolean {
  return !candidates.some((candidate) => candidate.id === selectedId);
}

/**
 * 本文に API の文が無いときに、応答を受け取れなかった (サーバーで済んだか分からない) ものとして扱う HTTP ステータス (#2086 V1)。
 * 502 Bad Gateway・503 Service Unavailable・504 Gateway Timeout は、route ではなく手前のプロキシ・ホスティング (関数の時間切れなど) が返す。
 * route がこれらを返すときは本文に API の文を入れるので、文がある応答はこれまでどおり失敗として出す
 */
export const OPERATOR_FORCE_ACTION_NO_RESPONSE_STATUSES: readonly number[] = [502, 503, 504];

/** 強制譲渡で、譲渡先がすでに今の代表者 / オーナーだったときに route が返す code (この 409 は済んでいたものとして扱う。#2086 V1) */
const FORCE_ACTION_ALREADY_DONE_CODES: Readonly<Record<OperatorForceAction, readonly string[]>> = {
  transfer: [OPERATOR_FORCE_TRANSFER_ALREADY_REPRESENTATIVE_CODE, OPERATOR_FORCE_TRANSFER_ALREADY_OWNER_CODE],
  // 強制解散の押し直しは RPC が 409 FAMILY_ALREADY_DISSOLVED / ORG_ALREADY_DISSOLVED で止め、二重にならない。文をそのまま出す
  dissolve: [],
};

/**
 * 強制の操作の POST の結果。
 *   - ok: 成功の応答
 *   - already-done: 強制譲渡の譲渡先がすでに今の代表者 / オーナーだった (route が押し直しを止めた。済んでいたものとして扱う)
 *   - no-response: 応答を受け取れなかった (サーバーで済んだかどうかは分からない)。status は null なら fetch の reject、
 *     数なら本文に API の文の無い 502 / 503 / 504
 */
export type OperatorForceActionResult =
  | { readonly kind: 'ok' }
  | { readonly kind: 'already-done' }
  | { readonly kind: 'no-response'; readonly status: number | null };

/**
 * 強制の操作 (強制譲渡・強制解散) を POST する。
 * 成功の応答なら ok、応答を受け取れなかったら no-response (画面は対象を読み直す)、強制譲渡の譲渡先がすでに今の代表者 / オーナーの 409 なら already-done。
 * 401 (ログインが切れた) は、本文の文 (「認証が必要です」) ではなく、同じ画面の読み込み (fetchOperatorJson) と同じ
 * 「ログインし直してください」(UNAUTHENTICATED_SCREEN_MESSAGE) の OperatorScreenError を投げる (#2112 Z4)。
 * ほかの失敗の応答は、本文の API の文 (無ければ HTTP のステータスを添えた固定の文) の OperatorScreenError を投げる。
 */
export async function postOperatorForceAction(
  url: string,
  body: Record<string, unknown>,
  action: OperatorForceAction,
): Promise<OperatorForceActionResult> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    return { kind: 'no-response', status: null };
  }
  if (res.ok) return { kind: 'ok' };
  // 401 は route の認可 (requireSuperAdmin の AuthError) の断り。本文の文 (「認証が必要です」) ではなく、同じ画面の読み込みの 401 と同じ文にする (#2112 Z4)
  if (res.status === HTTP_UNAUTHORIZED) throw new OperatorScreenError(UNAUTHENTICATED_SCREEN_MESSAGE);
  const errorBody: unknown = await res.json().catch(() => null);
  const apiMessage = extractApiErrorMessage(errorBody);
  if (apiMessage === null && OPERATOR_FORCE_ACTION_NO_RESPONSE_STATUSES.includes(res.status)) {
    return { kind: 'no-response', status: res.status };
  }
  const code = extractApiErrorCode(errorBody);
  if (
    res.status === OPERATOR_FORCE_TRANSFER_ALREADY_DONE_STATUS &&
    code !== null &&
    FORCE_ACTION_ALREADY_DONE_CODES[action].includes(code)
  ) {
    return { kind: 'already-done' };
  }
  throw new OperatorScreenError(apiMessage ?? operatorForceActionHttpFailedMessage(action, res.status));
}
