// src/__tests__/app/settings/data-export.test.ts
// #1131: 設定画面の「データをエクスポート」ボタンが、実際に GET /api/account/export を呼んで
// JSON ファイルを保存することの契約テスト。
//
// 修正前の handleExportData は fetch を一切せず alert('…準備中です') を出すだけだった。
// ここでは設定画面を jsdom に描画し、ボタンを押したときの振る舞い
// (Web のダウンロード / ネイティブ WebView への転送 / 401 / 429 / 失敗 / 二重実行の防止) を確かめる。
//
// NOTE: tsconfig の jsx: "preserve" と Vitest の .tsx 変換が非互換のため、他の描画テストと同様に
// 拡張子 .ts + React.createElement で書く。

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';

const h = React.createElement;

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  native: { value: false },
  supabase: {
    auth: {
      getUser: async () => ({ data: { user: null } }),
      signOut: async () => ({}),
    },
    from: () => ({
      select: () => ({ eq: () => ({ single: async () => ({ data: null }) }) }),
      update: () => ({ eq: async () => ({}) }),
    }),
  },
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mocks.push }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/hooks/useNativeAppMode', () => ({ useNativeAppMode: () => mocks.native.value }));
vi.mock('@/lib/supabase/client', () => ({ createClient: () => mocks.supabase }));
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

let container: HTMLDivElement;
let root: Root;

const fetchMock = vi.fn();
const alertMock = vi.fn();
const downloads: Array<{ download: string; href: string }> = [];
const createObjectURL = vi.fn((_blob: Blob) => 'blob:mock-url');
const revokeObjectURL = vi.fn();
const postMessage = vi.fn();

const exportJson = JSON.stringify({ format: 'homegohan-personal-data-export', data: {} });

function respondWith(handlers: Record<string, () => Promise<Response> | Response>) {
  fetchMock.mockImplementation(async (input: string) => {
    if (input === '/api/notification-preferences') return new Response('{}', { status: 500 });
    const handler = handlers[input];
    if (!handler) throw new Error(`unexpected fetch: ${input}`);
    return handler();
  });
}

function findButton(text: string): HTMLButtonElement {
  const button = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes(text));
  if (!button) throw new Error(`button not found: ${text}`);
  return button as HTMLButtonElement;
}

async function click(button: HTMLButtonElement) {
  await act(async () => {
    button.click();
  });
}

const flush = () => act(async () => {});

