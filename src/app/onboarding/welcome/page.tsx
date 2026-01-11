"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { motion } from "framer-motion";

// 初回ウェルカム画面 (OB-UI-03)
export default function OnboardingWelcomePage() {
  const router = useRouter();
  const [isSkipping, setIsSkipping] = useState(false);

  const handleSkip = async () => {
    if (isSkipping) return;
    setIsSkipping(true);
    try {
      // オンボーディングを完了としてマークしてからリダイレクト
      await fetch('/api/onboarding/complete', { method: 'POST' });
      router.push('/home');
    } catch (error) {
      console.error('Failed to skip onboarding:', error);
      // エラーでもホームに遷移
      router.push('/home');
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-b from-orange-50 to-white flex flex-col items-center justify-center px-4 sm:px-6 lg:px-8 py-8 sm:py-12 text-center overflow-hidden relative">

      {/* 背景エフェクト */}
      <div className="absolute inset-0 pointer-events-none overflow-hidden">
        <div className="absolute w-[300px] h-[300px] sm:w-[500px] sm:h-[500px] lg:w-[700px] lg:h-[700px] top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-orange-100 rounded-full opacity-30 blur-3xl" />
      </div>

      <motion.div
        initial={{ opacity: 0, scale: 0.9 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.8 }}
        className="relative z-10 max-w-sm sm:max-w-md lg:max-w-lg xl:max-w-xl w-full space-y-6 sm:space-y-8 lg:space-y-10"
      >
        {/* アイコン */}
        <div className="relative mx-auto w-24 h-24 sm:w-28 sm:h-28 lg:w-32 lg:h-32">
          <motion.div
            initial={{ scale: 0, rotate: -180 }}
            animate={{ scale: 1, rotate: 0 }}
            transition={{ type: "spring", stiffness: 100, delay: 0.2 }}
            className="w-full h-full rounded-full bg-gradient-to-tr from-[#FF8A65] to-[#FFAB91] flex items-center justify-center text-white text-3xl sm:text-4xl shadow-2xl"
          >
            🍳
          </motion.div>
          <motion.div
            initial={{ scale: 0 }}
            animate={{ scale: [1, 1.2, 1] }}
            transition={{ repeat: Infinity, duration: 2 }}
            className="absolute inset-0 rounded-full border-4 border-[#FF8A65]/30"
          />
        </div>

        {/* タイトル */}
        <div className="space-y-3 sm:space-y-4">
          <motion.h1
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.4 }}
            className="text-2xl sm:text-3xl lg:text-4xl font-bold text-gray-900"
          >
            はじめまして！
          </motion.h1>
          <motion.p
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.6 }}
            className="text-gray-500 text-base sm:text-lg leading-relaxed"
          >
            私はあなたの食生活をサポートする<br />
            AI栄養士「ほめゴハン」です。
          </motion.p>
        </div>

        {/* 説明カード */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.8 }}
          className="bg-white/80 backdrop-blur border border-gray-100 rounded-2xl sm:rounded-3xl p-4 sm:p-6 shadow-xl"
        >
          <div className="space-y-3 sm:space-y-4">
            <p className="text-sm sm:text-base text-gray-600 leading-relaxed">
              あなたに最適な食事プランを作成するため、<br />
              いくつか質問させてください。
            </p>
            <div className="flex items-center justify-center gap-2 text-xs sm:text-sm text-gray-400">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <span>所要時間: 約3〜5分</span>
            </div>
          </div>
        </motion.div>

        {/* ボタン */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 1.0 }}
        >
          <Link
            href="/onboarding/questions"
            className="inline-flex items-center justify-center w-full py-4 sm:py-5 lg:py-6 rounded-full bg-[#333] hover:bg-black text-white font-bold text-base sm:text-lg shadow-xl hover:shadow-2xl transition-all duration-300 hover:scale-105"
          >
            はじめる
          </Link>
        </motion.div>

        {/* スキップリンク */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 1.2 }}
        >
          <button
            onClick={handleSkip}
            disabled={isSkipping}
            className="text-sm text-gray-400 hover:text-gray-600 transition-colors disabled:opacity-50"
          >
            {isSkipping ? 'しばらくお待ちください...' : 'あとで設定する'}
          </button>
        </motion.div>

      </motion.div>
    </div>
  );
}
