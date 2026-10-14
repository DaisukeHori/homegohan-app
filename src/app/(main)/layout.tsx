// (main) セグメント全体を動的レンダーに強制
// → Vercel CDN にキャッシュさせず、middleware の認証チェックを毎回実行する
// (Bug-37 / 88: 未認証ユーザーへの保護ルート HTML キャッシュ流出を防止)
export const dynamic = 'force-dynamic';
export const revalidate = 0;

import { cookies, headers } from 'next/headers';
import { LEGAL_CONSENT_PENDING_HEADER } from '@/lib/legal-consent';
import MainLayout from './MainLayout';

export default async function Layout({ children }: { children: React.ReactNode }) {
  // SSR 初回レンダリング時に Cookie を参照し、native アプリモードを判定
  // middleware が ?mode=app を検出して Cookie をセットするため、
  // 最初のリクエストから正しい初期値をクライアントへ渡せる
  const cookieStore = await cookies();
  const initialIsNativeApp = cookieStore.get('is_native_app')?.value === '1';

  // #1174: 利用規約・プライバシーポリシーへの同意が済んでいない人には、画面の上に「同意のお願い」を出す。
  // 判定は middleware (lib/supabase/middleware.ts の同意ゲート) が、すでに読んでいる user_profiles の行で行い、
  // お知らせを有効にしていて (LEGAL_CONSENT_NOTICE=on)、強制 (LEGAL_CONSENT_ENFORCE=on) にしていない間だけ、
  // このヘッダーで画面へ渡す (既定ではどちらも off なので、お知らせは出ない)。ここでは DB も環境変数も読み直さない。
  const legalConsentPending = headers().get(LEGAL_CONSENT_PENDING_HEADER) === '1';

  return (
    <MainLayout initialIsNativeApp={initialIsNativeApp} legalConsentPending={legalConsentPending}>
      {children}
    </MainLayout>
  );
}
