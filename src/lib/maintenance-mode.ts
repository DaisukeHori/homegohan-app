/**
 * メンテナンスモード (#1148)
 *
 * feature_flags の maintenance_mode が ON のあいだ、ミドルウェア (lib/supabase/middleware.ts) が、
 * 運営 (admin / super_admin) 以外のリクエストにメンテナンス中の応答を返す。
 *   - ページ: メンテナンス中の HTML (503。Retry-After 付き)
 *   - API:    { error: <固定の文>, code: 'MAINTENANCE_MODE', retryAfter } (503。Retry-After 付き)
 *             AI 相談の緊急停止 (src/lib/ai/ai-chat-gate.ts) と同じ平らな形。error は文字列なので、
 *             本文の data.error をそのまま出す Web の画面でも固定の文になる (オブジェクトにすると描画で落ちる。#1486)
 *
 * 通すもの (メンテナンス中でも止めない):
 *   - 運営ロール (admin / super_admin) のログイン済みユーザー。メンテナンスの作業をするため
 *   - /login と /auth/*。運営がログインし直せるように。ネイティブ認証ブリッジ (/auth/native-bridge) も通る
 *   - /terms と /privacy。利用規約とプライバシーポリシーは、いつでも読めるようにする (ストア審査に出す URL でもある)
 *   - /legal (特定商取引法に基づく表記) と /contact (お問い合わせ) の画面 (#1486)。どちらも未ログインで読める公開の文面で、
 *     メンテナンス中でも事業者の表記と連絡先を確かめられるようにする。お問い合わせの送信の API (POST /api/contact) は止めたまま
 *     (メンテナンス中は利用者からの書き込みを受け付けない。送ると 503 の固定の文が出て、画面のメールアドレスは残る)。
 *     /signup (新規登録) は止める
 *   - 死活監視 /api/health、cron (/api/cron/*)、認証 API (/api/auth/*)、画面が前もって状態を知るための窓口 /api/feature-flags
 *     (いま呼んでいる画面は無い。画面は、この 503 の応答の code で止められたことを知る。#1457)
 *   - Resend の Webhook の受け口 (POST /api/webhooks/resend。#1577 の 4)。cron と同じ「機械から機械」で、利用者からの書き込みではない。
 *     止めると Resend (Svix) は送り直すが、メンテナンスが長い (約 1 日を超える) と知らせを失うか、Svix が宛先を無効にする恐れがあるため。
 *     完全一致の 1 本だけ (RESEND_WEBHOOK_API_PATH)。ほかの Webhook (/api/webhooks/stripe など) と /api/webhooks の下のほかのパスは止める
 *   - 通知のトークンの claim (POST /api/push-tokens/claim。#1636)。利用者の操作ではなく端末の後片付け (同じ端末の前の利用者の
 *     行を外す) で、止めると前の利用者宛ての通知がこの端末に届き続けるため。claim の 1 本だけ (src/lib/push-tokens.ts の
 *     isPushTokenClaimApiPath。release など、ほかの /api/push-tokens/* は止める)
 *   - /_next/* (Next の静的ファイル)。ミドルウェアの matcher が外しているが、念のためここでも通す
 *
 * 静的ファイル (画像・manifest・robots・サービスワーカーなど) は、ミドルウェアの matcher (src/proxy.ts) が外していて、
 * そもそもミドルウェアに届かない。ここで拡張子 (.json / .txt / .js / .css など) を見て通すことはしない:
 * 動的なページのパス (/meals/abc.json のような、末尾が静的ファイルに見えるもの) まで、メンテナンス中の画面を通り抜けてしまうため。
 * 静的ファイルを足すときは、matcher に足す (tests/health-middleware-exemption.test.ts と src/__tests__/lib/maintenance-mode.test.ts が見る)。
 *
 * 【止めない側に倒す (fail-open)】
 * maintenance_mode の読み出しに失敗した・行が無い・待ちきれなかったときは OFF として扱う (src/lib/feature-flags.ts)。
 * ミドルウェアは全リクエストで通るため、DB が遅いときにリクエストを待たせないよう、読み出しを待つ上限を短くする
 * (MAINTENANCE_FLAG_TIMEOUT_MS)。値はメモリに 30 秒覚えるので、通常は DB を読まない。
 *
 * 応答は決まった文字列だけで作る (DB・セッション・React の描画に頼らない)。メンテナンス中に DB が不安定でも、
 * この応答だけは確実に返せるようにするため。
 */
