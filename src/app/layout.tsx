import type { Metadata } from "next";
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
  title: "ほめごはん | パフォーマンスを食事から変える",
  description: "撮るだけで分かる。食べ方から、パフォーマンスを底上げ。",
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
