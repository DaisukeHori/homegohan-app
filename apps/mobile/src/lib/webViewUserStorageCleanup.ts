/**
 * ネイティブのログアウト・退会のあとに、WebView の利用者別の localStorage を消す (#1037)。
 *
 * なぜ要るか:
 *   アプリの中のログアウト・退会はネイティブの設定画面だけで行う (#1037)。Web の画面のログアウトは signOut の前に
 *   clearUserScopedLocalStorage() (src/lib/user-storage.ts) で利用者別の localStorage を消していたが、ネイティブの経路は
 *   その掃除を通らない。WebView の中の SIGNED_OUT でも Web は localStorage を消さない (src/app/(main)/MainLayout.tsx。
 *   借り物のセッションの更新の失敗と区別できないため)。WebView は domStorageEnabled で、localStorage は端末に残り、
 *   全タブの WebView で共有される。そのままでは共有端末の次の利用者に、前の利用者の v4_range_days・
 *   profile_reminder_dismissed・生成の進行状況などが残る。
 *
 * やり方 (ログアウトの印をネイティブが持ち、次に WebView を開いたとき、Web のページが読み込まれる前に消す):
 *   1. ログアウト・退会の後始末 (signOut.ts) が、サインアウトの前に requestWebViewUserScopedStorageClear() を呼ぶ。
 *      毎回新しい掃除の ID を作り、AsyncStorage (と、このプロセスのメモリ) に置く。
 *   2. WebViewScreen は WebView を開くとき readPendingWebViewUserScopedStorageClear() で ID を読み、
 *      buildClearUserScopedWebStorageScript(ID) を injectedJavaScriptBeforeContentLoaded の先頭に入れる。
 *   3. 注入した JS は、WebView の localStorage に置いた「済んだ掃除の ID」と比べ、違えば
 *      利用者別のキーを消してから ID を書く。同じなら何もしない。
 *
 * この方法を選んだ理由:
 *   - 開いている WebView は、ログアウトでセッションが消えると (tabs)/_layout.tsx の Redirect でタブごと外れる。
 *     次の利用者が開くのは新しく作られた WebView なので、「開くとき」に消せば、一度もマウントされていないタブも含めて漏れない。
 *     開いている WebView へ injectJavaScript で送る方法は、開いていないタブには届かない。
 *   - WebView の記憶領域ごと消す API は react-native-webview に無い (incognito は Cookie によるログインの受け渡しも壊す)。
 *   - injectedJavaScriptBeforeContentLoaded は、同じ WebView の以後の読み込み (タブの再タップでの読み込み直しなど) の
 *     たびにも走る。ID で「この掃除は済んだ」を覚えるので、次の利用者がログインしたあとに書いた値は消さない。
 *     ID は全タブの WebView で共有する localStorage に置くので、最初に開いた 1 つが消せば、ほかのタブは何もしない。
 *   - 印 (AsyncStorage の値) は消さずに残す。掃除の済んだかどうかは WebView の側の ID で判定するので、残しても二度は消さない。
 *     利用者別のデータではないので、clearUserScopedAsyncStorage の対象にも入れない。
 *
 * 消すキーの一覧は packages/shared/src/user-scoped-storage.ts (USER_SCOPED_LOCAL_STORAGE_KEYS と、
 * 後ろに ID が付くキーの接頭辞 USER_SCOPED_LOCAL_STORAGE_KEY_PREFIXES) を正にする。
 * Web の clearUserScopedLocalStorage() と同じ一覧で、ここには写さない。一覧にキーを足せば、注入する JS も自動で追随する。
 *
 * ## Cookie (#1612 / #1049 F7-16)
 * WebView の Web のセッションは Cookie (native-bridge が張る Supabase の認証の Cookie。#1036) にある。ネイティブのログアウトは
 * Web の画面のログアウト (supabase.auth.signOut が Cookie を消す) を通らないので、前の利用者の Cookie が WebView に残り、
 * ログアウトをオフラインで行った (サーバーのセッションが失効していない) ときは、次に認証ブリッジ無しで開いた WebView が
 * 前の利用者としてログインしたまま Web のページを出し得た。掃除は同じ経路 (userScopedLocalData.ts → ここ) の上で 2 段で行う。
 *   1. ログアウトの時点 (clearWebViewNativeCookies)。React Native の Networking.clearCookies で、端末の Cookie の置き場を空にする。
 *      - Android: WebView の CookieManager そのもの (RN の ForwardingCookieHandler は android.webkit.CookieManager に転送する)。
 *        HttpOnly も含めてすべて消える。開いていないタブの WebView にも効く。
 *      - iOS: NSHTTPCookieStorage。WebViewScreen は sharedCookiesEnabled なので、react-native-webview (13.13.5) は
 *        WebView を作るたびにここから Cookie を書き戻し (syncCookiesToWebView)、WebView の Cookie が変わるたびにここへ写す
 *        (cookiesDidChangeInCookieStore。足すだけで、消したことは写さない)。ここを空にしないと、WebView の中で消しても
 *        次の WebView に前の利用者の Cookie が戻る。
 *   2. 次に WebView を開いたとき (buildClearUserScopedWebStorageScript の clearAuthCookies)。iOS の WKWebView は自分の
 *      Cookie の置き場 (既定の WKWebsiteDataStore。端末に残る) を持ち、1 ではそこを空にできないので、localStorage の掃除と
 *      同じ注入の JS で、USER_SCOPED_COOKIE_NAME_PREFIXES の接頭辞の Cookie を消す (JS から見える Cookie だけ。
 *      Supabase の認証の Cookie は Web のクライアントが読むので HttpOnly ではない)。
 *      認証ブリッジで開くときは消さない: 注入の JS は、ブリッジのリダイレクトの先のページで、ブリッジがいま張った
 *      新しい利用者の Cookie を見るため。ブリッジは同じ名前の Cookie を上書きするので、前の利用者の Cookie は残らない。
 * 限界: iOS で、1 のあと最初の WebView を認証ブリッジ無しで開いたときの最初の要求は、WKWebView の置き場に残った前の利用者の
 * Cookie を送る (注入の JS は応答を受けたあとに動く)。サーバーのセッションがログアウトで失効していれば、Web の middleware の
 * セッションの確認が失敗して Cookie を消すので、前の利用者として表示されるのは、オフラインでログアウトしたときだけ。
 */

