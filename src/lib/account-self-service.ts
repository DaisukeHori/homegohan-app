/**
 * 本人のアカウントの「書き出し」と「退会」を、ブラウザ (Web とモバイルアプリの WebView) から呼ぶための共通の処理。
 *
 * 使う画面:
 *   - 設定画面 (src/app/(main)/settings/page.tsx)
 *   - 凍結中の利用者の画面 (src/app/frozen/account/page.tsx。#1445: 凍結中でも退会と書き出しをできるようにする)
 *   - 規約にまだ同意していない人の画面 (src/app/legal-consent/account/page.tsx。#1901 cross/20 Q-23: 同意しなくても退会と書き出しをできるようにする)。
 *     この 2 つは共通の部品 src/components/account/AccountSelfServicePanel.tsx から呼ぶ
 * 2 つの画面で、API の呼び方・ファイルの保存のしかた・退会のあとのログアウトの順番を食い違わせないために、ここにまとめる。
 *
 * API の契約:
 *   - GET  /api/account/export (#1131): 本人のデータを JSON で返す。連打は 429 (Retry-After 秒)
 *   - POST /api/account/delete (#1175): 本文 { confirm: true } で即時に退会する。組織のオーナー・家族の代表者は 409
 */

import { MEMBERSHIP_SETTINGS_PATH } from '@homegohan/shared';
import { ACCOUNT_DELETE_API_PATH, ACCOUNT_EXPORT_API_PATH } from '@/lib/auth/frozen';
// 保存するファイル名は、API が Content-Disposition に付ける名前と同じ関数で作る (UTC の日付。tests/account-export.test.ts が固定)
import { buildExportFilename } from '@/lib/account-export';
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
    await saveResponseAsDownload(res, buildExportFilename(), 'application/json', options.isNativeApp);
    return { kind: 'saved' };
  } catch (error) {
    console.error('[account export]', error);
    return { kind: 'failed' };
  }
}

/** 退会を止めている立場 (#1562)。組織のオーナー / 家族グループの代表者 */
export type AccountDeletionBlocker = 'organization' | 'family_group';

/** 409 の本文の error (src/lib/account-deletion.ts の AccountDeletionErrorCode) → 退会を止めている立場 */
const BLOCKER_OF_ERROR_CODE: ReadonlyMap<string, AccountDeletionBlocker> = new Map<string, AccountDeletionBlocker>([
  ['ACCOUNT_DELETE_BLOCKED_ORG_OWNER', 'organization'],
  ['ACCOUNT_DELETE_BLOCKED_FAMILY_REPRESENTATIVE', 'family_group'],
]);

/**
 * 退会できなかった (409) ときに案内する画面 (#1562 → #1917)。
 * メンバーシップ設定 (/settings/membership) に、代表者・オーナーの譲渡へのリンクと解散の区画がある (docs/design/family/11-self-dissolve.md §15.1)。
 * 凍結中の画面 (/frozen/account) と同意の前の画面 (/legal-consent/account) は設定を開けないので、共通の枠 (AccountSelfServicePanel) がその場で解散の区画を出す (同 §15.4)
 */
export const ACCOUNT_DELETE_BLOCKED_GUIDE: Readonly<Record<AccountDeletionBlocker, { path: string; prompt: string }>> = {
  organization: {
    path: MEMBERSHIP_SETTINGS_PATH,
    prompt: 'メンバーシップ設定の画面を開きますか？（オーナーの譲渡か、組織の解散ができます）',
  },
  family_group: {
    path: MEMBERSHIP_SETTINGS_PATH,
    prompt: 'メンバーシップ設定の画面を開きますか？（代表者の譲渡か、家族グループの解散ができます）',
  },
};

/** 409 の本文の family_group / organization (id と名前)。退会と書き出しの枠 (凍結中の画面・同意の前の画面) がその場で解散するのに使う */
export interface AccountDeletionBlockedScope {
  id: string;
  name: string;
}

export type AccountDeletionResult =
  | { kind: 'deleted' }
  | { kind: 'unauthorized' }
  /**
   * 組織のオーナー・家族の代表者なので、先に譲渡や解散が要る (409)。
   * message はサーバーが書いた固定の文 (src/lib/account-deletion.ts の findBlocker の 2 つの文。利用者向けの日本語で、
   * DB などの生のエラー文は入らない)。画面はこの文をそのまま出してよい (#1447)。本文に無ければ null。
   * blocker は本文の error から分かる立場 (#1562 → #1917。メンバーシップ設定への案内に使う)。分からなければ null。
   * scope は本文の立場の id と名前 (#1917。凍結中の画面・同意の前の画面がその場で解散するのに使う)。blocker が null か、本文の形が違えば null
   */
  | { kind: 'blocked'; message: string | null; blocker: AccountDeletionBlocker | null; scope: AccountDeletionBlockedScope | null }
  | { kind: 'failed' };

/**
 * 409 の本文から、退会を止めている家族グループ / 組織の id と名前を読む (#1917)。
 * findBlocker は、組織のオーナーなら本文の organization に、家族の代表者なら family_group に { id, name } を入れる。
 * 本文の鍵の名前は AccountDeletionBlocker の値と同じ ('organization' / 'family_group') なので、立場をそのまま鍵に使う。
 * 立場が分からない・鍵が無い・id か name が文字列でなければ null
 */
function blockedScopeOfBody(body: unknown, blocker: AccountDeletionBlocker | null): AccountDeletionBlockedScope | null {
  if (blocker === null || typeof body !== 'object' || body === null) return null;
  const raw: unknown = (body as Record<string, unknown>)[blocker];
  if (typeof raw !== 'object' || raw === null) return null;
  const { id, name } = raw as { id?: unknown; name?: unknown };
  return typeof id === 'string' && typeof name === 'string' ? { id, name } : null;
}

/** 退会に失敗したとき (409 以外の失敗・通信の失敗) に出す文 */
export const ACCOUNT_DELETE_FAILED_MESSAGE = 'アカウントの削除に失敗しました。時間をおいて再度お試しください。';

/** 退会できなかった (409) のに、サーバーの本文に理由の文が無かったときに出す文 */
export const ACCOUNT_DELETE_BLOCKED_FALLBACK_MESSAGE =
  '組織のオーナー、または家族グループの代表者のため、退会できません。先にオーナー・代表者を譲渡するか、組織・家族グループを解散してください。';

/**
 * 退会できなかった (409) ときに出す文 (#1447)。サーバーの文 (譲渡や解散が先だという案内) があればそれを、無ければ定型の文を返す。
 * 設定画面は、これまで 409 でも「削除に失敗しました」としか出さず、何をすれば退会できるかが分からなかった。
 */
export function accountDeletionBlockedMessage(message: string | null): string {
  return message !== null && message.trim() !== '' ? message : ACCOUNT_DELETE_BLOCKED_FALLBACK_MESSAGE;
}

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
      const errorCode =
        typeof body === 'object' && body !== null && typeof (body as { error?: unknown }).error === 'string'
          ? (body as { error: string }).error
          : null;
      const blocker = errorCode !== null ? (BLOCKER_OF_ERROR_CODE.get(errorCode) ?? null) : null;
      const scope = blockedScopeOfBody(body, blocker);
      return { kind: 'blocked', message, blocker, scope };
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
