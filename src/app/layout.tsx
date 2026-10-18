import type { Metadata, Viewport } from "next";
import { Noto_Sans_JP, Noto_Serif_JP } from "next/font/google";
import { SpeedInsightsClient } from "@/components/SpeedInsightsClient";
import { HashHistoryEntryBridge } from "@/components/navigation/HashHistoryEntryBridge";
import { getSiteUrl, SITE_NAME } from "@/lib/site-config";
import { OG_LOCALE, SITE_DEFAULT_TITLE, SITE_DESCRIPTION, SITE_TWITTER_DESCRIPTION } from "@/lib/seo/public-pages";
import "./globals.css";

// #1169: CSP の nonce は毎リクエスト違うので、全ページを動的に描画する (静的化した HTML には nonce が入らず、Next の
// インラインスクリプトが止まる)。ルートの layout に書くと配下の全ルートが動的になる (docs/design/cross/18-csp-nonce.md §5)
export const dynamic = 'force-dynamic';

// サイトの URL (metadataBase。各ページの canonical・OGP の基点)。NEXT_PUBLIC_APP_URL、未設定なら既定値 (src/lib/site-config.ts, #1194)
const siteUrl = getSiteUrl();

const notoSans = Noto_Sans_JP({ 
  subsets: ["latin"],
  weight: ["400", "500", "700"],
  variable: "--font-sans",
});

const notoSerif = Noto_Serif_JP({
  subsets: ["latin"],
  weight: ["400", "700"],
  variable: "--font-serif",
});

export const metadata: Metadata = {
  title: {
    default: SITE_DEFAULT_TITLE,
    template: `%s | ${SITE_NAME}`,
  },
  description: SITE_DESCRIPTION,
  keywords: [
    "食事管理",
    "献立",
    "AI",
    "栄養管理",
    "カロリー計算",
    "健康管理",
    "ダイエット",
    "食事記録",
    "レシピ",
    "自炊",
  ],
  authors: [{ name: "ほめゴハン" }],
  creator: "ほめゴハン",
  publisher: "ほめゴハン",
  formatDetection: {
    email: false,
    address: false,
    telephone: false,
  },
  metadataBase: new URL(siteUrl),
  // canonical (alternates) と og:url は、ここに書かない (#1867)。ルートの layout に書くと全ページに引き継がれ、
  // 以前は全ページの canonical が「/」 (トップの重複) になっていた。公開ページは src/lib/seo/public-pages.ts の
  // publicPageMetadata で自分のパスの canonical・og:url を持つ。ログインが要る画面は canonical を持たない。
  openGraph: {
    title: SITE_DEFAULT_TITLE,
    description: SITE_DESCRIPTION,
    siteName: SITE_NAME,
    locale: OG_LOCALE,
    type: "website",
    // 画像 (og:image) は書かない。src/app/opengraph-image.tsx (Next の file convention) が PNG を作り、Next が
    // og:image / og:image:width / height / type / alt を metadataBase を前に付けた絶対 URL で入れる (#1845。
    // 以前は public/ に無い /og-image.png を指していて、本番で 404 だった)。
  },
  twitter: {
    card: "summary_large_image",
    title: SITE_DEFAULT_TITLE,
    description: SITE_TWITTER_DESCRIPTION,
    // 画像 (twitter:image) は src/app/twitter-image.tsx (Next の file convention) が入れる (#1845)
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-video-preview": -1,
      "max-image-preview": "large",
      "max-snippet": -1,
    },
  },
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "any" },
      { url: "/icon.svg", type: "image/svg+xml" },
    ],
    // /apple-touch-icon.png は src/app/apple-touch-icon.png/route.ts が PNG を返す (#1845。以前は public/ に無く 404)
    apple: [
      { url: "/apple-touch-icon.png", sizes: "180x180" },
    ],
    shortcut: "/favicon.ico",
  },
  manifest: "/manifest.json",
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "ほめゴハン",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#E07A5F" },
    { media: "(prefers-color-scheme: dark)", color: "#E07A5F" },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ja" className={`${notoSans.variable} ${notoSerif.variable}`}>
      <body className="font-sans antialiased">
        {/* グローバル a11y 基盤 (#1058): キーボード操作でナビゲーションを飛ばして本文へ移動 */}
        <a href="#main-content" className="skip-link">
          メインコンテンツへスキップ
        </a>
        <div id="main-content">{children}</div>
        {/*
          Vercel Speed Insights (#1179): 表示速度 (Web Vitals) の計測だけを行う。画面には何も描画しない。
          エラーの記録は app_logs が担い、Sentry / Better Stack は採用しない (docs/design/00-architecture.md)。
          本番の Speed Insights は、すでに有効とみられる (/_vercel/speed-insights/script.js が 200 を返す)。
          そのため、デプロイした時点から、全ページで計測が始まる。ダッシュボードで有効にするのを待つ関門は無い。
          計測値には URL が載る。URL には招待先のメールアドレスと招待トークンが入るページがあるので、
          <SpeedInsights /> を直に置かず、送る前に URL を直す SpeedInsightsClient を使う (docs/design/operator/07-audit-monitoring.md §7.3)。
          スクリプトも計測値の送信先も同じオリジンのパス (既定は /_vercel/speed-insights/*、Vercel がビルドに設定を渡すときはその固有のパス)。
          そのため CSP (src/lib/security/csp.ts) は script-src / connect-src の 'self' で足り、変更していない。
          読み込み先と 'self' は tests/speed-insights-1179.test.tsx が検査する (実際の送信先はデプロイ後に確認する)。
        */}
        <SpeedInsightsClient />
        {/*
          #1867: ハッシュだけの移動 (<a href="#how">・上のスキップリンクなど) で積まれた履歴の項目を、ブラウザの戻る / 進むで
          Next の app router が描き直せるようにする (画面には何も描かない)。src/lib/navigation/hash-history-entry.ts
        */}
        <HashHistoryEntryBridge />
      </body>
    </html>
  );
}
