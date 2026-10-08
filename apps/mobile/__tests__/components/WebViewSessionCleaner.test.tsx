/**
 * WebViewSessionCleaner.test.tsx
 * src/components/web/WebViewSessionCleaner.tsx のテスト (#1049 F7-16)
 *
 * ログアウト (SIGNED_OUT) のたびに、画面に出さない WebView で前のユーザーの Web 側の状態を消す。
 *  - 普段は何も描画しない
 *  - SIGNED_OUT で、Web のオリジンを基点にした空の HTML + 消す JavaScript の WebView を置く
 *  - 消し終わった知らせ / 上限の時間 / 読み込みの失敗 / 次のログイン (SIGNED_IN) で片付ける
 */

import React from 'react';
import { act, render, screen } from '@testing-library/react-native';

const WEB_BASE_URL = 'https://web.example.com';
process.env.EXPO_PUBLIC_WEB_URL = WEB_BASE_URL;

// ── react-native-webview モック ────────────────────────────────────────────────
// 描画された WebView の props をテスト側から検査できるようにする
let mockWebViewProps: Record<string, any> | null = null;
jest.mock('react-native-webview', () => ({
  WebView: (props: Record<string, any>) => {
    mockWebViewProps = props;
    const { View } = require('react-native');
    return <View testID={props.testID ?? 'webview'} />;
  },
}));

// ── supabase モック: onAuthStateChange のコールバックを捕まえて、テストから認証イベントを流す ──
let mockAuthListener: ((event: string, session: unknown) => void) | null = null;
const mockUnsubscribe = jest.fn();
jest.mock('../../src/lib/supabase', () => ({
  supabase: {
    auth: {
      onAuthStateChange: (cb: (event: string, session: unknown) => void) => {
        mockAuthListener = cb;
        return { data: { subscription: { unsubscribe: mockUnsubscribe } } };
      },
    },
  },
}));

import { WebViewSessionCleaner } from '../../src/components/web/WebViewSessionCleaner';
import {
  WEBVIEW_SESSION_CLEARED_MESSAGE,
  WEBVIEW_SESSION_CLEANUP_HTML,
  WEBVIEW_SESSION_CLEANUP_TIMEOUT_MS,
  buildWebViewSessionCleanupScript,
} from '../../src/lib/webViewSessionCleanup';

// 隠した WebView は、アクセシビリティからも隠している (importantForAccessibility="no-hide-descendants") ので、
// RNTL の既定の検索には出てこない。hidden: true で探す
const queryCleaner = () => screen.queryByTestId('webview-session-cleaner', { hidden: true });
const getCleaner = () => screen.getByTestId('webview-session-cleaner', { hidden: true });

function emit(event: string) {
  act(() => {
    mockAuthListener?.(event, null);
  });
}

function sendMessage(data: string) {
  act(() => {
    mockWebViewProps?.onMessage?.({ nativeEvent: { data } });
  });
}

