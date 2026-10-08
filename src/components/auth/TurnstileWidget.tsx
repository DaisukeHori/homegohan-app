'use client';

/**
 * Cloudflare Turnstile のウィジェットと、それを画面から使うためのフック (#1165)
 *
 * ログイン・新規登録・パスワード再設定の 3 画面で使う。使い方:
 *
 *   const captcha = useTurnstile();
 *   ...
 *   <TurnstileWidget {...captcha.widgetProps} action="login" />
 *   <button type="submit" disabled={!captcha.ready}>送信</button>
 *   ...
 *   // 送信の直前に 1 回だけ呼ぶ (トークンは 1 回しか使えない。呼んだ時点で、次のトークンの取り直しが始まる)
 *   const captchaToken = captcha.takeToken();
 *   await supabase.auth.signInWithPassword({ email, password, ...(captchaToken ? { options: { captchaToken } } : {}) });
 *
 * サイトキー (NEXT_PUBLIC_TURNSTILE_SITE_KEY) が未設定のときは Turnstile は無効:
 * ウィジェットは何も表示せず、ready は常に true、takeToken() は null を返す (= 今までどおりの動き)。
 * ウィジェットの種類 (Managed / Non-interactive / Invisible) は、Cloudflare の管理画面でサイトキーを作るときに決める。
 * このアプリは Managed を想定している。詳細は docs/operations/auth-protection.md。
 */

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type RefObject,
} from 'react';
import { getTurnstileApi, getTurnstileSiteKey, loadTurnstileApi } from '@/lib/auth/turnstile';

/** 親から呼べる操作 */
export interface TurnstileWidgetHandle {
  /** いまのトークンを捨てて、確認をやり直す */
  reset: () => void;
}

export interface TurnstileWidgetProps {
  /** Cloudflare の管理画面の集計で、どの画面の確認かを見分けるための名前 */
  action: 'login' | 'signup' | 'password-reset';
  /** トークンが取れたら文字列。期限切れ・失敗・やり直し・取り外しのときは null */
  onTokenChange: (token: string | null) => void;
}

type WidgetStatus = 'loading' | 'ready' | 'error';

export const TurnstileWidget = forwardRef<TurnstileWidgetHandle, TurnstileWidgetProps>(function TurnstileWidget(
  { action, onTokenChange },
  ref,
) {
  const siteKey = getTurnstileSiteKey();
  const containerRef = useRef<HTMLDivElement>(null);
  const widgetIdRef = useRef<string | null>(null);
  // コールバックは Cloudflare 側から非同期に呼ばれる。いつも最新の関数を呼べるよう ref 経由にして、
  // 親が関数を作り直してもウィジェットを作り直さずに済ませる
  const onTokenChangeRef = useRef(onTokenChange);
  onTokenChangeRef.current = onTokenChange;

  const [status, setStatus] = useState<WidgetStatus>('loading');
  const [errorCode, setErrorCode] = useState<string | null>(null);
  // 増やすと、ウィジェットを (必要なら api.js の読み込みから) 作り直す
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const container = containerRef.current;
    if (!siteKey || !container) return;

    let disposed = false;
    setStatus('loading');
    setErrorCode(null);

    const fail = (code: string) => {
      setStatus('error');
      setErrorCode(code);
      onTokenChangeRef.current(null);
    };

    loadTurnstileApi().then(
      (turnstile) => {
        if (disposed) return;
        let widgetId: string | undefined;
        try {
          widgetId = turnstile.render(container, {
            sitekey: siteKey,
            action,
            theme: 'light',
            language: 'ja',
            size: 'flexible',
            // トークンはコールバックで受け取る。フォームに hidden の入力欄は足さない
            'response-field': false,
            // 期限切れ・時間切れのあとは、Turnstile が自動で取り直す (Cloudflare の既定と同じ。ここで明示して、
            // 下の expired-callback / timeout-callback が「取り直すまで送信を止める」だけで済むことを保つ)
            'refresh-expired': 'auto',
            'refresh-timeout': 'auto',
            callback: (token) => {
              setStatus('ready');
              setErrorCode(null);
              onTokenChangeRef.current(token);
            },
            // 期限 (5 分) が切れたら、取り直すまで送信は止める (取り直しは上の refresh-expired: auto)
            'expired-callback': () => {
              setStatus('loading');
              onTokenChangeRef.current(null);
            },
            'timeout-callback': () => {
              setStatus('loading');
              onTokenChangeRef.current(null);
            },
            // 一時的な失敗は Turnstile が自動で再試行する (retry の既定は auto)。成功すれば callback で ready に戻る。
            // true を返すのは「こちらで処理する」という意味 (返さないとコンソールに警告が出る)
            'error-callback': (code) => {
              fail(String(code));
              return true;
            },
          });
        } catch (error) {
          console.error('[turnstile] render failed:', error);
          widgetId = undefined;
        }
        if (widgetId === undefined) {
          fail('render');
          return;
        }
        widgetIdRef.current = widgetId;
      },
      (error) => {
        if (disposed) return;
        console.error('[turnstile] script load failed:', error);
        fail('script');
      },
    );

    return () => {
      disposed = true;
      const widgetId = widgetIdRef.current;
      widgetIdRef.current = null;
      if (widgetId !== null) {
        try {
          getTurnstileApi()?.remove(widgetId);
        } catch {
          // 取り除けなくても、画面から消えれば困らない
        }
      }
      // 取り外したウィジェットのトークンは、もう使えない
      onTokenChangeRef.current(null);
    };
  }, [siteKey, action, attempt]);

  const reset = useCallback(() => {
    onTokenChangeRef.current(null);
    setStatus('loading');
    setErrorCode(null);
    const widgetId = widgetIdRef.current;
    const turnstile = getTurnstileApi();
    if (widgetId !== null && turnstile) {
      try {
        turnstile.reset(widgetId);
        return;
      } catch {
        // 下で作り直す
      }
    }
    // ウィジェットがまだ無い (api.js の読み込みや描画に失敗した) ときは、最初からやり直す
    setAttempt((n) => n + 1);
  }, []);

  useImperativeHandle(ref, () => ({ reset }), [reset]);

  if (!siteKey) return null;

  return (
    <div
      data-testid="turnstile"
      data-turnstile-status={status}
      role="group"
      aria-label="ボットではないことの確認"
      className="space-y-2"
    >
      {/* Cloudflare が iframe を入れる場所。React の子要素は置かない (Cloudflare が書き換えるため) */}
      <div ref={containerRef} data-testid="turnstile-widget" className="flex min-h-[65px] w-full justify-center" />
      {status === 'loading' && (
        <p role="status" className="text-xs text-gray-400">
          ボットではないことを確認しています。確認が終わるとボタンを押せます。
        </p>
      )}
      {status === 'error' && (
        <div role="alert" className="space-y-1 rounded-xl border border-red-200 bg-red-50 p-3 text-left">
          <p className="text-sm font-medium text-red-800">
            ボットではないことの確認を完了できませんでした。通信状況をご確認のうえ、もう一度お試しください。広告ブロッカーなどの拡張機能が原因のこともあります。
          </p>
          {errorCode && <p className="text-xs text-red-600">エラーコード: {errorCode}</p>}
          <button
            type="button"
            onClick={reset}
            className="text-sm font-bold text-[#FF8A65] hover:text-[#FF7043] hover:underline underline-offset-4"
          >
            もう一度確認する
          </button>
        </div>
      )}
    </div>
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