import AsyncStorage from "@react-native-async-storage/async-storage";
import { Networking } from "react-native";
import {
  USER_SCOPED_COOKIE_NAME_PREFIXES,
  USER_SCOPED_LOCAL_STORAGE_KEYS,
  USER_SCOPED_LOCAL_STORAGE_KEY_PREFIXES,
  USER_SCOPED_STORAGE_CLEARED_EVENT,
} from "@homegohan/shared";

/** AsyncStorage: 最後に頼んだ掃除の ID (ネイティブのログアウトの印)。利用者別のデータではないので、ログアウトでは消さない */
export const WEB_VIEW_STORAGE_CLEAR_REQUEST_KEY = "webview_user_scoped_storage_clear_request_v1";

/** WebView の localStorage: 済んだ掃除の ID。全タブの WebView で共有されるので、同じ掃除を二度しない */
export const WEB_VIEW_STORAGE_CLEARED_MARKER_KEY = "homegohan:native-sign-out-cleared";

/**
 * 端末の Cookie の置き場を空にする (Networking.clearCookies) のを待つ上限 (ミリ秒)。
 * ネイティブは消し終わると必ず知らせるが、知らせが来ないときにログアウトを止めないための上限。
 * 端末の上の処理 (ディスクの書き込みを含む) で、通信はしないので、ふつうは数十ミリ秒で終わる。待ちすぎてログアウトの
 * 画面の移動が遅れないよう、利用者が「押したのに止まった」と感じにくい長さにしている。
 */
export const WEB_VIEW_NATIVE_COOKIE_CLEAR_TIMEOUT_MS = 3000;

