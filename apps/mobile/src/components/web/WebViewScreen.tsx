import React, { useRef, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { WebView } from 'react-native-webview';
import { colors } from '../../theme/colors';

const WEB_BASE_URL = process.env.EXPO_PUBLIC_WEB_URL ?? 'https://homegohan-app.vercel.app';

interface Props {
  path: string;  // 例 '/home', '/menus/weekly'
  testID?: string;
}

export const WebViewScreen: React.FC<Props> = ({ path, testID }) => {
  const webViewRef = useRef<WebView>(null);
  const [loading, setLoading] = useState(true);
  // path に既に mode=app が含まれている場合は重複付与しない
  const alreadyHasMode = path.includes('mode=app');
  const separator = path.includes('?') ? '&' : '?';
  const url = alreadyHasMode
    ? `${WEB_BASE_URL}${path}`
    : `${WEB_BASE_URL}${path}${separator}mode=app`;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: '#FFF' }} edges={['top']}>
      <WebView
        ref={webViewRef}
        testID={testID ?? 'webview-screen'}
        source={{ uri: url }}
        sharedCookiesEnabled={true}
        thirdPartyCookiesEnabled={true}
        contentInsetAdjustmentBehavior="never"
        domStorageEnabled={true}
        javaScriptEnabled={true}
        startInLoadingState={true}
        pullToRefreshEnabled={true}
        onLoadStart={() => setLoading(true)}
        onLoadEnd={() => setLoading(false)}
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
