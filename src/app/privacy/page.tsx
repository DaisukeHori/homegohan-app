import type { Metadata } from "next";
import Link from "next/link";
import { LegalDocumentBody } from "@/components/legal/LegalDocumentBody";
import { LegalDocumentMeta } from "@/components/legal/LegalDocumentMeta";
import { AI_CONSENT_PROVIDERS, AI_CONSENT_PROVIDER_INFO } from "@/lib/ai/consent-config";
import {
  BUSINESS_ADDRESS,
  BUSINESS_EMAIL,
  BUSINESS_HOURS,
  BUSINESS_NAME,
  BUSINESS_REPRESENTATIVE,
  PHONE_DISCLOSED_ON_REQUEST,
} from "@/lib/business-info";
import { privacyText } from "@/lib/legal/privacy-text";
import { publicPageMetadata } from "@/lib/seo/public-pages";

// #1174 (同意の前提): 未ログインでも読める公開ページ。サインアップ画面・LP フッターの同意リンクと、
// ストア審査に出すプライバシー URL の着地点なので、(main) グループ (ログイン後の画面。アプリ用のナビ付き) の外に置く。
// ログイン・オンボーディング・凍結の差し戻しからは、lib/supabase/middleware.ts の publicPaths と
// lib/onboarding-routing.ts の isPolicyPath で除外している。
// #1867: title・description・canonical・OGP は src/lib/seo/public-pages.ts が正本
// #1901: 本文は src/lib/legal/privacy-text.ts (設計書 cross/20 §7) が正本。このファイルは文を持たない。
//        事業者の情報と窓口は src/lib/business-info.ts (#1911) の定数を渡す (特定商取引法に基づく表記・運営会社のページと同じ値)
// #1366: AI 事業者の一覧は、同意画面と同じ AI_CONSENT_PROVIDERS / AI_CONSENT_PROVIDER_INFO から作って渡す
//        (実際の送信先と同意の一覧は tests/ai-consent-provider-inventory.test.ts が突き合わせている)
export const metadata: Metadata = publicPageMetadata("/privacy");

const MAIN_CLASS =
  "p-6 max-w-3xl mx-auto text-gray-700 leading-relaxed " +
  "[&_h2]:mt-10 [&_h2]:mb-3 [&_h2]:text-xl [&_h2]:font-bold [&_h2]:text-gray-900 " +
  "[&_h3]:mt-8 [&_h3]:mb-2 [&_h3]:text-lg [&_h3]:font-bold [&_h3]:text-gray-900 " +
  "[&_p]:mb-4 [&_ul]:mb-4 [&_ul]:list-disc [&_ul]:pl-6 [&_ol]:mb-4 [&_ol]:list-decimal [&_ol]:pl-6 [&_li]:mb-1 " +
  "[&_table]:mb-4 [&_table]:w-full [&_table]:text-sm [&_th]:text-left [&_th]:align-top [&_th]:p-2 [&_th]:border-b " +
  "[&_td]:align-top [&_td]:p-2 [&_td]:border-b";

export default function PrivacyPage() {
  const document = privacyText({
    businessName: BUSINESS_NAME,
    businessAddress: BUSINESS_ADDRESS,
    businessRepresentative: BUSINESS_REPRESENTATIVE,
    phoneDisclosure: PHONE_DISCLOSED_ON_REQUEST,
    businessEmail: BUSINESS_EMAIL,
    businessHours: BUSINESS_HOURS,
    aiProviders: AI_CONSENT_PROVIDERS.map((id) => {
      const info = AI_CONSENT_PROVIDER_INFO[id];
      return { name: info.name, country: info.country, usage: info.usage };
    }),
  });
  return (
    <div className="min-h-screen bg-white">
      <header className="bg-white border-b border-gray-100 sticky top-0 z-20">
        <div className="max-w-3xl mx-auto p-6 flex items-center gap-4">
          <Link href="/" aria-label="トップページへ戻る" className="p-2 -ml-2 hover:bg-gray-50 rounded-full">
            <svg className="w-6 h-6 text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
          </Link>
          <h1 className="text-xl font-bold text-gray-900">プライバシーポリシー</h1>
        </div>
      </header>

      <main className={MAIN_CLASS}>
        {/* 版・施行日は packages/shared の LEGAL_DOCUMENTS (同意の記録に使う版と同じ値) から出す */}
        <LegalDocumentMeta type="privacy_policy" />
        <LegalDocumentBody document={document} />
      </main>

      <footer className="py-8 border-t border-gray-100">
        <p className="text-center text-sm text-gray-500">© 2025 ほめゴハン All rights reserved.</p>
      </footer>
    </div>
  );
}
