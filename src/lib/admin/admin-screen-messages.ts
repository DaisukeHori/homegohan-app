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

/** 書き込みの操作が失敗の応答を返し、本文に画面に出せる文が無いときの文 (プロキシの 502 など) */
export function adminActionHttpFailedMessage(action: string, status: number): string {
  return `${action}に失敗しました (HTTP ${status})`;
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
 * 運営の API に書き込みを送り、成功の応答の JSON の本文を返す (本文が JSON でなければ null)。
 * 通信そのものの失敗は「<操作>の応答を受け取れませんでした（通信エラー）」、失敗の応答は本文の日本語の文
 * (無ければ「<操作>に失敗しました (HTTP <番号>)」) の AdminScreenError を投げる
 */
export async function sendAdminRequest(url: string, init: RequestInit, action: string): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch {
    throw new AdminScreenError(adminActionNoResponseMessage(action));
  }
  if (!res.ok) throw await adminScreenErrorOfResponse(res, (status) => adminActionHttpFailedMessage(action, status));
  return res.json().catch(() => null);
}