/** clearWebViewNativeCookies の結果 */
export type WebViewNativeCookieClearResult =
  /** 消した (iOS は消す Cookie が 1 つ以上あった) */
  | "cleared"
  /** 消す Cookie が無かった (iOS) / 消せなかった (Android の removeAllCookies が false) */
  | "nothing"
  /** Networking.clearCookies が無い・例外を投げた・上限の時間までに知らせが来なかった */
  | "failed";

/** Networking のうち、ここで使う部分 (src/types/react-native-networking.d.ts) */
export type CookieClearingNetworking = { clearCookies: (callback: (result: boolean) => void) => void };

/**
 * ログアウトの時点で、WebView の Cookie の置き場を端末の側から空にする (#1612 / #1049 F7-16。上の「Cookie」の 1)。
 * 例外は投げない (消せなくてもログアウトは続ける)。サインアウトの前でも後でもよいが、ほかの掃除と同じ所 (clearUserScopedLocalData) で呼ぶ。
 * networking はテストで差し替えるためのもので、アプリでは React Native の Networking を使う。
 */
export function clearWebViewNativeCookies(
  networking: Partial<CookieClearingNetworking> | undefined = Networking,
): Promise<WebViewNativeCookieClearResult> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (result: WebViewNativeCookieClearResult) => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      resolve(result);
    };
    try {
      const clearCookies = networking?.clearCookies;
      if (typeof clearCookies !== "function") {
        finish("failed");
        return;
      }
      timer = setTimeout(() => finish("failed"), WEB_VIEW_NATIVE_COOKIE_CLEAR_TIMEOUT_MS);
      clearCookies.call(networking, (result) => finish(result === true ? "cleared" : "nothing"));
    } catch {
      finish("failed");
    }
  });
}

/**
 * このプロセスで頼んだ掃除の ID。AsyncStorage への書き込みが失敗しても、このプロセスの間に開く WebView では消せるよう、
 * メモリにも持つ。
 */
let requestedInThisProcess: string | null = null;

/**
 * AsyncStorage を読めなかったときに使う掃除の ID。印があるかどうか分からないときは、漏らさない側に倒して消す。
 * プロセスごとに 1 つの値にするので、同じプロセスの中の読み込み直しのたびには消さない (次の起動で一度だけ消し直す)。
 */
const UNREADABLE_REQUEST_ID = `unreadable-${Date.now()}`;

function createRequestId(): string {
  return `${Date.now()}-${Math.random()}`;
}

/**
 * ネイティブのログアウト・退会で、次に開く WebView に利用者別の localStorage を消させる。サインアウトの前に呼ぶ。
 * 例外は投げない (AsyncStorage に書けなくても、このプロセスの間はメモリの ID で消す)。
 */
export async function requestWebViewUserScopedStorageClear(): Promise<void> {
  const requestId = createRequestId();
  requestedInThisProcess = requestId;
  try {
    await AsyncStorage.setItem(WEB_VIEW_STORAGE_CLEAR_REQUEST_KEY, requestId);
  } catch {
    // 書けなくても続ける (このプロセスの間はメモリの ID を使う)
  }
}

/**
 * WebView を開くときに注入する掃除の ID を返す。一度もログアウトしていない端末では null。
 * 例外は投げない。AsyncStorage を読めないときは、漏らさない側に倒して UNREADABLE_REQUEST_ID を返す。
 */
export async function readPendingWebViewUserScopedStorageClear(): Promise<string | null> {
  if (requestedInThisProcess) return requestedInThisProcess;
  try {
    return await AsyncStorage.getItem(WEB_VIEW_STORAGE_CLEAR_REQUEST_KEY);
  } catch {
    return UNREADABLE_REQUEST_ID;
  }
}

