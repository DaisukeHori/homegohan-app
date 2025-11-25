"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";
import { motion } from "framer-motion";

export default function OnboardingCompletePage() {
  return (
    <div className="min-h-screen bg-white flex flex-col items-center justify-center p-6 text-center overflow-hidden relative">
      
      {/* 背景エフェクト */}
      <div className="absolute inset-0 pointer-events-none">
        <div className="blob-shape bg-orange-100 w-[800px] h-[800px] top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 opacity-30" />
      </div>

      <motion.div
        initial={{ opacity: 0, scale: 0.9 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.8 }}
        className="relative z-10 max-w-lg w-full space-y-10"
      >
        <div className="relative mx-auto w-32 h-32">
           <motion.div 
             initial={{ scale: 0, rotate: -180 }}
             animate={{ scale: 1, rotate: 0 }}
             transition={{ type: "spring", stiffness: 100, delay: 0.2 }}
             className="w-full h-full rounded-full bg-gradient-to-tr from-[#FF8A65] to-[#FFAB91] flex items-center justify-center text-white text-4xl shadow-2xl"
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

        <div className="space-y-4">
          <motion.h1 
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.4 }}
            className="text-3xl md:text-4xl font-bold text-gray-900"
          >
            All Set!
          </motion.h1>
          <motion.p 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.6 }}
            className="text-gray-500 text-lg leading-relaxed"
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
          className="bg-white/80 backdrop-blur border border-gray-100 rounded-3xl p-6 shadow-xl"
        >
          <div className="space-y-4">
            {[
              { label: 'Motivation', value: '100%' },
              { label: 'Nutrition Plan', value: 'Optimized' },
              { label: 'AI Partner', value: 'Active' },
            ].map((item, i) => (
              <div key={i} className="flex items-center justify-between border-b border-gray-50 pb-2 last:border-0 last:pb-0">
                <span className="text-sm font-bold text-gray-400">{item.label}</span>
                <span className="text-lg font-bold text-[#FF8A65]">{item.value}</span>
              </div>
            ))}
          </div>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 1.2 }}
        >
          <Button 
            asChild
            className="w-full py-6 rounded-full bg-[#333] hover:bg-black text-white font-bold text-lg shadow-xl hover:shadow-2xl transition-all duration-300 hover:scale-105"
          >
            <Link href="/home">ダッシュボードへ移動</Link>
          </Button>
        </motion.div>

      </motion.div>
    </div>
  );
}
