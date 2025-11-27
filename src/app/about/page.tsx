"use client";

import Link from "next/link";
import { motion } from "framer-motion";
import { ArrowLeft, Camera, Brain, Target, Users, Heart, Sparkles, ArrowRight } from "lucide-react";

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

const features = [
  {
    icon: Camera,
    title: '写真で簡単記録',
    description: '食事の写真を撮るだけで、AIが自動で料理を認識し、カロリーや栄養素を推定します。面倒な手入力は不要です。',
    color: colors.primary,
  },
  {
    icon: Sparkles,
    title: 'AIが褒めてくれる',
    description: 'ダメ出しではなく、良いところを見つけて褒める。だから続けられる、だから楽しい。',
    color: colors.warning,
  },
  {
    icon: Brain,
    title: 'AIによる献立提案',
    description: 'あなたの好み、健康状態、冷蔵庫の食材を考慮して、最適な献立をAIが提案。毎日の「何作ろう？」を解決します。',
    color: colors.secondary,
  },
  {
    icon: Target,
    title: 'パーソナライズ栄養管理',
    description: '年齢、体重、活動量、健康目標に基づいて、あなただけの栄養目標を設定。無理なく続けられる健康管理を実現します。',
    color: colors.success,
  },
  {
    icon: Heart,
    title: '健康記録＆分析',
    description: '体重、体脂肪、血圧などの健康データを記録し、AIが傾向を分析。健康状態の変化を可視化してアドバイスします。',
    color: colors.primary,
  },
  {
    icon: Users,
    title: '家族みんなで使える',
    description: '家族の人数に合わせた分量計算、それぞれの好き嫌いやアレルギーにも対応。家族全員の健康をサポートします。',
    color: colors.warning,
  },
];

const stats = [
  { value: '1,234,567+', label: '食の分析実績' },
  { value: '98.7%', label: '継続率' },
  { value: '4.9', label: 'App Store評価' },
  { value: '42日', label: '最長連続記録' },
];

