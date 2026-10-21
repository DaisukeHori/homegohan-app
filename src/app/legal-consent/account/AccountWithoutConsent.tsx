'use client';

// #1901 (cross/20 Q-23): 規約・プライバシーポリシーに同意していない人の、退会とデータの書き出し。
// 退会と書き出しの 2 つの枠は、凍結中の画面 (/frozen/account) と共通の部品 (AccountSelfServicePanel)。呼ぶ API は退会と書き出しと、
// 409 のときの家族グループ / 組織の解散 (#1917) の 4 つだけ (どれも同意の許可リスト LEGAL_CONSENT_EXEMPT_API_PATHS にある)。
// 退会できたら (ログアウト済み)、ログインの画面へ移らずに「退会しました」を出す: アプリの WebView の中では、ネイティブがログアウトを受けて
// 同意画面の上に「閉じる」を出し、Web の案内を残す (apps/mobile/app/legal-consent.tsx の signed-out-notice)。
import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { LEGAL_CONSENT_COPY } from '@homegohan/shared';
import { AccountSelfServicePanel } from '@/components/account/AccountSelfServicePanel';
import { LEGAL_CONSENT_ACCOUNT_PATH, LEGAL_CONSENT_PATH } from '@/lib/legal-consent';

export default function AccountWithoutConsent() {
  const router = useRouter();
  const [deleted, setDeleted] = useState(false);

  if (deleted) {
    return (
      <div className="space-y-6" data-testid="legal-consent-account-deleted">
        <div className="space-y-2">
          <h1 className="text-2xl font-bold tracking-tight text-gray-900">{LEGAL_CONSENT_COPY.accountDeletedHeading}</h1>
          <p className="text-sm leading-relaxed text-gray-600">{LEGAL_CONSENT_COPY.accountDeletedBody}</p>
        </div>
        <Link href="/" className="inline-block font-bold text-orange-700 underline underline-offset-4 hover:text-orange-800">
          トップページへ
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-6" data-testid="legal-consent-account">
      <div className="space-y-2">
        <h1 className="text-2xl font-bold tracking-tight text-gray-900">{LEGAL_CONSENT_COPY.accountPageHeading}</h1>
        <p className="text-sm leading-relaxed text-gray-600">{LEGAL_CONSENT_COPY.accountPageIntro}</p>
      </div>

      <AccountSelfServicePanel
        idPrefix="legal-consent-account"
        deleteBlockedGuidance={LEGAL_CONSENT_COPY.accountDeleteBlockedGuidance}
        onDeleted={() => setDeleted(true)}
        onUnauthorized={() => router.push(`/login?next=${encodeURIComponent(LEGAL_CONSENT_ACCOUNT_PATH)}`)}
      />

      <div className="flex flex-col gap-3 text-sm">
        <Link href="/contact" className="font-bold text-orange-700 underline underline-offset-4 hover:text-orange-800">
          お問い合わせフォームへ
        </Link>
        <Link href={LEGAL_CONSENT_PATH} className="text-gray-600 underline underline-offset-4 hover:text-gray-800">
          同意の画面に戻る
        </Link>
      </div>
    </div>
  );
}
