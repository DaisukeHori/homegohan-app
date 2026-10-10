'use client';

import { Suspense } from 'react';
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { buildLegalConsentPath } from '@/lib/legal-consent';

/** パスが取れないときの戻り先 */
const FALLBACK_PATHNAME = '/home';

/**
 * 「利用規約・プライバシーポリシーへの同意のお願い」のお知らせ (#1174)。
 *
 * lib/supabase/middleware.ts の同意ゲートが、未同意 (または古い版に同意) の利用者に対して、
 * 環境変数 LEGAL_CONSENT_NOTICE=on で、LEGAL_CONSENT_ENFORCE=on にしていない間だけ、画面の上へ出す
 * (既定ではどちらも off なので出ない)。同意画面 /legal-consent へ回す強制の前段で、使うのは止めない (非ブロッキング)。
 * 出すかどうかはサーバー側で決まり、(main) の layout から MainLayout の props で渡ってくる。この部品は環境変数を読まない。
 *
 * - 画面の流れの中 (position: static) に置く。固定表示にしないので、ボトムナビ・ヘッダー・モーダルに重ならない
 * - 同意画面へのリンクには、いま見ているパスとクエリを next として付ける (同意したあとで元の画面へ戻れる)。
 *   作り方は middleware の強制の経路と同じ buildLegalConsentPath (_rsc は落とす) (#1435)
 * - useSearchParams は Suspense 境界の中で読む (MainLayout の BottomNav と同じ流儀)。
 *   クエリを読めるまでの間は、パスだけを next にしたリンクを出す
 */
export function LegalConsentBanner() {
  return (
    <Suspense fallback={<ConsentNoticePathOnly />}>
      <ConsentNoticeWithQuery />
    </Suspense>
  );
}

function ConsentNoticeWithQuery() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  return <ConsentNoticeView href={buildLegalConsentPath(pathname || FALLBACK_PATHNAME, searchParams?.toString() ?? '')} />;
}

function ConsentNoticePathOnly() {
  const pathname = usePathname();
  return <ConsentNoticeView href={buildLegalConsentPath(pathname || FALLBACK_PATHNAME, '')} />;
}

function ConsentNoticeView({ href }: { href: string }) {
  return (
    <div
      role="region"
      aria-label="利用規約・プライバシーポリシーの同意のお願い"
      data-testid="legal-consent-banner"
      className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b border-orange-100 bg-orange-50 px-4 py-2 text-xs text-gray-700"
    >
      <p>利用規約・プライバシーポリシーの内容をご確認のうえ、同意をお願いします。</p>
      <Link href={href} className="font-bold text-orange-700 underline underline-offset-2 hover:text-orange-800">
        確認して同意する
      </Link>
    </div>
  );
}
