// src/lib/admin/admin-screen-messages.ts
// 運営の画面 (src/app/super-admin・src/app/admin) の、読み込み・書き込みの失敗の文 (#2086 V6)。
//
// 以前の画面は、本文に文の無い失敗 (プロキシの 502 など) を「HTTP 502」と英字だけで出し、fetch の reject (オフライン・接続が切れたなど) では
// ブラウザの英字の例外の文 (Failed to fetch など) を、失敗の応答の本文が JSON でないとき (プロキシの 502 の HTML など) は
// res.json() の英字の SyntaxError の文を、そのままエラー欄・alert に出していた。
// 運営のメンバーシップの画面 (src/lib/membership/operator-screen-messages.ts。#2080 U5) と同じ型を、ここで運営の画面全体に広げる:
//   - 画面に出してよい日本語の文を AdminScreenError で投げる。画面は displayableAdminError でこの例外の文だけを出し、
//     それ以外の例外 (ブラウザの英字の文・SyntaxError など) は画面ごとの固定の日本語の文にする
//   - 失敗の応答の本文は .catch(() => null) で読む (JSON でない本文で例外を投げない)。本文の文は日本語を含むときだけ出し、
//     無ければ (英字だけの文・本文が読めない) 「<対象>を読み込めませんでした (HTTP <番号>)」の形の固定の文にする
//   - 通信そのものの失敗は「…（通信エラー）」にする
//
// このファイルはブラウザからも読むので、サーバー専用のものを import しない。

import { extractApiErrorMessage } from '@/lib/admin/api-error-message';
import { OPERATOR_FORCE_ACTION_NO_RESPONSE_STATUSES } from '@/lib/membership/operator-screen-messages';

/** 画面にそのまま出してよい日本語の文を持つ例外 */
export class AdminScreenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AdminScreenError';
  }
}

/** 例外から画面に出す文を決める。AdminScreenError の文だけを出し、それ以外 (ブラウザの英字の文・SyntaxError など) は fallback */
export function displayableAdminError(err: unknown, fallback: string): string {
  return err instanceof AdminScreenError ? err.message : fallback;
}

/**
 * 日本語の文字 (ひらがな・カタカナ・CJK 統合漢字 (拡張 A を含む)・全角の英数記号)。
 * tests/org-ui-no-english-copy.test.ts の「英語だけの文言」の判定 (JAPANESE) と同じ範囲
 */
const JAPANESE_TEXT = /[぀-ヿ㐀-鿿＀-￯]/;

/**
 * 失敗の応答の本文 ({ error: '…' } / { error: { message } }) から、画面に出してよい文を取り出す。
 * 日本語を含む文だけを返し、英字だけの文 (古い route・プロキシの文など)・本文が読めない・形が違うときは null
 * (呼び出し側が「<対象>を読み込めませんでした (HTTP <番号>)」などの固定の文を出す)
 */
export function screenApiErrorMessage(body: unknown): string | null {
  const message = extractApiErrorMessage(body);
  return message !== null && JAPANESE_TEXT.test(message) ? message : null;
}

/** 読み込みが失敗したときの文。status が null なら通信そのものの失敗 (fetch の reject・応答の本文が読めない) */
export function adminLoadFailedMessage(subject: string, status: number | null): string {
  if (status === null) return `${subject}を読み込めませんでした（通信エラー）`;
  return `${subject}を読み込めませんでした (HTTP ${status})`;
}

/**
 * 読み込みが AdminScreenError でない例外 (画面の処理の中の例外など) で終わったときの、固定の文。
 * 通信の失敗とは限らないので「通信エラー」とは添えない
 */
export function adminLoadFailedFallback(subject: string): string {
  return `${subject}を読み込めませんでした`;
}

/**
 * 日本語の文 (summary) に HTTP のステータスを添える (「ステータス変更に失敗しました (HTTP 502)」)。
 * 画面のソースに `${summary} (HTTP ${status})` と書くと、運営の画面の走査 (tests/org-ui-no-english-copy.test.ts) からは
 * 「HTTP 502」だけの文と見分けられないので、この関数に通す
 */
export function withHttpStatus(summary: string, status: number): string {
  return `${summary} (HTTP ${status})`;
}

/** 書き込みの操作が失敗の応答を返し、本文に画面に出せる文が無いときの文 (プロキシの 502 など) */
export function adminActionHttpFailedMessage(action: string, status: number): string {
  return withHttpStatus(`${action}に失敗しました`, status);
}

/**
 * 書き込みの操作の通信そのものが失敗した (応答を受け取れなかった) ときの文。
 * サーバーが済ませてから応答が切れたこともあるので「失敗しました」とは言わない
 */
