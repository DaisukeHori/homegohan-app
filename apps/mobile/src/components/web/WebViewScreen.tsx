import React, { useRef, useState, useEffect, useCallback } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { WebView } from 'react-native-webview';
import { useFocusEffect } from 'expo-router';
import { colors } from '../../theme/colors';
import { supabase } from '../../lib/supabase';

const WEB_BASE_URL = process.env.EXPO_PUBLIC_WEB_URL ?? 'https://homegohan-app.vercel.app';
const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';
// "https://abc123.supabase.co" → "abc123"
const PROJECT_REF = SUPABASE_URL.replace('https://', '').split('.')[0];

interface Props {
  path: string;  // 例 '/home', '/menus/weekly'
  testID?: string;
}

export const WebViewScreen: React.FC<Props> = ({ path, testID }) => {
  const webViewRef = useRef<WebView>(null);
  const [uri, setUri] = useState<string | null>(null);
  const [injectedJS, setInjectedJS] = useState<string>('');
  // 初回フォーカスをスキップするためのフラグ
  const isFirstFocus = useRef(true);

  // タブ再タップ時に WebView を初期 URL にリセットする
  useFocusEffect(useCallback(() => {
    if (isFirstFocus.current) {
      isFirstFocus.current = false;
      return;
    }
    // 2 回目以降のフォーカス = 他タブから戻ってきた / タブ再タップ
    const alreadyHasMode = path.includes('mode=app');
    const separator = path.includes('?') ? '&' : '?';
    const targetPath = alreadyHasMode ? path : `${path}${separator}mode=app`;
    const targetUrl = `${WEB_BASE_URL}${targetPath}`;
    webViewRef.current?.injectJavaScript(`
      (function() {
        if (window.location.href !== '${targetUrl}') {
          window.location.href = '${targetUrl}';
        }
      })();
      true;
    `);
  }, [path]));

  useEffect(() => {
    const init = async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (session?.access_token && session?.refresh_token) {
        // bridge URL に access/refresh token + next path を埋め込む
        // path に既に mode=app が含まれている場合は重複付与しない
        const alreadyHasMode = path.includes('mode=app');
        const separator = path.includes('?') ? '&' : '?';
        const nextPath = alreadyHasMode
          ? path
          : `${path}${separator}mode=app`;
        const next = encodeURIComponent(nextPath);
        const bridgeUrl = `${WEB_BASE_URL}/auth/native-bridge?access_token=${session.access_token}&refresh_token=${session.refresh_token}&next=${next}`;
        setUri(bridgeUrl);

        // localStorage 注入: クライアント Supabase JS SDK が参照するキーに session を書き込む
        // SSR middleware は Cookie で動作するが、クライアント側 SDK は localStorage を参照するため両方設定が必要
        const storageKey = `sb-${PROJECT_REF}-auth-token`;
        const sessionPayload = JSON.stringify({
          access_token: session.access_token,
          refresh_token: session.refresh_token,
          expires_at: session.expires_at,
          expires_in: session.expires_in,
          token_type: 'bearer',
          user: session.user,
          provider_token: session.provider_token ?? null,
          provider_refresh_token: session.provider_refresh_token ?? null,
        });
        // JS 文字列リテラル内で安全に使えるよう バックスラッシュ・シングルクォートをエスケープ
        const escapedPayload = sessionPayload
          .replace(/\\/g, '\\\\')
          .replace(/'/g, "\\'");
        setInjectedJS(`
          (function() {
            try {
              window.localStorage.setItem('${storageKey}', '${escapedPayload}');
            } catch (e) {
              // localStorage 書き込み失敗時は Cookie 経由で認証継続
            }
          })();
          true;
        `);
      } else {
        // セッションなし → 直接 path (mode=app 付き)
        const alreadyHasMode = path.includes('mode=app');
        const separator = path.includes('?') ? '&' : '?';
        const directUrl = alreadyHasMode
          ? `${WEB_BASE_URL}${path}`
          : `${WEB_BASE_URL}${path}${separator}mode=app`;
        setUri(directUrl);
        setInjectedJS('');
      }
    };
    init();
  }, [path]);

  if (!uri) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: '#FFF' }} edges={['top']}>
        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
          <ActivityIndicator size="large" color={colors.accent} />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: '#FFF' }} edges={['top']}>
      <WebView
        ref={webViewRef}
        testID={testID ?? 'webview-screen'}
        source={{ uri }}
        injectedJavaScriptBeforeContentLoaded={injectedJS || undefined}
        sharedCookiesEnabled={true}
        thirdPartyCookiesEnabled={true}
        contentInsetAdjustmentBehavior="never"
        domStorageEnabled={true}
        javaScriptEnabled={true}
        startInLoadingState={true}
        pullToRefreshEnabled={true}
        onMessage={(_event) => {
          // ネイティブからのメッセージ受信 (撮影結果等)
          // TODO: Phase B-2 で実装
        }}
        renderLoading={() => (
          <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
            <ActivityIndicator size="large" color={colors.accent} />
          </View>
        )}
      />
    </SafeAreaView>
  );
};
