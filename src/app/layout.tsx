import type { Metadata, Viewport } from "next";
import { Noto_Sans_JP, Noto_Serif_JP } from "next/font/google";
import "./globals.css";

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
    default: "ほめゴハン | AIで食事管理をもっと簡単に",
    template: "%s | ほめゴハン",
  },
  description: "写真を撮るだけでAIが栄養分析。毎日の食事記録から献立提案、健康管理まで。あなたの食生活をサポートする次世代の食事管理アプリ。",
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
  metadataBase: new URL("https://homegohan.app"),
  alternates: {
    canonical: "/",
  },
  openGraph: {
    title: "ほめゴハン | AIで食事管理をもっと簡単に",
    description: "写真を撮るだけでAIが栄養分析。毎日の食事記録から献立提案、健康管理まで。あなたの食生活をサポートする次世代の食事管理アプリ。",
    url: "https://homegohan.app",
    siteName: "ほめゴハン",
    locale: "ja_JP",
    type: "website",
    images: [
      {
        url: "/og-image.png",
        width: 1200,
        height: 630,
        alt: "ほめゴハン - AIで食事管理をもっと簡単に",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "ほめゴハン | AIで食事管理をもっと簡単に",
    description: "写真を撮るだけでAIが栄養分析。毎日の食事記録から献立提案、健康管理まで。",
    images: ["/og-image.png"],
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
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `
              (function() {
                try {
                  // ダークモード設定を削除
                  localStorage.removeItem('darkMode');
                  // html要素からdarkクラスを削除
                  document.documentElement.classList.remove('dark');
                } catch (e) {}
              })();
            `,
          }}
        />
      </head>
      <body className="font-sans antialiased">
        {children}
      </body>
    </html>
  );
}
