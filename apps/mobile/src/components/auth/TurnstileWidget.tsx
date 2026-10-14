/**
 * Cloudflare Turnstile のウィジェット (小さな WebView) と、それを画面から使うためのフック (#1165)
 *
 * ログイン・新規登録・パスワード再設定の 3 画面で使う。使い方は Web 版 (src/components/auth/TurnstileWidget.tsx) と同じ:
 *
 *   const captcha = useTurnstile();
 *   ...
 *   <TurnstileWidget {...captcha.widgetProps} action="login" />
 *   <Pressable disabled={!captcha.ready}>...</Pressable>
 *   ...
 *   // 送信の直前に 1 回だけ呼ぶ (トークンは 1 回しか使えない。呼んだ時点で、次のトークンの取り直しが始まる)
 *   const captchaToken = captcha.takeToken();
 *   await supabase.auth.signInWithPassword({ email, password, ...(captchaToken ? { options: { captchaToken } } : {}) });
 *
 * サイトキー (EXPO_PUBLIC_TURNSTILE_SITE_KEY) が未設定のときは Turnstile は無効:
 * ウィジェットは何も表示せず、ready は常に true、takeToken() は null を返す (= 今までどおりの動き)。
 *
 * WebView には、Web のベース URL (EXPO_PUBLIC_WEB_URL。既定 https://homegohan-app.vercel.app) を baseUrl として与える。
 * Turnstile は、動かしているページのホスト名が、Cloudflare のウィジェットに登録した許可ホスト名に入っているかを確かめるため、
 * このホスト名を許可しておく必要がある (docs/operations/auth-protection.md)。
 */

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from 'react';
import { Linking, Pressable, Text, View } from 'react-native';
import { WebView } from 'react-native-webview';
import type { WebViewMessageEvent } from 'react-native-webview';

import {
  buildTurnstileHtml,
  getTurnstileSiteKey,
  isExternalHttpsUrl,
  parseTurnstileMessage,
  type TurnstileAction,
} from '../../lib/turnstile';
import { getWebBaseUrl } from '../../lib/webBaseUrl';
import { colors, radius, spacing } from '../../theme';

/** ウィジェットの高さ (Cloudflare の size=flexible は高さ 65px) */
const WIDGET_HEIGHT = 70;

/**
 * この時間 (ミリ秒) のあいだトークンも失敗の知らせも届かなければ、失敗として扱って「もう一度確認する」を出す。
 * WebView の中の JavaScript が動かなかった場合などに、送信ボタンが押せないまま理由も分からない状態を防ぐ。
 * 利用者の操作が要る確認 (チェックボックス) の途中でも出るが、そのあと操作が済めば、トークンが届いて元に戻る。
 */
const WATCHDOG_MS = 45_000;

/** 親から呼べる操作 */
export interface TurnstileWidgetHandle {
  /** いまのトークンを捨てて、確認をやり直す */
  reset: () => void;
}

export interface TurnstileWidgetProps {
  /** Cloudflare の管理画面の集計で、どの画面の確認かを見分けるための名前 */
  action: TurnstileAction;
  /** トークンが取れたら文字列。期限切れ・失敗・やり直しのときは null */
  onTokenChange: (token: string | null) => void;
}

type WidgetStatus = 'loading' | 'ready' | 'error';

