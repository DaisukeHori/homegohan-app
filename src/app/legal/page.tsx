"use client";

import type { ReactNode } from "react";
import Link from "next/link";

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

// 事業者の実在情報がまだ確定していない項目の表示。
// 架空の値 (ダミーの代表者名・住所・電話番号など) は載せない。確定したら実際の値に差し替える。
const PENDING = '準備中（確定次第掲載します）';

// 有料プランは販売開始前。価格・支払・解約などの条件はまだ決まっていないので載せない。
const PAID_PLAN_PENDING = '有料プランは準備中です（販売開始前）';

const rows: { label: string; value: ReactNode }[] = [
  { label: '販売事業者', value: '株式会社ほめゴハン' },
  { label: '代表者', value: PENDING },
  { label: '所在地', value: PENDING },
  { label: '電話番号', value: PENDING },
  { label: 'メールアドレス', value: PENDING },
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
  { label: '販売価格', value: PAID_PLAN_PENDING },
  { label: '商品代金以外の必要料金', value: 'インターネット接続料金、通信料金等はお客様のご負担となります。' },
  { label: '支払方法', value: PAID_PLAN_PENDING },
  { label: '支払時期', value: PAID_PLAN_PENDING },
  { label: 'サービス提供時期', value: PAID_PLAN_PENDING },
  { label: '返品・キャンセル', value: 'デジタルコンテンツの性質上、購入後の返品・返金は原則としてお受けしておりません。\n\nただし、サービスに重大な瑕疵があった場合は、個別に対応いたします。' },
  { label: '解約について', value: PAID_PLAN_PENDING },
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
          最終更新日：2026年10月8日
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

