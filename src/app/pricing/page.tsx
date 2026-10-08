"use client";

import Link from "next/link";
import { motion } from "framer-motion";
import { Check, Sparkles, Crown, ArrowRight, HelpCircle } from "lucide-react";

const colors = {
  primary: '#E07A5F',
  primaryLight: '#FDF0ED',
  secondary: '#3D5A80',
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

// 有料プランは販売開始前。価格・機能・支払条件はまだ決まっていないので載せない。
const PAID_PLAN_PENDING = '有料プランは準備中です（販売開始前）';

// 現在ご利用いただける機能。実際にある機能だけを載せる (回数や期間の上限・広告の有無など、実際には無いものは書かない)。
const freeFeatures = [
  "写真で食事記録",
  "AI栄養分析",
  "AIコメント（褒める）",
  "週間レポート",
  "バッジ収集",
  "献立提案",
  "健康記録",
  "過去データ閲覧",
];

const faqs = [
  { q: "現在、料金はかかりますか？", a: "現在ご提供している機能は無料でご利用いただけます。" },
  { q: "有料プランはありますか？", a: `${PAID_PLAN_PENDING}。内容・料金・開始時期が決まりましたら、このページでご案内します。` },
];

export default function PricingPage() {
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
      <main className="container mx-auto px-4 py-16">
        {/* タイトル */}
        <div className="text-center max-w-2xl mx-auto mb-12">
          <h1 className="text-4xl md:text-5xl font-bold mb-4" style={{ color: colors.text }}>
            シンプルな<span style={{ color: colors.primary }}>料金プラン</span>
          </h1>
          <p className="text-lg" style={{ color: colors.textLight }}>
            現在は無料でご利用いただけます。<br />
            {PAID_PLAN_PENDING}。
          </p>
        </div>

        {/* プランカード */}
        <div className="grid md:grid-cols-2 gap-6 max-w-3xl mx-auto mb-20">
          {/* フリープラン */}
          <motion.div
            className="relative p-6 rounded-3xl"
            style={{ background: colors.card, border: `1px solid ${colors.border}` }}
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
          >
            <div className="text-center mb-6">
              <div className="w-14 h-14 mx-auto mb-4 rounded-2xl flex items-center justify-center" style={{ background: `${colors.success}15`, color: colors.success }}>
                <Sparkles size={24} />
              </div>
              <h3 className="text-xl font-bold mb-1" style={{ color: colors.text }}>フリー</h3>
              <p className="text-sm mb-4" style={{ color: colors.textMuted }}>まずは試してみたい方に</p>
              <div className="flex items-baseline justify-center gap-1">
                <span className="text-4xl font-bold" style={{ color: colors.text }}>¥0</span>
                <span className="text-sm" style={{ color: colors.textMuted }}>現在は無料</span>
              </div>
            </div>

            <ul className="space-y-3 mb-6">
              {freeFeatures.map((feature) => (
                <li key={feature} className="flex items-center gap-3 text-sm">
                  <Check size={18} style={{ color: colors.success }} />
                  <span style={{ color: colors.textLight }}>{feature}</span>
                </li>
              ))}
            </ul>

            <Link href="/signup">
              <motion.button
                className="w-full py-3 rounded-full font-bold text-sm"
                style={{ background: colors.primary, color: 'white' }}
                whileHover={{ scale: 1.02 }}
                whileTap={{ scale: 0.98 }}
              >
                無料で始める
              </motion.button>
            </Link>
          </motion.div>

          {/* 有料プラン (準備中) */}
          <motion.div
            className="relative p-6 rounded-3xl flex flex-col"
            style={{ background: colors.card, border: `2px dashed ${colors.border}` }}
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.1 }}
          >
            <div className="text-center mb-6">
              <div className="w-14 h-14 mx-auto mb-4 rounded-2xl flex items-center justify-center" style={{ background: `${colors.textMuted}15`, color: colors.textMuted }}>
                <Crown size={24} />
              </div>
              <h3 className="text-xl font-bold mb-1" style={{ color: colors.text }}>有料プラン</h3>
              <p className="text-sm mb-4" style={{ color: colors.textMuted }}>販売開始前</p>
              <div className="flex items-baseline justify-center gap-1">
                <span className="text-4xl font-bold" style={{ color: colors.textMuted }}>準備中</span>
              </div>
            </div>

            <p className="text-sm leading-relaxed text-center flex-1" style={{ color: colors.textLight }}>
              {PAID_PLAN_PENDING}。<br />
              内容・料金・開始時期が決まりましたら、このページでご案内します。
            </p>
          </motion.div>
        </div>

        {/* FAQ */}
        <div className="max-w-2xl mx-auto">
          <h2 className="text-2xl font-bold text-center mb-8" style={{ color: colors.text }}>よくある質問</h2>
          <div className="space-y-4">
            {faqs.map((faq, i) => (
              <div key={i} className="p-5 rounded-2xl" style={{ background: colors.card, border: `1px solid ${colors.border}` }}>
                <div className="flex items-start gap-3">
                  <HelpCircle size={20} style={{ color: colors.primary }} className="flex-shrink-0 mt-0.5" />
                  <div>
                    <p className="font-bold mb-2" style={{ color: colors.text }}>{faq.q}</p>
                    <p className="text-sm" style={{ color: colors.textLight }}>{faq.a}</p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* CTA */}
        <div className="text-center mt-16">
          <p className="text-lg mb-4" style={{ color: colors.textLight }}>まずは無料で始めてみませんか？</p>
          <Link href="/signup">
            <motion.button
              className="px-8 py-4 rounded-full font-bold text-white inline-flex items-center gap-2"
              style={{ background: colors.primary }}
              whileHover={{ scale: 1.03 }}
              whileTap={{ scale: 0.98 }}
            >
              無料で始める <ArrowRight size={18} />
            </motion.button>
          </Link>
        </div>
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
