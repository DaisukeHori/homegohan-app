'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { buildLegalConsentPath } from '@/lib/legal-consent';

/**
 * 「利用規約・プライバシーポリシーへの同意のお願い」のお知らせ (#1174)。
 *
 * lib/supabase/middleware.ts の同意ゲートが、未同意 (または古い版に同意) の利用者に対して、
 * 環境変数 LEGAL_CONSENT_ENFORCE=on にしていない間 (既定) に画面の上へ出す。
 * 同意画面 /legal-consent へ回す強制の前段で、使うのは止めない (非ブロッキング)。
 *
 * - 画面の流れの中 (position: static) に置く。固定表示にしないので、ボトムナビ・ヘッダー・モーダルに重ならない
 * - 同意画面へのリンクには、いま見ているパスを next として付ける (同意したあとで元の画面へ戻れる)
 */
export function LegalConsentBanner() {
  const pathname = usePathname();

  return (
    <div
      role="region"
      aria-label="利用規約・プライバシーポリシーの同意のお願い"
      data-testid="legal-consent-banner"
      className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b border-orange-100 bg-orange-50 px-4 py-2 text-xs text-gray-700"
    >
      <p>利用規約・プライバシーポリシーの内容をご確認のうえ、同意をお願いします。</p>
      <Link
        href={buildLegalConsentPath(pathname || '/home', '')}
        className="font-bold text-orange-700 underline underline-offset-2 hover:text-orange-800"
      >
        確認して同意する
      </Link>
    </div>
  );
}
