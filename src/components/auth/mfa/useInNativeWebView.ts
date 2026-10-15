'use client';
import { useEffect, useState } from 'react';
import { isInNativeWebView } from '@/lib/native-auth-bridge';

/**
 * MFA の画面を、アプリの WebView の中で開いているか (#1176。docs/design/cross/12-operator-mfa.md §16.4.2)。
 *   'undecided' : サーバーの描画とブラウザの最初の描画 (window を読めない)。画面は何も描かず、API も呼ばない
 *   'in_app'    : window.ReactNativeWebView がある (アプリの WebView の中)
 *   'browser'   : それ以外
 * is_native_app の Cookie や ?mode=app は見ない (Cookie は 30 日残り、パソコンのブラウザで一度アプリのモードを開いた人が、
 * そのブラウザで 6 桁を入れられなくなるため)。WebView の中なら window.ReactNativeWebView は最初の useEffect の時点で必ずある
 * (src/hooks/useAccountActionsPlacement.ts の注記と同じ)
 */
export type InNativeWebViewState = 'undecided' | 'in_app' | 'browser';

export function useInNativeWebView(): InNativeWebViewState {
  const [state, setState] = useState<InNativeWebViewState>('undecided');
  useEffect(() => {
    setState(isInNativeWebView() ? 'in_app' : 'browser');
  }, []);
  return state;
}
