"use client";

import { useState } from "react";
import Link from "next/link";
import { motion } from "framer-motion";
import { ChevronDown, ArrowRight } from "lucide-react";
import { GUIDES } from "./guide-content";
import { GuideStepImage } from "./GuideStepImage";

const colors = {
  primary: '#E07A5F',
  primaryLight: '#FDF0ED',
  secondary: '#3D5A80',
  secondaryLight: '#E8EEF4',
  success: '#6B9B6B',
  successLight: '#EDF5ED',
  warning: '#F4A261',
  warningLight: '#FEF6EE',
  bg: '#FAF9F7',
  bgAlt: '#F5F3EF',
  card: '#FFFFFF',
  text: '#1A1A1A',
  textLight: '#4A4A4A',
  textMuted: '#8A8A8A',
  border: '#E8E8E8',
};

// #1867 (公開の主張の見直し): 撮り方のコツは、確かめていない認識の良し悪し (「自然光で認識精度がアップ」) を約束しない
const tips = [
  { icon: '💡', title: '写真は明るい場所で', desc: '明るい場所で撮ると、料理がはっきり写ります。' },
  { icon: '📱', title: '食事全体を写す', desc: '一部だけでなく、お皿全体が写るように。' },
  { icon: '⏰', title: '食べる前に撮る', desc: '食べ始める前に撮影するのがおすすめ。' },
  { icon: '🎯', title: '毎日続ける', desc: '完璧じゃなくてOK。継続が大切です。' },
];

export default function GuidePage() {
  const [activeGuide, setActiveGuide] = useState('start');
  const [expandedStep, setExpandedStep] = useState<number | null>(0);

  const currentGuide = GUIDES.find(g => g.id === activeGuide);

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
      <main className="container mx-auto px-4 py-12">
        {/* タイトル */}
        <div className="text-center max-w-2xl mx-auto mb-12">
          <h1 className="text-4xl md:text-5xl font-bold mb-4" style={{ color: colors.text }}>
            📚 <span style={{ color: colors.primary }}>使い方ガイド</span>
          </h1>
          <p className="text-lg" style={{ color: colors.textLight }}>
            ほめゴハンの使い方をわかりやすく解説します。<br />
            初めての方はまず「はじめかた」から読んでみてください。
          </p>
        </div>

        <div className="grid lg:grid-cols-4 gap-8 max-w-6xl mx-auto">
          {/* サイドナビ */}
          <div className="lg:col-span-1">
            <div className="sticky top-24 space-y-2">
              {GUIDES.map((guide) => (
                <button
                  key={guide.id}
                  onClick={() => { setActiveGuide(guide.id); setExpandedStep(0); }}
                  className="w-full p-4 rounded-2xl text-left flex items-center gap-3 transition-all"
                  style={{ 
                    background: activeGuide === guide.id ? colors.card : 'transparent',
                    boxShadow: activeGuide === guide.id ? '0 2px 12px rgba(0,0,0,0.06)' : 'none',
                    border: activeGuide === guide.id ? `1px solid ${colors.border}` : '1px solid transparent'
                  }}
                >
                  <div className="w-10 h-10 rounded-xl flex items-center justify-center" style={{ background: `${guide.color}15`, color: guide.color }}>
                    <guide.Icon size={24} />
                  </div>
                  <span className="font-medium" style={{ color: activeGuide === guide.id ? colors.text : colors.textLight }}>
                    {guide.title}
                  </span>
                </button>
              ))}
            </div>
          </div>

          {/* コンテンツ */}
          <div className="lg:col-span-3">
            {currentGuide && (
              <motion.div
                key={currentGuide.id}
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.3 }}
              >
                <div className="p-6 rounded-3xl mb-8" style={{ background: colors.card, border: `1px solid ${colors.border}` }}>
                  <div className="flex items-center gap-4 mb-6">
                    <div className="w-14 h-14 rounded-2xl flex items-center justify-center" style={{ background: `${currentGuide.color}15`, color: currentGuide.color }}>
                      <currentGuide.Icon size={24} />
                    </div>
                    <h2 className="text-2xl font-bold" style={{ color: colors.text }}>{currentGuide.title}</h2>
                  </div>

                  <div className="space-y-4">
                    {currentGuide.steps.map((step, i) => (
                      <div
                        key={i}
                        className="rounded-2xl overflow-hidden"
                        style={{ background: colors.bgAlt, border: expandedStep === i ? `2px solid ${currentGuide.color}` : `1px solid ${colors.border}` }}
                      >
                        <button
                          onClick={() => setExpandedStep(expandedStep === i ? null : i)}
                          className="w-full p-4 flex items-center justify-between"
                        >
                          <div className="flex items-center gap-4">
                            <div className="w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold text-white" style={{ background: currentGuide.color }}>
                              {i + 1}
                            </div>
                            <span className="font-bold" style={{ color: colors.text }}>{step.title}</span>
                          </div>
                          <motion.div animate={{ rotate: expandedStep === i ? 180 : 0 }}>
                            <ChevronDown size={20} style={{ color: colors.textMuted }} />
                          </motion.div>
                        </button>
                        
                        {expandedStep === i && (
                          <motion.div
                            initial={{ height: 0, opacity: 0 }}
                            animate={{ height: 'auto', opacity: 1 }}
                            className="px-4 pb-4"
                          >
                            <div className="p-4 rounded-xl" style={{ background: colors.card }}>
                              <p className="text-sm leading-relaxed mb-4" style={{ color: colors.textLight }}>{step.desc}</p>
                              <GuideStepImage key={step.image} src={step.image} alt={step.imageAlt} />
                            </div>
                          </motion.div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              </motion.div>
            )}

            {/* Tips */}
            <div className="p-6 rounded-3xl" style={{ background: colors.warningLight }}>
              <h3 className="font-bold mb-4 flex items-center gap-2" style={{ color: colors.warning }}>
                💡 上手に使うコツ
              </h3>
              <div className="grid sm:grid-cols-2 gap-4">
                {tips.map((tip, i) => (
                  <div key={i} className="p-4 rounded-xl flex items-start gap-3" style={{ background: colors.card }}>
                    <span className="text-2xl">{tip.icon}</span>
                    <div>
                      <p className="font-bold text-sm mb-1" style={{ color: colors.text }}>{tip.title}</p>
                      <p className="text-xs" style={{ color: colors.textLight }}>{tip.desc}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* CTA */}
        <div className="text-center mt-16">
          <p className="text-lg mb-4" style={{ color: colors.textLight }}>使い方はわかりましたか？</p>
          <Link href="/signup">
            <motion.button
              className="px-8 py-4 rounded-full font-bold text-white inline-flex items-center gap-2"
              style={{ background: colors.primary }}
              whileHover={{ scale: 1.03 }}
              whileTap={{ scale: 0.98 }}
            >
              さっそく始める <ArrowRight size={18} />
            </motion.button>
          </Link>
        </div>
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

