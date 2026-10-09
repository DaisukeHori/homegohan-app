import { useCallback, useRef, useState } from 'react';

/** react-native-webview の onHttpError が渡すイベントのうち、使う部分 */
type HttpErrorEvent = { nativeEvent: { statusCode: number } };

/**
 * iOS が、ページ内の移動 (history の書き換え) のときに送る onLoadEnd か。
 * このイベントだけが navigationType を持つ。読み込みの終わりのイベント (iOS の didFinishNavigation / Android の onPageFinished) は持たない。
 * onLoadEnd のイベントは、型の上では読み込みの終わりと読み込みの失敗のどちらもあり得るので、unknown で受けて確かめる。
 */
function isHistoryNavigationEnd(event: unknown): boolean {
  const nativeEvent = (event as { nativeEvent?: { navigationType?: unknown } } | null | undefined)?.nativeEvent;
  return typeof nativeEvent?.navigationType === 'string';
}

/**
 * メインのページが 5xx (サーバー側の失敗) で返ってきたことを覚える (#1049 F7-15)。
 *
 * - onHttpError は、メインのページ (最上位のフレーム) の HTTP エラーだけに呼ばれる。
 * - 4xx (404 や 403 など) は、Web 側のページに案内が出ているので、アプリでは何もしない。
 * - 失敗の表示を消すのは、5xx を受けなかった読み込みが終わったとき (onLoadEnd) だけ。
 *   「再読み込み」やタブの再タップでの読み直しが成功したのに、失敗の表示が残らないようにする。
 *
 * 消す条件に onLoadStart を使わないのは、onLoadStart と onHttpError の順序が OS で逆だから
 * (react-native-webview 13.13.5 の実装):
 *   - iOS:     onLoadStart → onHttpError → onLoadEnd
 *              (onLoadStart は decidePolicyForNavigationAction、onHttpError は decidePolicyForNavigationResponse で発火)
 *   - Android: onHttpError → onLoadStart → onLoadEnd
 *              (onLoadStart は doUpdateVisitedHistory = ページの確定で発火する。onPageStarted では発火しない。
 *               onHttpError は onReceivedHttpError = 応答ヘッダーを受けた時点で発火するので、確定より前に来る)
 * 「onLoadStart が来たら消す」だと、Android では 5xx を覚えた直後に、同じ読み込みの onLoadStart で消してしまい、
 * 案内が一度も出ないまま、サーバーのエラーページがそのまま見える。
 * onLoadEnd は、どちらの OS でも onHttpError より後に来る (応答のあとに読み込みが終わるため)。
 * 5xx を受けた読み込みの onLoadEnd では消さず、受けなかった読み込みの onLoadEnd で消す。
 *
 * 次の onLoadEnd は読み込みの終わりではないので数えない:
 *   - iOS は、ページ内の移動 (history.pushState / replaceState / 戻る) のたびにも onLoadEnd を送る。
 *     このイベントだけが navigationType を持つ (読み込みの終わりのイベントは持たない)。
 *     5xx のエラーページ自身が履歴を書き換えても、案内が消えないようにする。
 *   - Android の onLoadStart は、ページ内の移動でも発火する (doUpdateVisitedHistory)。使わないので影響しない。
 *
 * 読み込みそのものの失敗 (オフライン・DNS・接続など) のときも、ライブラリは onLoadEnd を呼ぶ (onError のあと)。
 * このときは WebView の renderError が「通信に失敗しました」の案内を出すので、前の 5xx の案内は消えてよい。
 */
export function useWebViewHttpFailure() {
  const [statusCode, setStatusCode] = useState<number | null>(null);
  // いまの読み込みで 5xx を受けたか。その読み込みの onLoadEnd で見て、下ろす
  const sawServerErrorRef = useRef(false);

  const onHttpError = useCallback((event: HttpErrorEvent) => {
    const code = event.nativeEvent.statusCode;
    if (code >= 500) {
      sawServerErrorRef.current = true;
      setStatusCode(code);
    }
  }, []);

  const onLoadEnd = useCallback((event?: unknown) => {
    // iOS のページ内の移動 (history の書き換え) で届く onLoadEnd は、読み込みの終わりではない
    if (isHistoryNavigationEnd(event)) return;

    if (sawServerErrorRef.current) {
      // 5xx を受けた読み込みの終わり: 案内は残す
      sawServerErrorRef.current = false;
      return;
    }
    // 5xx を受けなかった読み込みが終わった: 前の失敗の案内があれば消す (無ければ何も変わらない)
    setStatusCode(null);
  }, []);

  return { statusCode, onHttpError, onLoadEnd };
}
