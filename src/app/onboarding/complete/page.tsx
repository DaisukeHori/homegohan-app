"use client";

import Link from "next/link";
import { motion } from "framer-motion";

export default function OnboardingCompletePage() {
  return (
    <div className="min-h-screen bg-gradient-to-b from-orange-50 to-white flex flex-col items-center justify-center px-4 sm:px-6 lg:px-8 py-8 sm:py-12 text-center overflow-hidden relative">

      {/* 背景エフェクト - レスポンシブ対応 */}
      <div className="absolute inset-0 pointer-events-none overflow-hidden">
        <div className="absolute w-[300px] h-[300px] sm:w-[500px] sm:h-[500px] lg:w-[700px] lg:h-[700px] xl:w-[800px] xl:h-[800px] top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-orange-100 rounded-full opacity-30 blur-3xl" />
      </div>

      <motion.div
        initial={{ opacity: 0, scale: 0.9 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.8 }}
        className="relative z-10 max-w-sm sm:max-w-md lg:max-w-lg xl:max-w-xl w-full space-y-6 sm:space-y-8 lg:space-y-10"
      >
        <div className="relative mx-auto w-24 h-24 sm:w-28 sm:h-28 lg:w-32 lg:h-32">
           <motion.div
             initial={{ scale: 0, rotate: -180 }}
             animate={{ scale: 1, rotate: 0 }}
             transition={{ type: "spring", stiffness: 100, delay: 0.2 }}
             className="w-full h-full rounded-full bg-gradient-to-tr from-[#FF8A65] to-[#FFAB91] flex items-center justify-center text-white text-3xl sm:text-4xl shadow-2xl"
           >
             ✨
           </motion.div>
           <motion.div
             initial={{ scale: 0 }}
             animate={{ scale: [1, 1.2, 1] }}
             transition={{ repeat: Infinity, duration: 2 }}
             className="absolute inset-0 rounded-full border-4 border-[#FF8A65]/30"
           />
        </div>

        <div className="space-y-3 sm:space-y-4">
          <motion.h1
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.4 }}
            className="text-2xl sm:text-3xl lg:text-4xl font-bold text-gray-900"
          >
            準備完了！
          </motion.h1>
          <motion.p
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.6 }}
            className="text-gray-500 text-base sm:text-lg leading-relaxed"
          >
            あなたのためのAIパートナーが<br/>
            準備完了しました。
          </motion.p>
        </div>

        {/* 疑似的なパラメータチャート */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.8 }}
          className="bg-white/80 backdrop-blur border border-gray-100 rounded-2xl sm:rounded-3xl p-4 sm:p-6 shadow-xl"
        >
          <div className="space-y-3 sm:space-y-4">
            {[
              { label: 'モチベーション', value: '100%' },
              { label: '栄養プラン', value: '最適化済み' },
              { label: 'AIパートナー', value: '稼働中' },
            ].map((item, i) => (
              <div key={i} className="flex items-center justify-between border-b border-gray-50 pb-2 last:border-0 last:pb-0">
                <span className="text-xs sm:text-sm font-bold text-gray-400">{item.label}</span>
                <span className="text-base sm:text-lg font-bold text-[#FF8A65]">{item.value}</span>
              </div>
            ))}
          </div>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 1.0 }}
          className="text-center"
        >
          <Link
            href="/profile/nutrition-targets"
            className="text-sm text-orange-500 hover:text-orange-600 underline underline-offset-2"
          >
            栄養プランの根拠を見る（任意）
          </Link>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 1.2 }}
        >
          <Link
            href="/home"
            className="inline-flex items-center justify-center w-full py-4 sm:py-5 lg:py-6 rounded-full bg-[#333] hover:bg-black text-white font-bold text-base sm:text-lg shadow-xl hover:shadow-2xl transition-all duration-300 hover:scale-105"
          >
            ダッシュボードへ移動
          </Link>
        </motion.div>

      </motion.div>
    </div>
  );
}