export function adminActionNoResponseMessage(action: string): string {
  return `${action}の応答を受け取れませんでした（通信エラー）`;
}

/** 失敗の応答の本文を読む。JSON でない本文 (プロキシの 502 の HTML など) は null (例外を投げない) */
export function readFailureBody(res: Response): Promise<unknown> {
  return res.json().catch(() => null);
}

/**
 * 失敗の応答から、画面に出す日本語の文の AdminScreenError を作る。
 * 本文に画面に出せる文 (日本語を含む) があればそれ、無ければ fallbackOf(HTTP のステータス) の文
 */
export async function adminScreenErrorOfResponse(
  res: Response,
  fallbackOf: (status: number) => string,
): Promise<AdminScreenError> {
  const body = await readFailureBody(res);
  return new AdminScreenError(screenApiErrorMessage(body) ?? fallbackOf(res.status));
}

/**
 * 運営の API を GET で読み、JSON の本文を返す。
 * 通信の失敗・失敗の応答・JSON でない本文は、どれも画面に出せる日本語の文の AdminScreenError を投げる
 * (失敗の応答の本文に日本語の文があればそれを、無ければ HTTP のステータスを添えた固定の文)
 */
export async function fetchAdminJson(url: string, subject: string): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url);
  } catch {
    throw new AdminScreenError(adminLoadFailedMessage(subject, null));
  }
  if (!res.ok) throw await adminScreenErrorOfResponse(res, (status) => adminLoadFailedMessage(subject, status));
  const body: unknown = await res.json().catch(() => null);
  if (body === null) throw new AdminScreenError(adminLoadFailedMessage(subject, null));
  return body;
}

/**
 * 本文に API の文が無いときに、書き込みの応答を受け取れなかった (サーバーで済んだか分からない) ものとして扱う HTTP ステータス (#2093 W1)。
 * 502 Bad Gateway・503 Service Unavailable・504 Gateway Timeout は、route ではなく手前のプロキシ・ホスティング (関数の時間切れなど) が返す。
 * 運営のメンバーシップの強制操作 (#2086 V1) と同じ 3 つ。route がこれらを返すときは本文に API の文を入れるので、文がある応答はこれまでどおり失敗として出す
 */
export const ADMIN_ACTION_NO_RESPONSE_STATUSES: readonly number[] = OPERATOR_FORCE_ACTION_NO_RESPONSE_STATUSES;

/**
 * 書き込みの応答を受け取れなかったときの文 (#2093 W1)。
 * status が null なら通信そのものの失敗 (fetch の reject。「（通信エラー）」)、数なら本文に API の文の無い 502 / 503 / 504 (「(HTTP n)」)
 */
export function adminActionNoResponseSummary(action: string, status: number | null): string {
  if (status === null) return adminActionNoResponseMessage(action);
  return withHttpStatus(`${action}の応答を受け取れませんでした`, status);
}

/**
 * 書き込みの応答を受け取れなかった (サーバーで済んだか分からない) ことを表す例外 (#2093 W1)。
 * 文は adminActionNoResponseSummary の文で、画面にそのまま出してよい。画面はこれを受けたら、対象を読み直すか、送信を止めて確かめさせる
 * (押し直しで二重に作らない)。status は adminActionNoResponseSummary と同じ
 */
export class AdminActionNoResponseError extends AdminScreenError {
  readonly status: number | null;

  constructor(action: string, status: number | null) {
    super(adminActionNoResponseSummary(action, status));
    this.name = 'AdminActionNoResponseError';
    this.status = status;
  }
}

/** 書き込みの要求を送る。通信そのものが失敗 (fetch の reject) したら AdminActionNoResponseError を投げる (#2093 W1) */
export async function sendAdminAction(url: string, init: RequestInit, action: string): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch {
    throw new AdminActionNoResponseError(action, null);
  }
}

/**
 * 書き込みの失敗の応答から、画面に出す例外を作る (#2093 W1)。
 * 本文に API の文の無い 502 / 503 / 504 は AdminActionNoResponseError (サーバーで済んだか分からない)。
 * ほかは adminScreenErrorOfResponse と同じ (本文の日本語の文、無ければ「<操作>に失敗しました (HTTP n)」)
 */
export async function adminActionErrorOfResponse(res: Response, action: string): Promise<AdminScreenError> {
  return adminActionErrorOfBody(await readFailureBody(res), res.status, action);
}

