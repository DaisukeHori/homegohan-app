/**
 * useWebViewHttpFailure.test.tsx
 * メインのページが 5xx で返ってきたことを覚えるフックのテスト (#1049 F7-15)
 *
 * このフックは、失敗の表示を消す条件に onLoadStart を使わない。onLoadStart と onHttpError の順序が OS で逆だから
 * (react-native-webview 13.13.5 の実装):
 *   iOS:     onLoadStart → onHttpError → onLoadEnd
 *   Android: onHttpError → onLoadStart → onLoadEnd
 *            (onLoadStart は doUpdateVisitedHistory = ページの確定で発火し、応答ヘッダーを受けた時点の onHttpError より遅い)
 * 以前は「onLoadStart が来たら消す」だったため、Android では 5xx を覚えた直後に、同じ読み込みの onLoadStart で
 * 消えてしまい、案内が一度も出なかった。onHttpError と onLoadEnd だけで決めるので、OS の順序に依らない。
 * (画面に配線された状態で、両 OS の順にイベントを流すテストは WebViewScreen.error.test.tsx にある)
 */

import { act, renderHook } from '@testing-library/react-native';

import { useWebViewHttpFailure } from '../../src/components/web/useWebViewHttpFailure';

const httpError = (statusCode: number) => ({ nativeEvent: { statusCode } });

function setup() {
  const { result } = renderHook(() => useWebViewHttpFailure());
  return {
    result,
    /** onHttpError(statusCode) */
    http: (statusCode: number) => act(() => result.current.onHttpError(httpError(statusCode))),
    /** 読み込みの終わり (iOS の didFinishNavigation / Android の onPageFinished) */
    end: () => act(() => result.current.onLoadEnd({ nativeEvent: {} })),
  };
}

describe('useWebViewHttpFailure — 5xx を受けた読み込み', () => {
  it('最初は失敗なし', () => {
    const { result } = setup();

    expect(result.current.statusCode).toBeNull();
  });

  it('5xx を受けたら、ステータスを覚える (読み込みが終わる前から)', () => {
    const { result, http } = setup();

    http(503);

    expect(result.current.statusCode).toBe(503);
  });

  it('5xx を受けた読み込みが終わっても、覚えたまま (案内を消さない)', () => {
    const { result, http, end } = setup();

    http(503);
    end();

    expect(result.current.statusCode).toBe(503);
  });

  it('500〜599 が対象。499 以下 (4xx など) は覚えない', () => {
    const { result, http } = setup();

    http(404);
    http(403);
    http(499);
    expect(result.current.statusCode).toBeNull();

    http(500);
    expect(result.current.statusCode).toBe(500);

    http(599);
    expect(result.current.statusCode).toBe(599);
  });

  it('続けて 5xx を受けたら、新しいステータスにする', () => {
    const { result, http, end } = setup();

    http(503);
    end();
    http(502);
    end();

    expect(result.current.statusCode).toBe(502);
  });
});

describe('useWebViewHttpFailure — 失敗の表示を消す条件', () => {
  it('5xx を受けなかった読み込みが終わったら (読み直しが成功したら)、消す', () => {
    const { result, http, end } = setup();
    http(503);
    end();
    expect(result.current.statusCode).toBe(503);

    // 次の読み込みは HTTP エラー無しで終わる
    end();

    expect(result.current.statusCode).toBeNull();
  });

  it('4xx で終わった読み込みも、5xx の失敗ではないので、前の 5xx の案内は消す', () => {
    const { result, http, end } = setup();
    http(503);
    end();

    http(404);
    end();

    expect(result.current.statusCode).toBeNull();
  });

  it('消したあとの 5xx は、また覚える', () => {
    const { result, http, end } = setup();
    http(503);
    end();
    end();
    expect(result.current.statusCode).toBeNull();

    http(504);
    end();

    expect(result.current.statusCode).toBe(504);
  });

  it('失敗なしのとき、読み込みが終わっても何も変わらない (最初の読み込みなど)', () => {
    const { result, end } = setup();

    end();
    end();

    expect(result.current.statusCode).toBeNull();
  });

  it('onLoadEnd にイベントが渡されなくても動く', () => {
    const { result, http } = setup();
    act(() => result.current.onHttpError(httpError(503)));
    act(() => result.current.onLoadEnd());
    expect(result.current.statusCode).toBe(503);

    act(() => result.current.onLoadEnd());
    expect(result.current.statusCode).toBeNull();
    // 以降も使える
    http(500);
    expect(result.current.statusCode).toBe(500);
  });
});

describe('useWebViewHttpFailure — iOS のページ内の移動で届く onLoadEnd', () => {
  // iOS の react-native-webview は、history.pushState / replaceState / 戻る のたびに onLoadEnd も送る
  // (navigationType が付く。読み込みの終わりのイベントには付かない)。読み込みの終わりとして数えない。
  const historyEnd = (navigationType: 'other' | 'backforward') => ({ nativeEvent: { navigationType } });

  it('5xx のエラーページ自身が履歴を書き換えても、案内を消さない', () => {
    const { result, http, end } = setup();
    http(500);
    end(); // 5xx を受けた読み込みの終わり

    act(() => result.current.onLoadEnd(historyEnd('other')));
    act(() => result.current.onLoadEnd(historyEnd('backforward')));

    expect(result.current.statusCode).toBe(500);
  });

  it('読み込みの終わりより前に届いても、5xx を受けた読み込みの終わりとして数えない', () => {
    const { result, http, end } = setup();
    http(500);

    // 先にページ内の移動のイベントが来ても、「5xx を受けた読み込み」の印は残る
    act(() => result.current.onLoadEnd(historyEnd('other')));
    expect(result.current.statusCode).toBe(500);
    end();
    expect(result.current.statusCode).toBe(500);

    // 次の (5xx を受けない) 読み込みの終わりで消える
    end();
    expect(result.current.statusCode).toBeNull();
  });

  it('5xx を受けなかった読み込みのあとのページ内の移動では、何も起きない', () => {
    const { result, end } = setup();
    end();

    act(() => result.current.onLoadEnd(historyEnd('other')));

    expect(result.current.statusCode).toBeNull();
  });
});

describe('useWebViewHttpFailure — ハンドラーの安定性', () => {
  it('再描画してもハンドラーの参照は変わらない (WebView の props を無駄に更新しない)', () => {
    const { result, http } = setup();
    const { onHttpError, onLoadEnd } = result.current;

    http(503);

    expect(result.current.onHttpError).toBe(onHttpError);
    expect(result.current.onLoadEnd).toBe(onLoadEnd);
  });
});
