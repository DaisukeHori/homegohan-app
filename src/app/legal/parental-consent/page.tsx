// src/app/legal/parental-consent/page.tsx
// #1173: 保護者の同意書の全文 (公開ページ)。未ログインでも読める (/legal は同意ゲートの対象外で、middleware の公開のパス)。
// 文面・版・施行日は packages/shared の parental-consent.ts が正 (子供の追加画面・メンバーの画面・控えのメールが同じ定数を使う)。
import type { Metadata } from 'next';
import Link from 'next/link';
import {
  PARENTAL_CONSENT_DOCUMENT,
  PARENTAL_CONSENT_DOCUMENT_COPY,
  formatLegalEffectiveDate,
} from '@homegohan/shared';
import { getSupportEmail } from '@/lib/site-config';

export const metadata: Metadata = {
  title: '保護者の同意書',
};

export default function ParentalConsentDocumentPage() {
  return (
    <div className="min-h-screen bg-white">
      <header className="border-b border-gray-100">
        <div className="mx-auto flex max-w-2xl items-center gap-3 p-6">
          <Link href="/" className="flex items-center gap-3">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#FF8A65] font-bold text-white" aria-hidden="true">
              H
            </span>
            <span className="text-lg font-bold tracking-tight text-gray-900">ほめゴハン</span>
          </Link>
        </div>
      </header>

      <main className="mx-auto max-w-2xl space-y-6 p-6">
        <div className="space-y-2">
          <h1 className="text-2xl font-bold tracking-tight text-gray-900">{PARENTAL_CONSENT_DOCUMENT_COPY.title}</h1>
          <p className="text-xs text-gray-500" data-testid="parental-consent-version">
            版: {PARENTAL_CONSENT_DOCUMENT.version} ／ 施行日: {formatLegalEffectiveDate(PARENTAL_CONSENT_DOCUMENT.effectiveDate)}
          </p>
        </div>

        <div className="space-y-4 text-sm leading-relaxed text-gray-700">
          {PARENTAL_CONSENT_DOCUMENT_COPY.paragraphs.map((paragraph) => (
            <p key={paragraph}>{paragraph}</p>
          ))}
        </div>

        <section className="space-y-2 rounded-2xl border border-gray-200 bg-gray-50 p-4 text-sm text-gray-700">
          <p>
            お問い合わせ先: <span className="font-bold">{getSupportEmail()}</span>
          </p>
          <p>
            個人情報の取り扱いは
            <Link href="/privacy" className="font-bold text-orange-700 underline underline-offset-4 hover:text-orange-800">
              プライバシーポリシー
            </Link>
            をご確認ください。
          </p>
        </section>
      </main>
    </div>
  );
}
