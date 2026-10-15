import { useCallback, useRef, useState } from 'react';
import { SERVICE_UNAVAILABLE_STATUS } from '@homegohan/shared';

/** HTTP のステータスのうち、サーバー側の失敗 (5xx) の下限 (RFC 9110 §15.6) */
export const SERVER_ERROR_STATUS_MIN = 500;

/**
 * メインのページの HTTP のステータスに、アプリの案内 (WebViewErrorView) を重ねるか。
 *
 * - 4xx: 重ねない (Web 側のページに案内が出る)。
 * - 503 (SERVICE_UNAVAILABLE_STATUS): 重ねない。503 は「サービスを一時的に止めている」状態で
 *   (packages/shared/src/service-unavailable.ts)、Web はメンテナンス中に専用の日本語の画面
 *   (「ただいまメンテナンス中です」・再読み込み・運営の方のログインの導線。src/lib/maintenance-mode.ts の
 *   maintenancePageResponse) を 503 で返す。onHttpError には本文が渡らず status しか分からないので、
 *   503 を「エラー」と断定して覆うと、メンテナンス中の画面が隠れ、利用者に「エラー」と誤って伝わる。
 *   Web のページ (メンテナンス中の画面・ホスティングの 503 の画面) をそのまま見せる。
 * - それ以外の 5xx (500・502・504 など): 重ねる (サーバーのエラーページにはやり直す手段が無い)。
 */
export function shouldCoverHttpStatus(statusCode: number): boolean {
  return statusCode >= SERVER_ERROR_STATUS_MIN && statusCode !== SERVICE_UNAVAILABLE_STATUS;
}

/** react-native-webview の onHttpError が渡すイベントのうち、使う部分 */
type HttpErrorEvent = { nativeEvent: { statusCode: number } };

/**
 * iOS が、ページの中の移動 (history の書き換え) のときに送る onLoadEnd か。
 * このイベントだけが navigationType を持つ (react-native-webview 13.13.5 の apple/RNCWebViewImpl.m の
 * userContentController:didReceiveScriptMessage: で、history の shim からの知らせを onLoadingFinish として送る)。
 * 読み込みの終わりのイベント (iOS の didFinishNavigation / Android の onPageFinished) は navigationType を持たない。
 * onLoadEnd のイベントは、型の上では読み込みの終わりと読み込みの失敗のどちらもあり得るので、unknown で受けて確かめる。
 */
function isHistoryNavigationEnd(event: unknown): boolean {
  if (typeof event !== 'object' || event === null || !('nativeEvent' in event)) return false;
  const { nativeEvent } = event;
  if (typeof nativeEvent !== 'object' || nativeEvent === null || !('navigationType' in nativeEvent)) return false;
  return typeof nativeEvent.navigationType === 'string';
}

/**
 * メインのページが 5xx (サーバー側の失敗) で返ってきたことを覚える (#1612 / #1049 F7-15)。
 *
 * - onHttpError は、メインのページ (最上位のフレーム) の HTTP エラーにだけ呼ばれる。
 * - 4xx (404 や 403 など) と 503 (メンテナンス中など) は、Web 側のページに案内が出るので、アプリでは何もしない
 *   (shouldCoverHttpStatus)。
 * - 失敗の表示を消すのは、5xx を受けなかった読み込みが終わったとき (onLoadEnd) と、読み込みそのものが失敗したとき (onError)。
 *   「再読み込み」やタブの再タップでの読み直しが成功したのに、失敗の表示が残らないようにする。
 *
 * 消す条件に onLoadStart を使わないのは、onLoadStart と onHttpError の順序が OS で逆だから
 * (react-native-webview 13.13.5 の実装):
 *   - iOS:     onLoadStart → onHttpError → onLoadEnd
 *              (onLoadStart は decidePolicyForNavigationAction、onHttpError は decidePolicyForNavigationResponse で送る)
 *   - Android: onHttpError → onLoadStart → onLoadEnd
 *              (onLoadStart は doUpdateVisitedHistory = ページの確定で送る。onHttpError は onReceivedHttpError =
 *               応答のヘッダーを受けた時点で送るので、確定より前に来る)
 * 「onLoadStart が来たら消す」だと、Android では 5xx を覚えた直後に、同じ読み込みの onLoadStart で消してしまい、
 * 案内が一度も出ないまま、サーバーのエラーページがそのまま見える。
 * onLoadEnd は、どちらの OS でも onHttpError より後に来る (応答のあとに読み込みが終わるため)。
 * 5xx を受けた読み込みの onLoadEnd では消さず、受けなかった読み込みの onLoadEnd で消す。
 * 503 は「受けなかった」側に数える (500 の案内が出ている間にタブの再タップで読み直した先がメンテナンス中の画面なら、案内を消して見せる)。
 *
 * 次の onLoadEnd は読み込みの終わりではないので数えない:
 *   - iOS は、ページの中の移動 (history.pushState / replaceState / 戻る) のたびにも onLoadEnd を送る
 *     (isHistoryNavigationEnd)。5xx のエラーページ自身が履歴を書き換えても、案内が消えないようにする。
 *
 * 読み込みそのものの失敗 (オフライン・DNS・接続など) は onError で受け、5xx の案内を消す。
 * そのときは WebView の renderError が「通信に失敗しました」の案内を出すので、二重に出さない。
 */
export function useWebViewHttpFailure() {
  const [statusCode, setStatusCode] = useState<number | null>(null);
  // いまの読み込みで、案内を重ねる 5xx (503 を除く) を受けたか。その読み込みの onLoadEnd で見て、下ろす
  const sawServerErrorRef = useRef(false);

  const onHttpError = useCallback((event: HttpErrorEvent) => {
    const code = event.nativeEvent.statusCode;
    if (shouldCoverHttpStatus(code)) {
      sawServerErrorRef.current = true;
      setStatusCode(code);
    }
  }, []);

  const onLoadEnd = useCallback((event?: unknown) => {
    // iOS のページの中の移動 (history の書き換え) で届く onLoadEnd は、読み込みの終わりではない
    if (isHistoryNavigationEnd(event)) return;

    if (sawServerErrorRef.current) {
      // 案内を重ねる 5xx を受けた読み込みの終わり: 案内は残す
      sawServerErrorRef.current = false;
      return;
    }
    // 案内を重ねる 5xx を受けなかった読み込み (成功・4xx・503) が終わった: 前の失敗の案内があれば消す (無ければ何も変わらない)
    setStatusCode(null);
  }, []);

  const onLoadError = useCallback(() => {
    // 読み込みそのものが失敗した。案内は renderError が出すので、5xx の案内は消す
    sawServerErrorRef.current = false;
    setStatusCode(null);
  }, []);

  return { statusCode, onHttpError, onLoadEnd, onLoadError };
}
