/**
 * #1867 ハッシュだけの移動で積まれた履歴の項目に、Next の app router の印を付ける部品のテスト
 * (src/components/navigation/HashHistoryEntryBridge.tsx・判定は src/lib/navigation/hash-history-entry.ts)。
 *
 * 不具合: `/` → <a href="#how"> → next/link で /signup → 戻る で、URL だけ /#how に戻り画面は /signup のまま
 * (ハッシュの移動の項目の history.state が null で、app router が popstate を無視する)。
 * 実際のブラウザでの戻る / 進む は tests/e2e/back-navigation.spec.ts が確かめる。ここでは判定と、部品がいつ何を呼ぶかを確かめる。
 *
 * このリポジトリには @testing-library/react が無いため react-dom/client + act で直接描画する。
 */
import fs from 'node:fs';
import path from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  APP_ROUTER_HISTORY_MARK,
  decideOnHashChange,
  decideOnPopState,
  isAppRouterHistoryState,
  isSameRoute,
  toRouteLocation,
} from '@/lib/navigation/hash-history-entry';

// usePathname / useSearchParams は「いま画面に描かれているルート」、reloadCurrentDocument は読み込み直しの呼び出しを控える
const { navigation, reloadDocument } = vi.hoisted(() => ({
  navigation: { pathname: '/' as string | null, search: '' },
  reloadDocument: vi.fn(),
}));
vi.mock('next/navigation', () => ({
  usePathname: () => navigation.pathname,
  useSearchParams: () => new URLSearchParams(navigation.search),
}));
vi.mock('@/lib/navigation/reload-document', () => ({ reloadCurrentDocument: reloadDocument }));

import { HashHistoryEntryBridge } from '@/components/navigation/HashHistoryEntryBridge';

// React に「テスト環境 (act で包む)」であることを伝える
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** app router が積んだ項目の state (印つき) */
const APP_ROUTER_STATE = { [APP_ROUTER_HISTORY_MARK]: true, __PRIVATE_NEXTJS_INTERNALS_TREE: { tree: ['', {}] } };

describe('判定 (src/lib/navigation/hash-history-entry.ts)', () => {
  it('isAppRouterHistoryState: 印 (__NA: true) のある state だけ真', () => {
    expect(isAppRouterHistoryState(APP_ROUTER_STATE)).toBe(true);
    expect(isAppRouterHistoryState(null)).toBe(false);
    expect(isAppRouterHistoryState({})).toBe(false);
    expect(isAppRouterHistoryState({ [APP_ROUTER_HISTORY_MARK]: 'true' })).toBe(false);
    expect(isAppRouterHistoryState({ __N: true })).toBe(false);
    expect(isAppRouterHistoryState('__NA')).toBe(false);
  });

  it('toRouteLocation: 検索の部分を window.location.search と同じ ? つきの形にする', () => {
    expect(toRouteLocation('/', '')).toEqual({ pathname: '/', search: '' });
    expect(toRouteLocation('/signup', 'redirect=%2Finvite')).toEqual({ pathname: '/signup', search: '?redirect=%2Finvite' });
    expect(toRouteLocation('/', null)).toEqual({ pathname: '/', search: '' });
    expect(toRouteLocation(null, 'a=1')).toBeNull();
  });

  it('isSameRoute: パスと検索の両方が同じときだけ真 (描かれたルートが分からなければ偽)', () => {
    expect(isSameRoute({ pathname: '/', search: '' }, { pathname: '/', search: '' })).toBe(true);
    expect(isSameRoute({ pathname: '/signup', search: '' }, { pathname: '/', search: '' })).toBe(false);
    expect(isSameRoute({ pathname: '/p', search: '?x=2' }, { pathname: '/p', search: '?x=1' })).toBe(false);
    expect(isSameRoute(null, { pathname: '/', search: '' })).toBe(false);
  });

  it('decideOnHashChange: 印が無く、画面と URL のルートが同じときだけ印を付ける', () => {
    const landing = { pathname: '/', search: '' };
    expect(decideOnHashChange(null, landing, landing)).toBe('mark-entry');
    expect(decideOnHashChange({}, landing, landing)).toBe('mark-entry');
    // 既に印がある (next/link のハッシュの移動・印を付けたあとの戻る / 進む)
    expect(decideOnHashChange(APP_ROUTER_STATE, landing, landing)).toBe('none');
    // 印の無い古い項目へ別のルートから戻ってきた: 今の画面 (/signup) の木を / の項目に入れない
    expect(decideOnHashChange(null, { pathname: '/signup', search: '' }, landing)).toBe('none');
    // 描かれたルートがまだ分からない
    expect(decideOnHashChange(null, null, landing)).toBe('none');
  });

  it('decideOnPopState: state が null で、画面と URL のルートが違うときだけ描き直す', () => {
    const landing = { pathname: '/', search: '' };
    const signup = { pathname: '/signup', search: '' };
    expect(decideOnPopState(null, signup, landing)).toBe('redraw');
    // 同じ画面の中のハッシュの移動 (ブラウザがスクロールするだけ)
    expect(decideOnPopState(null, landing, landing)).toBe('none');
    // 印つき: app router が描き直す
    expect(decideOnPopState(APP_ROUTER_STATE, signup, landing)).toBe('none');
    // 印の無い別の値: app router が読み込み直す (手を出さない)
    expect(decideOnPopState({ __N: true }, signup, landing)).toBe('none');
    expect(decideOnPopState(null, null, landing)).toBe('none');
  });
});

