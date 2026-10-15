import { useCallback, useRef, useState } from 'react';

/** HTTP のステータスのうち、サーバー側の失敗 (5xx) の下限 (RFC 9110 §15.6) */
export const SERVER_ERROR_STATUS_MIN = 500;

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
 * - 4xx (404 や 403 など) は、Web 側のページに案内が出るので、アプリでは何もしない。
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
  // いまの読み込みで 5xx を受けたか。その読み込みの onLoadEnd で見て、下ろす
  const sawServerErrorRef = useRef(false);

  const onHttpError = useCallback((event: HttpErrorEvent) => {
    const code = event.nativeEvent.statusCode;
    if (code >= SERVER_ERROR_STATUS_MIN) {
      sawServerErrorRef.current = true;
      setStatusCode(code);
    }
  }, []);

  const onLoadEnd = useCallback((event?: unknown) => {
    // iOS のページの中の移動 (history の書き換え) で届く onLoadEnd は、読み込みの終わりではない
    if (isHistoryNavigationEnd(event)) return;

    if (sawServerErrorRef.current) {
      // 5xx を受けた読み込みの終わり: 案内は残す
      sawServerErrorRef.current = false;
      return;
    }
    // 5xx を受けなかった読み込みが終わった: 前の失敗の案内があれば消す (無ければ何も変わらない)
    setStatusCode(null);
  }, []);

  const onLoadError = useCallback(() => {
    // 読み込みそのものが失敗した。案内は renderError が出すので、5xx の案内は消す
    sawServerErrorRef.current = false;
    setStatusCode(null);
  }, []);

  return { statusCode, onHttpError, onLoadEnd, onLoadError };
}
