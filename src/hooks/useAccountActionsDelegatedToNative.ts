'use client';
import { useEffect, useState } from 'react';

import { isInNativeWebView } from '@/lib/native-auth-bridge';

/**
 * アプリ (モバイルアプリの WebView) の中で開いた Web の画面では、ログアウトと退会を出さず、
 * ネイティブの設定画面 (マイページの上の歯車から開く) に一本化する (#1037)。
 * 設計書 docs/design/mobile/01-architecture.md §3.2: 設定画面 (通知の権限・ログアウトなど OS の機能) はネイティブで作る。
 * Web をブラウザで開いたときは、これまでどおり Web の画面にログアウトと退会を出す。
 *
 * 「アプリの中か」は、既にある 2 つの判定のどちらかが立てばアプリの中とする (新しい判定は作らない)。
 *   - useNativeAppMode() の結果 (?mode=app / native-bridge が付ける is_native_app Cookie / sessionStorage の印)
 *   - isInNativeWebView() (window.ReactNativeWebView がある = WebView の中。native-auth-bridge.ts)
 *     Cookie や sessionStorage が残っていない読み込みでも、WebView の中なら必ず立つ
 *
 * サーバーの描画とブラウザの最初の描画ではどちらも判定できない (Cookie を読むのはブラウザ、window もブラウザにしか無い) ので、
 * 描画が終わる (useEffect が走る) までは「出さない」側に倒す。
 *   - アプリの中で、ログアウトや退会のボタンが一瞬だけ見えることがない
 *   - サーバーとブラウザの最初の描画が同じになり、ハイドレーションの食い違いが起きない
 *   - ブラウザでは、描画のすぐあとにボタンが出る
 */
export function shouldDelegateAccountActionsToNative(input: {
  /** 描画が終わった (useEffect が走った) か */
  hasMounted: boolean;
  /** useNativeAppMode() の結果 */
  isNativeApp: boolean;
  /** isInNativeWebView() の結果 */
  inNativeWebView: boolean;
}): boolean {
  if (!input.hasMounted) return true;
  return input.isNativeApp || input.inNativeWebView;
}

/**
 * Web の画面がログアウトと退会を出さずに、ネイティブの設定画面に任せるべきなら true。
 * @param isNativeApp 呼び出し側の useNativeAppMode() の結果
 */
export function useAccountActionsDelegatedToNative(isNativeApp: boolean): boolean {
  const [hasMounted, setHasMounted] = useState(false);
  const [inNativeWebView, setInNativeWebView] = useState(false);

  useEffect(() => {
    // window.ReactNativeWebView は、ネイティブがページのスクリプトより前に入れるので、最初の useEffect の時点で見える
    setInNativeWebView(isInNativeWebView());
    setHasMounted(true);
  }, []);

  return shouldDelegateAccountActionsToNative({ hasMounted, isNativeApp, inNativeWebView });
}
