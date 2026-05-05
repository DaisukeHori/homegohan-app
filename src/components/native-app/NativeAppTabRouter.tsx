'use client';

import { useEffect } from 'react';
import { useNativeAppMode } from '@/hooks/useNativeAppMode';

const TAB_PATHS = ['/menus', '/meals/new', '/comparison', '/profile', '/home'];

function findTabFor(pathname: string): string | null {
  return TAB_PATHS.find(p => pathname === p || pathname.startsWith(p + '/')) ?? null;
}

export function NativeAppTabRouter() {
  const isNativeApp = useNativeAppMode();

  useEffect(() => {
    if (!isNativeApp) return;
    if (typeof window === 'undefined') return;

    const handleClick = (e: MouseEvent) => {
      let node = e.target as HTMLElement | null;
      while (node && node !== document.body) {
        if (node.tagName === 'A') break;
        node = node.parentElement;
      }
      if (!node || node.tagName !== 'A') return;

      const link = node as HTMLAnchorElement;
      try {
        const url = new URL(link.href, window.location.origin);
        if (url.origin !== window.location.origin) return;

        const targetPath = url.pathname;
        const currentPath = window.location.pathname;
        const currentTab = findTabFor(currentPath);
        const targetTab = findTabFor(targetPath);

        // 同じタブ内のナビゲーション → 素通し
        if (targetTab && currentTab && targetTab === currentTab) return;
        // 別タブへの遷移
        if (targetTab && targetTab !== currentTab) {
          e.preventDefault();
          e.stopPropagation();
          const w = window as unknown as { ReactNativeWebView?: { postMessage: (s: string) => void } };
          w.ReactNativeWebView?.postMessage(JSON.stringify({
            type: 'tab-navigate',
            path: targetTab,
            fullPath: targetPath + url.search,
          }));
        }
      } catch {
        // URL parse 失敗 → 素通し
      }
    };

    document.addEventListener('click', handleClick, true);
    return () => document.removeEventListener('click', handleClick, true);
  }, [isNativeApp]);

  return null;
}
