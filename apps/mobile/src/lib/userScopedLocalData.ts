/**
 * サインアウトの前に、端末に残る利用者別のデータを消す (#1037 / #1599)。
 *
 * 消すもの (一覧はそれぞれの正本にあり、ここには写さない):
 *   - AsyncStorage の利用者別のキー (user-storage.ts の clearUserScopedAsyncStorage)
 *   - WebView の利用者別の localStorage (webViewUserStorageCleanup.ts。次に WebView を開いたとき、Web のページが
 *     読み込まれる前に消させる。一覧の正本は packages/shared の USER_SCOPED_LOCAL_STORAGE_KEYS)
 *   - WebView の Cookie (webViewUserStorageCleanup.ts の clearWebViewNativeCookies。#1612 / #1049 F7-16)。
 *     端末の Cookie の置き場をいま空にする。iOS の WKWebView が自分で持つ置き場の Supabase の認証の Cookie は、
 *     上の localStorage と同じ注入の JS が、次に WebView を開いたときに消す (一覧の正本は USER_SCOPED_COOKIE_NAME_PREFIXES)
 *
 * 使う所 (どこからサインアウトしても、同じ掃除を通す):
 *   - signOut.ts のログアウト・退会のあとのサインアウト
 *   - AuthProvider の起動時の復元で、サーバーが失効と明言したときの端末側だけのサインアウト (#1599)
 *
 * signOut.ts は push token の削除のために pushNotifications.ts (通知・端末の情報のモジュール) を読む。
 * AuthProvider がそれらを読まずに済むよう、掃除だけをこのファイルに分けている。
 */

import { clearUserScopedAsyncStorage } from "./user-storage";
import { clearWebViewNativeCookies, requestWebViewUserScopedStorageClear } from "./webViewUserStorageCleanup";

/** 端末に残る利用者別のデータを消す。サインアウトの前に呼ぶ。失敗してもサインアウトは続けるので、例外は投げない */
export async function clearUserScopedLocalData(userId: string | null | undefined): Promise<void> {
  try {
    await clearUserScopedAsyncStorage(userId ?? null);
  } catch {
    // ローカルデータの掃除に失敗しても、サインアウトは続ける
  }
  try {
    await requestWebViewUserScopedStorageClear();
  } catch {
    // 同上
  }
  try {
    // 例外は投げないが、差し替えられたときに備えて囲む
    await clearWebViewNativeCookies();
  } catch {
    // 同上
  }
}