export const TurnstileWidget = forwardRef<TurnstileWidgetHandle, TurnstileWidgetProps>(function TurnstileWidget(
  { action, onTokenChange },
  ref,
) {
  const siteKey = getTurnstileSiteKey();
  // 親が関数を作り直しても、WebView を作り直さずに済ませる (いつも最新の関数を呼ぶ)
  const onTokenChangeRef = useRef(onTokenChange);
  onTokenChangeRef.current = onTokenChange;

  const [status, setStatus] = useState<WidgetStatus>('loading');
  const [errorCode, setErrorCode] = useState<string | null>(null);
  // 増やすと、WebView ごと作り直して、確認を最初からやり直す
  const [attempt, setAttempt] = useState(0);

  const html = useMemo(() => (siteKey ? buildTurnstileHtml(siteKey, action) : ''), [siteKey, action]);

  const fail = useCallback((code: string) => {
    setStatus('error');
    setErrorCode(code);
    onTokenChangeRef.current(null);
  }, []);

  const handleMessage = useCallback(
    (event: WebViewMessageEvent) => {
      const message = parseTurnstileMessage(event.nativeEvent.data);
      if (!message) return;
      switch (message.type) {
        case 'token':
          setStatus('ready');
          setErrorCode(null);
          onTokenChangeRef.current(message.token);
          break;
        case 'expired':
          // 期限切れは、ウィジェットが自動で取り直す。取り直すまで送信は止める
          setStatus('loading');
          onTokenChangeRef.current(null);
          break;
        case 'error':
          // 一時的な失敗は、Turnstile が自動で再試行する。成功すれば token で ready に戻る
          fail(message.code);
          break;
      }
    },
    [fail],
  );

  // ウィジェットの中の別ウィンドウのリンク (Cloudflare の「プライバシー」「利用規約」。target="_blank") は、外のブラウザで開く。
  // onOpenWindow を渡さないと、iOS はそのページを同じ WebView (高さ 70px のウィジェット) に読み込んで、ウィジェットを置き換えてしまう
  // (トークンを取る前なら、45 秒後の見張りまで確認をやり直せなくなる)。Android は画面に出ない別の WebView に読み込むだけで、何も起きない。
  // 渡すと、どちらも WebView はそのままで、リンクの URL だけがここへ届く (react-native-webview 13.13.5 のネイティブ実装で確認)。
  const handleOpenWindow = useCallback(async (event: { nativeEvent: { targetUrl: string } }) => {
    const url = event.nativeEvent.targetUrl;
    if (!isExternalHttpsUrl(url)) return;
    try {
      await Linking.openURL(url);
    } catch {
      // 外のブラウザを開けなくても、ウィジェットはそのまま使える
    }
  }, []);

  // WebView の中から何も知らせが来ないとき (JavaScript が動かないなど) の見張り
  useEffect(() => {
    if (!siteKey || status !== 'loading') return;
    const timer = setTimeout(() => fail('timeout'), WATCHDOG_MS);
    return () => clearTimeout(timer);
  }, [siteKey, status, attempt, fail]);

  const reset = useCallback(() => {
    onTokenChangeRef.current(null);
    setStatus('loading');
    setErrorCode(null);
    setAttempt((n) => n + 1);
  }, []);

  useImperativeHandle(ref, () => ({ reset }), [reset]);

  if (!siteKey) return null;

  return (
    <View testID="turnstile" style={{ gap: spacing.sm }}>
      <View style={{ height: WIDGET_HEIGHT }}>
        <WebView
          key={attempt}
          testID="turnstile-webview"
          source={{ html, baseUrl: getWebBaseUrl() }}
          originWhitelist={['*']}
          javaScriptEnabled
          domStorageEnabled
          onMessage={handleMessage}
          onOpenWindow={handleOpenWindow}
          onError={() => fail('webview')}
          scrollEnabled={false}
          bounces={false}
          overScrollMode="never"
          showsHorizontalScrollIndicator={false}
          showsVerticalScrollIndicator={false}
          style={{ backgroundColor: 'transparent' }}
        />
      </View>
      {status === 'loading' && (
        // 送信ボタンが押せない理由を伝える文なので、文字として読める濃さにする (textMuted は薄くて AA の 4.5:1 に届かない。textLight は届く)
        <Text testID="turnstile-hint" style={{ fontSize: 12, color: colors.textLight }}>
          ボットではないことを確認しています。確認が終わるとボタンを押せます。
        </Text>
      )}
      {status === 'error' && (
        <View
          testID="turnstile-error"
          style={{
            backgroundColor: colors.errorLight,
            borderRadius: radius.lg,
            padding: spacing.md,
            gap: spacing.sm,
          }}
        >
          {/* 赤い文字には、塗り用の error ではなく、AA (4.5:1) を満たす dangerText を使う (CLAUDE.md「状態色」) */}
          <Text style={{ fontSize: 14, color: colors.dangerText }}>
            ボットではないことの確認を完了できませんでした。通信状況をご確認のうえ、もう一度お試しください。
          </Text>
          {errorCode !== null && (
            <Text style={{ fontSize: 12, color: colors.dangerText }}>エラーコード: {errorCode}</Text>
          )}
          <Pressable testID="turnstile-retry" onPress={reset} accessibilityRole="button" hitSlop={8}>
            <Text style={{ fontSize: 14, color: colors.accent, fontWeight: '700' }}>もう一度確認する</Text>
          </Pressable>
        </View>
      )}
    </View>
  );
});

/** 画面が Turnstile を使うためのフックが返すもの */
export interface TurnstileControl {
  /** サイトキーが設定されていて、Turnstile が有効 */
  enabled: boolean;
  /** 送信してよい状態か。無効なら常に true。有効なら、トークンが取れているときだけ true */
  ready: boolean;
  /**
   * トークンを 1 回分として取り出す。取り出した時点でトークンは捨てられ、ウィジェットが新しいトークンを取り直す。
   * 無効のとき、またはトークンがまだ無いときは null。
   * 送信の直前に 1 回だけ呼ぶこと (入力の検証で弾く前に呼ぶと、使っていないトークンを無駄にする)。
   */
  takeToken: () => string | null;
  /** <TurnstileWidget {...widgetProps} action="..." /> と書いて渡す */
  widgetProps: {
    ref: RefObject<TurnstileWidgetHandle | null>;
    onTokenChange: (token: string | null) => void;
  };
}

export function useTurnstile(): TurnstileControl {
  const enabled = getTurnstileSiteKey() !== null;
  const [token, setToken] = useState<string | null>(null);
  // takeToken は、描画を待たずに最新のトークンを見られるよう ref にも持つ
  // (送信ボタンの二度押しで、同じトークンを 2 回使わないため)
  const tokenRef = useRef<string | null>(null);
  const widgetRef = useRef<TurnstileWidgetHandle>(null);

  const onTokenChange = useCallback((next: string | null) => {
    tokenRef.current = next;
    setToken(next);
  }, []);

  const takeToken = useCallback((): string | null => {
    const current = tokenRef.current;
    if (current === null) return null;
    tokenRef.current = null;
    setToken(null);
    widgetRef.current?.reset();
    return current;
  }, []);

  return {
    enabled,
    ready: !enabled || token !== null,
    takeToken,
    widgetProps: { ref: widgetRef, onTokenChange },
  };
}
