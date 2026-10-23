/**
 * 管理 API の失敗応答 (JSON の本文) から、画面に出すメッセージを取り出す。
 * 運営コンソールのお知らせ管理・組織管理の画面で共通に使う。
 *
 * API によって失敗の本文の形が違う。
 *   - お知らせ API (/api/announcements)                : { error: 'title and content are required' }
 *   - 管理系 API (/api/admin/organizations など)        : { error: { code: 'OWNER_ALREADY_IN_ORG', message: '…' } }
 * どちらでも、文字列のメッセージがあればそれを返す。無ければ null を返す (呼び出し側が汎用の文言を出す)。
 */
export function extractApiErrorMessage(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;

  const error = (body as { error?: unknown }).error;
  if (typeof error === 'string') {
    return error.trim() === '' ? null : error;
  }
  if (typeof error === 'object' && error !== null) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim() !== '') return message;
  }
  return null;
}

/**
 * 管理系 API の失敗応答 ({ error: { code, message } }) から、エラーの code を取り出す。
 * 画面が code で動きを変える (例: 組織のプランの変更で 409 CONFLICT_STALE_DATA なら一覧を読み直す) ときに使う。
 * code が文字列で無い・空・本文の形が違う (お知らせ API の { error: '文字列' } など) ときは null。
 */
export function extractApiErrorCode(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;

  const error = (body as { error?: unknown }).error;
  if (typeof error !== 'object' || error === null) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && code.trim() !== '' ? code : null;
}

/**
 * 読んでから書くまでに別の運営が先に変えていた (条件つきの更新が 0 行で、送った変更が入っていない) ときの、エラーの code。
 * 管理系 API はこのとき書かずに 409 で返す (cross/04 §4.2。問い合わせの更新・AI の 1 日の上限の保存・組織のプランの変更・リードのステージの変更など)
 */
export const STALE_DATA_ERROR_CODE = 'CONFLICT_STALE_DATA';

/** STALE_DATA_ERROR_CODE を返すときの HTTP ステータス (409 Conflict) */
export const STALE_DATA_HTTP_STATUS = 409;

/**
 * 失敗の応答が「画面の表示が古い」(409 CONFLICT_STALE_DATA) か。
 * 画面はこのとき文を出すだけでなく、表示を読み直す (運営が手で読み直さなくてよいように。#1917)。
 * 同じ 409 でも別の code (例: AI の上限の PLAN_READ_ONLY) は false。
 */
export function isStaleDataConflict(status: number, body: unknown): boolean {
  return status === STALE_DATA_HTTP_STATUS && extractApiErrorCode(body) === STALE_DATA_ERROR_CODE;
}