export type ClearUserScopedWebStorageScriptOptions = {
  /**
   * USER_SCOPED_COOKIE_NAME_PREFIXES の接頭辞の Cookie も消すか (#1612 / #1049 F7-16。上の「Cookie」の 2)。
   * 認証ブリッジで開くときは false にする (ブリッジがいま張った新しい利用者の Cookie を消さないため)。既定は false
   */
  clearAuthCookies?: boolean;
};

/**
 * WebView の injectedJavaScriptBeforeContentLoaded に入れる、利用者別の localStorage (と、頼まれたときは認証の Cookie) を消す JS。
 * 済んだ掃除の ID (WEB_VIEW_STORAGE_CLEARED_MARKER_KEY) が requestId と違うときだけ、
 * USER_SCOPED_LOCAL_STORAGE_KEYS と、USER_SCOPED_LOCAL_STORAGE_KEY_PREFIXES の接頭辞で始まるキー (#1599) を消し、
 * clearAuthCookies なら USER_SCOPED_COOKIE_NAME_PREFIXES の接頭辞の Cookie を消し、
 * Web の clearUserScopedLocalStorage() と同じイベントを出してから ID を書く。
 * localStorage の掃除の途中で失敗したら ID を書かないので、次の読み込みでもう一度消す。
 * Cookie を消すのに失敗しても localStorage の掃除と ID の書き込みは続ける (Cookie はログアウトの時点で端末の側からも消している)。
 */
export function buildClearUserScopedWebStorageScript(
  requestId: string,
  options: ClearUserScopedWebStorageScriptOptions = {},
): string {
  return `
(function() {
  try {
    var storage = window.localStorage;
    var MARKER_KEY = ${JSON.stringify(WEB_VIEW_STORAGE_CLEARED_MARKER_KEY)};
    var REQUEST_ID = ${JSON.stringify(requestId)};
    if (storage.getItem(MARKER_KEY) === REQUEST_ID) return;
    if (${JSON.stringify(options.clearAuthCookies === true)}) {
      try {
        var COOKIE_PREFIXES = ${JSON.stringify(USER_SCOPED_COOKIE_NAME_PREFIXES)};
        var pairs = document.cookie ? document.cookie.split(';') : [];
        for (var c = 0; c < pairs.length; c++) {
          var name = pairs[c].split('=')[0].replace(/^\\s+|\\s+$/g, '');
          if (!name) continue;
          for (var p = 0; p < COOKIE_PREFIXES.length; p++) {
            if (name.indexOf(COOKIE_PREFIXES[p]) === 0) {
              // Web は Path=/ で張るので、同じ Path を付けて期限切れにする (省略すると今のページの Path になり消えない)
              document.cookie = name + '=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/';
              break;
            }
          }
        }
      } catch (cookieError) {
        // Cookie を消せなくても localStorage の掃除は続ける
      }
    }
    var KEYS = ${JSON.stringify(USER_SCOPED_LOCAL_STORAGE_KEYS)};
    for (var i = 0; i < KEYS.length; i++) storage.removeItem(KEYS[i]);
    var PREFIXES = ${JSON.stringify(USER_SCOPED_LOCAL_STORAGE_KEY_PREFIXES)};
    var prefixed = [];
    for (var j = 0; j < storage.length; j++) {
      var key = storage.key(j);
      if (key === null) continue;
      for (var k = 0; k < PREFIXES.length; k++) {
        if (key.indexOf(PREFIXES[k]) === 0) {
          prefixed.push(key);
          break;
        }
      }
    }
    for (var m = 0; m < prefixed.length; m++) storage.removeItem(prefixed[m]);
    try {
      window.dispatchEvent(new Event(${JSON.stringify(USER_SCOPED_STORAGE_CLEARED_EVENT)}));
    } catch (e) {}
    storage.setItem(MARKER_KEY, REQUEST_ID);
  } catch (e) {
    // localStorage を使えないときは何もしない (次の読み込みでもう一度試す)
  }
})();
true;
`;
}

/** テスト用: このプロセスで頼んだ掃除の ID を忘れる */
export function resetWebViewUserStorageCleanupForTests(): void {
  requestedInThisProcess = null;
}
