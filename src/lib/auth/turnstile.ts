/**
 * Cloudflare Turnstile (#1165): ログイン・新規登録・パスワード再設定の bot 対策 (Web)
 *
 * このファイルは React に依存しない部品だけを持つ。画面に出すウィジェットは
 * src/components/auth/TurnstileWidget.tsx。
 *
 * 動作の約束:
 *   - NEXT_PUBLIC_TURNSTILE_SITE_KEY が未設定 (空文字・空白だけも含む) なら Turnstile は「無効」。
 *     何も表示せず、送信ボタンも止めず、Supabase にトークンも送らない (今までどおりの動き)。
 *   - 設定されているときは、トークンが取れるまで送信できない。トークンは 1 回しか使えないので、
 *     送信のたびに取り直す。
 *   - Supabase の Auth で CAPTCHA を有効にする時期は、モバイルの配布状況に合わせてオーナーが決める
 *     (docs/operations/auth-protection.md)。Web のサイトキーを設定しただけでは、
 *     Supabase の Auth API を直接呼ぶ攻撃は止まらない。
 */

/**
 * Cloudflare の api.js。`render=explicit` は「自動では描画せず、こちらから turnstile.render() を呼ぶ」指定。
 * このホストは next.config.mjs の CSP (script-src / frame-src) にも書いてある。変えるときは両方を直す。
 */
export const TURNSTILE_SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

/** turnstile.render() に渡す設定 (このアプリで使うものだけ) */
export interface TurnstileRenderOptions {
  sitekey: string;
  /** Cloudflare の管理画面の集計で、操作ごとに見分けるための名前 (英数字・_・- のみ、32 文字まで) */
  action?: string;
  theme?: 'light' | 'dark' | 'auto';
  language?: string;
  size?: 'normal' | 'flexible' | 'compact';
  /** false にすると、フォームに hidden の入力欄 (cf-turnstile-response) を足さない */
  'response-field'?: boolean;
  /** トークンの期限 (5 分) が切れたとき、自動で取り直すか (Cloudflare の既定は auto) */
  'refresh-expired'?: 'auto' | 'manual' | 'never';
  /** 利用者の操作が必要な確認が時間切れになったとき、自動でやり直すか (Cloudflare の既定は auto。Managed のみ) */
  'refresh-timeout'?: 'auto' | 'manual' | 'never';
  /** 確認に成功したとき。トークンを受け取る */
  callback?: (token: string) => void;
  /** トークンの有効期限 (5 分) が切れたとき */
  'expired-callback'?: () => void;
  /** 利用者の操作が必要な確認が、時間内に終わらなかったとき */
  'timeout-callback'?: () => void;
  /** 失敗したとき。true を返すと「こちらで処理した」扱いになり、Turnstile はコンソールに警告を出さない */
  'error-callback'?: (errorCode: string) => boolean | void;
}

/** window.turnstile (api.js が作る) のうち、このアプリで使うもの */
export interface TurnstileApi {
  /** ウィジェットを描画する。ウィジェットの id を返す (描画できなければ undefined) */
  render(container: HTMLElement | string, options: TurnstileRenderOptions): string | undefined;
  /** 確認をやり直して、新しいトークンを取る */
  reset(widgetId?: string): void;
  /** ウィジェットを取り除く (コールバックは呼ばれない) */
  remove(widgetId?: string): void;
}

type TurnstileWindow = Window & { turnstile?: TurnstileApi };

/**
 * サイトキー。未設定 (空文字・空白だけも含む) なら null = Turnstile は無効。
 * NEXT_PUBLIC_* はビルド時に埋め込まれる (Vercel で設定したら再デプロイが要る)。
 * 呼ぶたびに読む (テストで環境変数を差し替えられるように)。
 */
export function getTurnstileSiteKey(): string | null {
  const siteKey = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY?.trim();
  return siteKey ? siteKey : null;
}

/** 読み込み済みの window.turnstile。まだ無い (または、ブラウザ以外) なら undefined */
export function getTurnstileApi(): TurnstileApi | undefined {
  if (typeof window === 'undefined') return undefined;
  return (window as TurnstileWindow).turnstile;
}

let loadingPromise: Promise<TurnstileApi> | null = null;

/**
 * Cloudflare の api.js を読み込む。何度呼んでも、script タグは 1 つだけ。
 * 読み込めなかった (通信の失敗、広告ブロッカーなどによる遮断) ときは reject し、次の呼び出しでやり直せる。
 * 成功したあとも script タグは残す (api.js は自分の script タグを探して設定を読むため)。
 */
export function loadTurnstileApi(): Promise<TurnstileApi> {
  const loaded = getTurnstileApi();
  if (loaded) return Promise.resolve(loaded);
  if (typeof document === 'undefined') {
    return Promise.reject(new Error('Turnstile はブラウザでしか読み込めません'));
  }
  if (loadingPromise) return loadingPromise;

  loadingPromise = new Promise<TurnstileApi>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = TURNSTILE_SCRIPT_SRC;
    script.async = true;

    const fail = (message: string) => {
      loadingPromise = null;
      script.remove();
      reject(new Error(message));
    };
    script.onload = () => {
      const api = getTurnstileApi();
      if (api) resolve(api);
      else fail('Turnstile の api.js を読み込みましたが、window.turnstile がありません');
    };
    script.onerror = () => fail('Turnstile の api.js を読み込めませんでした');

    document.head.appendChild(script);
  });
  return loadingPromise;
}

/** Supabase Auth が CAPTCHA の確認を断ったときの、利用者向けの文言 */
export const CAPTCHA_FAILED_MESSAGE = 'ボットではないことの確認に失敗しました。もう一度お試しください。';

/**
 * Supabase Auth のエラーが「CAPTCHA の確認に失敗した」ものか。
 * Supabase 側で CAPTCHA を有効にしたあとで、トークンが無い・期限切れ・使用済みのときに返る
 * (error.code が captcha_failed、message が "captcha verification process failed" など)。
 */
export function isCaptchaFailure(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { code, message } = error as { code?: unknown; message?: unknown };
  if (code === 'captcha_failed') return true;
  return typeof message === 'string' && /captcha/i.test(message);
}
