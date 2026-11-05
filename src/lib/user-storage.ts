/**
 * User-scoped localStorage helpers.
 *
 * Keys that are specific to an authenticated session are listed in
 * packages/shared/src/user-scoped-storage.ts (USER_SCOPED_LOCAL_STORAGE_KEYS — 一覧の正本。#1037)。
 * Call `clearUserScopedLocalStorage()` on SIGNED_OUT to prevent sensitive
 * settings from leaking to the next user on a shared device.
 *
 * モバイルアプリのネイティブのログアウト・退会も、同じ一覧で WebView の localStorage を消す
 * (apps/mobile/src/lib/webViewUserStorageCleanup.ts)。一覧をここに写さない。
 */

import {
  USER_SCOPED_LOCAL_STORAGE_KEYS,
  USER_SCOPED_LOCAL_STORAGE_KEY_PREFIXES,
  USER_SCOPED_STORAGE_CLEARED_EVENT,
} from '@homegohan/shared';

import { notifyNativeSignOut } from './native-auth-bridge';

/**
 * 利用者別の localStorage を消したこと (= サインアウト) を知らせる window のイベント。
 * 値の正本は packages/shared/src/user-scoped-storage.ts (モバイルアプリが WebView に注入する掃除の JS も同じイベントを出す)。
 */
export { USER_SCOPED_STORAGE_CLEARED_EVENT };

/**
 * localStorage そのものへの参照の失敗を握る形。参照できなければ警告を出して null を返す。
 * 保存が禁止された環境 (サイトのデータの保存を禁止したブラウザなど) では、`localStorage` を参照しただけで SecurityError が飛ぶ (#2280)。
 */
function readUserScopedStorage(): Storage | null {
  try {
    return localStorage;
  } catch (storageError: unknown) {
    console.warn('[user-storage] localStorage is not available:', storageError);
    return null;
  }
}

/**
 * removeItem の失敗を握る形。消せなかったときは警告だけ出して戻る (#2280)。
 * src/app/(main)/menus/weekly/_state/safeLocalStorage.ts の removeLocalStorageItem (#2275 T3) と同じ考え方。
 */
function removeUserScopedStorageItem(storage: Storage, key: string): void {
  try {
    storage.removeItem(key);
  } catch (storageError: unknown) {
    console.warn('[user-storage] localStorage.removeItem failed:', key, storageError);
  }
}

/**
 * key(i) の失敗を握る形。読めなかったときは警告を出して null (その位置にキーが無いのと同じ扱い) を返す (#2280)。
 */
function readUserScopedStorageKey(storage: Storage, index: number): string | null {
  try {
    return storage.key(index);
  } catch (storageError: unknown) {
    console.warn('[user-storage] localStorage.key failed:', index, storageError);
    return null;
  }
}

/**
 * 利用者別の接頭辞で始まるキーを集める。length / key(i) の失敗を握り、集められた分だけを返す (#2280)。
 * length を読めなければ何も集めない。key(i) が投げたときは、その位置を飛ばして続ける (readUserScopedStorageKey)。
 */
function collectPrefixedKeys(storage: Storage): string[] {
  let length: number;
  try {
    length = storage.length;
  } catch (storageError: unknown) {
    console.warn('[user-storage] localStorage.length failed:', storageError);
    return [];
  }
  const prefixedKeys: string[] = [];
  for (let i = 0; i < length; i++) {
    const key = readUserScopedStorageKey(storage, i);
    if (key !== null && USER_SCOPED_LOCAL_STORAGE_KEY_PREFIXES.some((prefix) => key.startsWith(prefix))) {
      prefixedKeys.push(key);
    }
  }
  return prefixedKeys;
}

/**
 * Removes all user-scoped localStorage keys.
 * Safe to call in a non-browser environment (no-op if `localStorage` is
 * not available, e.g. during SSR).
 *
 * 決まったキー (USER_SCOPED_LOCAL_STORAGE_KEYS) と、利用者別の接頭辞 (USER_SCOPED_LOCAL_STORAGE_KEY_PREFIXES) で
 * 始まるキーを消す (#1599)。接頭辞のキーは、消しながら数えるとずれるので、先に集めてから消す。
 *
 * 投げない (#2280): localStorage への参照・removeItem・length・key(i) の失敗は警告 (console.warn) だけにして、
 * 消せるキーは消し続け、最後の USER_SCOPED_STORAGE_CLEARED_EVENT は必ず出す。呼び出し側 (設定画面のログアウト・
 * MainLayout の別タブからのサインアウトの受け手など) は、この関数のあとにサインアウトとログイン画面への移動をするので、
 * ここで投げると、保存が禁止された環境ではログアウトのボタンを押しても何も起きなくなる。
 * 使える環境では、消すキーとその順はこれまでと同じ。
 */
export function clearUserScopedLocalStorage(): void {
  if (typeof window === 'undefined') return;
  const storage = readUserScopedStorage();
  if (storage !== null) {
    for (const key of USER_SCOPED_LOCAL_STORAGE_KEYS) {
      removeUserScopedStorageItem(storage, key);
    }
    for (const key of collectPrefixedKeys(storage)) {
      removeUserScopedStorageItem(storage, key);
    }
  }
  window.dispatchEvent(new Event(USER_SCOPED_STORAGE_CLEARED_EVENT));
}

/**
 * Broadcasts a SIGNED_OUT event to other tabs via BroadcastChannel (#145).
 * Call this after supabase.auth.signOut() to ensure all open tabs redirect.
 * Safe to call in a non-browser environment (no-op if BroadcastChannel is
 * not available).
 *
 * モバイルアプリの WebView の中なら、ネイティブアプリにもログアウトを伝える (#1038 F7-04)。
 * 伝えないと、Web だけがログアウトし、ネイティブは保存済みのセッションを持ったままになる。
 * BroadcastChannel を使えない WebView (iOS 15.4 未満など) でも伝わるよう、最初に呼ぶ。
 *
 * 各画面は、これより前 (supabase.auth.signOut() の前) に notifyNativeSignOut() でネイティブへ知らせる (#1038 F7-10。
 * 理由は native-auth-bridge.ts の notifyNativeSignOut)。知らせてあれば、ここでは二重に送らない。
 * 並び (notifyNativeSignOut -> signOut -> broadcastSignOut) は tests/native-sign-out-order-source-scan.test.ts が検査する。
 */
export function broadcastSignOut(): void {
  notifyNativeSignOut();
  if (typeof BroadcastChannel === 'undefined') return;
  const channel = new BroadcastChannel('auth');
  channel.postMessage('SIGNED_OUT');
  // Close immediately after posting — we only need a one-shot message.
  channel.close();
}
