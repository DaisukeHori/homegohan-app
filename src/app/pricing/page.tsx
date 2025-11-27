"use client";

import { useState } from "react";
import Link from "next/link";
import { motion } from "framer-motion";
import { Check, X, Sparkles, Crown, Zap, ArrowRight, HelpCircle } from "lucide-react";

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

const plans = [
  {
    name: "フリー",
    price: "¥0",
    period: "永久無料",
    description: "まずは試してみたい方に",
    icon: <Sparkles size={24} />,
    color: colors.success,
    features: [
      { name: "写真で食事記録", included: true },
      { name: "AI栄養分析", included: true },
      { name: "AIコメント（褒める）", included: true },
      { name: "1日3食まで記録", included: true },
      { name: "週間レポート", included: true },
      { name: "バッジ収集", included: true },
      { name: "献立提案", included: "週1回" },
      { name: "健康記録", included: true },
      { name: "過去データ閲覧", included: "30日分" },
      { name: "広告表示", included: "あり" },
    ],
    cta: "無料で始める",
    popular: false,
  },
  {
    name: "プレミアム",
    price: "¥980",
    period: "/月",
    description: "本気で食生活を改善したい方に",
    icon: <Crown size={24} />,
    color: colors.primary,
    features: [
      { name: "写真で食事記録", included: true },
      { name: "AI栄養分析", included: true },
      { name: "AIコメント（褒める）", included: true },
      { name: "無制限に記録", included: true },
      { name: "週間レポート", included: true },
      { name: "バッジ収集", included: true },
      { name: "献立提案", included: "無制限" },
      { name: "健康記録", included: true },
      { name: "過去データ閲覧", included: "無制限" },
      { name: "広告表示", included: "なし" },
      { name: "優先サポート", included: true },
      { name: "家族共有（5人まで）", included: true },
      { name: "詳細栄養レポート", included: true },
      { name: "カスタム目標設定", included: true },
    ],
    cta: "プレミアムを始める",
    popular: true,
  },
  {
    name: "ファミリー",
    price: "¥1,980",
    period: "/月",
    description: "家族みんなの健康管理に",
    icon: <Zap size={24} />,
    color: colors.secondary,
    features: [
      { name: "プレミアム全機能", included: true },
      { name: "家族10人まで", included: true },
      { name: "家族間データ共有", included: true },
      { name: "子供用モード", included: true },
      { name: "高齢者用モード", included: true },
      { name: "家族レポート", included: true },
      { name: "栄養士相談（月1回）", included: true },
    ],
    cta: "ファミリーを始める",
    popular: false,
  },
];

const faqs = [
  { q: "無料プランはいつまで使えますか？", a: "永久無料です！基本機能は今後も無料でご利用いただけます。課金を強制することは一切ありません。" },
  { q: "途中でプラン変更できますか？", a: "はい、いつでも変更可能です。アップグレードは即時反映、ダウングレードは次回更新日から適用されます。" },
  { q: "解約はいつでもできますか？", a: "はい、いつでも解約できます。解約後も次回更新日まではプレミアム機能をご利用いただけます。" },
  { q: "支払い方法は？", a: "クレジットカード（Visa、Mastercard、JCB、American Express）に対応しています。" },
];

