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
  USER_SCOPED_STORAGE_CLEARED_EVENT,
} from '@homegohan/shared';

import { notifyNativeSignOut } from './native-auth-bridge';

/**
 * 利用者別の localStorage を消したこと (= サインアウト) を知らせる window のイベント。
 * 値の正本は packages/shared/src/user-scoped-storage.ts (モバイルアプリが WebView に注入する掃除の JS も同じイベントを出す)。
 */
export { USER_SCOPED_STORAGE_CLEARED_EVENT };

/**
 * Removes all user-scoped localStorage keys.
 * Safe to call in a non-browser environment (no-op if `localStorage` is
 * not available, e.g. during SSR).
 */
export function clearUserScopedLocalStorage(): void {
  if (typeof window === 'undefined') return;
  for (const key of USER_SCOPED_LOCAL_STORAGE_KEYS) {
    localStorage.removeItem(key);
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
