/**
 * User-scoped localStorage helpers.
 *
 * Keys that are specific to an authenticated session should be listed here.
 * Call `clearUserScopedLocalStorage()` on SIGNED_OUT to prevent sensitive
 * settings from leaking to the next user on a shared device.
 */

import { notifyNativeSignOut } from './native-auth-bridge';

/**
 * localStorage keys that belong to a specific auth session.
 * These must be cleared when the user signs out.
 */
const USER_SCOPED_KEYS: readonly string[] = [
  // AI generate modal – range settings (v4_range_days, v4_include_existing)
  'v4_range_days',
  'v4_include_existing',
  // In-progress generation state trackers
  'v4MenuGenerating',
  'weeklyMenuGenerating',
  'singleMealGenerating',
  'shoppingListRegenerating',
  // Profile reminder dismissal
  'profile_reminder_dismissed',
];

/**
 * 利用者別の localStorage を消したこと (= サインアウト) を知らせる window のイベント。
 * localStorage に無い、メモリに持っている利用者別の状態 (外国の AI 事業者への提供の同意の状況など、
 * src/hooks/useAiConsent.tsx) を、同じタブで次にログインする別の利用者へ引き継がないために、持ち主が聞いて捨てる。
 */
export const USER_SCOPED_STORAGE_CLEARED_EVENT = 'homegohan:user-scoped-storage-cleared';

/**
 * Removes all user-scoped localStorage keys.
 * Safe to call in a non-browser environment (no-op if `localStorage` is
 * not available, e.g. during SSR).
 */
export function clearUserScopedLocalStorage(): void {
  if (typeof window === 'undefined') return;
  for (const key of USER_SCOPED_KEYS) {
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