export default function PricingPage() {
  const [billingPeriod, setBillingPeriod] = useState<'monthly' | 'yearly'>('monthly');

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
            まずは無料で始めて、必要に応じてアップグレード。<br />
            いつでも解約できるので安心です。
          </p>
        </div>

        {/* 期間切り替え */}
        <div className="flex justify-center mb-12">
          <div className="inline-flex p-1 rounded-full" style={{ background: colors.bgAlt }}>
            <button
              onClick={() => setBillingPeriod('monthly')}
              className="px-6 py-2 rounded-full text-sm font-medium transition-all"
              style={{ 
                background: billingPeriod === 'monthly' ? colors.card : 'transparent',
                color: billingPeriod === 'monthly' ? colors.text : colors.textMuted,
                boxShadow: billingPeriod === 'monthly' ? '0 2px 8px rgba(0,0,0,0.08)' : 'none'
              }}
            >
              月払い
            </button>
            <button
              onClick={() => setBillingPeriod('yearly')}
              className="px-6 py-2 rounded-full text-sm font-medium transition-all flex items-center gap-2"
              style={{ 
                background: billingPeriod === 'yearly' ? colors.card : 'transparent',
                color: billingPeriod === 'yearly' ? colors.text : colors.textMuted,
                boxShadow: billingPeriod === 'yearly' ? '0 2px 8px rgba(0,0,0,0.08)' : 'none'
              }}
            >
              年払い
              <span className="px-2 py-0.5 rounded-full text-xs font-bold" style={{ background: colors.successLight, color: colors.success }}>2ヶ月分お得</span>
            </button>
          </div>
        </div>

        {/* プランカード */}
        <div className="grid md:grid-cols-3 gap-6 max-w-5xl mx-auto mb-20">
          {plans.map((plan, i) => (
            <motion.div
              key={i}
              className="relative p-6 rounded-3xl"
              style={{ 
                background: colors.card, 
                border: plan.popular ? `2px solid ${colors.primary}` : `1px solid ${colors.border}`,
              }}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.1 }}
            >
              {plan.popular && (
                <div className="absolute -top-3 left-1/2 -translate-x-1/2 px-4 py-1 rounded-full text-xs font-bold text-white" style={{ background: colors.primary }}>
                  人気No.1
                </div>
              )}

              <div className="text-center mb-6">
                <div className="w-14 h-14 mx-auto mb-4 rounded-2xl flex items-center justify-center" style={{ background: `${plan.color}15`, color: plan.color }}>
                  {plan.icon}
                </div>
                <h3 className="text-xl font-bold mb-1" style={{ color: colors.text }}>{plan.name}</h3>
                <p className="text-sm mb-4" style={{ color: colors.textMuted }}>{plan.description}</p>
                <div className="flex items-baseline justify-center gap-1">
                  <span className="text-4xl font-bold" style={{ color: colors.text }}>
                    {billingPeriod === 'yearly' && plan.price !== '¥0' 
                      ? `¥${Math.floor(parseInt(plan.price.replace('¥', '').replace(',', '')) * 10)}`
                      : plan.price}
                  </span>
                  <span className="text-sm" style={{ color: colors.textMuted }}>
                    {plan.price === '¥0' ? plan.period : billingPeriod === 'yearly' ? '/年' : plan.period}
                  </span>
                </div>
                {billingPeriod === 'yearly' && plan.price !== '¥0' && (
                  <p className="text-xs mt-1" style={{ color: colors.success }}>年払いで2ヶ月分お得！</p>
                )}
              </div>

              <ul className="space-y-3 mb-6">
                {plan.features.map((feature, j) => (
                  <li key={j} className="flex items-center gap-3 text-sm">
                    {feature.included === true ? (
                      <Check size={18} style={{ color: colors.success }} />
                    ) : feature.included === false ? (
                      <X size={18} style={{ color: colors.textMuted }} />
                    ) : (
                      <Check size={18} style={{ color: colors.success }} />
                    )}
                    <span style={{ color: feature.included ? colors.textLight : colors.textMuted }}>
                      {feature.name}
                      {typeof feature.included === 'string' && (
                        <span className="ml-1 text-xs px-1.5 py-0.5 rounded" style={{ background: colors.bgAlt, color: colors.textMuted }}>
                          {feature.included}
                        </span>
                      )}
                    </span>
                  </li>
                ))}
              </ul>

              <Link href="/signup">
                <motion.button
                  className="w-full py-3 rounded-full font-bold text-sm"
                  style={{ 
                    background: plan.popular ? colors.primary : colors.bgAlt,
                    color: plan.popular ? 'white' : colors.text
                  }}
                  whileHover={{ scale: 1.02 }}
                  whileTap={{ scale: 0.98 }}
                >
                  {plan.cta}
                </motion.button>
              </Link>
            </motion.div>
          ))}
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

