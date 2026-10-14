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
 */

import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  USER_SCOPED_LOCAL_STORAGE_KEYS,
  USER_SCOPED_LOCAL_STORAGE_KEY_PREFIXES,
  USER_SCOPED_STORAGE_CLEARED_EVENT,
} from "@homegohan/shared";

/** AsyncStorage: 最後に頼んだ掃除の ID (ネイティブのログアウトの印)。利用者別のデータではないので、ログアウトでは消さない */
export const WEB_VIEW_STORAGE_CLEAR_REQUEST_KEY = "webview_user_scoped_storage_clear_request_v1";

/** WebView の localStorage: 済んだ掃除の ID。全タブの WebView で共有されるので、同じ掃除を二度しない */
export const WEB_VIEW_STORAGE_CLEARED_MARKER_KEY = "homegohan:native-sign-out-cleared";

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

/**
 * WebView の injectedJavaScriptBeforeContentLoaded に入れる、利用者別の localStorage を消す JS。
 * 済んだ掃除の ID (WEB_VIEW_STORAGE_CLEARED_MARKER_KEY) が requestId と違うときだけ、
 * USER_SCOPED_LOCAL_STORAGE_KEYS と、USER_SCOPED_LOCAL_STORAGE_KEY_PREFIXES の接頭辞で始まるキー (#1599) を消し、
 * Web の clearUserScopedLocalStorage() と同じイベントを出してから ID を書く。
 * 途中で失敗したら ID を書かないので、次の読み込みでもう一度消す。
 */
export function buildClearUserScopedWebStorageScript(requestId: string): string {
  return `
(function() {
  try {
    var storage = window.localStorage;
    var MARKER_KEY = ${JSON.stringify(WEB_VIEW_STORAGE_CLEARED_MARKER_KEY)};
    var REQUEST_ID = ${JSON.stringify(requestId)};
    if (storage.getItem(MARKER_KEY) === REQUEST_ID) return;
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
