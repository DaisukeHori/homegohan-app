'use client';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';

const STORAGE_KEY = 'isNativeApp';
const COOKIE_NAME = 'is_native_app';

/**
 * `document.cookie` 文字列から指定キーの値を取得するユーティリティ。
 * SSR 環境では `document` が存在しないため undefined を返す。
 */
function getCookieValue(name: string): string | undefined {
  if (typeof document === 'undefined') return undefined;
  const match = document.cookie
    .split('; ')
    .find((row) => row.startsWith(name + '='));
  return match ? match.split('=')[1] : undefined;
}

export function useNativeAppMode(): boolean {
  const searchParams = useSearchParams();

  // 初期値として Cookie を読む。
  // クライアント初回レンダリング (hydration) 時点でブラウザが Cookie を持っていれば
  // useState(false) → true の遷移が起きず bottom nav のちらつきを防止できる。
  // SSR では document が存在しないため false のままにする (SSR は Cookie を読めない)。
  const [isNativeApp, setIsNativeApp] = useState<boolean>(
    () => getCookieValue(COOKIE_NAME) === '1',
  );

  useEffect(() => {
    // SSR ガード
    if (typeof window === 'undefined') return;

    // 1. URL パラメータ判定
    const urlMode = searchParams.get('mode');
    if (urlMode === 'app') {
      sessionStorage.setItem(STORAGE_KEY, '1');
      setIsNativeApp(true);
      return;
    }

    // 2. Cookie 判定 (bridge route 経由で設定された場合)
    if (getCookieValue(COOKIE_NAME) === '1') {
      setIsNativeApp(true);
      return;
    }

    // 3. sessionStorage から復元 (フォールバック)
    const stored = sessionStorage.getItem(STORAGE_KEY);
    setIsNativeApp(stored === '1');
  }, [searchParams]);

  return isNativeApp;
}