import { NextResponse } from 'next/server';
import { isFeatureEnabled } from '@/lib/feature-flags';
import { isPolicyPath } from '@/lib/onboarding-routing';
import { isPushTokenClaimApiPath } from '@/lib/push-tokens';
import { MAINTENANCE_API_CODE, MAINTENANCE_MESSAGE, SERVICE_UNAVAILABLE_STATUS } from '@homegohan/shared';

export const MAINTENANCE_FLAG_KEY = 'maintenance_mode';
// code と文の置き場は packages/shared/src/service-unavailable.ts の 1 つ (モバイルも同じ値で、503 の本文の代わりに固定の文を出す。#1457)
export { MAINTENANCE_API_CODE, MAINTENANCE_MESSAGE };
/** クライアントに「このくらいあとで試して」と伝える目安 (秒)。メンテナンスがいつ終わるかは分からないので長めにする */
export const MAINTENANCE_RETRY_AFTER_SECONDS = 300;
/** ミドルウェアがフラグの読み出しを待つ上限 (ms)。超えたらメンテナンスなしとして通す */
export const MAINTENANCE_FLAG_TIMEOUT_MS = 800;

/** メンテナンス中でも通す運営ロール */
const OPERATOR_ROLES = ['admin', 'super_admin'] as const;

/** admin / super_admin を持っているか。メンテナンス中に通すかどうかの判定に使う */
export function isOperatorRoles(roles: readonly string[] | null | undefined): boolean {
  return Array.isArray(roles) && OPERATOR_ROLES.some((role) => roles.includes(role));
}

