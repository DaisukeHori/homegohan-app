/**
 * #1165: Cloudflare Turnstile のウィジェット (src/components/auth/TurnstileWidget.tsx、モバイル) の RNTL 単体テスト
 *
 * 確かめること:
 *   A. サイトキーが無い (空・空白だけも含む) とき = Turnstile 無効
 *      何も描画せず (WebView も作らない)、ready は常に true、takeToken() は null。
 *   B. サイトキーがあるとき
 *      - WebView に、サイトキー入りの HTML と、Web のベース URL (baseUrl) を渡す
 *      - トークンが無い間は送信できない (ready=false → ボタンが disabled)
 *      - WebView から token が届くと送信できる
 *      - 期限切れ (expired) でトークンを捨て、また送信できなくなる
 *      - takeToken() はトークンを 1 回分として返し、捨てて、WebView を作り直す (送信の二度押しでも同じトークンを 2 回使わない)
 *      - 失敗 (error) では利用者向けの文言と「もう一度確認する」を出し、押すと WebView を作り直す。
 *        Turnstile の自動再試行で成功したら、エラー表示は消える
 *      - 形の違うメッセージは無視する
 *      - 何も知らせが来ないまま 45 秒たったら、失敗として「もう一度確認する」を出す
 *   C. ウィジェットの中のリンク (Cloudflare の「プライバシー」「利用規約」。target="_blank")
 *      - onOpenWindow を WebView に渡す (渡さないと iOS は同じ WebView に読み込んで、ウィジェットを置き換えてしまう)
 *      - https のリンクだけ外のブラウザで開く。ウィジェット (WebView・トークン・表示) はそのまま
 *   D. 文字色 (WCAG AA 4.5:1): 案内文は textLight、赤い文字は塗り用の error ではなく dangerText
 */

import React from 'react';
import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { act, fireEvent, render } from '@testing-library/react-native';

// ---- Mocks (before any component imports) ----

// WebView の props を捕まえて、テストから onMessage を呼べるようにする。
// key が変わって作り直されたら、マウントの回数が増える (mockMounts)。
let mockWebViewProps: Record<string, any> = {};
let mockMounts = 0;
jest.mock('react-native-webview', () => ({
  WebView: (props: any) => {
    const ReactInner = require('react');
    const { View: ViewInner } = require('react-native');
    mockWebViewProps = props;
    ReactInner.useEffect(() => {
      mockMounts += 1;
    }, []);
    return <ViewInner testID={props.testID ?? 'webview'} />;
  },
}));

jest.mock('../../src/theme', () => ({
  colors: {
    bg: '#fff', accent: '#f00', text: '#000', textMuted: '#888',
    textLight: '#666', card: '#fafafa', border: '#eee', error: '#f44', errorLight: '#fee', dangerText: '#b00',
  },
  spacing: { sm: 8, md: 16, lg: 24, xl: 32 },
  radius: { lg: 12 },
  shadows: { sm: {}, md: {} },
}));

// ---- Component import (after mocks) ----
import { TurnstileWidget, useTurnstile } from '../../src/components/auth/TurnstileWidget';
import { DEFAULT_WEB_URL } from '../../src/lib/webBaseUrl';

const SITE_KEY = '1x00000000000000000000AA';

/** このテストの足場: ウィジェット + 送信ボタン。送信すると takeToken() の結果を記録する */
function Harness({ onSubmit }: { onSubmit: (token: string | null) => void }) {
  const captcha = useTurnstile();
  return (
    <View>
      <TurnstileWidget {...captcha.widgetProps} action="login" />
      <Pressable testID="submit" disabled={!captcha.ready} onPress={() => onSubmit(captcha.takeToken())}>
        <Text>送信</Text>
      </Pressable>
    </View>
  );
}

/** WebView の中のスクリプトから、アプリへ postMessage が届いたことにする */
function postFromWebView(message: unknown) {
  act(() => {
    mockWebViewProps.onMessage({
      nativeEvent: { data: typeof message === 'string' ? message : JSON.stringify(message) },
    });
  });
}

const originalSiteKey = process.env.EXPO_PUBLIC_TURNSTILE_SITE_KEY;
const originalWebUrl = process.env.EXPO_PUBLIC_WEB_URL;

beforeEach(() => {
  mockWebViewProps = {};
  mockMounts = 0;
  delete process.env.EXPO_PUBLIC_WEB_URL;
});

afterEach(() => {
  jest.useRealTimers();
  if (originalSiteKey === undefined) delete process.env.EXPO_PUBLIC_TURNSTILE_SITE_KEY;
  else process.env.EXPO_PUBLIC_TURNSTILE_SITE_KEY = originalSiteKey;
  if (originalWebUrl === undefined) delete process.env.EXPO_PUBLIC_WEB_URL;
  else process.env.EXPO_PUBLIC_WEB_URL = originalWebUrl;
});

