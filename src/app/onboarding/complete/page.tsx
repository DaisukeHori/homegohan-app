"use client";

import Link from "next/link";
import { motion } from "framer-motion";
import { NutritionTargetPlanner } from "@/components/nutrition/nutrition-target-planner";

export default function OnboardingCompletePage() {
  return (
    <div className="min-h-screen bg-[linear-gradient(180deg,_#fff3ec_0%,_#fffaf7_35%,_#ffffff_100%)] px-4 py-8 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-6xl">
        <motion.div
          initial={{ opacity: 0, y: 18 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
          className="mb-8 overflow-hidden rounded-[36px] border border-orange-100 bg-white/80 p-8 shadow-sm backdrop-blur"
        >
          <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.3em] text-orange-500">Ready</p>
              <h1 className="mt-3 text-3xl font-bold text-gray-900 sm:text-4xl">
                栄養設計まで完了しました
              </h1>
              <p className="mt-3 max-w-2xl text-sm leading-7 text-gray-600 sm:text-base">
                ここで自動計算の根拠を確認して、そのまま始めるか、自分の感覚に合わせて目標カロリーを微調整できます。
                後から設定画面から何度でも見直せます。
              </p>
            </div>

            <div className="rounded-[28px] bg-[#1f1f1f] px-5 py-4 text-white shadow-lg">
              <p className="text-xs uppercase tracking-[0.2em] text-white/60">Onboarding</p>
              <p className="mt-2 text-2xl font-bold">最後の確認</p>
              <p className="mt-1 text-sm text-white/70">このまま保存してすぐ使えます</p>
            </div>
          </div>
        </motion.div>

        <NutritionTargetPlanner mode="onboarding" />

        <div className="mt-8 flex flex-col gap-3 sm:flex-row">
          <Link
            href="/home"
            className="inline-flex w-full items-center justify-center rounded-full bg-[#222] px-6 py-4 text-sm font-bold text-white transition-colors hover:bg-black sm:w-auto"
          >
            この設定で始める
          </Link>
          <Link
            href="/profile/nutrition-targets"
            className="inline-flex w-full items-center justify-center rounded-full border border-orange-200 bg-white px-6 py-4 text-sm font-semibold text-orange-600 transition-colors hover:bg-orange-50 sm:w-auto"
          >
            後でじっくり見直す
          </Link>
        </div>
      </div>
    </div>
  );
}
