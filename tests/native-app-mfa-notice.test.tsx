/**
 * #1176 アプリの WebView の中の MFA の案内 (NativeAppMfaNotice) のテスト。docs/design/cross/12-operator-mfa.md §16.4.3・§21.7
 *
 *   - kind=verify は描画の後に { type: 'mfa-verify-required' } を 1 回送り、[確認画面を開く] でもう 1 回送る
 *   - kind=browser_only は何も送らない
 *   - どちらも Web の API (fetch) を呼ばない (借り物のセッションで token を発行し直さない)
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  NATIVE_APP_MFA_BROWSER_ONLY_NOTICE,
  NATIVE_APP_MFA_FALLBACK_NOTICE,
  NATIVE_APP_MFA_VERIFY_NOTICE,
  NativeAppMfaNotice,
} from '@/components/auth/mfa/NativeAppMfaNotice';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type WindowWithBridge = Window & { ReactNativeWebView?: unknown };

let container: HTMLDivElement;
let root: Root;
const postMessage = vi.fn();
const fetchMock = vi.fn();

beforeEach(() => {
  postMessage.mockReset();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  (window as WindowWithBridge).ReactNativeWebView = { postMessage };
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  delete (window as WindowWithBridge).ReactNativeWebView;
  vi.unstubAllGlobals();
});

function sentMessages() {
  return postMessage.mock.calls.map(([raw]) => JSON.parse(raw as string));
}

describe('NativeAppMfaNotice', () => {
  it('kind=verify は描画の後に mfa-verify-required を 1 回送り、[確認画面を開く] でもう 1 回送る', async () => {
    await act(async () => {
      root.render(createElement(NativeAppMfaNotice, { kind: 'verify' }));
    });
    expect(sentMessages()).toEqual([{ type: 'mfa-verify-required' }]);
    expect(container.querySelector('[data-testid="native-app-mfa-notice"]')?.textContent).toContain(NATIVE_APP_MFA_VERIFY_NOTICE);
    expect(container.textContent).toContain(NATIVE_APP_MFA_FALLBACK_NOTICE);

    const button = container.querySelector<HTMLButtonElement>('[data-testid="native-app-mfa-open-verify"]');
    expect(button).not.toBeNull();
    await act(async () => {
      button?.click();
    });
    expect(sentMessages()).toEqual([{ type: 'mfa-verify-required' }, { type: 'mfa-verify-required' }]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('kind=browser_only は何も送らない', async () => {
    await act(async () => {
      root.render(createElement(NativeAppMfaNotice, { kind: 'browser_only' }));
    });
    expect(postMessage).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="native-app-mfa-notice"]')?.textContent).toContain(
      NATIVE_APP_MFA_BROWSER_ONLY_NOTICE,
    );
    expect(container.querySelector('[data-testid="native-app-mfa-open-verify"]')).toBeNull();
    expect(container.querySelector('button')).toBeNull();
  });

  it('どちらも fetch を呼ばない', async () => {
    for (const kind of ['verify', 'browser_only'] as const) {
      await act(async () => {
        root.render(createElement(NativeAppMfaNotice, { kind }));
      });
      await act(async () => {
        container.querySelector<HTMLButtonElement>('button')?.click();
      });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