describe('A. サイトキーが無いとき (Turnstile 無効)', () => {
  it.each([
    ['未設定', undefined],
    ['空文字 (env.example の EXPO_PUBLIC_TURNSTILE_SITE_KEY= のまま)', ''],
    ['空白だけ', '   '],
  ])('%s: 何も描画せず、送信ボタンは押せて、トークンは null', (_label, value) => {
    if (value === undefined) delete process.env.EXPO_PUBLIC_TURNSTILE_SITE_KEY;
    else process.env.EXPO_PUBLIC_TURNSTILE_SITE_KEY = value;
    const submitted: Array<string | null> = [];

    const { queryByTestId, getByTestId } = render(<Harness onSubmit={(t) => submitted.push(t)} />);

    expect(queryByTestId('turnstile')).toBeNull();
    expect(queryByTestId('turnstile-webview')).toBeNull();
    expect(mockMounts).toBe(0);
    expect(getByTestId('submit')).toBeEnabled();

    fireEvent.press(getByTestId('submit'));
    expect(submitted).toEqual([null]);
  });
});

describe('B. サイトキーがあるとき', () => {
  beforeEach(() => {
    process.env.EXPO_PUBLIC_TURNSTILE_SITE_KEY = SITE_KEY;
  });

  it('WebView に、サイトキーと action 入りの HTML と、Web のベース URL (baseUrl) を渡す', () => {
    render(<Harness onSubmit={() => {}} />);

    const { source } = mockWebViewProps;
    expect(source.html).toContain(JSON.stringify({ sitekey: SITE_KEY, action: 'login' }));
    expect(source.html).toContain('https://challenges.cloudflare.com/turnstile/v0/api.js');
    // Turnstile は、動いているページのホスト名が、Cloudflare に登録した許可ホスト名に入っているかを確かめる
    expect(source.baseUrl).toBe(DEFAULT_WEB_URL);
    expect(mockWebViewProps.javaScriptEnabled).toBe(true);
    // Cloudflare の手引き: DOM storage を有効にする
    expect(mockWebViewProps.domStorageEnabled).toBe(true);
  });

  it('EXPO_PUBLIC_WEB_URL を設定していれば、そのオリジンを baseUrl にする', () => {
    process.env.EXPO_PUBLIC_WEB_URL = 'https://staging.example.com';

    render(<Harness onSubmit={() => {}} />);

    expect(mockWebViewProps.source.baseUrl).toBe('https://staging.example.com');
  });

  it('トークンが無い間は送信ボタンが無効で、確認中の案内を出す。押しても送信されない', () => {
    const submitted: Array<string | null> = [];
    const { getByTestId } = render(<Harness onSubmit={(t) => submitted.push(t)} />);

    expect(getByTestId('submit')).toBeDisabled();
    expect(getByTestId('turnstile-hint')).toBeTruthy();

    fireEvent.press(getByTestId('submit'));
    expect(submitted).toEqual([]);
  });

  it('token が届くと送信ボタンが有効になり、案内が消える', () => {
    const { getByTestId, queryByTestId } = render(<Harness onSubmit={() => {}} />);

    postFromWebView({ type: 'token', token: 'tok-1' });

    expect(getByTestId('submit')).toBeEnabled();
    expect(queryByTestId('turnstile-hint')).toBeNull();
  });

  it('送信するとトークンを 1 回分として渡し、WebView を作り直して、また送信できなくする', () => {
    const submitted: Array<string | null> = [];
    const { getByTestId } = render(<Harness onSubmit={(t) => submitted.push(t)} />);
    expect(mockMounts).toBe(1);
    postFromWebView({ type: 'token', token: 'tok-1' });

    fireEvent.press(getByTestId('submit'));

    expect(submitted).toEqual(['tok-1']);
    expect(mockMounts).toBe(2); // key が変わって、WebView ごと作り直された
    expect(getByTestId('submit')).toBeDisabled();

    postFromWebView({ type: 'token', token: 'tok-2' });
    expect(getByTestId('submit')).toBeEnabled();
    fireEvent.press(getByTestId('submit'));
    expect(submitted).toEqual(['tok-1', 'tok-2']);
  });

  it('expired が届くと、トークンを捨てて送信できなくする', () => {
    const { getByTestId } = render(<Harness onSubmit={() => {}} />);
    postFromWebView({ type: 'token', token: 'tok-1' });
    expect(getByTestId('submit')).toBeEnabled();

    postFromWebView({ type: 'expired' });

    expect(getByTestId('submit')).toBeDisabled();
    expect(getByTestId('turnstile-hint')).toBeTruthy();
  });

  it('error が届くと、利用者向けの文言とエラーコードを出し、送信はできないまま', () => {
    const { getByTestId, getByText } = render(<Harness onSubmit={() => {}} />);
    postFromWebView({ type: 'token', token: 'tok-1' });

    postFromWebView({ type: 'error', code: '300030' });

    expect(getByTestId('turnstile-error')).toBeTruthy();
    expect(getByText(/ボットではないことの確認を完了できませんでした/)).toBeTruthy();
    expect(getByText('エラーコード: 300030')).toBeTruthy();
    expect(getByTestId('submit')).toBeDisabled();
  });

  it('「もう一度確認する」を押すと、WebView を作り直して確認し直す', () => {
    const { getByTestId, queryByTestId } = render(<Harness onSubmit={() => {}} />);
    postFromWebView({ type: 'error', code: 'script' });
    expect(mockMounts).toBe(1);

    fireEvent.press(getByTestId('turnstile-retry'));

    expect(mockMounts).toBe(2);
    expect(queryByTestId('turnstile-error')).toBeNull();
    expect(getByTestId('turnstile-hint')).toBeTruthy();
    postFromWebView({ type: 'token', token: 'tok-after-retry' });
    expect(getByTestId('submit')).toBeEnabled();
  });

  it('エラー表示のまま Turnstile の自動再試行が成功したら、案内を戻して送信できる', () => {
    const { getByTestId, queryByTestId } = render(<Harness onSubmit={() => {}} />);
    postFromWebView({ type: 'error', code: '300030' });
    expect(getByTestId('turnstile-error')).toBeTruthy();

    postFromWebView({ type: 'token', token: 'tok-auto' });

    expect(queryByTestId('turnstile-error')).toBeNull();
    expect(getByTestId('submit')).toBeEnabled();
  });

  it('WebView 自体の読み込みに失敗したら (onError)、エラー表示にする', () => {
    const { getByTestId, getByText } = render(<Harness onSubmit={() => {}} />);

    act(() => {
      mockWebViewProps.onError({ nativeEvent: {} });
    });

    expect(getByTestId('turnstile-error')).toBeTruthy();
    expect(getByText('エラーコード: webview')).toBeTruthy();
    expect(getByTestId('submit')).toBeDisabled();
  });

  it.each([
    ['JSON でない文字列', 'not json'],
    ['知らない type', JSON.stringify({ type: 'hello', token: 'tok' })],
    ['空のトークン', JSON.stringify({ type: 'token', token: '' })],
    ['トークンが文字列でない', JSON.stringify({ type: 'token', token: 123 })],
    ['配列', '[1,2,3]'],
  ])('形の違うメッセージ (%s) は無視して、送信できるようにはならない', (_label, data) => {
    const { getByTestId } = render(<Harness onSubmit={() => {}} />);

    postFromWebView(data);

    expect(getByTestId('submit')).toBeDisabled();
    expect(getByTestId('turnstile-hint')).toBeTruthy();
  });

  it('何も知らせが来ないまま 45 秒たったら、失敗として「もう一度確認する」を出す', () => {
    jest.useFakeTimers();
    const { getByTestId, getByText, queryByTestId } = render(<Harness onSubmit={() => {}} />);

    act(() => {
      jest.advanceTimersByTime(44_000);
    });
    expect(queryByTestId('turnstile-error')).toBeNull();

    act(() => {
      jest.advanceTimersByTime(1_000);
    });
    expect(getByTestId('turnstile-error')).toBeTruthy();
    expect(getByText('エラーコード: timeout')).toBeTruthy();
    expect(getByTestId('submit')).toBeDisabled();
  });

  it('トークンが届いていれば、45 秒たっても失敗にはしない', () => {
    jest.useFakeTimers();
    const { getByTestId, queryByTestId } = render(<Harness onSubmit={() => {}} />);
    postFromWebView({ type: 'token', token: 'tok-1' });

    act(() => {
      jest.advanceTimersByTime(120_000);
    });

    expect(queryByTestId('turnstile-error')).toBeNull();
    expect(getByTestId('submit')).toBeEnabled();
  });
});

