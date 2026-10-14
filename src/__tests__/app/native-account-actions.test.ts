// src/__tests__/app/native-account-actions.test.ts
// #1037: アプリ (モバイルアプリの WebView) の中で開いた Web の画面では、ログアウトと退会を出さず、
// ネイティブの設定画面 (マイページの上の歯車から開く) に一本化する。ブラウザで開いたときは、これまでどおり出す。
//
// 「アプリの中か」は既にある 2 つの判定 (useNativeAppMode / window.ReactNativeWebView) のどちらかで決める
// (src/hooks/useAccountActionsDelegatedToNative.ts)。描画が終わるまでは出さない側に倒す (サーバーの描画と食い違わないように)。
//
// NOTE: tsconfig の jsx: "preserve" の都合で、拡張子 .ts + React.createElement で書く (data-export.test.ts と同じ)。

import React from 'react';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';

const h = React.createElement;

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  signOut: vi.fn(async () => ({ error: null })),
  native: { value: false },
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mocks.push }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/hooks/useNativeAppMode', () => ({ useNativeAppMode: () => mocks.native.value }));
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    auth: {
      getUser: async () => ({ data: { user: null }, error: null }),
      signOut: mocks.signOut,
    },
    from: () => ({
      select: () => ({ eq: () => ({ single: async () => ({ data: null }), maybeSingle: async () => ({ data: null }) }) }),
      update: () => ({ eq: async () => ({}) }),
    }),
  }),
}));
vi.mock('@/components/icons', () => ({ Icons: new Proxy({}, { get: () => () => null }) }));
vi.mock('framer-motion', async () => {
  const react = await import('react');
  const motion = new Proxy(
    {},
    {
      get:
        (_target, tag: string) =>
        ({ children, className, onClick, role }: Record<string, unknown>) =>
          react.createElement(tag, { className, onClick, role }, children as React.ReactNode),
    },
  );
  return {
    motion,
    AnimatePresence: ({ children }: { children?: React.ReactNode }) => react.createElement(react.Fragment, null, children),
  };
});

import SettingsPage from '@/app/(main)/settings/page';
import ProfilePage from '@/app/(main)/profile/page';
import {
  shouldDelegateAccountActionsToNative,
  useAccountActionsDelegatedToNative,
} from '@/hooks/useAccountActionsDelegatedToNative';

type WindowWithBridge = Window & { ReactNativeWebView?: unknown };

let container: HTMLDivElement;
let root: Root;

async function renderPage(page: React.ComponentType) {
  container = document.createElement('div');
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container);
  });
  act(() => {
    root.render(h(page));
  });
  // 描画のあとの useEffect (アプリの中かの判定・初期の読み込み) を流す
  await act(async () => {});
}

const byTestId = (testId: string) => container.querySelector(`[data-testid="${testId}"]`);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.native.value = false;
  delete (window as WindowWithBridge).ReactNativeWebView;
  // 起動時の取得 (この画面の関心事ではない) は失敗扱いにする
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })));
});

afterEach(() => {
  if (root) {
    act(() => {
      root.unmount();
    });
  }
  container?.remove();
  delete (window as WindowWithBridge).ReactNativeWebView;
  vi.unstubAllGlobals();
});

describe('shouldDelegateAccountActionsToNative', () => {
  it.each([
    // [描画が終わったか, useNativeAppMode, window.ReactNativeWebView, ネイティブに任せる (Web に出さない) か]
    [false, false, false, true], // サーバーの描画・ブラウザの最初の描画: どちらとも決められないので出さない
    [false, true, false, true],
    [false, false, true, true],
    [true, false, false, false], // ブラウザ: 出す
    [true, true, false, true], // ?mode=app / is_native_app Cookie / sessionStorage の印
    [true, false, true, true], // WebView の中 (Cookie などが残っていなくても)
    [true, true, true, true],
  ])('描画済み=%s・useNativeAppMode=%s・ReactNativeWebView=%s → %s', (hasMounted, isNativeApp, inNativeWebView, expected) => {
    expect(shouldDelegateAccountActionsToNative({ hasMounted, isNativeApp, inNativeWebView })).toBe(expected);
  });

  it('サーバーの描画 (useEffect が走らない) では、ブラウザ向けでも「任せる」= ボタンを出さない側になる (ハイドレーションの食い違いを作らない)', () => {
    function Probe() {
      return h('span', null, useAccountActionsDelegatedToNative(false) ? 'delegated' : 'web');
    }
    expect(renderToString(h(Probe))).toContain('delegated');
  });
});

