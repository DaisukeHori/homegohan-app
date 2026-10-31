// src/lib/admin/users-load-failure.ts
// 運営のユーザーの画面 (/admin/users の一覧・/admin/users/{id} の詳細・/admin/users/{id}/freeze の凍結) の、
// 読み込みの失敗の文と、API の応答の読み方 (#2093 W3)。
//
// 以前、一覧は API の失敗・通信の失敗を console.error で捨てて 0 件のまま描き、「ユーザーが見つかりません」と出していた
// (運営は、いる利用者をいないと誤り、問い合わせへの対応や凍結の判断を誤りうる)。詳細・凍結は 404 以外の失敗 (500 / 503 / 403) も
// notFound() にして、利用者が消えた (無い) ように見せていた。読み込みの失敗は 0 件・「無い」と分けて、ここの文と
// 「再読み込み」のボタンを出す (審査の画面の #2086 V7 と同じ型。src/lib/admin/moderation-load-failure.ts)。
//
// このファイルはサーバーの画面 (Server Component) から読む。'use client' の部品のファイルに定数を置くと、
// サーバーの画面からは値ではなく部品の参照として読まれるので、文はここに置く。
// 通信 (adminFetch) はここに置かない (src/lib/admin/user-detail-load.ts)。

/** 一覧の読み込みの失敗の文 (0 件の文とは別に出す) */
export const USERS_LIST_LOAD_FAILED_MESSAGE =
  'ユーザーの一覧を読み込めませんでした。時間をおいて「再読み込み」を押してください';

/** 詳細・凍結の画面の、ユーザーの読み込みの失敗の文 (404 の「無い」とは別に出す) */
export const USER_DETAIL_LOAD_FAILED_MESSAGE =
  'ユーザーを読み込めませんでした。時間をおいて「再読み込み」を押してください';

/** 一覧の API の応答 ({ data, meta }) を読んだ結果 */
export type UsersListLoad<T> = { ok: true; users: T[]; total: number } | { ok: false };

/**
 * 一覧の API の応答の本文を読む。data が配列でない応答 (壊れた応答) は読み込めなかったものとして扱う
 * (壊れた応答を「0 件」と見せない)。件数 (meta.total) が数でなければ、読めた行の数を件数にする
 */
export function readUsersListBody<T>(body: unknown): UsersListLoad<T> {
  if (typeof body !== 'object' || body === null) return { ok: false };
  const data = (body as { data?: unknown }).data;
  if (!Array.isArray(data)) return { ok: false };
  const meta = (body as { meta?: unknown }).meta;
  const total = typeof meta === 'object' && meta !== null ? (meta as { total?: unknown }).total : undefined;
  return { ok: true, users: data as T[], total: typeof total === 'number' && Number.isFinite(total) ? total : data.length };
}

/**
 * 詳細の API の応答の本文を読む。data がオブジェクトでない応答 (壊れた応答) は読み込めなかったものとして null を返す
 */
export function readUserDetailBody<T>(body: unknown): T | null {
  if (typeof body !== 'object' || body === null) return null;
  const data = (body as { data?: unknown }).data;
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null;
  return data as T;
}