describe('C. ウィジェットの中のリンク (Cloudflare の「プライバシー」「利用規約」など)', () => {
  let openURL: jest.SpyInstance;

  beforeEach(() => {
    process.env.EXPO_PUBLIC_TURNSTILE_SITE_KEY = SITE_KEY;
    openURL = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
  });

  afterEach(() => {
    openURL.mockRestore();
  });

  /** WebView の中で target="_blank" のリンクが押された (または window.open が呼ばれた) ことにする */
  async function openWindowFromWebView(targetUrl: unknown) {
    await act(async () => {
      await mockWebViewProps.onOpenWindow({ nativeEvent: { targetUrl } });
    });
  }

  it('WebView に onOpenWindow を渡す (渡さないと、iOS は別ウィンドウのリンクを同じ WebView に読み込んで、ウィジェットを置き換える)', () => {
    render(<Harness onSubmit={() => {}} />);

    expect(typeof mockWebViewProps.onOpenWindow).toBe('function');
  });

  it('https のリンクは外のブラウザで開く。ウィジェットは作り直さず、取れたトークンも捨てない', async () => {
    const { getByTestId } = render(<Harness onSubmit={() => {}} />);
    postFromWebView({ type: 'token', token: 'tok-1' });
    expect(mockMounts).toBe(1);

    await openWindowFromWebView('https://www.cloudflare.com/privacypolicy/');

    expect(openURL).toHaveBeenCalledTimes(1);
    expect(openURL).toHaveBeenCalledWith('https://www.cloudflare.com/privacypolicy/');
    expect(mockMounts).toBe(1); // WebView は作り直されていない
    expect(getByTestId('submit')).toBeEnabled(); // トークンはそのまま
  });

  it('確認中 (トークン前) に押されても、ウィジェットはそのまま確認を続ける (エラー表示にならない)', async () => {
    const { getByTestId, queryByTestId } = render(<Harness onSubmit={() => {}} />);

    await openWindowFromWebView('https://www.cloudflare.com/website-terms/');

    expect(openURL).toHaveBeenCalledWith('https://www.cloudflare.com/website-terms/');
    expect(mockMounts).toBe(1);
    expect(queryByTestId('turnstile-error')).toBeNull();
    expect(getByTestId('turnstile-hint')).toBeTruthy();
    expect(getByTestId('submit')).toBeDisabled();
    // その後に届いたトークンは、今までどおり受け取れる
    postFromWebView({ type: 'token', token: 'tok-1' });
    expect(getByTestId('submit')).toBeEnabled();
  });

  it.each([
    ['http', 'http://www.cloudflare.com/privacypolicy/'],
    ['javascript:', 'javascript:alert(1)'],
    ['Android の intent:', 'intent://scan/#Intent;scheme=zxing;end'],
    ['file:', 'file:///etc/passwd'],
    ['ホストが無い', 'https://'],
    ['空白を含む', 'https://example.com/a b'],
    ['空文字', ''],
    ['URL でない文字列', 'cloudflare'],
    ['文字列でない', 123],
    ['無い', undefined],
  ])('https の URL ではないもの (%s) は開かない', async (_label, targetUrl) => {
    render(<Harness onSubmit={() => {}} />);

    await openWindowFromWebView(targetUrl);

    expect(openURL).not.toHaveBeenCalled();
  });

  it('外のブラウザを開けなくても (openURL が失敗しても)、例外にならず、ウィジェットはそのまま', async () => {
    openURL.mockRejectedValue(new Error('No Activity found to handle Intent'));
    const { getByTestId, queryByTestId } = render(<Harness onSubmit={() => {}} />);
    postFromWebView({ type: 'token', token: 'tok-1' });

    await expect(openWindowFromWebView('https://www.cloudflare.com/privacypolicy/')).resolves.toBeUndefined();

    expect(openURL).toHaveBeenCalledTimes(1);
    expect(queryByTestId('turnstile-error')).toBeNull();
    expect(getByTestId('submit')).toBeEnabled();
  });
});

describe('D. 文字色 (WCAG AA 4.5:1。CLAUDE.md「状態色」)', () => {
  beforeEach(() => {
    process.env.EXPO_PUBLIC_TURNSTILE_SITE_KEY = SITE_KEY;
  });

  /** testID で見つけた Text の文字色 (style が配列でもオブジェクトでも読む) */
  const colorOf = (element: { props: { style?: unknown } }) =>
    (StyleSheet.flatten(element.props.style as never) as { color?: string }).color;

  it('確認中の案内文は textLight (textMuted は薄くて届かない)', () => {
    const { getByTestId } = render(<Harness onSubmit={() => {}} />);

    expect(colorOf(getByTestId('turnstile-hint'))).toBe('#666'); // 上の theme のモックの textLight
  });

  it('エラーの赤い文字は、塗り用の error ではなく dangerText', () => {
    const { getByText } = render(<Harness onSubmit={() => {}} />);
    postFromWebView({ type: 'error', code: '300030' });

    expect(colorOf(getByText(/ボットではないことの確認を完了できませんでした/))).toBe('#b00');
    expect(colorOf(getByText('エラーコード: 300030'))).toBe('#b00'); // 上の theme のモックの dangerText
  });
});
