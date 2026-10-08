/**
 * NativeAppTabRouter (WebView 内でのタブ間リンクのインターセプト) のテスト (#1049 F7-22)
 *
 * 以前は '/menus', '/meals/new', ... という別の一覧を持っていて、ネイティブ側の一覧 ('/meals') と食い違い、
 * Web が送る tab-navigate の path ('/meals/new') がネイティブの一覧に無く、読み捨てられることがあった。
 * 今は @homegohan/shared の NATIVE_APP_TABS だけを見るので、送る path は必ず表の pathPrefix になる。
 *
 * このリポジトリには @testing-library/react が無いため react-dom/client + act で直接描画する。
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { NATIVE_APP_TABS } from '@homegohan/shared';

const state = vi.hoisted(() => ({ isNativeApp: true }));

vi.mock('@/hooks/useNativeAppMode', () => ({
  useNativeAppMode: () => state.isNativeApp,
}));

const { NativeAppTabRouter } = await import('@/components/native-app/NativeAppTabRouter');

// React に「テスト環境 (act で包む)」であることを伝える
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type PostedMessage = { type: string; path: string; fullPath: string };

let container: HTMLDivElement;
let root: Root;
let postMessage: ReturnType<typeof vi.fn>;

async function mount() {
  await act(async () => {
    root.render(<NativeAppTabRouter />);
  });
}

/**
 * 現在のページを pathname に見立てて、その中にあるリンクをクリックする。
 * コンポーネントがクリックを止めた (リンク本体に届かず、既定動作もキャンセルされた) なら true。
 * 止められなかったリンクは、jsdom が本当に移動しようとして警告を出さないよう、リンク自身のところで既定動作を止める。
 */
function clickLink(currentPath: string, href: string): boolean {
  window.history.pushState({}, '', currentPath);
  const link = document.createElement('a');
  link.setAttribute('href', href);
  link.textContent = 'link';
  let reachedLink = false;
  link.addEventListener('click', (e) => {
    reachedLink = true;
    e.preventDefault();
  });
  document.body.appendChild(link);
  const event = new MouseEvent('click', { bubbles: true, cancelable: true });
  link.dispatchEvent(event);
  link.remove();
  return event.defaultPrevented && !reachedLink;
}

function postedMessages(): PostedMessage[] {
  return postMessage.mock.calls.map((call) => JSON.parse(call[0] as string) as PostedMessage);
}

beforeEach(() => {
  state.isNativeApp = true;
  postMessage = vi.fn();
  (window as unknown as { ReactNativeWebView?: unknown }).ReactNativeWebView = { postMessage };
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  delete (window as unknown as { ReactNativeWebView?: unknown }).ReactNativeWebView;
  window.history.pushState({}, '', '/');
});

describe('NativeAppTabRouter — 別タブへのリンク', () => {
  it("ホームから '/meals/new' へのリンクは止めて、表の prefix ('/meals') で tab-navigate を送る", async () => {
    await mount();

    const prevented = clickLink('/home', '/meals/new');

    expect(prevented).toBe(true);
    expect(postedMessages()).toEqual([{ type: 'tab-navigate', path: '/meals', fullPath: '/meals/new' }]);
  });

  it('クエリ付きのリンクは fullPath にクエリを残す', async () => {
    await mount();

    clickLink('/home', '/menus/weekly?modal=shopping');

    expect(postedMessages()).toEqual([
      { type: 'tab-navigate', path: '/menus', fullPath: '/menus/weekly?modal=shopping' },
    ]);
  });

  it('どのタブへ行くリンクでも、送る path はネイティブ側の一覧 (NATIVE_APP_TABS) の pathPrefix になる', async () => {
    await mount();

    for (const tab of NATIVE_APP_TABS) {
      // 別のタブにいる状態から、このタブの rootPath へ
      const other = NATIVE_APP_TABS.find((t) => t.name !== tab.name)!;
      postMessage.mockClear();
      const prevented = clickLink(other.rootPath, tab.rootPath);

      expect(prevented).toBe(true);
      const [message] = postedMessages();
      expect(message.path).toBe(tab.pathPrefix);
      // ネイティブ側は pathPrefix の完全一致でも前方一致でもタブを引ける
      expect(NATIVE_APP_TABS.some((t) => t.pathPrefix === message.path)).toBe(true);
    }
  });
});

describe('NativeAppTabRouter — 止めないリンク', () => {
  it('同じタブの中のリンクは素通し (メッセージを送らない)', async () => {
    await mount();

    expect(clickLink('/menus/weekly', '/menus/other?x=1')).toBe(false);
    expect(clickLink('/meals/new', '/meals/3f2c1c3e')).toBe(false);
    expect(clickLink('/profile', '/profile/nutrition-targets')).toBe(false);
    expect(postMessage).not.toHaveBeenCalled();
  });

  it('タブに属さないページへのリンクは素通し', async () => {
    await mount();

    expect(clickLink('/home', '/family')).toBe(false);
    expect(clickLink('/home', '/settings')).toBe(false);
    expect(postMessage).not.toHaveBeenCalled();
  });

  it('prefix と前方一致するだけの別ページ (/homepage) はタブ扱いしない', async () => {
    await mount();

    expect(clickLink('/menus/weekly', '/homepage')).toBe(false);
    expect(postMessage).not.toHaveBeenCalled();
  });

  it('別オリジンのリンクは素通し', async () => {
    await mount();

    expect(clickLink('/home', 'https://example.com/meals/new')).toBe(false);
    expect(postMessage).not.toHaveBeenCalled();
  });

  it('ネイティブアプリでなければ何もしない', async () => {
    state.isNativeApp = false;
    await mount();

    expect(clickLink('/home', '/meals/new')).toBe(false);
    expect(postMessage).not.toHaveBeenCalled();
  });
});
