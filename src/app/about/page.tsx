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

/**
 * 主な機能。紹介ページ (src/components/marketing/landing-copy.ts の claims) と同じく、製品の根拠のある主張だけを書く (#1867)。
 * - 写真で記録: claims の photo-analyze・ai-estimate (数値は推定なので、「手入力は不要」とは言い切らない)
 * - ほめるひと言: claims の praise・nutrition-tip。写真の記録のコメントは定型の文で、食事の中身を見て良いところを探す文ではない
 * - 献立の提案: 使う情報は /faq「献立提案はどういう基準で作られますか？」と同じ (tests/faq-guide-wording-1859.test.ts が実コードと突き合わせる)
 * - 栄養の目標: src/app/api/nutrition-targets/calculate/route.ts (@homegohan/core の calculateNutritionTargets。
 *   基礎代謝は年齢・身長・体重から、活動量は仕事のスタイルと運動から、配分は目標と持病から)
 * - 健康の記録: 体重・体脂肪率・血圧の記録 (src/app/(main)/health/record/page.tsx) と、健康画面の「AI分析」(src/app/(main)/health/page.tsx)
 * - 家族: claims の family (招待・献立を一緒に見る・記録の共有)。分量の計算は無いので書かない
 * 最上級 (「最適な」)・効果の約束 (「続けられる」「解決します」「実現します」) は書かない
 */
const features = [
  {
    icon: Camera,
    title: '写真で記録',
    description: '食事の写真を撮るだけで、AIが料理を認識し、カロリーや栄養素を推定します。推定の値なので、実際の値と異なる場合があります。',
    color: colors.primary,
  },
  {
    icon: Sparkles,
    title: 'ほめるひと言',
    description: '食事の記録の画面では、写真で記録すると、記録をほめるひと言と栄養のひと言メモが出ます。献立の振り返りでは、AIが良いところを見つけて言葉にします。',
    color: colors.warning,
  },
  {
    icon: Brain,
    title: 'AIによる献立提案',
    description: '目標と栄養の目標をもとに、AIが1週間分の献立を提案します。登録されていれば、アレルギー・苦手な食材・好み・健康診断の結果・冷蔵庫の食材も考慮します。',
    color: colors.secondary,
  },
  {
    icon: Target,
    title: 'あなたの栄養の目標',
    description: '年齢・身長・体重・仕事のスタイルや運動・目標などから、あなたの1日の栄養の目標を計算します。',
    color: colors.success,
  },
  {
    icon: Heart,
    title: '健康の記録',
    description: '体重・体脂肪率・血圧などを記録して、推移をグラフで見られます。健康画面の「AI分析」では、AIが気づきを教えてくれます。',
    color: colors.primary,
  },
  {
    icon: Users,
    title: '家族で使える',
    description: '家族を招待して、献立を一緒に見たり、記録を共有したりできます。',
    color: colors.warning,
  },
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
              写真を撮るだけで、AIが料理を認識して栄養を推定します。<br />
              食事の記録の画面では、写真で記録すると、<br />
              記録をほめるひと言が出ます。
            </p>
          </motion.div>
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
          {/* #1867: 他のアプリについての根拠の無い比較と、写真の記録のコメントが食事の中身を見て褒めるかのような例 (「彩りが素敵！」)・
              健康上の効果の約束 (「健康になれる」) をやめ、実際にあることだけを書く */}
          <p className="text-lg leading-relaxed mb-8" style={{ color: colors.textLight }}>
            私たちは「褒める」ことにこだわります。
            食事の記録の画面では、写真で記録すると、記録をほめるひと言が出ます。
            献立の振り返りでは、AIが良いところを見つけて言葉にします。
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
            まずは3日、写真で記録してみてください。<br />
            食事の記録の画面に、記録をほめるひと言が出ます。
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
            <span>✓ カード不要</span>
            <span>✓ いつでも退会OK</span>
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

