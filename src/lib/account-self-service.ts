/**
 * 本人のアカウントの「書き出し」と「退会」を、ブラウザ (Web とモバイルアプリの WebView) から呼ぶための共通の処理。
 *
 * 使う画面:
 *   - 設定画面 (src/app/(main)/settings/page.tsx)
 *   - 凍結中の利用者の画面 (src/app/frozen/account/page.tsx。#1445: 凍結中でも退会と書き出しをできるようにする)
 * 2 つの画面で、API の呼び方・ファイルの保存のしかた・退会のあとのログアウトの順番を食い違わせないために、ここにまとめる。
 *
 * API の契約:
 *   - GET  /api/account/export (#1131): 本人のデータを JSON で返す。連打は 429 (Retry-After 秒)
 *   - POST /api/account/delete (#1175): 本文 { confirm: true } で即時に退会する。組織のオーナー・家族の代表者は 409
 */

import { ACCOUNT_DELETE_API_PATH, ACCOUNT_EXPORT_API_PATH } from '@/lib/auth/frozen';
import { broadcastSignOut, clearUserScopedLocalStorage } from '@/lib/user-storage';
import { notifyNativeSignOut } from '@/lib/native-auth-bridge';

/** 退会の確認のために入力してもらう言葉 */
export const ACCOUNT_DELETE_CONFIRM_KEYWORD = '削除します';

/** Retry-After (秒) を「分」にして伝えるための換算 */
const SECONDS_PER_MINUTE = 60;

/** HTTP のステータス (この処理が見分けるものだけ) */
const HTTP_UNAUTHORIZED = 401;
const HTTP_CONFLICT = 409;
const HTTP_TOO_MANY_REQUESTS = 429;

/** 書き出しのファイル名 (例: homegohan-export-2026-10-12.json)。設定画面の従来の名前と同じ */
export function accountExportFilename(now: Date = new Date()): string {
  return `homegohan-export-${now.toISOString().slice(0, 10)}.json`;
}

/**
 * 取得した応答をファイルとして保存する (JSON / CSV の書き出しで共通)。
 * モバイルアプリの WebView の中では Blob の URL でのダウンロードが動かないので、本文をネイティブへ送って保存してもらう
 * (apps/mobile/src/lib/webViewDownload.ts が受け取る)。
 */
export async function saveResponseAsDownload(
  res: Response,
  filename: string,
  mimeType: string,
  isNativeApp: boolean,
): Promise<void> {
  if (isNativeApp) {
    const content = await res.text();
    const w = window as unknown as { ReactNativeWebView?: { postMessage: (s: string) => void } };
    w.ReactNativeWebView?.postMessage(JSON.stringify({ type: 'download', filename, content, mimeType }));
    return;
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export type AccountExportResult =
  | { kind: 'saved' }
  | { kind: 'unauthorized' }
  | { kind: 'rate_limited'; retryAfterSec: number | null }
  | { kind: 'failed' };

/** 連打の上限に掛かったときに出す文 (いつ再開できるかをサーバーの Retry-After から伝える) */
export function accountExportRateLimitedMessage(retryAfterSec: number | null): string {
  const wait =
    retryAfterSec !== null && retryAfterSec > 0 ? `${Math.ceil(retryAfterSec / SECONDS_PER_MINUTE)}分ほど` : 'しばらく';
  return `短い時間にエクスポートを繰り返したため、一時的に実行できません。${wait}待ってからもう一度お試しください。`;
}

/** 書き出しに失敗したときに出す文 */
export const ACCOUNT_EXPORT_FAILED_MESSAGE = 'データのエクスポートに失敗しました。時間をおいて再度お試しください。';

/**
 * 本人のデータを JSON で書き出して保存する。例外は投げず、結果の種類を返す (画面ごとに出し方を決める)。
 */
export async function exportAccountData(options: { isNativeApp: boolean }): Promise<AccountExportResult> {
  try {
    const res = await fetch(ACCOUNT_EXPORT_API_PATH, { method: 'GET' });
    if (res.status === HTTP_UNAUTHORIZED) return { kind: 'unauthorized' };
    if (res.status === HTTP_TOO_MANY_REQUESTS) {
      const retryAfterSec = Number(res.headers.get('Retry-After'));
      return { kind: 'rate_limited', retryAfterSec: Number.isFinite(retryAfterSec) && retryAfterSec > 0 ? retryAfterSec : null };
    }
    if (!res.ok) {
      console.error(`[account export] failed: ${res.status}`);
      return { kind: 'failed' };
    }
    await saveResponseAsDownload(res, accountExportFilename(), 'application/json', options.isNativeApp);
    return { kind: 'saved' };
  } catch (error) {
    console.error('[account export]', error);
    return { kind: 'failed' };
  }
}

export type AccountDeletionResult =
  | { kind: 'deleted' }
  | { kind: 'unauthorized' }
  /** 組織のオーナー・家族の代表者なので、先に譲渡や解散が要る (409)。message はサーバーが書いた固定の文 */
  | { kind: 'blocked'; message: string | null }
  | { kind: 'failed' };

/**
 * 本人のアカウントを即時に削除する (取り消せない)。例外は投げず、結果の種類を返す。
 * 削除できたら、呼び出し側で signOutAfterAccountDeletion を呼んでログアウトする。
 */
export async function deleteOwnAccount(): Promise<AccountDeletionResult> {
  try {
    const res = await fetch(ACCOUNT_DELETE_API_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: true }),
    });
    if (res.ok) return { kind: 'deleted' };
    if (res.status === HTTP_UNAUTHORIZED) return { kind: 'unauthorized' };
    if (res.status === HTTP_CONFLICT) {
      const body: unknown = await res.json().catch(() => null);
      const message =
        typeof body === 'object' && body !== null && typeof (body as { message?: unknown }).message === 'string'
          ? (body as { message: string }).message
          : null;
      return { kind: 'blocked', message };
    }
    console.error(`[delete account] failed: ${res.status}`);
    return { kind: 'failed' };
  } catch (error) {
    console.error('[delete account]', error);
    return { kind: 'failed' };
  }
}

/**
 * 退会のあとのログアウト。CLAUDE.md の規約どおり、Supabase の signOut より前に端末のユーザー別データを消し、
 * WebView ならネイティブへも signOut の前に知らせる (#1038 F7-10)。signOut のあとで、ほかのタブにも伝える。
 */
export async function signOutAfterAccountDeletion(supabase: { auth: { signOut: () => Promise<unknown> } }): Promise<void> {
  clearUserScopedLocalStorage();
  notifyNativeSignOut();
  try {
    await supabase.auth.signOut();
  } catch (error) {
    // アカウントはもう消えているので、サーバーへのログアウトが失敗しても続ける (端末側のデータは上で消してある)
    console.error('[delete account] signOut failed', error);
  }
  broadcastSignOut();
}
