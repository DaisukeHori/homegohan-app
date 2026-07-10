'use client';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';

const STORAGE_KEY = 'isNativeApp';
const COOKIE_NAME = 'is_native_app';

/**
 * `document.cookie` 文字列から指定キーの値を取得するユーティリティ。
 * SSR 環境では `document` が存在しないため undefined を返す。
 *
 * Round-4 レビュー指摘: cookie 伝播ロジックの単体テストのために export する。
 */
export function getCookieValue(name: string): string | undefined {
  if (typeof document === 'undefined') return undefined;
  const match = document.cookie
    .split('; ')
    .find((row) => row.startsWith(name + '='));
  return match ? match.split('=')[1] : undefined;
}

/**
 * useNativeAppMode の初期 state を解決する優先順位ロジック。
 *   1. server から渡された initialIsNativeApp (SSR Cookie 判定済み) が指定されて
 *      いればそれを最優先で使う (undefined でない限り false も尊重する)。
 *   2. 指定がなければ client 側の document.cookie から判定する。
 *
 * useState の初期化関数から切り出すことで、React レンダリングなしに単体テストできる
 * ようにしている (Round-4 レビュー指摘: SSR seed 伝播の回帰防止)。
 */
export function resolveInitialNativeAppMode(
  initialIsNativeApp: boolean | undefined,
  cookieValue: string | undefined,
): boolean {
  return initialIsNativeApp ?? cookieValue === '1';
}

/**
 * @param initialIsNativeApp
 *   server 側 (layout.tsx) で Cookie を読んだ初期値。
 *   これを useState の初期値として使うことで、SSR HTML とクライアント初回 render が
 *   一致し、BottomNav のフラッシュ (一瞬表示 → 消える) を防止できる。
 *   省略時はクライアント側の Cookie / sessionStorage / URL params のみで判定する。
 */
export function useNativeAppMode(initialIsNativeApp?: boolean): boolean {
  const searchParams = useSearchParams();

  // 初期値の優先順位:
  //   1. server から渡された initialIsNativeApp (SSR Cookie 判定済み)
  //   2. クライアント側の document.cookie (ハイドレーション後の2回目以降)
  // これにより SSR → ハイドレーションのフラッシュを防止する。
  const [isNativeApp, setIsNativeApp] = useState<boolean>(
    () => resolveInitialNativeAppMode(initialIsNativeApp, getCookieValue(COOKIE_NAME)),
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
