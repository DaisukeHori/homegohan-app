'use client';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';

const STORAGE_KEY = 'isNativeApp';

export function useNativeAppMode(): boolean {
  const searchParams = useSearchParams();
  const [isNativeApp, setIsNativeApp] = useState(false);

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

    // 2. sessionStorage から復元
    const stored = sessionStorage.getItem(STORAGE_KEY);
    setIsNativeApp(stored === '1');
  }, [searchParams]);

  return isNativeApp;
}
