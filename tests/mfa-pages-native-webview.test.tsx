/**
 * #1176 MFA の 4 画面をアプリの WebView の中で開いたときの扱い。docs/design/cross/12-operator-mfa.md §15 冒頭・§16.4・§21.7
 *
 *   - window.ReactNativeWebView がある (WebView) と、verify は NativeAppMfaNotice kind=verify、状態・setup・recover は kind=browser_only だけを描き、
 *     fetch (MFA の API) を 1 回も呼ばない (借り物のセッションで Supabase の token を発行し直さない)
 *   - window.ReactNativeWebView が無い (ブラウザ) と今までの画面を描く (verify は GET /api/auth/mfa/status を呼ぶ)
 *   - useEffect の前の最初の描画 (サーバーの描画) は何も描かず、API も呼ばない
 * 通信の facade (src/lib/auth/mfa/client.ts) は本物を使い、fetch を差し替える。
 */
import { act, createElement, type ComponentType, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  router: { push: vi.fn(), replace: vi.fn(), refresh: vi.fn() },
  searchParams: new URLSearchParams('next=%2Fadmin'),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => mocks.router,
  useSearchParams: () => mocks.searchParams,
}));

vi.mock('next/link', async () => {
  const react = await import('react');
  return {
    default: ({ href, children, ...rest }: { href: string; children?: ReactNode } & Record<string, unknown>) =>
      react.createElement('a', { href, ...rest }, children),
  };
});

const { default: MfaStatusPage } = await import('@/app/(main)/settings/security/mfa/page');
const { default: MfaSetupPage } = await import('@/app/(main)/settings/security/mfa/setup/page');
const { default: MfaVerifyPage } = await import('@/app/(main)/settings/security/mfa/verify/page');
const { default: MfaRecoverPage } = await import('@/app/(main)/settings/security/mfa/recover/page');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type WindowWithBridge = Window & { ReactNativeWebView?: unknown };

const PAGES: ReadonlyArray<[string, ComponentType, 'verify' | 'browser_only']> = [
  ['状態 /settings/security/mfa', MfaStatusPage, 'browser_only'],
  ['登録 /settings/security/mfa/setup', MfaSetupPage, 'browser_only'],
  ['確認 /settings/security/mfa/verify', MfaVerifyPage, 'verify'],
  ['回復 /settings/security/mfa/recover', MfaRecoverPage, 'browser_only'],
];

let container: HTMLDivElement;
let root: Root;
const fetchMock = vi.fn();
const postMessage = vi.fn();

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  fetchMock.mockReset();
  postMessage.mockReset();
  mocks.router.push.mockReset();
  mocks.router.replace.mockReset();
  mocks.router.refresh.mockReset();
  fetchMock.mockImplementation(async () => new Response(JSON.stringify({ error: 'x', code: 'PERM_DENIED' }), { status: 403 }));
  vi.stubGlobal('fetch', fetchMock);
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

describe('MFA の画面: アプリの WebView の中', () => {
  it('window.ReactNativeWebView がある (WebView) と、verify は NativeAppMfaNotice kind=verify、状態・setup・recover は kind=browser_only だけを描き、fetch (MFA の API) を 1 回も呼ばない', async () => {
    (window as WindowWithBridge).ReactNativeWebView = { postMessage };
    for (const [name, Page, kind] of PAGES) {
      postMessage.mockReset();
      await act(async () => {
        root.render(createElement(Page));
      });
      await flush();
      const notice = container.querySelector('[data-testid="native-app-mfa-notice"]');
      expect(notice, name).not.toBeNull();
      const openVerify = container.querySelector('[data-testid="native-app-mfa-open-verify"]');
      if (kind === 'verify') {
        expect(openVerify, name).not.toBeNull();
        expect(postMessage.mock.calls.map(([raw]) => JSON.parse(raw as string)), name).toEqual([{ type: 'mfa-verify-required' }]);
      } else {
        expect(openVerify, name).toBeNull();
        expect(postMessage, name).not.toHaveBeenCalled();
      }
      // 6 桁の欄・バックアップコードの欄・[登録する] を出さない
      expect(container.querySelector('[data-testid="totp-code-input"]'), name).toBeNull();
      expect(container.querySelector('[data-testid="mfa-recover-code-input"]'), name).toBeNull();
      expect(container.querySelector('[data-testid="mfa-status-enroll"]'), name).toBeNull();
      act(() => root.unmount());
      root = createRoot(container);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('window.ReactNativeWebView が無い (ブラウザ) と今までの画面を描く (verify は GET /api/auth/mfa/status を呼ぶ)', async () => {
    await act(async () => {
      root.render(createElement(MfaVerifyPage));
    });
    await flush();
    expect(container.querySelector('[data-testid="native-app-mfa-notice"]')).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/auth/mfa/status');
    expect((fetchMock.mock.calls[0][1] as RequestInit).method).toBe('GET');
    expect(postMessage).not.toHaveBeenCalled();

    // 回復の画面はブラウザなら入力の欄を出す (送るまで API を呼ばない)
    act(() => root.unmount());
    root = createRoot(container);
    fetchMock.mockClear();
    await act(async () => {
      root.render(createElement(MfaRecoverPage));
    });
    await flush();
    expect(container.querySelector('[data-testid="mfa-recover-code-input"]')).not.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('useEffect の前の最初の描画は何も描かず、API も呼ばない', () => {
    for (const bridge of [false, true]) {
      if (bridge) (window as WindowWithBridge).ReactNativeWebView = { postMessage };
      for (const [name, Page] of PAGES) {
        const html = renderToString(createElement(Page));
        expect(html.replace(/<!--[^>]*-->/g, ''), `${name} bridge=${bridge}`).toBe('');
      }
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect(postMessage).not.toHaveBeenCalled();
  });
});
