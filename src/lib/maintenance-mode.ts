/**
 * メンテナンスモード (#1148)
 *
 * feature_flags の maintenance_mode が ON のあいだ、ミドルウェア (lib/supabase/middleware.ts) が、
 * 運営 (admin / super_admin) 以外のリクエストにメンテナンス中の応答を返す。
 *   - ページ: メンテナンス中の HTML (503。Retry-After 付き)
 *   - API:    { error: { code: 'MAINTENANCE_MODE', message } } (503。Retry-After 付き)
 *
 * 通すもの (メンテナンス中でも止めない):
 *   - 運営ロール (admin / super_admin) のログイン済みユーザー。メンテナンスの作業をするため
 *   - /login と /auth/*。運営がログインし直せるように。ネイティブ認証ブリッジ (/auth/native-bridge) も通る
 *   - /terms と /privacy。利用規約とプライバシーポリシーは、いつでも読めるようにする (ストア審査に出す URL でもある)
 *   - 死活監視 /api/health、cron (/api/cron/*)、認証 API (/api/auth/*)、クライアントが状態を知るための /api/feature-flags
 *   - 静的ファイル (/_next/*、画像・フォント・CSS・JS など)。ミドルウェアの matcher がほとんどを外しているが、念のためここでも通す
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

export const MAINTENANCE_FLAG_KEY = 'maintenance_mode';
export const MAINTENANCE_API_CODE = 'MAINTENANCE_MODE';
export const MAINTENANCE_MESSAGE = 'ただいまメンテナンス中です。しばらくしてから、もう一度お試しください。';
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

/** ページ (API 以外) の静的ファイル。ミドルウェアの matcher (src/middleware.ts) が外している拡張子より少し広く取る */
const STATIC_FILE_PATTERN = /\.(?:svg|png|jpe?g|gif|webp|ico|css|js|map|txt|xml|json|webmanifest|woff2?|ttf|otf)$/i;

/**
 * メンテナンス中でも止めないパスか。
 * pathname は URL の path 部分 (クエリを含まない)。
 */
export function isMaintenanceExemptPath(pathname: string): boolean {
  // ログイン・認証の途中の画面 (運営がログインし直す。ネイティブ認証ブリッジのコード引き換え)
  if (isSameOrUnder(pathname, '/login') || isSameOrUnder(pathname, '/auth')) return true;
  // 利用規約・プライバシーポリシー
  if (isPolicyPath(pathname)) return true;
  // 静的ファイル
  if (isSameOrUnder(pathname, '/_next')) return true;

  if (pathname === '/api' || pathname.startsWith('/api/')) {
    return (
      pathname === '/api/health' ||
      isSameOrUnder(pathname, '/api/auth') ||
      isSameOrUnder(pathname, '/api/cron') ||
      pathname === '/api/feature-flags'
    );
  }

  // 静的ファイルの拡張子は、API 以外のパスだけで通す (動的な API ルートの末尾に拡張子を付けて抜けられないように)
  return STATIC_FILE_PATTERN.test(pathname);
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

/** メンテナンス中の API の応答 (503 + Retry-After) */
export function maintenanceApiResponse(): NextResponse {
  return NextResponse.json(
    { error: { code: MAINTENANCE_API_CODE, message: MAINTENANCE_MESSAGE } },
    {
      status: 503,
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
    status: 503,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Retry-After': String(MAINTENANCE_RETRY_AFTER_SECONDS),
      'Cache-Control': NO_STORE,
    },
  });
}
