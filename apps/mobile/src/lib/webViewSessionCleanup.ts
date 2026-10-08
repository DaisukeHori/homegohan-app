/**
 * ネイティブでログアウトしたとき、WebView (Web) 側に残る前のユーザーの状態を消す仕組みの部品 (#1049 F7-16)。
 *
 * ネイティブのログアウトが消していたのは、ネイティブ側の AsyncStorage とセッションだけだった。
 * WebView は Web 版の Cookie (Supabase のセッション Cookie、is_native_app) と localStorage / sessionStorage を
 * ログアウトのあとも持ち続けるので、同じ端末で別のユーザーがログインすると、前のユーザーの Web 側の状態
 * (下書き・表示設定・生成中のフラグなど) が残って見える可能性があった。
 *
 * 消す方法: Web のオリジンを基点にした空のページを、画面に出さない WebView (WebViewSessionCleaner) で開き、
 * そのページの中で JavaScript を実行して、そのオリジンの Cookie / localStorage / sessionStorage / IndexedDB /
 * Cache Storage を消す。ネットワークは使わない (HTML は文字列で渡す) ので、オフラインでもログアウトできる。
 * WebView のデータは、同じアプリの WebView 全部で共有されるので、タブの WebView を開いていなくても消せる。
 *
 * 限界:
 *  - JavaScript から見えない Cookie (HttpOnly) は消せない。Web の Supabase セッション Cookie は HttpOnly ではない
 *    (ブラウザ側の Supabase クライアントが読むため)。サーバー側のセッションは、ネイティブの signOut が失効させる。
 *  - 消すのはベストエフォート。失敗してもログアウトは止めない。
 */

/** 消し終わったことを、隠した WebView からアプリへ知らせるメッセージの type */
export const WEBVIEW_SESSION_CLEARED_MESSAGE = 'webview-session-cleared';

/** 消し終わるのを待つ上限 (ミリ秒)。これを過ぎたら、隠した WebView を片付ける */
export const WEBVIEW_SESSION_CLEANUP_TIMEOUT_MS = 5000;

/**
 * 隠した WebView に渡す HTML。中身は空で、消す処理は injectedJavaScript (ページの読み込みが終わってから実行される)
 * で行う。ページの <script> に書かないのは、Android では window.ReactNativeWebView が
 * ページの読み込みが始まってから少し遅れて使えるようになるため (完了の知らせを送れなくなるのを避ける)。
 */
export const WEBVIEW_SESSION_CLEANUP_HTML =
  '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head><body></body></html>';

/**
 * WebView の中で実行する、状態を消す JavaScript。
 * どの手順も try/catch で囲み、1 つが失敗しても残りを続ける。最後に完了のメッセージを送る。
 * 戻り値の true は react-native-webview の injectedJavaScript の決まり (最後の式が真であること)。
 */
export function buildWebViewSessionCleanupScript(): string {
  return `
(function () {
  function safely(fn) {
    try { fn(); } catch (e) {}
  }

  safely(function () { window.localStorage.clear(); });
  safely(function () { window.sessionStorage.clear(); });

  // Cookie: JavaScript から見えるものを、名前ごとに消す (期限を過去にする)。
  // Web 側は Path=/ で設定しているので、同じ Path を明示する (省略すると今のページの Path 扱いになり消えない)
  safely(function () {
    var pairs = document.cookie ? document.cookie.split(';') : [];
    for (var i = 0; i < pairs.length; i++) {
      var name = pairs[i].split('=')[0].replace(/^\\s+|\\s+$/g, '');
      if (!name) continue;
      document.cookie = name + '=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/';
    }
  });

  // IndexedDB と Cache Storage は非同期。消し終わるのを待ってから完了を知らせる
  // (知らせを受けるとアプリは WebView を片付けるので、先に知らせると途中で止まる)
  var pending = [];

  safely(function () {
    if (window.indexedDB && typeof window.indexedDB.databases === 'function') {
      pending.push(
        window.indexedDB.databases().then(function (dbs) {
          return Promise.all(
            dbs.map(function (db) {
              return new Promise(function (resolve) {
                if (!db || !db.name) return resolve();
                var request = window.indexedDB.deleteDatabase(db.name);
                request.onsuccess = request.onerror = request.onblocked = function () { resolve(); };
              });
            })
          );
        })
      );
    }
  });

  safely(function () {
    if (window.caches && typeof window.caches.keys === 'function') {
      pending.push(
        window.caches.keys().then(function (keys) {
          return Promise.all(keys.map(function (key) { return window.caches.delete(key); }));
        })
      );
    }
  });

  function notifyDone() {
    safely(function () {
      window.ReactNativeWebView.postMessage(JSON.stringify({ type: ${JSON.stringify(WEBVIEW_SESSION_CLEARED_MESSAGE)} }));
    });
  }

  // 失敗しても完了は知らせる (ベストエフォート)
  safely(function () {
    Promise.all(pending).then(notifyDone, notifyDone);
  });
})();
true;
`;
}

/** WebView から届いたメッセージ (文字列) が、消し終わった知らせか */
export function isWebViewSessionClearedMessage(data: unknown): boolean {
  if (typeof data !== 'string') return false;
  try {
    const parsed: unknown = JSON.parse(data);
    return (
      typeof parsed === 'object' &&
      parsed !== null &&
      (parsed as { type?: unknown }).type === WEBVIEW_SESSION_CLEARED_MESSAGE
    );
  } catch {
    return false;
  }
}
