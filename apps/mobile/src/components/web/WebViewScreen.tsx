import React, { useRef, useState, useEffect } from 'react';
import { ActivityIndicator, Alert, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { WebView } from 'react-native-webview';
import { WebViewErrorView } from './WebViewErrorView';
import { useResetInitialPathOnBlur } from './useResetInitialPathOnBlur';
import { useWebViewHttpFailure } from './useWebViewHttpFailure';
import { useNavigation, useRouter, useLocalSearchParams } from 'expo-router';
import { getDownloadFailureNotice, handleWebViewDownload } from '../../lib/webViewDownload';
import { getWebBaseUrl } from '../../lib/webBaseUrl';
import { colors } from '../../theme/colors';
import { NATIVE_APP_TABS, findNativeAppTab } from '@homegohan/shared';
import { supabase } from '../../lib/supabase';

// download の送信元の確認 (webViewDownload.ts) と同じ値から決める (既定値を 2 か所に持たない)
const WEB_BASE_URL = getWebBaseUrl();
const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';
// "https://abc123.supabase.co" → "abc123"
const PROJECT_REF = SUPABASE_URL.replace('https://', '').split('.')[0];

interface Props {
  path: string;  // 例 '/home', '/menus/weekly'
  testID?: string;
}

// 各タブの「所有する」パス prefix と Expo Router タブルート のマッピング
// path は各タブの root path (サブパスも含む前方一致で判定)
// 定義は @homegohan/shared の NATIVE_APP_TABS が唯一の場所 (Web の NativeAppTabRouter も同じ表を見る)。
// 以前はここと Web で別々の一覧を持っていて、'/meals' と '/meals/new' が食い違っていた (#1049 F7-22)。
const TAB_ROUTES: Array<{ pathPrefix: string; tab: string }> = NATIVE_APP_TABS.map((t) => ({
  pathPrefix: t.pathPrefix,
  tab: t.route,
}));

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

const WebViewScreenBody: React.FC<Props & { onRetry: () => void }> = ({ path, testID, onRetry }) => {
  const webViewRef = useRef<WebView>(null);
  const [uri, setUri] = useState<string | null>(null);
  const [injectedJS, setInjectedJS] = useState<string>('');
  const navigation = useNavigation();
  const router = useRouter();
  // 他のタブへ移ったら、残っている initialPath を消す (#1049 F7-15)
  useResetInitialPathOnBlur();
  // サーバーが 5xx を返したことを覚える (#1049 F7-15)
  const httpFailure = useWebViewHttpFailure();

  // Fix 2: tab-navigate で fullPath (クエリ付き) を受け取った場合に初期 URL を上書き
  const params = useLocalSearchParams<{ initialPath?: string }>();
  const effectivePath = params.initialPath ?? path;

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
        // window.location.replace で履歴を残さず初期 URL に置換してフレッシュな state に戻す
        // (写真撮影デッドロック対策: step state や input キャッシュをリセット)
        webViewRef.current?.injectJavaScript(`
          (function() {
            window.location.replace('${targetUrl}');
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
        // effectivePath に既に mode=app が含まれている場合は重複付与しない
        const alreadyHasMode = effectivePath.includes('mode=app');
        const separator = effectivePath.includes('?') ? '&' : '?';
        const nextPath = alreadyHasMode
          ? effectivePath
          : `${effectivePath}${separator}mode=app`;
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
        // セッションなし → 直接 effectivePath (mode=app 付き)
        const alreadyHasMode = effectivePath.includes('mode=app');
        const separator = effectivePath.includes('?') ? '&' : '?';
        const directUrl = alreadyHasMode
          ? `${WEB_BASE_URL}${effectivePath}`
          : `${WEB_BASE_URL}${effectivePath}${separator}mode=app`;
        setUri(directUrl);
        setInjectedJS('');
      }
    };
    init();
  }, [effectivePath]);

  // effectivePath からクエリ・ハッシュを除いた純粋なパス部分
  const currentTabRoot = effectivePath.split('?')[0].split('#')[0];

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
              // data.path はタブの prefix そのものが来るのが正だが、Web 側が '/meals/new' のように
              // タブ配下のパスを送ってきても同じタブとして扱う (読み捨てない)
              const matchedTab = typeof data.path === 'string' ? findNativeAppTab(data.path) : null;
              const matched = matchedTab ? { pathPrefix: matchedTab.pathPrefix, tab: matchedTab.route } : undefined;
              if (matched) {
                setTimeout(() => {
                  // Fix 2: fullPath (クエリパラメータ含む) を initialPath として渡すことで
                  // 買い物リストのモーダル等を開くクエリが失われないようにする
                  if (data.fullPath && data.fullPath !== matched.pathPrefix) {
                    router.push({
                      pathname: matched.tab as any,
                      params: { initialPath: data.fullPath },
                    });
                  } else {
                    router.push(matched.tab as any);
                  }
                }, 0);
              }
            } else if (data.type === 'navigate-back') {
              // × ボタンや戻るボタン用: Expo Router の history を使って前画面に戻る
              if (router.canGoBack()) {
                router.back();
              } else {
                router.push('/(tabs)/home' as any);
              }
            } else if (data.type === 'download') {
              // Fix 3: iOS WebView でのエクスポート対応
              // Web 側から postMessage で受け取ったファイル内容を expo-sharing で保存・共有
              // filename / content / mimeType も送信元ページも WebView 内の JS が自由に作れるので信用せず、
              // 送信元・ファイル名・サイズの検証と cacheDirectory への保存は webViewDownload.ts に集約 (#1159)
              // 正規のエクスポートが失敗したときは、「押しても何も起きない」ように見えないよう利用者に知らせる
              void handleWebViewDownload(data, event.nativeEvent.url).then((result) => {
                const notice = getDownloadFailureNotice(result);
                if (notice) Alert.alert(notice.title, notice.message);
              });
            }
          } catch {
            // JSON パース失敗は無視
          }
        }}
        renderLoading={() => (
          <View testID="webview-loading" style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
            <ActivityIndicator size="large" color={colors.accent} />
          </View>
        )}
        // #1049 F7-15: 読み込みに失敗したとき (オフライン・DNS・接続・タイムアウトなど) と、
        // サーバーが 5xx を返したときに、日本語の案内と「再読み込み」を出す (以前は何も無かった)
        onHttpError={httpFailure.onHttpError}
        onLoadStart={httpFailure.onLoadStart}
        renderError={() => <WebViewErrorView failure={{ kind: 'network' }} onRetry={onRetry} />}
      />
      {httpFailure.statusCode !== null ? (
        <WebViewErrorView failure={{ kind: 'server', statusCode: httpFailure.statusCode }} onRetry={onRetry} />
      ) : null}
    </SafeAreaView>
  );
};

/**
 * 画面の入口。読み込みに失敗して「再読み込み」が押されたら、WebView の reload() ではなく、画面ごと作り直す。
 * 認証ブリッジの URL は、使い捨てにできる (一度しか使えない) 値を含みうるので、同じ URL を読み直すのではなく、
 * セッションの確認から (init を) 最初からやり直して、新しい URL で読み込む (#1049 F7-15)。
 */
export const WebViewScreen: React.FC<Props> = (props) => {
  const [attempt, setAttempt] = useState(0);
  return <WebViewScreenBody key={attempt} {...props} onRetry={() => setAttempt((n) => n + 1)} />;
};