/**
 * adminActionErrorOfResponse の、失敗の応答の本文を読んだあとの部分 (#2101 X1)。
 * 本文の code で分ける画面 (価格の変更の 409 OP_PRICE_UNCHANGED) は、本文を readFailureBody で 1 回だけ読み、ここに渡す
 */
export function adminActionErrorOfBody(body: unknown, status: number, action: string): AdminScreenError {
  if (extractApiErrorMessage(body) === null && ADMIN_ACTION_NO_RESPONSE_STATUSES.includes(status)) {
    return new AdminActionNoResponseError(action, status);
  }
  return new AdminScreenError(screenApiErrorMessage(body) ?? adminActionHttpFailedMessage(action, status));
}

/**
 * 作成の応答を受け取れなかったときに続ける文 (#2093 W1)。
 * 作成の表 (support_tickets・sales_leads) には一意の制約が無く、読み直しで同じものかを決める鍵も無いので、画面は送信を止め、一覧で確かめさせる
 */
export const ADMIN_CREATE_UNCONFIRMED_GUIDE = '済んだか分かりません。一覧で確かめてから作り直してください';

/** 作成の応答を受け取れなかったときの文 (「チケットの作成の応答を受け取れませんでした（通信エラー）。済んだか分かりません。…」) */
export function adminCreateUnconfirmedMessage(summary: string): string {
  return `${summary}。${ADMIN_CREATE_UNCONFIRMED_GUIDE}`;
}

/**
 * 作成の成功の応答 (2xx) を受けたが、本文が読めず作成したものを開けないときの文 (#2093 W1)。
 * 作成は済んでいるので、画面は送信を止めて一覧で確かめさせる (押し直すと二重になる)
 */
export function adminCreatedButNotOpenedMessage(subject: string): string {
  return `${subject}は作成されましたが、作成した${subject}を開けませんでした。一覧で確かめてください`;
}

/** 作成の成功の応答の本文 ({ data: { id } }) から、作成したものの id を取り出す。読めない・形が違えば null (#2093 W1) */
export function createdIdOfBody(body: unknown): string | null {
  const data = typeof body === 'object' && body !== null ? (body as { data?: unknown }).data : undefined;
  const id = typeof data === 'object' && data !== null ? (data as { id?: unknown }).id : undefined;
  return typeof id === 'string' && id !== '' ? id : null;
}

/**
 * 運営の API の一覧 ({ data: [...] }) を GET で読む。data が配列でない応答 (200 なのに本文が読めない・形が違う) は
 * 読み込めなかったものとして「<対象>を読み込めませんでした（通信エラー）」の AdminScreenError を投げる
 * (壊れた応答を「0 件」と見せない。#2093 W7。運営のメンバーシップの画面の fetchOperatorRows と同じ扱い)。
 * ほかの失敗は fetchAdminJson と同じ
 */
export async function fetchAdminRows<T>(url: string, subject: string): Promise<T[]> {
  const body = await fetchAdminJson(url, subject);
  const data = typeof body === 'object' && body !== null ? (body as { data?: unknown }).data : undefined;
  if (!Array.isArray(data)) throw new AdminScreenError(adminLoadFailedMessage(subject, null));
  return data as T[];
}

/**
 * 作成 (POST) の成功の応答の本文 ({ data: { id } }) から、作った行の id を読む。
 * 本文が JSON として読めない・id が無いときは null (作成は済んでいるので、呼び出し側は作成の失敗とは言わない。#2093 W7)
 */
export async function createdRowIdOfResponse(res: Response): Promise<string | null> {
  const body: unknown = await res.json().catch(() => null);
  return createdIdOfBody(body);
}

/**
 * 作成は成功の応答で済んだが、応答の本文が読めず、作った行の画面へ移れないときの文 (#2093 W7)。
 * 作成は済んでいるので「失敗しました」とも「通信エラー」とも言わず、一覧で確かめるよう促す
 */
export function adminCreatedButUnreadableMessage(action: string): string {
  return `${action}は済みましたが、応答を読み込めませんでした。一覧から開いて確かめてください`;
}

/**
 * 書き込み (PATCH) の成功の応答の本文 ({ data: 書いたあとの行 }) から行を読む。
 * 本文が JSON として読めない・data が無いときは null (書き込みは済んでいるかもしれないので、呼び出し側は失敗とは言わない。#2093 W7)
 */
export async function savedRowOfResponse<T>(res: Response): Promise<T | null> {
  const body: unknown = await res.json().catch(() => null);
  const data = typeof body === 'object' && body !== null ? (body as { data?: unknown }).data : undefined;
  return typeof data === 'object' && data !== null ? (data as T) : null;
}
