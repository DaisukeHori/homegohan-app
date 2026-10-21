"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import {
  BUSINESS_ADDRESS,
  BUSINESS_EMAIL,
  BUSINESS_HOURS,
  BUSINESS_NAME,
  BUSINESS_REPRESENTATIVE,
} from "@/lib/business-info";
import { PhoneOnRequest } from "@/components/legal/PhoneOnRequest";
import { PLAN_TRIAL_DAYS, formatLegalEffectiveDate, planCatalogPriceText } from "@homegohan/shared";
import { LEGAL_NOTICE_LAST_UPDATED } from "@/lib/legal/legal-notice";

const colors = {
  primary: '#E07A5F',
  primaryLight: '#FDF0ED',
  bg: '#FAF9F7',
  bgAlt: '#F5F3EF',
  card: '#FFFFFF',
  text: '#1A1A1A',
  textLight: '#4A4A4A',
  textMuted: '#8A8A8A',
  border: '#E8E8E8',
};

// 販売事業者・代表者・所在地・メールアドレス・営業時間は src/lib/business-info.ts の値を出す (法務ページの間で食い違わないように)。
// 電話番号は載せず、請求があれば遅滞なく開示すると書いて、請求の窓口 (メールアドレスとお問い合わせのフォーム) を添える。
// 架空の値 (ダミーの住所・電話番号など) は載せない。
// 有料の販売の項目 (販売価格・支払方法など) は、価格を `@homegohan/shared` の `planCatalogPriceText()` (DB の価格の写し `PLAN_CATALOG`。tests/billing-plan-catalog.test.ts が DB と突き合わせる) から出し、文はこのファイルに書く (billing/03 §10.2)。
const rows: { label: string; value: ReactNode }[] = [
  { label: '販売事業者', value: BUSINESS_NAME },
  { label: '代表者', value: BUSINESS_REPRESENTATIVE },
  { label: '所在地', value: BUSINESS_ADDRESS },
  { label: '電話番号', value: <PhoneOnRequest linkColor={colors.primary} /> },
  { label: 'メールアドレス', value: BUSINESS_EMAIL },
  { label: '営業時間', value: BUSINESS_HOURS },
  {
    label: 'お問い合わせ',
    value: (
      <>
        <Link href="/contact" className="font-bold underline" style={{ color: colors.primary }}>
          お問い合わせフォーム
        </Link>
        からご連絡ください。
      </>
    ),
  },
  { label: '販売価格', value: `${planCatalogPriceText()}\n無料プランは 0 円です。` },
  { label: '商品代金以外の必要料金', value: 'インターネット接続料金、通信料金等はお客様のご負担となります。' },
  {
    label: '支払方法',
    value: 'Web: クレジットカード (決済の事業者 Stripe の決済画面で受け付けるカード)。\niOS / Android アプリ: App Store / Google Play のアプリ内課金。',
  },
  {
    label: '支払時期',
    value:
      'Web: お申し込みの時に初回のお支払いをいただきます (無料体験のあるプランは、無料体験の終了時)。以後は毎月または毎年の更新日に自動でお支払いいただきます。\nアプリ内課金: 各ストアの定める時期にお支払いいただきます。',
  },
  {
    label: 'サービス提供時期',
    value: 'お支払いの手続き (無料体験のあるプランは、お申し込みの手続き) が完了した時点から、すぐにご利用いただけます。',
  },
  {
    label: '返品・キャンセル',
    value:
      'デジタルコンテンツの性質上、購入後の返品・返金は原則としてお受けしておりません。ただし、サービスに重大な瑕疵があった場合は、個別に対応いたします。\n\nApp Store / Google Play でお申し込みの場合の返金は、各ストアの規定によります。',
  },
  {
    label: '解約について',
    value:
      'いつでも解約できます。Web でお申し込みの方は本サービスの画面から、App Store / Google Play でお申し込みの方は各ストアの定期購読の管理から解約してください。解約後も、お支払い済みの期間の終わりまでご利用いただけます。期間の途中の解約による日割りの返金はありません。',
  },
  {
    label: '定期購入について',
    value: '有料プランは自動更新の定期購入です。解約しない限り、月額または年額の期間ごとに同じ金額が自動で請求されます。',
  },
  {
    label: '無料体験について',
    value: `Web でお申し込みの場合、どの有料プランも ${PLAN_TRIAL_DAYS} 日間の無料体験つきです (同じプランにつき 1 回)。無料体験の終了時に自動で有料の期間に移り、販売価格が請求されます。無料体験の間に解約すると、料金は請求されません。App Store / Google Play でお申し込みの場合の無料体験は、各ストアの表示によります。`,
  },
  { label: '動作環境', value: '【Webブラウザ】\nChrome、Safari、Firefox、Edgeの最新版\n\n【スマートフォン】\niOS 14.0以上\nAndroid 8.0以上' },
];

export default function LegalPage() {
  return (
    <div className="min-h-screen" style={{ background: colors.bg }}>
      {/* ヘッダー */}
      <header className="sticky top-0 z-50 border-b" style={{ background: colors.card, borderColor: colors.border }}>
        <div className="container mx-auto px-4 h-16 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-2">
            <div className="w-9 h-9 rounded-xl flex items-center justify-center text-white font-bold" style={{ background: colors.primary }}>H</div>
            <span className="font-bold text-lg" style={{ color: colors.text }}>ほめゴハン</span>
          </Link>
          <Link href="/signup">
            <button className="text-sm font-bold px-4 py-2 text-white rounded-full" style={{ background: colors.primary }}>無料で始める</button>
          </Link>
        </div>
      </header>

      {/* メインコンテンツ */}
      <main className="container mx-auto px-4 py-12 max-w-3xl">
        <h1 className="text-3xl md:text-4xl font-bold mb-8 text-center" style={{ color: colors.text }}>
          特定商取引法に基づく表記
        </h1>

        <div className="rounded-3xl p-6 md:p-8" style={{ background: colors.card, border: `1px solid ${colors.border}` }}>
          <table className="w-full">
            <tbody>
              {rows.map((row, i) => (
                <tr key={i} className="border-b last:border-b-0" style={{ borderColor: colors.border }}>
                  <th className="py-4 pr-4 text-left align-top w-1/3 font-bold text-sm" style={{ color: colors.text }}>
                    {row.label}
                  </th>
                  <td className="py-4 text-sm whitespace-pre-wrap" style={{ color: colors.textLight }}>
                    {row.value}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <p className="text-center text-sm mt-8" style={{ color: colors.textMuted }}>
          {/* 最終更新日は定数 1 か所 (src/lib/legal/legal-notice.ts) から出す。表の中身との組は tests/legal-notice-last-updated.test.ts が見る */}
          最終更新日：{formatLegalEffectiveDate(LEGAL_NOTICE_LAST_UPDATED)}
        </p>
      </main>

      {/* フッター */}
      <footer className="py-8 border-t mt-16" style={{ background: colors.card, borderColor: colors.border }}>
        <div className="container mx-auto px-4 text-center">
          <p className="text-sm" style={{ color: colors.textMuted }}>© 2025 ほめゴハン All rights reserved.</p>
        </div>
      </footer>
    </div>
  );
}

