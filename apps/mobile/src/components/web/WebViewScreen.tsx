import React, { useRef, useState, useEffect } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { WebView } from 'react-native-webview';
import { colors } from '../../theme/colors';
import { supabase } from '../../lib/supabase';

const WEB_BASE_URL = process.env.EXPO_PUBLIC_WEB_URL ?? 'https://homegohan-app.vercel.app';

interface Props {
  path: string;  // 例 '/home', '/menus/weekly'
  testID?: string;
}

export const WebViewScreen: React.FC<Props> = ({ path, testID }) => {
  const webViewRef = useRef<WebView>(null);
  const [uri, setUri] = useState<string | null>(null);

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
      } else {
        // セッションなし → 直接 path (mode=app 付き)
        const alreadyHasMode = path.includes('mode=app');
        const separator = path.includes('?') ? '&' : '?';
        const directUrl = alreadyHasMode
          ? `${WEB_BASE_URL}${path}`
          : `${WEB_BASE_URL}${path}${separator}mode=app`;
        setUri(directUrl);
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
