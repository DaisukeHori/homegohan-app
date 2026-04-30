// (main) セグメント全体を動的レンダーに強制
// → Vercel CDN にキャッシュさせず、middleware の認証チェックを毎回実行する
// (Bug-37 / 88: 未認証ユーザーへの保護ルート HTML キャッシュ流出を防止)
export const dynamic = 'force-dynamic';
export const revalidate = 0;

import MainLayout from './MainLayout';

export default function Layout({ children }: { children: React.ReactNode }) {
  return <MainLayout>{children}</MainLayout>;
}
