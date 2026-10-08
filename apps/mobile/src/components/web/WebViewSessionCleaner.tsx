import React, { useEffect, useState } from 'react';
import { WebView } from 'react-native-webview';

import { getWebBaseUrl } from '../../lib/webBaseUrl';
import { supabase } from '../../lib/supabase';
import {
  WEBVIEW_SESSION_CLEANUP_HTML,
  WEBVIEW_SESSION_CLEANUP_TIMEOUT_MS,
  buildWebViewSessionCleanupScript,
  isWebViewSessionClearedMessage,
} from '../../lib/webViewSessionCleanup';

/**
 * ログアウト (SIGNED_OUT) のたびに、WebView (Web) 側に残る前のユーザーの状態を消す (#1049 F7-16)。
 *
 * 以前のログアウトは、ネイティブ側の AsyncStorage とセッションを消すだけで、WebView の Cookie / localStorage は
 * そのまま残っていた。同じ端末で別のユーザーがログインすると、前のユーザーの Web 側の状態が見える可能性があった。
 *
 * ログアウトの経路は設定画面・プロフィール画面・アカウント削除・失効したセッションの片付けなど複数あるので、
 * 各画面のログアウト処理には手を入れず、認証状態の変化 (SIGNED_OUT) をアプリの根元で 1 か所だけ見て消す。
 * 消す中身と限界は src/lib/webViewSessionCleanup.ts を参照。
 *
 * 画面には何も出さない (1px・透明の WebView を、消し終わるか上限の時間が来るまで置くだけ)。
 * 消している間に次のログインが済んだ場合 (SIGNED_IN) は、新しいセッションの Cookie を消してしまわないよう、すぐ片付ける。
 */
export function WebViewSessionCleaner() {
  const [cleaning, setCleaning] = useState(false);

  useEffect(() => {
    const { data } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_OUT') setCleaning(true);
      else if (event === 'SIGNED_IN') setCleaning(false);
    });
    return () => data.subscription.unsubscribe();
  }, []);

  // 消し終わらなくても、上限の時間で片付ける (オフライン・WebView の不調でも居座らない)
  useEffect(() => {
    if (!cleaning) return;
    const timer = setTimeout(() => setCleaning(false), WEBVIEW_SESSION_CLEANUP_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [cleaning]);

  if (!cleaning) return null;

  return (
    <WebView
      testID="webview-session-cleaner"
      // Web のオリジンを基点にした空のページ。基点があるので、そのオリジンの Cookie / localStorage に触れる。
      // HTML は文字列で渡すので、ネットワークは使わない
      source={{ html: WEBVIEW_SESSION_CLEANUP_HTML, baseUrl: getWebBaseUrl() }}
      injectedJavaScript={buildWebViewSessionCleanupScript()}
      javaScriptEnabled={true}
      domStorageEnabled={true}
      onMessage={(event) => {
        if (isWebViewSessionClearedMessage(event.nativeEvent.data)) setCleaning(false);
      }}
      onError={() => setCleaning(false)}
      onHttpError={() => setCleaning(false)}
      // 画面には出さない。操作も受け付けない
      pointerEvents="none"
      accessible={false}
      importantForAccessibility="no-hide-descendants"
      style={{ position: 'absolute', width: 1, height: 1, opacity: 0 }}
    />
  );
}
