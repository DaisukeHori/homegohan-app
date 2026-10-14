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
 * 描画が終わる (useEffect が走る) までは、ボタンも案内も出さない ('undecided')。
 *   - アプリの中で、ログアウトや退会のボタンが一瞬だけ見えることがない
 *   - ブラウザで、アプリ向けの案内が一瞬だけ見えることもない
 *   - サーバーとブラウザの最初の描画が同じになり、ハイドレーションの食い違いが起きない
 *   - ブラウザでは、描画のすぐあとにボタンが出る
 */
/**
 * ログアウトと退会をどこで出すか。
 *   'undecided' : まだ判定できない (サーバーの描画・ブラウザの最初の描画)。ボタンも案内も出さない
 *   'native'    : アプリの中。Web の画面には出さず、ネイティブの設定画面への案内を出す
 *   'web'       : ブラウザ。Web の画面に出す
 */
export type AccountActionsPlacement = 'undecided' | 'native' | 'web';

export function resolveAccountActionsPlacement(input: {
  /** 描画が終わった (useEffect が走った) か */
  hasMounted: boolean;
  /** useNativeAppMode() の結果 */
  isNativeApp: boolean;
  /** isInNativeWebView() の結果 */
  inNativeWebView: boolean;
}): AccountActionsPlacement {
  if (!input.hasMounted) return 'undecided';
  return input.isNativeApp || input.inNativeWebView ? 'native' : 'web';
}

/**
 * ログアウトと退会をどこで出すか (resolveAccountActionsPlacement)。Web の画面に出してよいのは 'web' のときだけ。
 * @param isNativeApp 呼び出し側の useNativeAppMode() の結果
 */
export function useAccountActionsPlacement(isNativeApp: boolean): AccountActionsPlacement {
  const [hasMounted, setHasMounted] = useState(false);
  const [inNativeWebView, setInNativeWebView] = useState(false);

  useEffect(() => {
    // window.ReactNativeWebView は、ネイティブ (react-native-webview) がページの読み込みの初めに入れるので、最初の useEffect の時点で見える
    setInNativeWebView(isInNativeWebView());
    setHasMounted(true);
  }, []);

  return resolveAccountActionsPlacement({ hasMounted, isNativeApp, inNativeWebView });
}
