"use client";

import Link from "next/link";
import { motion } from "framer-motion";
import { ArrowLeft, Camera, Brain, Target, Users, Heart, Sparkles } from "lucide-react";

const colors = {
  bg: '#FAF9F7',
  card: '#FFFFFF',
  text: '#1A1A1A',
  textLight: '#4A4A4A',
  textMuted: '#9A9A9A',
  accent: '#E07A5F',
  accentLight: '#FDF0ED',
};

const features = [
  {
    icon: Camera,
    title: '写真で簡単記録',
    description: '食事の写真を撮るだけで、AIが自動で料理を認識し、カロリーや栄養素を推定します。面倒な手入力は不要です。',
  },
  {
    icon: Brain,
    title: 'AIによる献立提案',
    description: 'あなたの好み、健康状態、冷蔵庫の食材を考慮して、最適な献立をAIが提案。毎日の「何作ろう？」を解決します。',
  },
  {
    icon: Target,
    title: 'パーソナライズ栄養管理',
    description: '年齢、体重、活動量、健康目標に基づいて、あなただけの栄養目標を設定。無理なく続けられる健康管理を実現します。',
  },
  {
    icon: Heart,
    title: '健康記録＆分析',
    description: '体重、体脂肪、血圧などの健康データを記録し、AIが傾向を分析。健康状態の変化を可視化してアドバイスします。',
  },
  {
    icon: Users,
    title: '家族みんなで使える',
    description: '家族の人数に合わせた分量計算、それぞれの好き嫌いやアレルギーにも対応。家族全員の健康をサポートします。',
  },
  {
    icon: Sparkles,
    title: 'ゲーミフィケーション',
    description: '継続記録でバッジを獲得、チャレンジに挑戦してポイントをゲット。楽しみながら健康習慣を身につけられます。',
  },
];

const stats = [
  { value: '10万+', label: '登録ユーザー' },
  { value: '500万+', label: '記録された食事' },
  { value: '98%', label: '継続率' },
];

export default function AboutPage() {
  return (
    <div className="min-h-screen pb-24" style={{ backgroundColor: colors.bg }}>
      {/* ヘッダー */}
      <div className="sticky top-0 z-10 px-4 py-4" style={{ backgroundColor: colors.bg }}>
        <div className="flex items-center">
          <Link href="/home" className="p-2 -ml-2">
            <ArrowLeft size={24} style={{ color: colors.text }} />
          </Link>
          <h1 className="font-bold ml-2" style={{ color: colors.text }}>ほめゴハンについて</h1>
        </div>
      </div>

      {/* ヒーローセクション */}
      <div className="px-6 py-8 text-center">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="mb-6"
        >
          <div 
            className="w-20 h-20 rounded-2xl mx-auto mb-4 flex items-center justify-center text-3xl font-bold text-white shadow-lg"
            style={{ backgroundColor: colors.accent }}
          >
            H
          </div>
          <h2 className="text-2xl font-bold mb-2" style={{ color: colors.text }}>
            ほめゴハン
          </h2>
          <p className="text-sm" style={{ color: colors.textMuted }}>
            撮るだけで分かる。食べ方から、パフォーマンスを底上げ。
          </p>
        </motion.div>

        <motion.p
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1 }}
          className="text-sm leading-relaxed"
          style={{ color: colors.textLight }}
        >
          ほめゴハンは、AIの力で毎日の食事管理を簡単にするアプリです。
          写真を撮るだけで栄養を記録し、あなたに最適な献立を提案。
          健康的な食生活を、もっと手軽に、もっと楽しく。
        </motion.p>
      </div>

      {/* 統計セクション */}
      <div className="px-6 mb-8">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.2 }}
          className="grid grid-cols-3 gap-4"
        >
          {stats.map((stat, i) => (
            <div 
              key={i}
              className="p-4 rounded-2xl text-center"
              style={{ backgroundColor: colors.card }}
            >
              <p className="text-xl font-bold" style={{ color: colors.accent }}>
                {stat.value}
              </p>
              <p className="text-xs" style={{ color: colors.textMuted }}>
                {stat.label}
              </p>
            </div>
          ))}
        </motion.div>
      </div>

      {/* 機能セクション */}
      <div className="px-6 mb-8">
        <h3 className="font-bold mb-4" style={{ color: colors.text }}>
          主な機能
        </h3>
        <div className="space-y-4">
          {features.map((feature, i) => {
            const Icon = feature.icon;
            return (
              <motion.div
                key={i}
                initial={{ opacity: 0, x: -20 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: 0.1 * i }}
                className="p-4 rounded-2xl flex gap-4"
                style={{ backgroundColor: colors.card }}
              >
                <div 
                  className="w-12 h-12 rounded-xl flex items-center justify-center flex-shrink-0"
                  style={{ backgroundColor: colors.accentLight }}
                >
                  <Icon size={24} style={{ color: colors.accent }} />
                </div>
                <div>
                  <p className="font-semibold mb-1" style={{ color: colors.text }}>
                    {feature.title}
                  </p>
                  <p className="text-sm" style={{ color: colors.textMuted }}>
                    {feature.description}
                  </p>
                </div>
              </motion.div>
            );
          })}
        </div>
      </div>

      {/* ミッションセクション */}
      <div className="px-6 mb-8">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.5 }}
          className="p-6 rounded-2xl"
          style={{ backgroundColor: colors.accentLight }}
        >
          <h3 className="font-bold mb-3" style={{ color: colors.accent }}>
            私たちのミッション
          </h3>
          <p className="text-sm leading-relaxed" style={{ color: colors.textLight }}>
            「食」は人生の基盤です。私たちは、テクノロジーの力で、
            誰もが手軽に健康的な食生活を送れる世界を目指しています。
            AIによる自動化と、ユーザーに寄り添ったパーソナライズで、
            食事管理の負担を軽減し、健康づくりを楽しいものに変えていきます。
          </p>
        </motion.div>
      </div>

      {/* CTAセクション */}
      <div className="px-6">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.6 }}
          className="text-center"
        >
          <Link
            href="/signup"
            className="inline-block px-8 py-4 rounded-full font-bold text-white shadow-lg"
            style={{ backgroundColor: colors.accent }}
          >
            今すぐ始める
          </Link>
          <p className="text-xs mt-3" style={{ color: colors.textMuted }}>
            無料で始められます
          </p>
        </motion.div>
      </div>

      {/* フッター */}
      <div className="px-6 mt-12 pt-6 border-t" style={{ borderColor: '#EEEEEE' }}>
        <div className="flex justify-center gap-6 text-sm" style={{ color: colors.textMuted }}>
          <Link href="/terms" className="hover:underline">利用規約</Link>
          <Link href="/privacy" className="hover:underline">プライバシー</Link>
          <Link href="/contact" className="hover:underline">お問い合わせ</Link>
        </div>
        <p className="text-center text-xs mt-4" style={{ color: colors.textMuted }}>
          © 2024 ほめゴハン. All rights reserved.
        </p>
      </div>
    </div>
  );
}

