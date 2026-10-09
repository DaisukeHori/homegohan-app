import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getOutdatedLegalDocuments, hasAcceptedCurrentLegalDocuments } from '@homegohan/shared';
import { createClient } from '@/lib/supabase/server';
import { LEGAL_CONSENT_PATH, resolveLegalConsentNext } from '@/lib/legal-consent';
import LegalConsentForm from './LegalConsentForm';

// #1174: 利用規約・プライバシーポリシーへの同意画面。
// lib/supabase/middleware.ts の同意ゲートが、LEGAL_CONSENT_ENFORCE=on のとき、同意が済んでいない
// サインイン中の利用者を ?next=<元のパス> つきでここへ回す (LEGAL_CONSENT_NOTICE=on のときのお知らせのリンクからも来る。
// 既定ではどちらのフラグも off で、誰も回されない)。(main) グループの外に置く: アプリ用のナビ・AI チャットを
// 付けずに、同意だけに集中してもらう (ゲートの対象外のパスなので、ここへ来た人がさらに回されることはない)。
export const metadata: Metadata = {
  title: '規約への同意',
  robots: { index: false, follow: false },
};

// 同意の状況は利用者ごとに違い、同意した直後に変わる。キャッシュさせない
export const dynamic = 'force-dynamic';

interface PageProps {
  searchParams?: { next?: string | string[] };
}

export default async function LegalConsentPage({ searchParams }: PageProps) {
  const rawNext = Array.isArray(searchParams?.next) ? searchParams?.next[0] : searchParams?.next;
  const next = resolveLegalConsentNext(rawNext);

  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    // middleware が未ログインを /login へ回すので、通常はここへ来ない (念のため)
    redirect(`/login?next=${encodeURIComponent(`${LEGAL_CONSENT_PATH}?next=${encodeURIComponent(next)}`)}`);
  }

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('terms_version_accepted, privacy_version_accepted')
    .eq('id', user.id)
    .maybeSingle();

  // すでに同意済みの人 (戻るボタンや古いリンクで来た) は、同意画面を見せずに戻り先へ送る
  if (hasAcceptedCurrentLegalDocuments(profile)) {
    redirect(next);
  }

  const isReconsent = Boolean(profile?.terms_version_accepted || profile?.privacy_version_accepted);

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
        <LegalConsentForm next={next} isReconsent={isReconsent} outdated={getOutdatedLegalDocuments(profile)} />
      </main>
    </div>
  );
}
