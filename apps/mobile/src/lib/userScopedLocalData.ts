/**
 * サインアウトの前に、端末に残る利用者別のデータを消す (#1037 / #1599)。
 *
 * 消すもの (一覧はそれぞれの正本にあり、ここには写さない):
 *   - AsyncStorage の利用者別のキー (user-storage.ts の clearUserScopedAsyncStorage)
 *   - WebView の利用者別の localStorage (webViewUserStorageCleanup.ts。次に WebView を開いたとき、Web のページが
 *     読み込まれる前に消させる。一覧の正本は packages/shared の USER_SCOPED_LOCAL_STORAGE_KEYS)
 *   - WebView の Cookie (webViewUserStorageCleanup.ts の clearWebViewNativeCookies。#1612 / #1049 F7-16)。
 *     端末の Cookie の置き場をいま空にする (完了を待つかどうかは経路で分ける。下の WebViewNativeCookieClearWait。#1647)。
 *     iOS の WKWebView が自分で持つ置き場の Supabase の認証の Cookie は、
 *     上の localStorage と同じ注入の JS が、次に WebView を開いたときに消す (一覧の正本は USER_SCOPED_COOKIE_NAME_PREFIXES)
 *
 * 使う所 (どこからサインアウトしても、同じ掃除を通す。経路ごとの順と掃除する利用者の表は AuthProvider.tsx の先頭):
 *   - signOut.ts のログアウト・退会のあとのサインアウト (サインアウトの前に。Cookie の掃除も待つ)
 *   - AuthProvider の起動時の復元で、サーバーが失効と明言したときの端末側だけのサインアウト (サインアウトの前に。#1599。Cookie の掃除も待つ)
 *   - AuthProvider の起動時の復元で、未ログインと決まったとき (getSession() が null・例外。未ログインの画面を出す前に。#1615。
 *     Cookie の掃除は待たない。#1647)
 *   - AuthProvider の onAuthStateChange の SIGNED_OUT (supabase-js がセッションを消したあと。#1615)
 *     自動更新で refresh_token が失効と答えたときなど、サインアウトの前に呼べない経路もここで拾う。
 *     ここだけは clearUserScopedLocalDataAfterSignedOut を使い、この端末の push token の値 (push_token_value_v1) を残す
 *     (Cookie の掃除は待たない。#1647)。
 *     SIGNED_OUT は、signOut.ts が値を読んで user_push_tokens の行を消すより前に届くことがある (Web の session-expired で
 *     getUser() が端末のセッションを消したときなど)。値は signOut.ts の掃除が、行の削除のあとに消す
 *     (削除が失敗・0 件なら、消す前に release の宛先を控える。#1706)
 * 同じサインアウトで二度呼ばれることがある (signOut.ts の掃除の前後に届く SIGNED_OUT など)。何度呼んでも害は無い
 * (同じキーを消し直し、WebView の掃除の ID を作り直すだけ。次に開く WebView が一度だけ消す)
 *
 * signOut.ts は push token の削除のために pushNotifications.ts (通知・端末の情報のモジュール) を読む。
 * AuthProvider がそれらを読まずに済むよう、掃除だけをこのファイルに分けている。
 */

import { clearUserScopedAsyncStorage } from "./user-storage";
import { clearWebViewNativeCookies, requestWebViewUserScopedStorageClear } from "./webViewUserStorageCleanup";

/**
 * 端末の Cookie の置き場を空にする (clearWebViewNativeCookies) の完了を待つか (#1647)。
 *   - "wait": 待ってから戻る。ログアウト・退会 (signOut.ts)・起動時にサーバーが失効と明言したとき。どちらもこのあとに
 *     サインアウトするので、「サインアウトの前に消す」順を保つ
 *   - "background": 始めるだけで待たずに戻る (失敗はログに残すだけ)。起動時に未ログインと決まったとき・SIGNED_OUT。
 *     サインアウトはもう済んでいて待っても順は変わらず、待つと未ログインの画面が出るのがその分 (最大で
 *     WEB_VIEW_NATIVE_COOKIE_CLEAR_TIMEOUT_MS) 遅れるため (ネイティブから知らせが来ない端末で、未ログインで起動するたびに)
 * AsyncStorage の掃除と WebView の localStorage の掃除の依頼は、どちらでも待つ
 */
