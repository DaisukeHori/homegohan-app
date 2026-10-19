import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { LEGAL_CONSENT_ACCOUNT_PATH } from '@/lib/legal-consent';
import AccountWithoutConsent from './AccountWithoutConsent';

// #1901 (cross/20 Q-23): 規約・プライバシーポリシーに同意していない人が、同意しないまま本人で退会とデータの書き出しをする画面。
// 同意画面 (/legal-consent) のフォームの下・未成年の案内の画面のリンクと、「同意しない」の後の案内 (ログインの後にここへ戻る) から来る。
// 同意画面の下のパスなので、同意ゲートと初期設定の差し戻しの対象外 (lib/onboarding-routing.ts の isLegalConsentPath)。
// 凍結中は middleware の凍結の差し戻しが先に効くので /frozen へ回る (凍結中の退会と書き出しは /frozen/account)。
// アプリは同意画面を WebView で開く (13b) ので、アプリの中でもこの画面は同じ WebView の中で開く。
export const metadata: Metadata = {
  title: '退会とデータの書き出し',
  robots: { index: false, follow: false },
};

// 利用者ごとに違い、退会の直後に変わる。キャッシュさせない
export const dynamic = 'force-dynamic';

export default async function LegalConsentAccountPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    // middleware が未ログインを /login へ回すので、通常はここへ来ない (念のため)
    redirect(`/login?next=${encodeURIComponent(LEGAL_CONSENT_ACCOUNT_PATH)}`);
  }

  return (
    <div className="min-h-screen bg-white">
      <header className="border-b border-gray-100">
        <div className="mx-auto flex max-w-xl items-center gap-3 p-6">
          <Link href="/" className="flex items-center gap-3">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#FF8A65] font-bold text-white" aria-hidden="true">
              H
            </span>
            <span className="text-lg font-bold tracking-tight text-gray-900">ほめゴハン</span>
          </Link>
        </div>
      </header>

      <main className="mx-auto max-w-xl p-6">
        <AccountWithoutConsent />
      </main>
    </div>
  );
}
