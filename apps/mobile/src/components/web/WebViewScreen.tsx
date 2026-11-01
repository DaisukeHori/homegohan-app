import React, { useRef, useState, useEffect } from 'react';
import { ActivityIndicator, Alert, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { WebView } from 'react-native-webview';
import { useNavigation, useRouter, useLocalSearchParams } from 'expo-router';
import { NATIVE_APP_TABS, findNativeAppTabByPathPrefix } from '@homegohan/shared';
import { WebViewErrorView } from './WebViewErrorView';
import { NativeMfaVerifyModal } from '../NativeMfaVerifyModal';
import { useResetInitialPathOnBlur } from './useResetInitialPathOnBlur';
import { useWebViewHttpFailure } from './useWebViewHttpFailure';
import { getDownloadFailureNotice, handleWebViewDownload } from '../../lib/webViewDownload';
import { colors } from '../../theme/colors';
import { supabase } from '../../lib/supabase';
import { useWebAuthMessages } from '../../lib/webViewAuthMessages';
import { notifyLegalConsentAccepted, parseLegalConsentMessage } from '../../lib/legal-consent';
import { subscribeAiConsultationDataChanged } from '../../lib/ai-consultation-data-changed';
import {
  buildClearUserScopedWebStorageScript,
  readPendingWebViewUserScopedStorageClear,
} from '../../lib/webViewUserStorageCleanup';
// 認証ブリッジ・オリジン検証・外部遷移の判定は webViewBridge.ts に集約 (#1036 / #1158)
import {
  WEB_VIEW_ORIGIN_WHITELIST,
  buildBridgeUrl,
  buildNavigateScript,
  buildOriginGuardScript,
  buildOwnOriginOnlyScript,
  buildReloadCurrentPageScript,
  buildWebUrl,
  decideNavigation,
  decideOpenWindow,
  getSessionForBridge,
  isOwnOrigin,
  openExternalUrl,
  pathnameOf,
  requestBridgeCode,
  sanitizeInitialPath,
  withAppMode,
} from '../../lib/webViewBridge';

interface Props {
  path: string;  // 例 '/home', '/menus/weekly'
  testID?: string;
  // WebView の上 (上端の安全領域の内側) に置くネイティブの部品。
  // マイページのタブの歯車 (ネイティブの設定画面への入口) に使う (#1037。設計書 01-architecture.md §3.2)
  header?: React.ReactNode;
  // Web からのログアウト (sign-out・失効の session-expired) でネイティブもログアウトした後に呼ぶ。渡さなければ今までどおり
  // ウェルカム画面へ (router.replace('/'))。規約の同意画面 (app/legal-consent.tsx) だけが渡し、ウェルカムへ移らずに
  // Web の「同意しない」「登録をやめる」の後の案内を残す (#1442)
  afterSignOut?: () => void;
  // true なら、AI 相談のシートが提案を実行してデータを変えたとき (notifyAiConsultationDataChanged) に、今のページを読み込み直す (#2189 W2)。
  // AI 相談の提案が変えるデータ (献立・食事・買い物リスト・冷蔵庫・健康の記録・好みなど) を出すタブだけが渡す
  // (ホーム・献立・比較・マイページ)。入力の途中の画面 (スキャンのタブ・規約の同意など) は渡さない (読み込み直すと入力が消える)
  reloadOnAiConsultationDataChange?: boolean;
}

// 各タブの「受け持つ」パスの prefix と Expo Router のタブのルートの対応は、@homegohan/shared の NATIVE_APP_TABS だけが決める
// (Web の NativeAppTabRouter も同じ表を見る)。以前はここと Web で別々の一覧を持っていて、'/meals' と '/meals/new' が
// 食い違い、Web が送った tab-navigate が読み捨てられていた (#1612 / #1049 F7-22)
const TAB_PATH_PREFIXES: string[] = NATIVE_APP_TABS.map((tab) => tab.pathPrefix);

// Fix 1: postMessage 方式によるタブ独立性
// WebView 内に inject して <a> クリックを capture phase で捕捉し、
// 別タブのパスへの遷移を preventDefault + postMessage で React Native に通知する。
// onNavigationStateChange / onShouldStartLoadWithRequest よりも確実 (SPA pushState も捕捉)。
const buildTabInterceptScript = (currentTabRoot: string): string => {
  const tabPaths = TAB_PATH_PREFIXES;
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

// この画面が navigation で使うのは、タブの再タップ (tabPress) の購読と isFocused の 2 つだけ。
// useNavigation() の既定の型はルートのナビゲーターの型で、イベントの一覧に tabPress が無い (タブのナビゲーターだけが持つ)。
// そのため使う 2 つを型で宣言して useNavigation の型引数に渡す (イベント名を any へ外して型検査を止めない)。
// タブ以外の画面 (/settings/ai-consent など) では tabPress が発火しないだけで、購読も解除も同じに動く
type TabPressNavigation = {
  addListener: (event: 'tabPress', callback: () => void) => () => void;
  isFocused: () => boolean;
};

type WebViewScreenBodyProps = Props & {
  /** 読み込みの失敗の画面で「再読み込み」が押されたとき (WebViewScreen を参照) */
  onRetry: () => void;
};

const WebViewScreenBody: React.FC<WebViewScreenBodyProps> = ({
  path,
  testID,
  header,
  afterSignOut,
  reloadOnAiConsultationDataChange,
  onRetry,
}) => {
  const webViewRef = useRef<WebView>(null);
  const [uri, setUri] = useState<string | null>(null);
  // WebView を開くときに注入する前の利用者の localStorage の掃除 (#1037)。自オリジンのガード付き。掃除が要らなければ空
  const [injectedJS, setInjectedJS] = useState<string>('');
  const navigation = useNavigation<TabPressNavigation>();
  const router = useRouter();

  // Fix 2: tab-navigate で fullPath (クエリ付き) を受け取った場合に初期 URL を上書き
  // initialPath は deep link (homegohan://home?initialPath=…) からも指定できるため、
  // 単一の "/" で始まる同一オリジンのパスで、かつどれかのタブの prefix か、この画面自身の path のパス部分の配下のものだけを受け付ける
  // (//evil.example や /auth/native-bridge?code=… 等は path に戻す。tab-navigate の fullPath は必ずタブの prefix に一致する)。
  // 画面自身の path を入れるのは、タブ以外の画面 (/settings/ai-consent) でも session-expired の再 bridge
  // (initialPath に使い捨ての _rb を付けて effectivePath を変え、下の useEffect で code を取り直す) を効かせるため。
  // path はコードに書かれた信頼できる値なので、受け付ける範囲はタブの prefix と同じ強さで限られる
  const params = useLocalSearchParams<{ initialPath?: string }>();
  const effectivePath = sanitizeInitialPath(params.initialPath, path, [...TAB_PATH_PREFIXES, pathnameOf(path)]);

  // 他のタブへ移ったら、残っている initialPath を消す (#1612 / #1049 F7-15。理由は useResetInitialPathOnBlur.ts)
  useResetInitialPathOnBlur(Boolean(params.initialPath));
  // サーバーが 5xx (503 を除く) を返したことを覚えて、案内と「再読み込み」を出す (#1612 / #1049 F7-15)
  const httpFailure = useWebViewHttpFailure();

  // Web 側のログアウト・セッション失効の通知 (sign-out / session-expired) をネイティブに反映する (#1038 F7-04 / F7-05)。
  // 再 bridge は、いま開いているパス (検証済みの effectivePath) に _rb を付けて開き直す。
  // 検証で弾かれる initialPath を基準にすると、_rb を付けても path に戻されて effectivePath が変わらず、読み込み直しが起きない
  // 二段階認証の確認の依頼 (mfa-verify-required。docs/design/cross/12-operator-mfa.md §16.4.5) を受けたら、
  // ネイティブの確認画面 (NativeMfaVerifyModal) を出す。rebridge は確認が済んだ後に WebView を読み込み直す関数
  // (いま開いているパス effectivePath に _rb を付け直す。回数制限を通さない)。
  // 関数をそのまま state に入れない (setState(fn) は更新関数として呼ばれる) ので object で包む
  const [mfaVerifyRequest, setMfaVerifyRequest] = useState<{ rebridge: () => void } | null>(null);
  const handleAuthMessage = useWebAuthMessages(effectivePath, {
    onMfaVerifyRequested: (rebridge) => setMfaVerifyRequest({ rebridge }),
    // Web からのログアウトの後の移り先。渡した画面 (規約の同意画面だけ) はウェルカムへ移らずにこれを呼ぶ (#1442)
    afterSignOut,
  });

  // タブ再タップ時に WebView を初期 URL にリセットする
  // tabPress は同じタブを再タップした際にも発火するため useFocusEffect より確実
  useEffect(() => {
    const unsubscribe = navigation.addListener('tabPress', () => {
      // isFocused() が true = 既にアクティブなタブを再タップした
      if (navigation.isFocused()) {
        const targetUrl = buildWebUrl(withAppMode(path));
        // window.location.replace で履歴を残さず初期 URL に置換してフレッシュな state に戻す
        // (写真撮影デッドロック対策: step state や input キャッシュをリセット)
        // URL は JSON.stringify でリテラル化する (#1036)。
        // オリジンガードは付けない (guard: false)。このリセットは、WebView が自オリジンを表示していないときの復帰手段でもある:
        //   - 起動時にオフラインで直接 URL の読み込みに失敗すると、iOS は about:blank (origin は "null") のままエラー表示になる。
        //     読み込みの失敗の画面の「再読み込み」(#1612 F7-15。init からやり直す) と並ぶ、戻る手段の一つ
        //   - Android の shouldOverrideUrlLoading が待ち時間切れで許可に倒れ、外部ページが WebView に載った場合も同じ
        // このスクリプトが持つのは公開されている自オリジンの URL だけ (トークン・code は無い) なので、
        // 外部ページ上で実行されても漏れるものが無い。
        webViewRef.current?.injectJavaScript(buildNavigateScript(targetUrl, 'replace', { guard: false }));
      }
    });
    return unsubscribe;
  }, [navigation, path]);

  // AI 相談のシートが提案を実行してデータを変えたら、今のページを読み込み直す (#2189 W2。src/lib/ai-consultation-data-changed.ts)。
  // 読み込み直しは今の URL のまま (タブの中で移ったページ・クエリを保つ)。自オリジンのページでだけ動き、認証ブリッジのページでは動かない
  // (buildReloadCurrentPageScript)。WebView がまだ無い (uri を作っている途中) ときは何もしない (これから最新を読み込む)
  useEffect(() => {
    if (!reloadOnAiConsultationDataChange) return undefined;
    return subscribeAiConsultationDataChanged(() => {
      webViewRef.current?.injectJavaScript(buildReloadCurrentPageScript());
    });
  }, [reloadOnAiConsultationDataChange]);

  useEffect(() => {
    // effectivePath が変わる/アンマウントした後に、遅れて返ってきた結果で URL を上書きしない
    let cancelled = false;

    // bridge 用のセッション取得と code 発行。失敗はすべて null (= トークンを含まない直接 URL) に倒す
    // (旧方式のトークン付き URL には決してフォールバックしない)。
    const resolveBridgeCode = async (): Promise<string | null> => {
      try {
        // access_token の残りが少なければ先に更新する。Web 側は残りが 150 秒未満の access_token には code を発行せず 401 を返すうえ、
        // Web 側 setSession による refresh_token のローテーションも避けたいため (閾値の根拠は webViewBridge.ts の BRIDGE_MIN_TOKEN_TTL_SEC)。
        // 更新に失敗して残りが Web 側の下限を割る場合は null が返り、code 発行を呼ばずに直接 URL へ倒れる
        const session = await getSessionForBridge(supabase.auth);
        if (!session) return null;
        // ネイティブが Bearer で code を発行してもらい、WebView の URL には code だけを載せる (#1036)
        // access_token / refresh_token は URL・注入スクリプト・WebView の props のどこにも載せない
        return await requestBridgeCode(session);
      } catch {
        // 想定外の失敗でも直接 URL にフォールバックする
        return null;
      }
    };

    const init = async () => {
      // effectivePath に既に mode=app が含まれている場合は重複付与しない
      const nextPath = withAppMode(effectivePath);

      // ネイティブのログアウト・退会のあとなら、Web のページが読み込まれる前に、前の利用者の localStorage を消す (#1037)。
      // ログイン中・未ログインのどちらで開くときも入れる (webViewUserStorageCleanup.ts)。
      // 掃除の ID (AsyncStorage) と bridge の code は並べて取る (読み込みを遅らせない。ID の読み込みは例外を投げない)。
      // 掃除は利用者別のキーだけを消し、セッションには触れない。セッションは native-bridge が Cookie に張るので (#1036)、
      // 掃除と bridge の順序はぶつからない。
      const [pendingClearId, code] = await Promise.all([
        readPendingWebViewUserScopedStorageClear(),
        resolveBridgeCode(),
      ]);
      if (cancelled) return;

      // 掃除の JS は自アプリのオリジンのページでだけ動かす (#1036)。
      // injectedJavaScriptBeforeContentLoaded は WebView のすべての読み込みで動くので、外部ページが万一載っても、
      // そのサイトの localStorage を消したり書いたりしない。
      // 前の利用者の Supabase の認証の Cookie (iOS の WKWebView の置き場に残るもの) も、認証ブリッジ無しで開くときだけ消す
      // (#1612 / #1049 F7-16)。ブリッジで開くときに消すと、ブリッジがいま張った新しい利用者の Cookie を消してしまう
      // (ブリッジは同じ名前の Cookie を上書きするので、前の利用者の Cookie は残らない。webViewUserStorageCleanup.ts の「Cookie」)
      setInjectedJS(
        pendingClearId
          ? buildOwnOriginOnlyScript(buildClearUserScopedWebStorageScript(pendingClearId, { clearAuthCookies: !code }))
          : '',
      );
      // 既定はトークンを一切含まない直接 URL。bridge に成功したときだけ code 付き URL に差し替える
      setUri(code ? buildBridgeUrl(code, nextPath) : buildWebUrl(nextPath));
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
        {header}
        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
          <ActivityIndicator size="large" color={colors.accent} />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: '#FFF' }} edges={['top']}>
      {header}
      {/* 失敗の案内は WebView の部分だけを覆う (header = マイページの歯車は押せるまま残す) */}
      <View style={{ flex: 1 }}>
        <WebView
          ref={webViewRef}
          testID={testID ?? 'webview-screen'}
          source={{ uri }}
          // セッション情報 (トークン・localStorage のセッション) はページコンテキストへ一切注入しない (#1036)。
          // Web 側のセッションは native-bridge が Cookie に張る。
          // 読み込み前に注入するのは、ネイティブのログアウト後の利用者別の localStorage の掃除 (#1037) と、
          // 認証ブリッジ無しで開くときの前の利用者の認証の Cookie の掃除 (#1612 F7-16) だけで、
          // 自アプリのオリジンのページでだけ動く (buildOwnOriginOnlyScript)
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
          // #1036 / #1158: WebView を自アプリのオリジンに固定する。
          // 他オリジンへのトップフレーム遷移 (レシピ外部リンク等) は WebView に載せず OS の既定ブラウザで開く。
          // 他オリジンの iframe (Web の CSP が許す Turnstile) は WebView の中で読み込む (decideNavigation を参照)。
          // originWhitelist は未アンカーの前方一致で境界にならないため、URL を厳密にパースして判定する。
          // Android の shouldOverrideUrlLoading は JS の応答待ちが長引くと許可に倒れるので、
          // これは多層防御の一つ (本命は、ページから参照できるトークンを持たせないこと)。
          // originWhitelist は「どの URL を下の onShouldStartLoadWithRequest に渡すか」の入口 (WEB_VIEW_ORIGIN_WHITELIST を参照)。
          // http(s) はすべて判定に渡し、自オリジンかどうかは decideNavigation が URL を厳密にパースして決める。
          originWhitelist={WEB_VIEW_ORIGIN_WHITELIST}
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
            // 送信元が自アプリのオリジンでなければ、tab-navigate / download / legal-consent-accepted 等のメッセージは一切処理しない。
            // event.nativeEvent.url に入るもの (react-native-webview 13.13.5 のソースで確認):
            //   - iOS: メッセージを送ったフレームの request URL (WKScriptMessage.frameInfo.request)
            //   - Android: WebMessageListener に対応した WebView では、送ったフレームのオリジン。
            //     非対応の古い WebView (fallback の JavascriptInterface) ではトップフレームの URL (getUrl())
            // 最後のケースでは、自オリジンのページの中の他オリジンの iframe からのメッセージもこのゲートを通る。
            // Web の CSP (src/lib/security/csp.ts の frame-src) が許す他オリジンの iframe は Cloudflare Turnstile だけ
            // (/login、/settings/account のパスワード変更など。webViewBridge.ts の WEB_VIEW_EMBED_ORIGINS)。
            // この経路ではゲートが境界にならないので、Turnstile の iframe からのメッセージを止めるものは、下の各処理の中身の検証だけになる
            // (tab-navigate はタブの prefix と sanitizeInitialPath、download は webViewDownload.ts の送信元・ファイル名・サイズ)。
            // 埋め込みを足すときは、CSP とあわせて Android 実機で確認すること
            // (onShouldStartLoadWithRequest 側の Android の注記は webViewBridge.ts の NavigationRequestLike を参照)
            if (!isOwnOrigin(event.nativeEvent.url)) return;
            try {
              const data = JSON.parse(event.nativeEvent.data);
              if (data.type === 'tab-navigate') {
                // path はタブの pathPrefix そのもの (Web の NativeAppTabRouter も注入したスクリプトも、同じ表の pathPrefix を送る)
                const matched = findNativeAppTabByPathPrefix(data.path);
                if (matched) {
                  setTimeout(() => {
                    // Fix 2: fullPath (クエリパラメータ含む) を initialPath として渡すことで
                    // 買い物リストのモーダル等を開くクエリが失われないようにする
                    if (data.fullPath && data.fullPath !== data.path) {
                      router.push({
                        pathname: matched.route,
                        params: { initialPath: data.fullPath },
                      });
                    } else {
                      router.push(matched.route);
                    }
                  }, 0);
                }
              } else if (data.type === 'navigate-back') {
                // × ボタンや戻るボタン用: Expo Router の history を使って前画面に戻る
                if (router.canGoBack()) {
                  router.back();
                } else {
                  router.push('/(tabs)/home');
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
              } else if (
                data.type === 'sign-out' ||
                data.type === 'session-expired' ||
                data.type === 'mfa-verify-required'
              ) {
                // Web 側でログアウトした / Web 側のセッションが切れた / Web が二段階認証の確認を頼んだ (cross/12 §16.4)。
                // 送り元の検証と処理は useWebAuthMessages に集約している
                handleAuthMessage(data, event.nativeEvent.url);
              } else if (parseLegalConsentMessage(data)) {
                // #1442: Web の同意画面 (/legal-consent) で同意が記録できた。LegalConsentProvider が clear にし、ゲートが同意画面から入口へ移す
                notifyLegalConsentAccepted();
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
          // #1612 / #1049 F7-15: 読み込みに失敗したとき (オフライン・DNS・接続・時間切れなど) と、サーバーが 5xx を返したときに、
          // 日本語の案内と「再読み込み」を出す (以前は何も無く、ライブラリの英語の文かサーバーのエラーページがそのまま出ていた)。
          // 読み込みの失敗の画面は WebView の renderError が出す (react-native-webview は、次の読み込みが終わるまでこの画面を WebView の上に出し続ける)。
          // 5xx はページの読み込み自体は成功扱いなので、onHttpError で覚えて下で WebView の上に重ねる。
          // 503 は重ねない (メンテナンス中の画面を Web が 503 で返す。useWebViewHttpFailure.ts の shouldCoverHttpStatus)
          onError={httpFailure.onLoadError}
          onHttpError={httpFailure.onHttpError}
          onLoadEnd={httpFailure.onLoadEnd}
          renderError={() => <WebViewErrorView failure={{ kind: 'network' }} onRetry={onRetry} />}
        />
        {httpFailure.statusCode !== null ? (
          <WebViewErrorView failure={{ kind: 'server', statusCode: httpFailure.statusCode }} onRetry={onRetry} />
        ) : null}
        {/* 二段階認証の確認 (cross/12 §16.4.5)。要求が無いときは何も描かない。確認が済んだら閉じて、いまのパスを開き直す */}
        {mfaVerifyRequest ? (
          <NativeMfaVerifyModal
            onClose={() => setMfaVerifyRequest(null)}
            onVerified={() => {
              const { rebridge } = mfaVerifyRequest;
              setMfaVerifyRequest(null);
              rebridge();
            }}
          />
        ) : null}
      </View>
    </SafeAreaView>
  );
};

/**
 * 画面の入口。読み込みに失敗して「再読み込み」が押されたら、WebView の reload() ではなく、中身を作り直す (#1612 / #1049 F7-15)。
 * 認証ブリッジの URL の code は一度しか使えない (#1036) ので、同じ URL を読み直すとログインできない。セッションの確認と
 * code の発行 (init) を最初からやり直して、新しい URL で読み込む。iOS で起動時にオフラインだったときの about:blank からも、
 * これで戻れる (以前はタブの再タップだけが戻る手段だった)。
 */
export const WebViewScreen: React.FC<Props> = (props) => {
  const [attempt, setAttempt] = useState(0);
  return <WebViewScreenBody key={attempt} {...props} onRetry={() => setAttempt((n) => n + 1)} />;
};
