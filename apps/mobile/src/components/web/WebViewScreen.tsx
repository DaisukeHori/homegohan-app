import React, { useRef, useState, useEffect } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { WebView } from 'react-native-webview';
import { useNavigation, useRouter, useLocalSearchParams } from 'expo-router';
import * as FileSystem from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { colors } from '../../theme/colors';
import { supabase } from '../../lib/supabase';
// 認証ブリッジ・オリジン検証・外部遷移の判定は webViewBridge.ts に集約 (#1036 / #1158)
import {
  buildBridgeUrl,
  buildNavigateScript,
  buildOriginGuardScript,
  buildWebUrl,
  decideNavigation,
  decideOpenWindow,
  getSessionForBridge,
  isOwnOrigin,
  openExternalUrl,
  requestBridgeCode,
  sanitizeInitialPath,
  withAppMode,
} from '../../lib/webViewBridge';

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
  // 自アプリのオリジン以外 (外部サイトが万一表示された場合) では何もしない (#1036)
  ${buildOriginGuardScript()}
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
  const navigation = useNavigation();
  const router = useRouter();

  // Fix 2: tab-navigate で fullPath (クエリ付き) を受け取った場合に初期 URL を上書き
  // initialPath は deep link (homegohan://home?initialPath=…) からも指定できるため、
  // 単一の "/" で始まる同一オリジンのパスで、かつどれかのタブの prefix 配下のものだけを受け付ける
  // (//evil.example や /auth/native-bridge?code=… 等は path に戻す。tab-navigate の fullPath は必ずタブの prefix に一致する)
  const params = useLocalSearchParams<{ initialPath?: string }>();
  const effectivePath = sanitizeInitialPath(
    params.initialPath,
    path,
    TAB_ROUTES.map((t) => t.pathPrefix),
  );

  // タブ再タップ時に WebView を初期 URL にリセットする
  // tabPress は同じタブを再タップした際にも発火するため useFocusEffect より確実
  useEffect(() => {
    const unsubscribe = navigation.addListener('tabPress' as any, () => {
      // isFocused() が true = 既にアクティブなタブを再タップした
      if (navigation.isFocused()) {
        const targetUrl = buildWebUrl(withAppMode(path));
        // window.location.replace で履歴を残さず初期 URL に置換してフレッシュな state に戻す
        // (写真撮影デッドロック対策: step state や input キャッシュをリセット)
        // URL は JSON.stringify でリテラル化する (#1036)。
        // オリジンガードは付けない (guard: false)。このリセットは、WebView が自オリジンを表示していないときの復帰手段でもある:
        //   - 起動時にオフラインで直接 URL の読み込みに失敗すると、iOS は about:blank (origin は "null") のままエラー表示になる。
        //     エラー表示に再試行手段は無く、init も再実行されないので、戻れるのはこの再タップだけ
        //   - Android の shouldOverrideUrlLoading が待ち時間切れで許可に倒れ、外部ページが WebView に載った場合も同じ
        // このスクリプトが持つのは公開されている自オリジンの URL だけ (トークン・code は無い) なので、
        // 外部ページ上で実行されても漏れるものが無い。
        webViewRef.current?.injectJavaScript(buildNavigateScript(targetUrl, 'replace', { guard: false }));
      }
    });
    return unsubscribe;
  }, [navigation, path]);

  useEffect(() => {
    // effectivePath が変わる/アンマウントした後に、遅れて返ってきた結果で URL を上書きしない
    let cancelled = false;

    const init = async () => {
      // effectivePath に既に mode=app が含まれている場合は重複付与しない
      const nextPath = withAppMode(effectivePath);

      // 既定はトークンを一切含まない直接 URL。bridge に成功したときだけ code 付き URL に差し替える。
      // セッションが無い・refresh できない・code 発行に失敗した場合もここに倒れる
      // (旧方式のトークン付き URL には決してフォールバックしない)。
      let target = buildWebUrl(nextPath);
      try {
        // access_token の残りが少なければ先に更新する。Web 側は残りが 150 秒未満の access_token には code を発行せず 401 を返すうえ、
        // Web 側 setSession による refresh_token のローテーションも避けたいため (閾値の根拠は webViewBridge.ts の BRIDGE_MIN_TOKEN_TTL_SEC)。
        // 更新に失敗して残りが Web 側の下限を割る場合は null が返り、code 発行を呼ばずに直接 URL へ倒れる
        const session = await getSessionForBridge(supabase.auth);
        if (session) {
          // ネイティブが Bearer で code を発行してもらい、WebView の URL には code だけを載せる (#1036)
          // access_token / refresh_token は URL・注入スクリプト・WebView の props のどこにも載せない
          const code = await requestBridgeCode(session);
          if (code) target = buildBridgeUrl(code, nextPath);
        }
      } catch {
        // 想定外の失敗でも直接 URL にフォールバックする
      }
      if (!cancelled) setUri(target);
    };
    init();

    return () => {
      cancelled = true;
    };
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
        // セッション情報 (localStorage 等) はページコンテキストへ一切注入しない (#1036)。
        // Web 側のセッションは native-bridge が Cookie に張る。
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
        // #1036 / #1158: WebView を自アプリのオリジンに固定する。
        // 他オリジンへのトップフレーム遷移 (レシピ外部リンク等) は WebView に載せず OS の既定ブラウザで開く。
        // originWhitelist は未アンカーの前方一致で境界にならないため、URL を厳密にパースして判定する。
        // Android の shouldOverrideUrlLoading は JS の応答待ちが長引くと許可に倒れるので、
        // これは多層防御の一つ (本命は、ページから参照できるトークンを持たせないこと)。
        onShouldStartLoadWithRequest={(request) => {
          const decision = decideNavigation(request);
          if (decision.openExternal) {
            void openExternalUrl(decision.openExternal);
          }
          return decision.allow;
        }}
        // target="_blank" / window.open。iOS は onOpenWindow が無いと同じ WebView で開いてしまい (#1158)、
        // Android は何も起きない。自オリジンは今の WebView で開き、他オリジンは既定ブラウザで開く。
        onOpenWindow={(event) => {
          const decision = decideOpenWindow(event.nativeEvent.targetUrl);
          if (decision.navigateTo) {
            webViewRef.current?.injectJavaScript(buildNavigateScript(decision.navigateTo));
          } else if (decision.openExternal) {
            void openExternalUrl(decision.openExternal);
          }
        }}
        onMessage={(event) => {
          // window.ReactNativeWebView はどのオリジンのページにも存在する。
          // 送信元が自アプリのオリジンでなければ、tab-navigate / download 等のメッセージは一切処理しない。
          // event.nativeEvent.url に入るもの (react-native-webview 13.13.5 のソースで確認):
          //   - iOS: メッセージを送ったフレームの request URL (WKScriptMessage.frameInfo.request)
          //   - Android: WebMessageListener に対応した WebView では、送ったフレームのオリジン。
          //     非対応の古い WebView (fallback の JavascriptInterface) ではトップフレームの URL (getUrl())
          // 最後のケースでは、自オリジンのページに他オリジンの iframe があると、その中からのメッセージもこのゲートを通る。
          // 現状の Web は CSP (next.config.mjs: default-src 'self' で frame-src の指定なし) が外部 iframe を読み込ませないので実害は無い。
          // 動画などの外部埋め込みを足すときは、CSP とあわせて Android 実機で確認すること
          // (onShouldStartLoadWithRequest 側の Android の注記は webViewBridge.ts の NavigationRequestLike を参照)
          if (!isOwnOrigin(event.nativeEvent.url)) return;
          try {
            const data = JSON.parse(event.nativeEvent.data);
            if (data.type === 'tab-navigate') {
              const matched = TAB_ROUTES.find((t) => t.pathPrefix === data.path);
              if (matched) {
                setTimeout(() => {
                  // Fix 2: fullPath (クエリパラメータ含む) を initialPath として渡すことで
                  // 買い物リストのモーダル等を開くクエリが失われないようにする
                  if (data.fullPath && data.fullPath !== data.path) {
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
              const { filename, content, mimeType } = data;
              (async () => {
                try {
                  const filePath = `${FileSystem.documentDirectory}${filename}`;
                  await FileSystem.writeAsStringAsync(filePath, content, {
                    encoding: FileSystem.EncodingType.UTF8,
                  });
                  const isAvailable = await Sharing.isAvailableAsync();
                  if (isAvailable) {
                    await Sharing.shareAsync(filePath, {
                      mimeType,
                      dialogTitle: filename,
                    });
                  }
                } catch (e) {
                  console.error('[WebViewScreen] download failed', e);
                }
              })();
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
      />
    </SafeAreaView>
  );
};
