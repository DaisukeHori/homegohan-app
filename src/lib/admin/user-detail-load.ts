// src/lib/admin/user-detail-load.ts
// 運営のユーザーの詳細 (/admin/users/{id})・凍結 (/admin/users/{id}/freeze) の画面が、GET /api/admin/users/{id} を読む (#2093 W3)。
//
// 「無い」(notFound()) にするのは API の 404 だけ (route は、行が無いときと UUID の形でない id のときに 404 を返す)。
// それ以外の失敗 (500 / 503 / 403・通信の失敗・本文が JSON でない・data が無い壊れた応答) は failed にして、
// 画面は「ユーザーを読み込めませんでした」と「再読み込み」を出す (以前は 404 以外の失敗も notFound() にして、利用者が消えたように見せていた)。

import { adminFetch } from '@/lib/admin/fetch';
import { readUserDetailBody } from '@/lib/admin/users-load-failure';

/** API の 404 (ユーザーが無い)。これだけを notFound() にする */
const HTTP_NOT_FOUND = 404;

/** ユーザーを読んだ結果。notFound は API の 404、failed はそれ以外の読み込みの失敗 */
export type AdminUserDetailLoad<T> = { kind: 'ok'; profile: T } | { kind: 'notFound' } | { kind: 'failed' };

/**
 * GET /api/admin/users/{id} を読む。logSource は console.error の印 (どの画面の失敗か)
 */
export async function loadAdminUserDetail<T>(id: string, logSource: string): Promise<AdminUserDetailLoad<T>> {
  try {
    const res = await adminFetch(`/api/admin/users/${id}`);
    if (res.status === HTTP_NOT_FOUND) return { kind: 'notFound' };
    if (!res.ok) {
      console.error(`[${logSource}] API error:`, res.status);
      return { kind: 'failed' };
    }
    const profile = readUserDetailBody<T>(await res.json());
    if (!profile) {
      console.error(`[${logSource}] unexpected response body`);
      return { kind: 'failed' };
    }
    return { kind: 'ok', profile };
  } catch (err) {
    console.error(`[${logSource}] fetch failed:`, err);
    return { kind: 'failed' };
  }
}
