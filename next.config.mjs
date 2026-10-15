import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { formatBuildDateJst } from './shared/build-date.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, 'package.json'), 'utf8'));
const isDev = process.env.NODE_ENV === 'development';
// ローカルの Supabase (scripts/supabase-local.sh の http://127.0.0.1:54321 など) にブラウザから接続できるよう、
// NEXT_PUBLIC_SUPABASE_URL が *.supabase.co 以外のときだけ、その origin (と Realtime 用の ws / wss) を CSP に加える。
// 本番 (*.supabase.co) の CSP は変わらない。
const supabaseLocalOrigins = (() => {
  try {
    const url = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? '');
    if (url.hostname.endsWith('.supabase.co')) return null;
    return { http: url.origin, ws: `${url.protocol === 'https:' ? 'wss:' : 'ws:'}//${url.host}` };
  } catch {
    return null;
  }
})();
const supabaseImgSrc = supabaseLocalOrigins ? ` ${supabaseLocalOrigins.http}` : '';
const supabaseConnectSrc = supabaseLocalOrigins ? ` ${supabaseLocalOrigins.http} ${supabaseLocalOrigins.ws}` : '';

/**
 * 空・空白だけの値は未設定として扱う (#1434)。src/lib/env.ts (normalizeEnvSource・getOptionalEnv) と
 * npm run check:env と同じ扱い。.env.example は `NEXT_PUBLIC_APP_VERSION=` のように空で書いてあり、
 * `??` だけだと空のまま設定画面に出ていた。値があるときは加工せずにそのまま返す。
 */
function envValueOrUndefined(value) {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/**
 * ブラウザの中のルーターのキャッシュ (Client Router Cache) が、一度表示したページを使い回す時間 (秒) (#1444)。
 * Next 14 の既定は「動的なページ 30 秒・静的なページ 300 秒」。Next 15 で動的なページの既定が 0 秒 (使い回さない) に
 * 変わった。Next 15 への更新で、戻る・進む・リンクでの移動の速さとサーバーへの問い合わせの回数が変わらないよう、
 * Next 14 と同じ値を明示する。静的なページの値は Next 14 / 15 とも 300 秒で同じだが、組で読めるように並べて書く。
 * 値を変えるなら、画面の移動のたびに最新を読み直したいページが無いかを確かめてから変える。
 */
const CLIENT_ROUTER_CACHE_DYNAMIC_STALE_SEC = 30;
const CLIENT_ROUTER_CACHE_STATIC_STALE_SEC = 300;

/**
 * 画像の最適化 (/_next/image) が、最適化した画像を使い回す最短の時間 (秒) (#1621)。
 * Next 15 の既定は 60 秒。Next 16 で既定が 4 時間 (14400 秒) に変わった。
 * 食事写真・冷蔵庫写真は、期限つきの署名付き URL (src/lib/photo-storage-signing.ts。既定 1 時間) を next/image に渡して出す
 * (src/components/photo/SignedPhotoImage.tsx)。使い回す時間が署名の期限より長いと、期限が切れた URL を含む
 * /_next/image の URL でも、最適化済みの写真が返り続ける。Next 16 への更新でこれを長くしないよう、Next 15 の既定の値を明示する。
 * (元の画像の応答の Cache-Control の max-age がこれより長ければ、そちらが使われるのは Next 15 / 16 とも同じ)
 * src/__tests__/config/next-config-images.test.ts が固定する。
 */
const IMAGE_OPTIMIZER_MINIMUM_CACHE_TTL_SEC = 60;

/** @type {import('next').NextConfig} */
const nextConfig = {
  // #1621 Next 16: next build は ESLint を動かさなくなり、設定の `eslint` の項目も無くなった (書くと設定の検査で警告が出る)。
  // lint は `npm run lint` (eslint .) で別に回している (CI の ci.yml と local-ci の unit 段)。
  // src/__tests__/config/next-config-build-lint.test.ts が、`eslint` の項目を戻していないことを確かめる。
  experimental: {
    staleTimes: {
      dynamic: CLIENT_ROUTER_CACHE_DYNAMIC_STALE_SEC,
      static: CLIENT_ROUTER_CACHE_STATIC_STALE_SEC,
    },
  },
  env: {
    NEXT_PUBLIC_APP_VERSION: envValueOrUndefined(process.env.NEXT_PUBLIC_APP_VERSION) ?? `v${pkg.version}`,
    // 既定値は JST の暦日 (#1467。toISOString の UTC だと JST の 0:00〜8:59 のビルドが前日になる)
    NEXT_PUBLIC_BUILD_DATE: envValueOrUndefined(process.env.NEXT_PUBLIC_BUILD_DATE) ?? formatBuildDateJst(),
  },
  async headers() {
    return [
      {
        // #1044 (F6-08): '/handson-tour/(.*)' は認証必須ページ (例: /handson-tour/photo) にも
        // マッチしてしまい、CDN が認証済み HTML を1年キャッシュする恐れがあった。
        // public/handson-tour 配下の静的アセットのみに限定する。
        source: '/handson-tour/sample-meal.webp',
        headers: [
          {
            key: 'Cache-Control',
            value: 'public, max-age=31536000, immutable',
          },
        ],
      },
      {
        source: '/(.*)',
        headers: [
          {
            key: 'X-Frame-Options',
            value: 'DENY',
          },
          {
            key: 'X-Content-Type-Options',
            value: 'nosniff',
          },
          {
            key: 'X-XSS-Protection',
            value: '1; mode=block',
          },
          {
            key: 'Strict-Transport-Security',
            value: 'max-age=63072000; includeSubDomains; preload',
          },
          {
            key: 'Content-Security-Policy',
            // #275: 'unsafe-eval' を削除。'unsafe-inline' は nonce ベース移行が大規模なため別 issue で対応予定
            // dev モードでは Next.js webpack HMR が unsafe-eval を必要とするため条件付きで追加
            value: [
              "default-src 'self'",
              // #1165: Cloudflare Turnstile (ログイン・新規登録・パスワード再設定の bot 対策)。許可するのは
              // api.js を読む script-src と、ウィジェットを iframe で出す frame-src だけ。
              // frame-src を書くと default-src 'self' へのフォールバックが無くなるので、今までの動き (自分のページの iframe) を保つため 'self' も書く
              `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ''} *.vercel-scripts.com https://challenges.cloudflare.com`,
              "frame-src 'self' https://challenges.cloudflare.com",
              "style-src 'self' 'unsafe-inline'",
              `img-src 'self' data: blob: *.supabase.co images.unsplash.com${supabaseImgSrc}`,
              // #1166: 利用状況の計測 (PostHog) はやめたので、PostHog の送信先は許可しない
              // (環境変数 NEXT_PUBLIC_POSTHOG_HOST が残っていても CSP には出ない。src/__tests__/config/next-config-headers.test.ts が検査する)
              `connect-src 'self' *.supabase.co *.vercel.app wss://*.supabase.co${supabaseConnectSrc}`,
              "frame-ancestors 'none'",
              "font-src 'self'",
              "object-src 'none'",
            ].join('; '),
          },
        ],
      },
    ];
  },
  images: {
    minimumCacheTTL: IMAGE_OPTIMIZER_MINIMUM_CACHE_TTL_SEC,
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'images.unsplash.com',
        port: '',
        pathname: '/**',
      },
      {
        protocol: 'https',
        hostname: '*.supabase.co',
        port: '',
        pathname: '/**',
      },
      {
        protocol: 'https',
        hostname: 'flmeolcfutuwwbjmzyoz.supabase.co',
        port: '',
        pathname: '/**',
      },
    ],
  },
};

export default nextConfig;
