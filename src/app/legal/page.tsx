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
// 有料の販売で要る項目 (販売価格・商品代金以外の必要料金・支払方法・支払時期・サービス提供時期・返品・解約) は、
// 有料プランの販売 (#1912) が足す。それまでは「準備中」とも書かず、項目ごと出さない (#1911)。
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
          最終更新日：2026年10月19日
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