beforeEach(async () => {
  vi.clearAllMocks();
  downloads.length = 0;
  mocks.native.value = false;

  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('alert', alertMock);
  URL.createObjectURL = createObjectURL as unknown as typeof URL.createObjectURL;
  URL.revokeObjectURL = revokeObjectURL;
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    downloads.push({ download: this.download, href: this.href });
  });
  (window as unknown as { ReactNativeWebView?: unknown }).ReactNativeWebView = undefined;

  container = document.createElement('div');
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container);
  });
  respondWith({});
  act(() => {
    root.render(h(SettingsPage));
  });
  await flush();
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('設定画面: データをエクスポート (JSON) #1131', () => {
  it('ボタンは「準備中」ではなく、押すと GET /api/account/export を呼ぶ', async () => {
    respondWith({ '/api/account/export': () => new Response(exportJson, { status: 200, headers: { 'Content-Type': 'application/json' } }) });

    await click(findButton('データをエクスポート'));

    expect(fetchMock).toHaveBeenCalledWith('/api/account/export', { method: 'GET' });
    expect(alertMock).not.toHaveBeenCalled();
  });

  it('Web: レスポンスを homegohan-export-YYYY-MM-DD.json としてダウンロードする', async () => {
    respondWith({ '/api/account/export': () => new Response(exportJson, { status: 200, headers: { 'Content-Type': 'application/json' } }) });

    await click(findButton('データをエクスポート'));

    expect(downloads).toHaveLength(1);
    expect(downloads[0].download).toMatch(/^homegohan-export-\d{4}-\d{2}-\d{2}\.json$/);
    expect(downloads[0].href).toBe('blob:mock-url');
    const blob = createObjectURL.mock.calls[0][0];
    expect(blob.type).toBe('application/json');
    expect(await blob.text()).toBe(exportJson);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock-url');
    expect(alertMock).not.toHaveBeenCalled();
  });

  it('ネイティブアプリの WebView: Blob URL ではなく postMessage で RN にファイルを渡す', async () => {
    mocks.native.value = true;
    (window as unknown as { ReactNativeWebView: unknown }).ReactNativeWebView = { postMessage };
    act(() => {
      root.render(h(SettingsPage));
    });
    respondWith({ '/api/account/export': () => new Response(exportJson, { status: 200, headers: { 'Content-Type': 'application/json' } }) });

    await click(findButton('データをエクスポート'));

    expect(postMessage).toHaveBeenCalledTimes(1);
    const message = JSON.parse(postMessage.mock.calls[0][0]);
    expect(message).toMatchObject({ type: 'download', content: exportJson, mimeType: 'application/json' });
    expect(message.filename).toMatch(/^homegohan-export-\d{4}-\d{2}-\d{2}\.json$/);
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(downloads).toHaveLength(0);
  });

  it('実行中は「エクスポート中…」でボタンが無効になり、連打しても 1 回しか呼ばない。終わると元に戻る', async () => {
    let release: (res: Response) => void = () => {};
    const pending = new Promise<Response>((resolve) => {
      release = resolve;
    });
    respondWith({ '/api/account/export': () => pending });

    const button = findButton('データをエクスポート');
    await click(button);
    await click(button);
    await click(button);

    expect(fetchMock.mock.calls.filter(([url]) => url === '/api/account/export')).toHaveLength(1);
    expect(container.textContent).toContain('エクスポート中…');
    expect(findButton('エクスポート中…').disabled).toBe(true);

    await act(async () => {
      release(new Response(exportJson, { status: 200, headers: { 'Content-Type': 'application/json' } }));
    });
    await flush();

    expect(container.textContent).not.toContain('エクスポート中…');
    expect(findButton('データをエクスポート').disabled).toBe(false);
    expect(downloads).toHaveLength(1);
  });

  it('401: ログイン画面へ移動し、ダウンロードも警告も出さない', async () => {
    respondWith({ '/api/account/export': () => new Response('{"error":"Unauthorized"}', { status: 401 }) });

    await click(findButton('データをエクスポート'));

    expect(mocks.push).toHaveBeenCalledWith('/login');
    expect(downloads).toHaveLength(0);
    expect(alertMock).not.toHaveBeenCalled();
  });

  it('429: 回数制限であることと、待つ時間 (Retry-After を分に直したもの) を伝える', async () => {
    respondWith({
      '/api/account/export': () =>
        new Response('{"code":"RATE_LIMITED"}', { status: 429, headers: { 'Retry-After': '541' } }),
    });

    await click(findButton('データをエクスポート'));

    expect(alertMock).toHaveBeenCalledTimes(1);
    expect(alertMock.mock.calls[0][0]).toContain('10分'); // 541 秒 → 切り上げて 10 分
    expect(alertMock.mock.calls[0][0]).toContain('繰り返した');
    expect(downloads).toHaveLength(0);
    expect(findButton('データをエクスポート').disabled).toBe(false);
  });

  it('429 で Retry-After が無いときも、しばらく待つよう案内する', async () => {
    respondWith({ '/api/account/export': () => new Response('{}', { status: 429 }) });

    await click(findButton('データをエクスポート'));

    expect(alertMock.mock.calls[0][0]).toContain('しばらく待って');
  });

  it('500: 失敗を伝え、ダウンロードはせず、もう一度押せる', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    respondWith({ '/api/account/export': () => new Response('{"code":"EXPORT_FAILED"}', { status: 500 }) });

    await click(findButton('データをエクスポート'));

    expect(alertMock).toHaveBeenCalledTimes(1);
    expect(alertMock.mock.calls[0][0]).toContain('エクスポートに失敗しました');
    expect(downloads).toHaveLength(0);
    expect(findButton('データをエクスポート').disabled).toBe(false);
    error.mockRestore();
  });

  it('通信エラーや、ストリームが途中で切れた場合も失敗を伝える', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const broken = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"format":'));
        controller.error(new Error('stream aborted'));
      },
    });
    respondWith({ '/api/account/export': () => new Response(broken, { status: 200, headers: { 'Content-Type': 'application/json' } }) });

    await click(findButton('データをエクスポート'));

    expect(alertMock).toHaveBeenCalledTimes(1);
    expect(alertMock.mock.calls[0][0]).toContain('エクスポートに失敗しました');
    expect(downloads).toHaveLength(0);
    error.mockRestore();
  });
});

describe('設定画面: 献立 CSV エクスポートは従来どおり', () => {
  it('GET /api/export/meals を呼び、homegohan-meals-YYYY-MM-DD.csv としてダウンロードする', async () => {
    respondWith({ '/api/export/meals': () => new Response('date,meal_type\r\n', { status: 200, headers: { 'Content-Type': 'text/csv' } }) });

    await click(findButton('献立をCSVエクスポート'));

    expect(fetchMock).toHaveBeenCalledWith('/api/export/meals', { method: 'GET' });
    expect(downloads).toHaveLength(1);
    expect(downloads[0].download).toMatch(/^homegohan-meals-\d{4}-\d{2}-\d{2}\.csv$/);
    expect(createObjectURL.mock.calls[0][0].type).toBe('text/csv');
  });

  it('ネイティブアプリでは text/csv で postMessage する', async () => {
    mocks.native.value = true;
    (window as unknown as { ReactNativeWebView: unknown }).ReactNativeWebView = { postMessage };
    act(() => {
      root.render(h(SettingsPage));
    });
    respondWith({ '/api/export/meals': () => new Response('a,b\r\n', { status: 200 }) });

    await click(findButton('献立をCSVエクスポート'));

    expect(JSON.parse(postMessage.mock.calls[0][0])).toMatchObject({ type: 'download', mimeType: 'text/csv', content: 'a,b\r\n' });
  });
});
