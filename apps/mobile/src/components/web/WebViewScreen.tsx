import React, { useRef, useState, useEffect } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { WebView } from 'react-native-webview';
import { useNavigation, useRouter } from 'expo-router';
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

// 各タブの「所有する」パス prefix と Expo Router タブルート のマッピング
// path は各タブの root path (サブパスも含む前方一致で判定)
const TAB_ROUTES: Array<{ pathPrefix: string; tab: string }> = [
  { pathPrefix: '/menus', tab: '/(tabs)/menus' },
  { pathPrefix: '/meals', tab: '/(tabs)/meals' },
  { pathPrefix: '/comparison', tab: '/(tabs)/comparison' },
  { pathPrefix: '/profile', tab: '/(tabs)/profile' },
  { pathPrefix: '/home', tab: '/(tabs)/home' },
];

// Fix 1: postMessage 方式によるタブ独立性
// WebView 内に inject して <a> クリックを capture phase で捕捉し、
// 別タブのパスへの遷移を preventDefault + postMessage で React Native に通知する。
// onNavigationStateChange / onShouldStartLoadWithRequest よりも確実 (SPA pushState も捕捉)。
const buildTabInterceptScript = (currentTabRoot: string): string => {
  const tabPaths = TAB_ROUTES.map((t) => t.pathPrefix);
  return `
(function() {
  if (window.__tabInterceptInstalled) return;
  window.__tabInterceptInstalled = true;

  var TAB_PATHS = ${JSON.stringify(tabPaths)};
  var CURRENT_TAB_ROOT = ${JSON.stringify(currentTabRoot)};

  function findClickedLink(target) {
    while (target && target !== document.body) {
      if (target.tagName === 'A' && target.href) return target;
      target = target.parentElement;
    }
    return null;
  }

  function matchTab(targetPath) {
    // 自タブ内なら null (素通し)
    if (targetPath === CURRENT_TAB_ROOT || targetPath.indexOf(CURRENT_TAB_ROOT + '/') === 0) return null;
    // 別タブにマッチするか
    for (var i = 0; i < TAB_PATHS.length; i++) {
      var p = TAB_PATHS[i];
      if (targetPath === p || targetPath.indexOf(p + '/') === 0) return p;
    }
    return null;
  }

  // クリックイベントを capture phase で intercept
  document.addEventListener('click', function(e) {
    var link = findClickedLink(e.target);
    if (!link) return;
    try {
      var url = new URL(link.href, window.location.origin);
      if (url.origin !== window.location.origin) return;
      var matched = matchTab(url.pathname);
      if (matched) {
        e.preventDefault();
        e.stopPropagation();
        window.ReactNativeWebView.postMessage(JSON.stringify({
          type: 'tab-navigate',
          path: matched,
          fullPath: url.pathname + url.search,
        }));
      }
    } catch (err) {}
  }, true);

  // Next.js の history.pushState を hook して programmatic navigation も捕捉
  var _pushState = history.pushState.bind(history);
  history.pushState = function() {
    var result = _pushState.apply(history, arguments);
    setTimeout(function() {
      var matched = matchTab(window.location.pathname);
      if (matched) {
        window.ReactNativeWebView.postMessage(JSON.stringify({
          type: 'tab-navigate',
          path: matched,
          fullPath: window.location.pathname + window.location.search,
        }));
        history.back();
      }
    }, 0);
    return result;
  };
})();
true;
`;
};

export const WebViewScreen: React.FC<Props> = ({ path, testID }) => {
  const webViewRef = useRef<WebView>(null);
  const [uri, setUri] = useState<string | null>(null);
  const [injectedJS, setInjectedJS] = useState<string>('');
  const navigation = useNavigation();
  const router = useRouter();

  // タブ再タップ時に WebView を初期 URL にリセットする
  // tabPress は同じタブを再タップした際にも発火するため useFocusEffect より確実
  useEffect(() => {
    const unsubscribe = navigation.addListener('tabPress' as any, () => {
      // isFocused() が true = 既にアクティブなタブを再タップした
      if (navigation.isFocused()) {
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
      }
    });
    return unsubscribe;
  }, [navigation, path]);

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

  // path からクエリ・ハッシュを除いた純粋なパス部分
  const currentTabRoot = path.split('?')[0].split('#')[0];

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
        // Fix 1: postMessage 方式のタブ intercept script を全ページロード後に inject
        // capture phase click + pushState hook で SPA ナビゲーションも確実に捕捉
        injectedJavaScript={buildTabInterceptScript(currentTabRoot)}
        sharedCookiesEnabled={true}
        thirdPartyCookiesEnabled={true}
        contentInsetAdjustmentBehavior="never"
        domStorageEnabled={true}
        javaScriptEnabled={true}
        startInLoadingState={true}
        pullToRefreshEnabled={true}
        // Fix 3: iOS 18 カメラバツボタン workaround
        // <input type="file"> 経由カメラの dismiss が効かないケースへの対処
        // 根本解決は次 PR で expo-image-picker ネイティブブリッジ実装予定
        // TODO: Phase B-2 で <input type="file"> を expo-image-picker bridge に置換
        allowsInlineMediaPlayback={true}
        mediaPlaybackRequiresUserAction={false}
        onMessage={(event) => {
          try {
            const data = JSON.parse(event.nativeEvent.data);
            if (data.type === 'tab-navigate') {
              const matched = TAB_ROUTES.find((t) => t.pathPrefix === data.path);
              if (matched) {
                setTimeout(() => {
                  router.push(matched.tab as any);
                }, 0);
              }
            }
          } catch {
            // JSON パース失敗は無視
          }
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