/** pathname が prefix そのもの、または prefix の下か (`/loginx` のような似た名前は含めない) */
function isSameOrUnder(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/**
 * メンテナンス中でも見られる公開の案内の画面 (#1486)。特定商取引法に基づく表記と、お問い合わせ。
 * 画面だけを通す (どちらも API を呼ばずに表示できる。お問い合わせの送信の API は止める)。
 * `/legal-consent` (規約への同意の画面) は似た名前だが別の画面で、通さない (isSameOrUnder が `/legal` の下だけを見る)
 */
export const MAINTENANCE_PUBLIC_INFO_PATHS = ['/legal', '/contact'] as const;

/**
 * メンテナンス中でも止めない Webhook の受け口 (#1577 の 4)。Resend の bounce・苦情の知らせ (src/app/api/webhooks/resend/route.ts)。
 * 署名 (RESEND_WEBHOOK_SECRET) で認証する機械からの呼び出しで、利用者のセッションを持たない。完全一致だけを通す
 * (末尾の `/`・下のパス・似た名前は止める)。Stripe の Webhook (/api/webhooks/stripe) は billing/01 の取り決めどおり止める
 */
export const RESEND_WEBHOOK_API_PATH = '/api/webhooks/resend';

/**
 * メンテナンス中でも止めないパスか。
 * pathname は URL の path 部分 (クエリを含まない)。
 */
export function isMaintenanceExemptPath(pathname: string): boolean {
  // ログイン・認証の途中の画面 (運営がログインし直す。ネイティブ認証ブリッジのコード引き換え)
  if (isSameOrUnder(pathname, '/login') || isSameOrUnder(pathname, '/auth')) return true;
  // 利用規約・プライバシーポリシー
  if (isPolicyPath(pathname)) return true;
  // 特定商取引法に基づく表記・お問い合わせの画面 (#1486)
  if (MAINTENANCE_PUBLIC_INFO_PATHS.some((prefix) => isSameOrUnder(pathname, prefix))) return true;
  // Next の静的ファイル (ミドルウェアの matcher が外しているが、念のため)
  if (isSameOrUnder(pathname, '/_next')) return true;

  if (pathname === '/api' || pathname.startsWith('/api/')) {
    return (
      pathname === '/api/health' ||
      isSameOrUnder(pathname, '/api/auth') ||
      isSameOrUnder(pathname, '/api/cron') ||
      pathname === '/api/feature-flags' ||
      pathname === RESEND_WEBHOOK_API_PATH ||
      isPushTokenClaimApiPath(pathname)
    );
  }

  // それ以外は止める。拡張子で静的ファイルかどうかは見ない (上の説明を参照)
  return false;
}

/**
 * maintenance_mode が、このユーザーにとって ON か。ミドルウェアが、運営ロールではないリクエストにだけ呼ぶ。
 * 読み出しに失敗した・行が無い・待ちきれなかったときは false (止めない)。例外は投げない。
 *
 * @param userId ログイン済みなら認証で確定したユーザー ID。未ログインは省略
 * @param roles  すでに分かっているロール (ミドルウェアが user_profiles から読んだもの)
 */
export async function isMaintenanceFlagOn(userId?: string, roles?: readonly string[] | null): Promise<boolean> {
  try {
    return await isFeatureEnabled(MAINTENANCE_FLAG_KEY, userId, {
      timeoutMs: MAINTENANCE_FLAG_TIMEOUT_MS,
      context: Array.isArray(roles) ? { roles: [...roles] } : undefined,
    });
  } catch {
    // isFeatureEnabled は例外を投げない取り決めだが、全リクエストが通るミドルウェアを巻き込まないよう、念のため止めない側に倒す
    return false;
  }
}

const NO_STORE = 'private, no-store';

const MAINTENANCE_PAGE_HTML = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>メンテナンス中 | ほめゴハン</title>
<style>
:root{color-scheme:light dark;--bg:#fffaf5;--fg:#3b2f2a;--muted:#7a6a62;--accent:#c2410c}
@media (prefers-color-scheme:dark){:root{--bg:#1d1714;--fg:#f5ece6;--muted:#b8a79d;--accent:#ff922b}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;background:var(--bg);color:var(--fg);font-family:-apple-system,BlinkMacSystemFont,"Hiragino Sans","Noto Sans JP",Meiryo,sans-serif;line-height:1.8;text-align:center}
main{max-width:28rem}
h1{margin:0 0 16px;font-size:1.5rem;line-height:1.4}
p{margin:0 0 12px;color:var(--muted)}
a{color:var(--accent)}
.retry{display:inline-block;margin:12px 0 28px;padding:10px 24px;border:1px solid var(--accent);border-radius:999px;font-weight:700;text-decoration:none}
.staff{font-size:.8rem}
</style>
</head>
<body>
<main role="status">
<h1>ただいまメンテナンス中です</h1>
<p>ほめゴハンは、サービスの改善のため、一時的にご利用いただけません。ご不便をおかけして申し訳ありません。</p>
<p>しばらくしてから、もう一度お試しください。</p>
<a class="retry" href="">再読み込み</a>
<p class="staff"><a href="/login">運営の方はこちら (ログイン)</a></p>
</main>
</body>
</html>
`;

/**
 * メンテナンス中の API の応答 (503 + Retry-After)。
 * 本文は { error: 固定の文, code: 'MAINTENANCE_MODE', retryAfter } (AI 相談の緊急停止の 503 と同じ平らな形。#1486)。
 * error を文字列にするのは、Web の画面の多くが本文の data.error をそのまま出すため (オブジェクトにすると、
 * React の描画で落ちる・`[object Object]` が出る)。モバイルは code から固定の文を決める (packages/shared の
 * serviceUnavailableMessageOfBody)。
 */
export function maintenanceApiResponse(): NextResponse {
  return NextResponse.json(
    { error: MAINTENANCE_MESSAGE, code: MAINTENANCE_API_CODE, retryAfter: MAINTENANCE_RETRY_AFTER_SECONDS },
    {
      status: SERVICE_UNAVAILABLE_STATUS,
      headers: {
        'Retry-After': String(MAINTENANCE_RETRY_AFTER_SECONDS),
        'Cache-Control': NO_STORE,
      },
    },
  );
}

/**
 * メンテナンス中の画面 (503 + Retry-After の HTML)。
 * 画面は決まった HTML の文字列で、アプリの描画 (React・フォント・CSS ファイル) に頼らない。
 * 色はライト・ダークの両方に対応し、スマホの幅でも崩れない。外部への通信もスクリプトも無い。
 */
export function maintenancePageResponse(): NextResponse {
  return new NextResponse(MAINTENANCE_PAGE_HTML, {
    status: SERVICE_UNAVAILABLE_STATUS,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Retry-After': String(MAINTENANCE_RETRY_AFTER_SECONDS),
      'Cache-Control': NO_STORE,
    },
  });
}
