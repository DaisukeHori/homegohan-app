/**
 * Cloudflare Turnstile (#1165): ログイン・新規登録・パスワード再設定の bot 対策 (モバイル)
 *
 * Turnstile はネイティブでは動かないので、小さな WebView に Cloudflare のウィジェットを載せて、
 * 取れたトークンを postMessage でアプリ側へ受け取る (Cloudflare の手引き:
 * https://developers.cloudflare.com/turnstile/get-started/mobile-implementation/)。
 * このファイルは React / React Native に依存しない部品だけを持つ。画面に出す部分は
 * src/components/auth/TurnstileWidget.tsx。Web 版は src/lib/auth/turnstile.ts (リポジトリのルート側)。
 *
 * 動作の約束 (Web と同じ):
 *   - EXPO_PUBLIC_TURNSTILE_SITE_KEY が未設定 (空文字・空白だけも含む) なら Turnstile は「無効」。
 *     何も表示せず、送信ボタンも止めず、Supabase にトークンも送らない (今までどおりの動き)。
 *   - 設定されているときは、トークンが取れるまで送信できない。トークンは 1 回しか使えないので、送信のたびに取り直す。
 *   - Supabase の Auth で CAPTCHA を有効にする時期は、このビルドを配って古いビルドが使われなくなってから
 *     (docs/operations/auth-protection.md)。有効にしたあとは、トークンを付けられない古いビルドはログインできなくなる。
 */

/** WebView の中に置く HTML が読む Cloudflare の api.js */
export const TURNSTILE_SCRIPT_URL = 'https://challenges.cloudflare.com/turnstile/v0/api.js';

/** Cloudflare の管理画面の集計で、どの画面の確認かを見分けるための名前 (英数字・_・- のみ、32 文字まで) */
export type TurnstileAction = 'login' | 'signup' | 'password-reset';

/**
 * サイトキー。未設定 (空文字・空白だけも含む) なら null = Turnstile は無効。
 * EXPO_PUBLIC_* はビルド時に埋め込まれる (変えたら新しいビルドが要る)。
 * 呼ぶたびに読む (テストで環境変数を差し替えられるように)。
 */
export function getTurnstileSiteKey(): string | null {
  const siteKey = process.env.EXPO_PUBLIC_TURNSTILE_SITE_KEY?.trim();
  return siteKey ? siteKey : null;
}

/** WebView の中の HTML からアプリへ届く、postMessage の内容 */
export type TurnstileMessage =
  | { type: 'token'; token: string }
  /** トークンの期限切れ、または操作が必要な確認の時間切れ。ウィジェットが自動で取り直す */
  | { type: 'expired' }
  | { type: 'error'; code: string };

/** Turnstile のトークンは最大 2048 文字。それより大きいものは受け付けない */
const MAX_TOKEN_LENGTH = 4096;

/**
 * WebView から届いた文字列を、アプリが扱う形に直す。形が違うもの (JSON でない、知らない type、空のトークン) は null。
 * Android では、WebView の中のどのフレーム (Cloudflare の iframe を含む) からも postMessage できるため、
 * 届いたものをそのまま信用せず、形を確かめてから使う。
 */
export function parseTurnstileMessage(data: unknown): TurnstileMessage | null {
  if (typeof data !== 'string') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const { type, token, code } = parsed as Record<string, unknown>;
  if (type === 'token') {
    return typeof token === 'string' && token.length > 0 && token.length <= MAX_TOKEN_LENGTH
      ? { type: 'token', token }
      : null;
  }
  if (type === 'expired') return { type: 'expired' };
  if (type === 'error') {
    return { type: 'error', code: typeof code === 'string' && code ? code.slice(0, 40) : 'unknown' };
  }
  return null;
}

/**
 * ウィジェットの中のリンク (Cloudflare の「プライバシー」「利用規約」など。target="_blank" や window.open で開くもの) を、
 * 外のブラウザで開いてよい URL か。https のものだけ (http・javascript:・intent:・file: などは開かない)。
 * 届いた値は WebView の中のページ由来なので、形を確かめてから使う。
 */
export function isExternalHttpsUrl(url: unknown): url is string {
  return typeof url === 'string' && /^https:\/\/[^\s/?#]+\S*$/i.test(url);
}

/**
 * WebView に読み込ませる HTML。Cloudflare のウィジェットを 1 つ描画して、結果を postMessage で知らせる。
 * 設定は JSON にして埋め込む ("<" は < にして、</script> などで HTML が壊れないようにする)。
 */
export function buildTurnstileHtml(siteKey: string, action: TurnstileAction): string {
  const config = JSON.stringify({ sitekey: siteKey, action }).replace(/</g, '\\u003c');
  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
<style>html,body{margin:0;padding:0;background:transparent}#widget{display:flex;justify-content:center}</style>
</head>
<body>
<div id="widget"></div>
<script>
  var CONFIG = ${config};
  function post(message) {
    if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage(JSON.stringify(message));
  }
  function onTurnstileLoad() {
    try {
      turnstile.render('#widget', {
        sitekey: CONFIG.sitekey,
        action: CONFIG.action,
        theme: 'light',
        language: 'ja',
        size: 'flexible',
        'response-field': false,
        'refresh-expired': 'auto',
        'refresh-timeout': 'auto',
        callback: function (token) { post({ type: 'token', token: token }); },
        'expired-callback': function () { post({ type: 'expired' }); },
        'timeout-callback': function () { post({ type: 'expired' }); },
        'error-callback': function (code) { post({ type: 'error', code: String(code) }); return true; }
      });
    } catch (e) {
      post({ type: 'error', code: 'render' });
    }
  }
  function onTurnstileScriptError() { post({ type: 'error', code: 'script' }); }
</script>
<script src="${TURNSTILE_SCRIPT_URL}?render=explicit&onload=onTurnstileLoad" async defer onerror="onTurnstileScriptError()"></script>
</body>
</html>`;
}

/** Supabase Auth が CAPTCHA の確認を断ったときの、利用者向けの文言 (Web の CAPTCHA_FAILED_MESSAGE と同じ) */
export const CAPTCHA_FAILED_MESSAGE = 'ボットではないことの確認に失敗しました。もう一度お試しください。';

/**
 * Supabase Auth のエラーが「CAPTCHA の確認に失敗した」ものか (Web の isCaptchaFailure と同じ判定)。
 * Supabase 側で CAPTCHA を有効にしたあとで、トークンが無い・期限切れ・使用済みのときに返る
 * (error.code が captcha_failed、message が "captcha verification process failed" など)。
 */
export function isCaptchaFailure(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { code, message } = error as { code?: unknown; message?: unknown };
  if (code === 'captcha_failed') return true;
  return typeof message === 'string' && /captcha/i.test(message);
}
