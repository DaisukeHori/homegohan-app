// (main) セグメント全体を動的レンダーに強制
// → Vercel CDN にキャッシュさせず、middleware の認証チェックを毎回実行する
// (Bug-37 / 88: 未認証ユーザーへの保護ルート HTML キャッシュ流出を防止)
export const dynamic = 'force-dynamic';
export const revalidate = 0;

import { cookies } from 'next/headers';
import MainLayout from './MainLayout';

export default async function Layout({ children }: { children: React.ReactNode }) {
  // SSR 初回レンダリング時に Cookie を参照し、native アプリモードを判定
  // middleware が ?mode=app を検出して Cookie をセットするため、
  // 最初のリクエストから正しい初期値をクライアントへ渡せる
  const cookieStore = await cookies();
  const initialIsNativeApp = cookieStore.get('is_native_app')?.value === '1';

  return <MainLayout initialIsNativeApp={initialIsNativeApp}>{children}</MainLayout>;
}
