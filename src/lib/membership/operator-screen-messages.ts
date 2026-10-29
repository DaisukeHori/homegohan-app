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
//
// このファイルはブラウザからも読むので、サーバー専用のものを import しない。

import { extractApiErrorMessage } from '@/lib/admin/api-error-message';

/** 画面にそのまま出してよい日本語の文を持つ例外 */
export class OperatorScreenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OperatorScreenError';
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

/** 強制の操作の通信そのものが失敗した (応答を受け取れなかった) ときの文の頭 */
export function operatorForceActionNoResponseSummary(action: OperatorForceAction): string {
  return `${OPERATOR_FORCE_ACTION_LABELS[action]}の応答を受け取れませんでした（通信エラー）`;
}

/** 強制譲渡: 候補を読み直したら、選んだメンバーがまだ譲渡先の候補にいた (代表者・オーナーになっていない) ときに続ける文 */
export const FORCE_TRANSFER_NOT_DONE_GUIDE =
  '候補を読み込み直したところ、選んだメンバーはまだ譲渡先の候補にいて、譲渡されていません。必要ならもう一度実行してください';

/** 強制譲渡: 候補の読み直しにも失敗したときに続ける文 */
export const FORCE_TRANSFER_RELOAD_FAILED_GUIDE =
  '候補も読み込めなかったため、譲渡が済んだか分かりません。一覧に戻って状態を確かめてから、必要ならもう一度操作してください';

/** 強制解散: 一覧を読み直したら、対象がまだ解散されずに一覧にあったときに続ける文 */
export const FORCE_DISSOLVE_NOT_DONE_GUIDE =
  '一覧を読み込み直したところ、まだ解散されていません。必要ならもう一度実行してください';

/** 強制解散: 一覧の読み直しにも失敗したときに続ける文 */
export const FORCE_DISSOLVE_RELOAD_FAILED_GUIDE =
  '一覧も読み込めなかったため、解散が済んだか分かりません。「更新」で一覧を読み込み直して状態を確かめてから、必要ならもう一度操作してください';

/** 文の頭と、読み直しの結果に合わせた続きの文をつなぐ */
export function operatorForceActionNoResponseMessage(action: OperatorForceAction, guide: string): string {
  return `${operatorForceActionNoResponseSummary(action)}。${guide}`;
}

/**
 * 運営の API を GET で読み、JSON の本文を返す。
 * 通信の失敗・失敗の応答・JSON でない本文は、どれも画面に出せる日本語の文の OperatorScreenError を投げる
 * (失敗の応答の本文に API の文があればそれを、無ければ HTTP のステータスを添えた固定の文)。
 */
export async function fetchOperatorJson(url: string, subject: string): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url);
  } catch {
    throw new OperatorScreenError(operatorLoadFailedMessage(subject, null));
  }
  const body: unknown = await res.json().catch(() => null);
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

/** 強制の操作の POST の結果。'no-response' は通信そのものが失敗した (サーバーで済んだかどうかは分からない) */
export type OperatorForceActionResult = 'ok' | 'no-response';

/**
 * 強制の操作 (強制譲渡・強制解散) を POST する。
 * 成功の応答なら 'ok'、通信そのものが失敗したら 'no-response' (画面は対象を読み直す)。
 * 失敗の応答は、本文の API の文 (無ければ HTTP のステータスを添えた固定の文) の OperatorScreenError を投げる。
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
    return 'no-response';
  }
  if (res.ok) return 'ok';
  const errorBody: unknown = await res.json().catch(() => null);
  throw new OperatorScreenError(
    extractApiErrorMessage(errorBody) ?? operatorForceActionHttpFailedMessage(action, res.status),
  );
}