export type WebViewNativeCookieClearWait = "wait" | "background";

export type ClearUserScopedLocalDataOptions = {
  /** 既定は "wait" (上の型の説明) */
  webViewNativeCookies?: WebViewNativeCookieClearWait;
};

/** ログに出す接頭辞 */
const LOG_PREFIX = "[userScopedLocalData]";

/** 端末の Cookie の置き場を空にする。例外も拒否も外へ出さず、消せなかったときはログに残すだけ */
function clearNativeCookiesQuietly(): Promise<void> {
  try {
    return clearWebViewNativeCookies().then(
      (result) => {
        if (result === "failed") console.warn(`${LOG_PREFIX} could not clear WebView cookies`);
      },
      () => {
        // clearWebViewNativeCookies は拒否しないが、差し替えられたときに備えて受ける
        console.warn(`${LOG_PREFIX} could not clear WebView cookies`);
      },
    );
  } catch {
    // 同上 (同期の例外)
    console.warn(`${LOG_PREFIX} could not clear WebView cookies`);
    return Promise.resolve();
  }
}

/**
 * AsyncStorage の掃除 (渡された関数) と WebView の掃除の依頼を、どちらかが失敗してももう片方は行う。例外は投げない。
 * 端末の Cookie の置き場の掃除は、webViewNativeCookies が "wait" のときだけ完了を待つ
 */
async function clearLocalData(
  clearAsyncStorage: () => Promise<void>,
  webViewNativeCookies: WebViewNativeCookieClearWait,
): Promise<void> {
  try {
    await clearAsyncStorage();
  } catch {
    // ローカルデータの掃除に失敗しても、サインアウトは続ける
  }
  try {
    await requestWebViewUserScopedStorageClear();
  } catch {
    // 同上
  }
  const nativeCookiesCleared = clearNativeCookiesQuietly();
  if (webViewNativeCookies === "wait") await nativeCookiesCleared;
}

/**
 * 端末に残る利用者別のデータを消す。サインアウトの前に呼ぶ。失敗してもサインアウトは続けるので、例外は投げない。
 * 端末の Cookie の置き場の掃除の完了は、既定では待つ。起動時に未ログインと決まったときは
 * { webViewNativeCookies: "background" } で待たない (WebViewNativeCookieClearWait)
 */
export async function clearUserScopedLocalData(
  userId: string | null | undefined,
  options: ClearUserScopedLocalDataOptions = {},
): Promise<void> {
  await clearLocalData(() => clearUserScopedAsyncStorage(userId ?? null), options.webViewNativeCookies ?? "wait");
}

/**
 * SIGNED_OUT (supabase-js がセッションを消したあと) の掃除。AuthProvider だけが使う (#1615)。
 * clearUserScopedLocalData と同じものを消すが、この端末の push token の値 (push_token_value_v1:<利用者>) だけは残す
 * (user-storage.ts の ClearUserScopedAsyncStorageOptions の keepPushTokenValue)。SIGNED_OUT は、ログアウト (signOut.ts) が
 * その値を読んで user_push_tokens の行を消すより前に届くことがあるため (Web の session-expired で getUser() が端末のセッションを
 * 消したときなど。AuthProvider.tsx の先頭の表)。値は、ログアウトが行を消したあとの掃除 (clearUserScopedLocalData) で消える。
 * 端末の Cookie の置き場の掃除の完了は待たない (サインアウトは済んでいる。WebViewNativeCookieClearWait の "background")。
 * 例外は投げない
 */
export async function clearUserScopedLocalDataAfterSignedOut(userId: string | null | undefined): Promise<void> {
  await clearLocalData(() => clearUserScopedAsyncStorage(userId ?? null, { keepPushTokenValue: true }), "background");
}
