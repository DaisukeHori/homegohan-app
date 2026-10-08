import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, 'package.json'), 'utf8'));
const isDev = process.env.NODE_ENV === 'development';
// #1044 (F6-09): CSP の connect-src に許可する PostHog のホストは、アプリが実際に送信するホストと合わせる。
// #1197: 送信側の既定は packages/shared の POSTHOG_DEFAULT_HOST (src/lib/posthog.ts とモバイルが import する)。
// この .mjs は TypeScript を import できないので、同じ値のリテラルを残している。
// src/__tests__/config/posthog-default-host.test.ts が一致を検査するので、ホストを変えるときは両方を直す。
const posthogHost = process.env.NEXT_PUBLIC_POSTHOG_HOST ?? 'https://us.i.posthog.com';
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

/** @type {import('next').NextConfig} */
const nextConfig = {
  env: {
    NEXT_PUBLIC_APP_VERSION: process.env.NEXT_PUBLIC_APP_VERSION ?? `v${pkg.version}`,
    NEXT_PUBLIC_BUILD_DATE: process.env.NEXT_PUBLIC_BUILD_DATE ?? new Date().toISOString().slice(0, 10).replace(/-/g, ''),
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
              `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ''} *.vercel-scripts.com`,
              "style-src 'self' 'unsafe-inline'",
              `img-src 'self' data: blob: *.supabase.co images.unsplash.com${supabaseImgSrc}`,
              // #1044 (F6-09): PostHog の capture/identify 送信先を許可 (未設定だと全ブロックされていた)
              // #1044 round-2: session replay 等で使う PostHog アセットホストも予防的に許可
              `connect-src 'self' *.supabase.co *.vercel.app wss://*.supabase.co ${posthogHost} https://us-assets.i.posthog.com${supabaseConnectSrc}`,
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
