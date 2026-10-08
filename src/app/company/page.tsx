"use client";

import Link from "next/link";
import { motion } from "framer-motion";
import { Users, Target, Heart, Sparkles } from "lucide-react";

const colors = {
  primary: '#E07A5F',
  primaryLight: '#FDF0ED',
  secondary: '#3D5A80',
  secondaryLight: '#E8EEF4',
  success: '#6B9B6B',
  successLight: '#EDF5ED',
  warning: '#F4A261',
  bg: '#FAF9F7',
  bgAlt: '#F5F3EF',
  card: '#FFFFFF',
  text: '#1A1A1A',
  textLight: '#4A4A4A',
  textMuted: '#8A8A8A',
  border: '#E8E8E8',
};

const values = [
  { icon: <Heart size={24} />, title: '褒めて伸ばす', desc: 'ダメ出しではなく、良いところを見つけて褒める。それがほめゴハンの哲学です。', color: colors.primary },
  { icon: <Users size={24} />, title: 'ユーザーファースト', desc: '常にユーザーの声に耳を傾け、本当に必要な機能を提供します。', color: colors.secondary },
  { icon: <Target size={24} />, title: '継続可能な健康', desc: '無理なく続けられる。それが本当の健康への第一歩だと考えます。', color: colors.success },
  { icon: <Sparkles size={24} />, title: '技術で社会貢献', desc: '最新のAI技術を活用し、誰もが健康になれる社会を目指します。', color: colors.warning },
];

// 事業者の実在情報がまだ確定していない項目の表示。
// 架空の代表者名・住所・沿革・チーム紹介などは載せない。確定したら実際の値に差し替える。
const PENDING = '準備中（確定次第掲載します）';

export default function CompanyPage() {
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
      <main>
        {/* ヒーロー */}
        <section className="py-20 text-center" style={{ background: colors.primaryLight }}>
          <div className="container mx-auto px-4">
            <h1 className="text-4xl md:text-5xl font-bold mb-4" style={{ color: colors.text }}>
              運営会社
            </h1>
            <p className="text-lg" style={{ color: colors.textLight }}>
              「食べることを、もっと誇らしく。」<br />
              私たちはテクノロジーで食生活を変えていきます。
            </p>
          </div>
        </section>

        {/* ミッション */}
        <section className="py-16">
          <div className="container mx-auto px-4 max-w-4xl">
            <div className="text-center mb-12">
              <h2 className="text-3xl font-bold mb-4" style={{ color: colors.text }}>ミッション</h2>
              <p className="text-xl leading-relaxed" style={{ color: colors.textLight }}>
                「褒める」ことで、<br />
                すべての人が健康的な食生活を<br />
                楽しく続けられる世界をつくる。
              </p>
            </div>

            <div className="grid md:grid-cols-2 gap-6">
              {values.map((value, i) => (
                <motion.div
                  key={i}
                  className="p-6 rounded-2xl"
                  style={{ background: colors.card, border: `1px solid ${colors.border}` }}
                  initial={{ opacity: 0, y: 20 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={{ once: true }}
                  transition={{ delay: i * 0.1 }}
                >
                  <div className="w-12 h-12 rounded-xl flex items-center justify-center mb-4" style={{ background: `${value.color}15`, color: value.color }}>
                    {value.icon}
                  </div>
                  <h3 className="font-bold mb-2" style={{ color: colors.text }}>{value.title}</h3>
                  <p className="text-sm" style={{ color: colors.textLight }}>{value.desc}</p>
                </motion.div>
              ))}
            </div>
          </div>
        </section>

        {/* 会社概要 */}
        <section className="py-16" style={{ background: colors.bgAlt }}>
          <div className="container mx-auto px-4 max-w-4xl">
            <h2 className="text-3xl font-bold mb-8 text-center" style={{ color: colors.text }}>会社概要</h2>
            <div className="rounded-3xl p-6 md:p-8" style={{ background: colors.card }}>
              <table className="w-full">
                <tbody>
                  {[
                    { label: '会社名', value: '株式会社ほめゴハン' },
                    { label: '事業内容', value: '食事管理アプリ「ほめゴハン」の企画・開発・運営' },
                    { label: '代表者', value: PENDING },
                    { label: '所在地', value: PENDING },
                  ].map((row, i) => (
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
          </div>
        </section>

        {/* お問い合わせ */}
        <section className="py-16">
          <div className="container mx-auto px-4 max-w-2xl text-center">
            <h2 className="text-3xl font-bold mb-8" style={{ color: colors.text }}>お問い合わせ</h2>
            <p className="text-sm leading-relaxed" style={{ color: colors.textLight }}>
              メールアドレス・電話番号・所在地の掲載は準備中です（確定次第掲載します）。<br />
              お問い合わせは、下のお問い合わせフォームからお願いします。
            </p>
            <Link href="/contact" className="inline-block mt-8">
              <motion.button
                className="px-8 py-3 rounded-full font-bold text-white"
                style={{ background: colors.primary }}
                whileHover={{ scale: 1.03 }}
                whileTap={{ scale: 0.98 }}
              >
                お問い合わせフォーム
              </motion.button>
            </Link>
          </div>
        </section>
      </main>

      {/* フッター */}
      <footer className="py-8 border-t" style={{ background: colors.card, borderColor: colors.border }}>
        <div className="container mx-auto px-4 text-center">
          <p className="text-sm" style={{ color: colors.textMuted }}>© 2025 ほめゴハン All rights reserved.</p>
        </div>
      </footer>
    </div>
  );
}

