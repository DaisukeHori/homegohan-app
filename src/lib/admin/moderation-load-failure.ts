// src/lib/admin/moderation-load-failure.ts
// 運営の審査の画面 (/admin/moderation の一覧・/admin/moderation/{type}/{id} の詳細) の、読み込みの失敗の文と読み方 (#2086 V7)。
//
// 以前、一覧は API の失敗・通信の失敗を console.error で捨てて 0 件のまま描き、「審査待ちのアイテムはありません」と出していた
// (運営は審査待ちの通報が 0 件だと思い、有害なコンテンツの審査が放置されうる)。詳細は 404 以外の失敗 (500 など) も notFound() にして、
// 消えた (無い) と誤解させていた。読み込みの失敗は 0 件・「無い」と分けて、ここの文と「再読み込み」のボタン
// (src/components/operator/moderation/ModerationLoadFailure.tsx) を出す。
//
// このファイルはサーバーの画面 (Server Component) から読む。'use client' の部品のファイルに定数を置くと、
// サーバーの画面からは値ではなく部品の参照として読まれるので、文はここに置く。

/** 一覧の読み込みの失敗の文 (0 件の文とは別に出す) */
export const MODERATION_LIST_LOAD_FAILED_MESSAGE =
  '審査の一覧を読み込めませんでした。時間をおいて「再読み込み」を押してください';

/** 詳細の読み込みの失敗の文 (404 の「無い」とは別に出す) */
export const MODERATION_DETAIL_LOAD_FAILED_MESSAGE =
  '審査のアイテムを読み込めませんでした。時間をおいて「再読み込み」を押してください';

/** 「再読み込み」のボタンの文 */
export const MODERATION_RELOAD_LABEL = '再読み込み';

/** 「再読み込み」を押したあと、読み直している間のボタンの文 */
export const MODERATION_RELOADING_LABEL = '読み込み中...';

/** 一覧の API の応答 ({ data, meta }) を読んだ結果 */
export type ModerationQueueLoad<T> = { ok: true; items: T[]; total: number } | { ok: false };

/**
 * 一覧の API の応答の本文を読む。data が配列でない応答 (壊れた応答) は読み込めなかったものとして扱う
 * (壊れた応答を「0 件」と見せない)。件数 (meta.total) が数でなければ、読めた行の数を件数にする
 */
export function readModerationQueueBody<T>(body: unknown): ModerationQueueLoad<T> {
  if (typeof body !== 'object' || body === null) return { ok: false };
  const data = (body as { data?: unknown }).data;
  if (!Array.isArray(data)) return { ok: false };
  const meta = (body as { meta?: unknown }).meta;
  const total = typeof meta === 'object' && meta !== null ? (meta as { total?: unknown }).total : undefined;
  return { ok: true, items: data as T[], total: typeof total === 'number' && Number.isFinite(total) ? total : data.length };
}

/**
 * 詳細の API の応答の本文を読む。data がオブジェクトでない応答 (壊れた応答) は読み込めなかったものとして null を返す
 */
export function readModerationDetailBody<T>(body: unknown): T | null {
  if (typeof body !== 'object' || body === null) return null;
  const data = (body as { data?: unknown }).data;
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null;
  return data as T;
}