describe('HashHistoryEntryBridge', () => {
  let container: HTMLDivElement;
  let root: Root;
  let replaceStateSpy: ReturnType<typeof vi.spyOn>;

  /** ブラウザの通常のハッシュの移動を再現する (state null の項目を積み、hashchange を投げる) */
  function nativeHashNavigation(hash: string) {
    const oldURL = window.location.href;
    window.history.pushState(null, '', hash);
    window.dispatchEvent(new HashChangeEvent('hashchange', { oldURL, newURL: window.location.href }));
  }

  async function mount() {
    await act(async () => {
      root.render(<HashHistoryEntryBridge />);
    });
  }

  beforeEach(() => {
    window.history.replaceState(APP_ROUTER_STATE, '', '/');
    navigation.pathname = '/';
    navigation.search = '';
    reloadDocument.mockReset();
    replaceStateSpy = vi.spyOn(window.history, 'replaceState');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    replaceStateSpy.mockRestore();
  });

  it('画面には何も描かない', async () => {
    await mount();
    expect(container.innerHTML).toBe('');
  });

  it('同じ画面の中のハッシュの移動 (state null) で、今の項目を Next の replaceState に通す (URL はそのまま)', async () => {
    await mount();
    nativeHashNavigation('#how');

    expect(replaceStateSpy).toHaveBeenCalledTimes(1);
    expect(replaceStateSpy).toHaveBeenCalledWith(null, '', `${window.location.origin}/#how`);
    expect(reloadDocument).not.toHaveBeenCalled();
  });

  it('既に印のある項目 (next/link のハッシュの移動) には何もしない', async () => {
    await mount();
    window.history.pushState(APP_ROUTER_STATE, '', '#demo');
    window.dispatchEvent(new HashChangeEvent('hashchange'));

    expect(replaceStateSpy).not.toHaveBeenCalled();
  });

  it('画面 (/signup) と URL (/#how) のルートが違う hashchange では印を付けない', async () => {
    navigation.pathname = '/signup';
    window.history.replaceState(APP_ROUTER_STATE, '', '/signup');
    await mount();
    replaceStateSpy.mockClear();
    window.history.pushState(null, '', '/#how');
    window.dispatchEvent(new HashChangeEvent('hashchange'));

    expect(replaceStateSpy).not.toHaveBeenCalled();
  });

  it('印の無い項目へ戻って画面 (/signup) と URL (/#how) がずれたら、今の URL で読み込み直す', async () => {
    navigation.pathname = '/signup';
    window.history.replaceState(null, '', '/#how');
    await mount();
    window.dispatchEvent(new PopStateEvent('popstate', { state: null }));

    expect(reloadDocument).toHaveBeenCalledTimes(1);
  });

  it('パスが同じでも検索の部分が違えば (画面 /pricing?plan=a・URL /pricing?plan=b) 読み込み直す', async () => {
    navigation.pathname = '/pricing';
    navigation.search = 'plan=a';
    window.history.replaceState(null, '', '/pricing?plan=b#main-content');
    await mount();
    window.dispatchEvent(new PopStateEvent('popstate', { state: null }));

    expect(reloadDocument).toHaveBeenCalledTimes(1);
  });

  it('同じ画面の中のハッシュの移動の popstate (state null) では描き直さない', async () => {
    await mount();
    window.history.pushState(null, '', '#faq');
    window.dispatchEvent(new PopStateEvent('popstate', { state: null }));

    expect(reloadDocument).not.toHaveBeenCalled();
  });

  it('印つきの項目の popstate は app router に任せる (描き直さない)', async () => {
    navigation.pathname = '/signup';
    window.history.replaceState(APP_ROUTER_STATE, '', '/#how');
    await mount();
    window.dispatchEvent(new PopStateEvent('popstate', { state: APP_ROUTER_STATE }));

    expect(reloadDocument).not.toHaveBeenCalled();
  });

  it('外したあとはイベントに反応しない', async () => {
    await mount();
    await act(async () => {
      root.unmount();
    });
    root = createRoot(container);
    nativeHashNavigation('#how');
    navigation.pathname = '/signup';
    window.dispatchEvent(new PopStateEvent('popstate', { state: null }));

    expect(replaceStateSpy).not.toHaveBeenCalled();
    expect(reloadDocument).not.toHaveBeenCalled();
  });
});

describe('置き場所 (src/app/layout.tsx)', () => {
  it('ルートの layout が部品を 1 つだけ置く (全ページのハッシュの移動を受け持つ。スキップリンクの #main-content も含む)', () => {
    const layout = fs.readFileSync(path.join(process.cwd(), 'src/app/layout.tsx'), 'utf8');
    expect(layout).toContain("import { HashHistoryEntryBridge } from \"@/components/navigation/HashHistoryEntryBridge\";");
    expect(layout.split('<HashHistoryEntryBridge />').length - 1).toBe(1);
  });
});