describe('#1037 Web の設定画面 (/settings)', () => {
  it('ブラウザで開いたときは、ログアウトと退会 (危険ゾーン) を出す', async () => {
    await renderPage(SettingsPage);

    expect(byTestId('logout-button')).not.toBeNull();
    expect(byTestId('settings-delete-account-section')).not.toBeNull();
    expect(container.querySelector('[aria-label="アカウントを削除する"]')).not.toBeNull();
    expect(byTestId('settings-native-account-actions-note')).toBeNull();
  });

  it('アプリの中 (useNativeAppMode が true) では、ログアウトと退会を出さず、ネイティブの設定画面への案内を出す', async () => {
    mocks.native.value = true;
    await renderPage(SettingsPage);

    expect(byTestId('logout-button')).toBeNull();
    expect(byTestId('logout-confirm-button')).toBeNull();
    expect(byTestId('settings-delete-account-section')).toBeNull();
    expect(container.querySelector('[aria-label="アカウントを削除する"]')).toBeNull();
    expect(container.textContent).not.toContain('危険ゾーン');

    const note = byTestId('settings-native-account-actions-note');
    expect(note?.textContent).toContain('マイページの右上の歯車');
    // ほかの設定 (パスワード・メールアドレスなど、ネイティブの設定画面に無いもの) は、アプリの中でも使える
    expect(byTestId('settings-account-link')).not.toBeNull();
  });

  it('WebView の中 (window.ReactNativeWebView がある) なら、Cookie などの印が無くても出さない', async () => {
    (window as WindowWithBridge).ReactNativeWebView = { postMessage: vi.fn() };
    await renderPage(SettingsPage);

    expect(byTestId('logout-button')).toBeNull();
    expect(byTestId('settings-delete-account-section')).toBeNull();
    expect(byTestId('settings-native-account-actions-note')).not.toBeNull();
    expect(mocks.signOut).not.toHaveBeenCalled();
  });
});

describe('#1037 Web のマイページ (/profile)', () => {
  it('ブラウザで開いたときは、ログアウト (上部・「アプリ設定」の 2 か所) と Web の設定画面への入口を出す', async () => {
    await renderPage(ProfilePage);

    expect(byTestId('profile-header-logout-button')).not.toBeNull();
    expect(byTestId('profile-logout-button')).not.toBeNull();
    expect(byTestId('profile-settings-link')).not.toBeNull();
  });

  it('アプリの中では、ログアウトを出さない。Web の設定画面 (パスワードの変更など) への入口は残す', async () => {
    (window as WindowWithBridge).ReactNativeWebView = { postMessage: vi.fn() };
    await renderPage(ProfilePage);

    expect(byTestId('profile-header-logout-button')).toBeNull();
    expect(byTestId('profile-logout-button')).toBeNull();

    const settingsLink = byTestId('profile-settings-link') as HTMLButtonElement | null;
    expect(settingsLink).not.toBeNull();
    act(() => {
      settingsLink!.click();
    });
    expect(mocks.push).toHaveBeenCalledWith('/settings');
    expect(mocks.signOut).not.toHaveBeenCalled();
  });

  it('アプリの中 (useNativeAppMode が true) でも、ログアウトを出さない', async () => {
    mocks.native.value = true;
    await renderPage(ProfilePage);

    expect(byTestId('profile-header-logout-button')).toBeNull();
    expect(byTestId('profile-logout-button')).toBeNull();
  });
});