export default function AboutPage() {
  return (
    <div className="min-h-screen" style={{ background: colors.bg }}>
      {/* ヘッダー */}
      <header className="sticky top-0 z-50 border-b" style={{ background: colors.card, borderColor: colors.border }}>
        <div className="container mx-auto px-4 h-16 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Link href="/" className="p-2 -ml-2 rounded-full hover:bg-gray-100 transition-colors">
              <ArrowLeft size={20} style={{ color: colors.text }} />
            </Link>
            <Link href="/" className="flex items-center gap-2">
              <div className="w-9 h-9 rounded-xl flex items-center justify-center text-white font-bold" style={{ background: colors.primary }}>H</div>
              <span className="font-bold text-lg" style={{ color: colors.text }}>ほめゴハン</span>
            </Link>
          </div>
          <Link href="/signup">
            <button className="text-sm font-bold px-4 py-2 text-white rounded-full" style={{ background: colors.primary }}>無料で始める</button>
          </Link>
        </div>
      </header>

      {/* ヒーロー */}
      <section className="py-16 md:py-24 text-center" style={{ background: colors.primaryLight }}>
        <div className="container mx-auto px-4">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
          >
            <h1 className="text-4xl md:text-5xl font-bold mb-6" style={{ color: colors.text }}>
              ほめゴハンについて
            </h1>
            <p className="text-lg md:text-xl max-w-2xl mx-auto leading-relaxed" style={{ color: colors.textLight }}>
              「食べることを、もっと誇らしく。」<br />
              写真を撮るだけで、AIがあなたの食事を分析。<br />
              ダメ出しじゃなく、良いところを見つけて褒める。<br />
              だから、続けられる。
            </p>
          </motion.div>
        </div>
      </section>

      {/* 実績 */}
      <section className="py-12 border-b" style={{ background: colors.card, borderColor: colors.border }}>
        <div className="container mx-auto px-4">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-6">
            {stats.map((stat, i) => (
              <motion.div
                key={i}
                className="text-center"
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ delay: i * 0.1 }}
              >
                <div className="text-3xl md:text-4xl font-bold mb-1" style={{ color: colors.primary }}>{stat.value}</div>
                <div className="text-sm" style={{ color: colors.textMuted }}>{stat.label}</div>
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      {/* 機能紹介 */}
      <section className="py-16 md:py-24">
        <div className="container mx-auto px-4">
          <div className="text-center mb-12">
            <h2 className="text-3xl md:text-4xl font-bold mb-4" style={{ color: colors.text }}>
              主な機能
            </h2>
            <p style={{ color: colors.textLight }}>
              ほめゴハンで実現できること
            </p>
          </div>

          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6 max-w-5xl mx-auto">
            {features.map((feature, i) => {
              const Icon = feature.icon;
              return (
                <motion.div
                  key={i}
                  className="p-6 rounded-2xl"
                  style={{ background: colors.card, border: `1px solid ${colors.border}` }}
                  initial={{ opacity: 0, y: 20 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={{ once: true }}
                  transition={{ delay: i * 0.05 }}
                >
                  <div className="w-12 h-12 rounded-xl flex items-center justify-center mb-4" style={{ background: `${feature.color}15`, color: feature.color }}>
                    <Icon size={24} />
                  </div>
                  <h3 className="font-bold mb-2" style={{ color: colors.text }}>{feature.title}</h3>
                  <p className="text-sm leading-relaxed" style={{ color: colors.textLight }}>{feature.description}</p>
                </motion.div>
              );
            })}
          </div>
        </div>
      </section>

      {/* ミッション */}
      <section className="py-16 md:py-24" style={{ background: colors.bgAlt }}>
        <div className="container mx-auto px-4 max-w-3xl text-center">
          <h2 className="text-3xl md:text-4xl font-bold mb-6" style={{ color: colors.text }}>
            私たちのミッション
          </h2>
          <p className="text-lg leading-relaxed mb-8" style={{ color: colors.textLight }}>
            多くの食事管理アプリは「カロリーオーバーです」「野菜が足りません」とダメ出しをします。
            でも、それで続けられる人はどれだけいるでしょうか？
          </p>
          <p className="text-lg leading-relaxed mb-8" style={{ color: colors.textLight }}>
            私たちは「褒める」ことにこだわります。
            「彩りが素敵！」「タンパク質バッチリ！」
            良いところを見つけて褒めることで、食事が楽しくなる。
            楽しいから続けられる。続けられるから、健康になれる。
          </p>
          <p className="text-xl font-bold" style={{ color: colors.primary }}>
            「褒める」ことで、すべての人が健康的な食生活を<br />
            楽しく続けられる世界をつくる。
          </p>
        </div>
      </section>

      {/* CTA */}
      <section className="py-16 md:py-24">
        <div className="container mx-auto px-4 text-center">
          <h2 className="text-3xl md:text-4xl font-bold mb-6" style={{ color: colors.text }}>
            今日から始めてみませんか？
          </h2>
          <p className="mb-8" style={{ color: colors.textLight }}>
            まずは3日間、写真を撮ってみてください。<br />
            食事が変わる感覚を、きっと実感できるはずです。
          </p>
          <Link href="/signup">
            <motion.button
              className="px-8 py-4 rounded-full font-bold text-white inline-flex items-center gap-2"
              style={{ background: colors.primary }}
              whileHover={{ scale: 1.03 }}
              whileTap={{ scale: 0.98 }}
            >
              <Sparkles size={20} />
              無料で始める
              <ArrowRight size={18} />
            </motion.button>
          </Link>
          <div className="flex justify-center gap-6 mt-6 text-sm" style={{ color: colors.textMuted }}>
            <span>✓ 30秒で登録</span>
            <span>✓ カード不要</span>
            <span>✓ いつでも解約OK</span>
          </div>
        </div>
      </section>

      {/* フッター */}
      <footer className="py-8 border-t" style={{ background: colors.card, borderColor: colors.border }}>
        <div className="container mx-auto px-4 text-center">
          <p className="text-sm" style={{ color: colors.textMuted }}>© 2025 ほめゴハン All rights reserved.</p>
        </div>
      </footer>
    </div>
  );
}

