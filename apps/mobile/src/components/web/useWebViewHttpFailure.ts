import { useCallback, useState } from 'react';

/** react-native-webview の onHttpError が渡すイベントのうち、使う部分 */
type HttpErrorEvent = { nativeEvent: { statusCode: number } };

/**
 * メインのページが 5xx (サーバー側の失敗) で返ってきたことを覚える (#1049 F7-15)。
 *
 * - onHttpError は、メインのページ (最上位のフレーム) の HTTP エラーだけに呼ばれる。
 * - 4xx (404 や 403 など) は、Web 側のページに案内が出ているので、アプリでは何もしない。
 * - 新しい読み込みが始まったら (onLoadStart) 覚えた失敗を消す。
 *   「再読み込み」やタブの再タップでの読み直しが成功したのに、失敗の表示が残らないようにする。
 *   なお、失敗する読み込みでも onLoadStart → onHttpError の順で来るので、失敗の表示は消えない。
 */
export function useWebViewHttpFailure() {
  const [statusCode, setStatusCode] = useState<number | null>(null);

  const onHttpError = useCallback((event: HttpErrorEvent) => {
    const code = event.nativeEvent.statusCode;
    if (code >= 500) setStatusCode(code);
  }, []);

  const onLoadStart = useCallback(() => {
    setStatusCode(null);
  }, []);

  return { statusCode, onHttpError, onLoadStart };
}