beforeEach(() => {
  jest.useFakeTimers();
  mockWebViewProps = null;
  mockAuthListener = null;
  mockUnsubscribe.mockClear();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('WebViewSessionCleaner', () => {
  it('普段は何も描画しない。認証状態の変化を購読する', () => {
    render(<WebViewSessionCleaner />);

    expect(queryCleaner()).toBeNull();
    expect(mockAuthListener).not.toBeNull();
  });

  it('SIGNED_OUT で、Web のオリジンを基点にした空の HTML と消す JavaScript の WebView を置く', () => {
    render(<WebViewSessionCleaner />);

    emit('SIGNED_OUT');

    expect(getCleaner()).toBeTruthy();
    expect(mockWebViewProps?.source).toEqual({ html: WEBVIEW_SESSION_CLEANUP_HTML, baseUrl: WEB_BASE_URL });
    expect(mockWebViewProps?.injectedJavaScript).toBe(buildWebViewSessionCleanupScript());
    // Web の localStorage に触れるには DOM ストレージが有効である必要がある
    expect(mockWebViewProps?.javaScriptEnabled).toBe(true);
    expect(mockWebViewProps?.domStorageEnabled).toBe(true);
  });

  it('画面には出さず、操作も受け付けない (1px・透明・タップ不可)', () => {
    render(<WebViewSessionCleaner />);

    emit('SIGNED_OUT');

    expect(mockWebViewProps?.style).toMatchObject({ position: 'absolute', width: 1, height: 1, opacity: 0 });
    expect(mockWebViewProps?.pointerEvents).toBe('none');
    expect(mockWebViewProps?.accessible).toBe(false);
  });

  it('消し終わった知らせが届いたら片付ける', () => {
    render(<WebViewSessionCleaner />);
    emit('SIGNED_OUT');

    sendMessage(JSON.stringify({ type: WEBVIEW_SESSION_CLEARED_MESSAGE }));

    expect(queryCleaner()).toBeNull();
  });

  it('関係の無いメッセージや壊れたメッセージでは片付けない', () => {
    render(<WebViewSessionCleaner />);
    emit('SIGNED_OUT');

    sendMessage(JSON.stringify({ type: 'tab-navigate' }));
    sendMessage('not json');

    expect(getCleaner()).toBeTruthy();
  });

  it('知らせが来なくても、上限の時間で片付ける', () => {
    render(<WebViewSessionCleaner />);
    emit('SIGNED_OUT');

    act(() => {
      jest.advanceTimersByTime(WEBVIEW_SESSION_CLEANUP_TIMEOUT_MS - 1);
    });
    expect(getCleaner()).toBeTruthy();

    act(() => {
      jest.advanceTimersByTime(1);
    });
    expect(queryCleaner()).toBeNull();
  });

  it('WebView の読み込みが失敗したら (onError / onHttpError) 片付ける', () => {
    render(<WebViewSessionCleaner />);

    emit('SIGNED_OUT');
    act(() => {
      mockWebViewProps?.onError?.({ nativeEvent: {} });
    });
    expect(queryCleaner()).toBeNull();

    emit('SIGNED_OUT');
    act(() => {
      mockWebViewProps?.onHttpError?.({ nativeEvent: { statusCode: 500 } });
    });
    expect(queryCleaner()).toBeNull();
  });

  it('消している間に次のログイン (SIGNED_IN) が済んだら、新しいセッションを消さないようすぐ片付ける', () => {
    render(<WebViewSessionCleaner />);
    emit('SIGNED_OUT');
    expect(getCleaner()).toBeTruthy();

    emit('SIGNED_IN');

    expect(queryCleaner()).toBeNull();
  });

  it('SIGNED_OUT 以外の認証イベントでは何もしない', () => {
    render(<WebViewSessionCleaner />);

    for (const event of ['INITIAL_SESSION', 'TOKEN_REFRESHED', 'USER_UPDATED', 'PASSWORD_RECOVERY']) {
      emit(event);
    }

    expect(queryCleaner()).toBeNull();
  });

  it('片付けたあとにもう一度ログアウトしたら、また消す', () => {
    render(<WebViewSessionCleaner />);

    emit('SIGNED_OUT');
    sendMessage(JSON.stringify({ type: WEBVIEW_SESSION_CLEARED_MESSAGE }));
    expect(queryCleaner()).toBeNull();

    emit('SIGNED_OUT');
    expect(getCleaner()).toBeTruthy();
  });

  it('片付けたあとは、上限の時間のタイマーが残らない', () => {
    render(<WebViewSessionCleaner />);
    emit('SIGNED_OUT');
    sendMessage(JSON.stringify({ type: WEBVIEW_SESSION_CLEARED_MESSAGE }));

    expect(jest.getTimerCount()).toBe(0);
  });

  it('アンマウントしたら購読を解除する', () => {
    const view = render(<WebViewSessionCleaner />);

    view.unmount();

    expect(mockUnsubscribe).toHaveBeenCalledTimes(1);
  });
});
