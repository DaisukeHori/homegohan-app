import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, 'package.json'), 'utf8'));
const isDev = process.env.NODE_ENV === 'development';
// #1044 (F6-09): PostHog の api_host は src/lib/posthog.ts のデフォルトと合わせる
const posthogHost = process.env.NEXT_PUBLIC_POSTHOG_HOST ?? 'https://us.i.posthog.com';

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
              "img-src 'self' data: blob: *.supabase.co images.unsplash.com",
              // #1044 (F6-09): PostHog の capture/identify 送信先を許可 (未設定だと全ブロックされていた)
              `connect-src 'self' *.supabase.co *.vercel.app wss://*.supabase.co ${posthogHost}`,
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
