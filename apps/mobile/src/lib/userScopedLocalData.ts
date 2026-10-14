/**
 * サインアウトの前に、端末に残る利用者別のデータを消す (#1037 / #1599)。
 *
 * 消すもの (一覧はそれぞれの正本にあり、ここには写さない):
 *   - AsyncStorage の利用者別のキー (user-storage.ts の clearUserScopedAsyncStorage)
 *   - WebView の利用者別の localStorage (webViewUserStorageCleanup.ts。次に WebView を開いたとき、Web のページが
 *     読み込まれる前に消させる。一覧の正本は packages/shared の USER_SCOPED_LOCAL_STORAGE_KEYS)
 *
 * 使う所 (どこからサインアウトしても、同じ掃除を通す。経路ごとの順と掃除する利用者の表は AuthProvider.tsx の先頭):
 *   - signOut.ts のログアウト・退会のあとのサインアウト (サインアウトの前に)
 *   - AuthProvider の起動時の復元で、サーバーが失効と明言したときの端末側だけのサインアウト (サインアウトの前に。#1599)
 *   - AuthProvider の起動時の復元で、未ログインと決まったとき (getSession() が null・例外。未ログインの画面を出す前に。#1615)
 *   - AuthProvider の onAuthStateChange の SIGNED_OUT (supabase-js がセッションを消したあと。#1615)
 *     自動更新で refresh_token が失効と答えたときなど、サインアウトの前に呼べない経路もここで拾う
 * 同じサインアウトで二度呼ばれることがある (signOut.ts の掃除のあとに届く SIGNED_OUT など)。何度呼んでも害は無い
 * (同じキーを消し直し、WebView の掃除の ID を作り直すだけ。次に開く WebView が一度だけ消す)
 *
 * signOut.ts は push token の削除のために pushNotifications.ts (通知・端末の情報のモジュール) を読む。
 * AuthProvider がそれらを読まずに済むよう、掃除だけをこのファイルに分けている。
 */

import { clearUserScopedAsyncStorage } from "./user-storage";
import { requestWebViewUserScopedStorageClear } from "./webViewUserStorageCleanup";

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
}
