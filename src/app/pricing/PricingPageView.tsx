"use client";

/**
 * /pricing の見た目 (billing/01 §10.1・billing/03 §10.1)。page.tsx (Server Component) が公開のプランと、アプリの WebView で開いたか (is_native_app) を渡す。
 * この部品は Supabase も Cookie も読まない。
 *
 * - 公開のプラン (listPublicPlans) ごとに有料のカードを 1 枚。カードの中は金額のある間隔 (月額・年額) の金額を常に出し、
 *   CTA は買える間隔 (isPurchasable が真) だけ。買える間隔が 1 つも無いカード (Stripe の Price を入れる前) は CTA を置かない
 * - 読み取りに失敗して 0 件のときはフリーのカードだけ
 * - アプリの WebView (isNativeApp) では有料のカードと注記を描かない (アプリ内に Web の価格・購入の導線を出さない。billing/01 §10.4)
 */

import Link from "next/link";
import { motion } from "framer-motion";
import { Check, Sparkles, Crown, ArrowRight } from "lucide-react";
import { FREE_PLAN_AI_LIMIT_NOTE, FREE_PLAN_FEATURES, PLAN_CATALOG } from "@homegohan/shared";
import {
  BILLING_CHECKOUT_PAGE_PATH,
  BILLING_INTERVALS,
  amountJpyFor,
  isPurchasable,
  type BillingInterval,
  type PublicPlan,
} from "@/lib/billing/core";

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

/** カードが順に出てくるときの 1 枚ごとの遅れ (秒) */
const CARD_DELAY_STEP_SEC = 0.1;

/** 買える間隔ごとの金額の単位と CTA の文 (billing/01 §10.1 の表) */
const INTERVAL_DISPLAY: Readonly<Record<BillingInterval, { unit: string; cta: string }>> = {
  month: { unit: "/ 月（税込）", cta: "月額で始める" },
  year: { unit: "/ 年（税込）", cta: "年額で始める" },
};

/** 有料のカードの下の注記 (Web の Stripe とアプリ内課金。アプリ内課金の価格がストアで違うときの説明を兼ねる。billing/03 §10.1・Q-1) */
const PAID_PLAN_PAYMENT_NOTE =
  "お支払いはクレジットカード (Stripe) のほか、iOS / Android アプリでは App Store / Google Play のアプリ内課金でもお申し込みいただけます。アプリ内課金の価格は各ストアの表示が正となります。";

/** 金額の書き方の言語 (「1,480」のような桁区切り) */
const PRICE_LOCALE = "ja-JP";

/** 確認画面 (/account/billing/checkout) への行き先 */
function checkoutHref(plan: PublicPlan, interval: BillingInterval): string {
  return `${BILLING_CHECKOUT_PAGE_PATH}?plan_key=${encodeURIComponent(plan.plan_key)}&interval=${interval}`;
}

export interface PricingPageViewProps {
  /** 公開のプラン (listPublicPlans。並びは display_order。Price の有無で絞らない) */
  plans: PublicPlan[];
  /** アプリの WebView で開いた (Cookie is_native_app=1) */
  isNativeApp: boolean;
}

export default function PricingPageView({ plans, isNativeApp }: PricingPageViewProps) {
  // 有料のカード = 公開のプランごとに 1 枚。amounts は金額のある間隔 (金額は常に出す)、purchasable は CTA を置く間隔 (Price のある間隔)。
  // 金額が 1 つも無いプランはカードにしない (billing/03 §10.1)
  const cards = plans
    .map((plan) => ({
      plan,
      amounts: BILLING_INTERVALS.filter((interval) => (amountJpyFor(plan, interval) ?? 0) > 0),
      purchasable: BILLING_INTERVALS.filter((interval) => isPurchasable(plan, interval)),
    }))
    .filter(({ amounts }) => amounts.length > 0);
  // アプリの WebView では有料のカードと注記を描かない (billing/01 §10.4)
  const showPaidCards = !isNativeApp && cards.length > 0;

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
        </div>

        {/* プランカード (有料プランのカードを描かないときは、フリーのカード 1 枚を中央に置く) */}
        <div className={`grid gap-6 mx-auto mb-20 ${showPaidCards ? "md:grid-cols-2 max-w-3xl" : "max-w-md"}`}>
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
              </div>
            </div>

            <ul className="space-y-3 mb-6">
              {FREE_PLAN_FEATURES.map((feature) => (
                <li key={feature} className="flex items-center gap-3 text-sm">
                  <Check size={18} style={{ color: colors.success }} />
                  <span style={{ color: colors.textLight }}>{feature}</span>
                </li>
              ))}
            </ul>

            <p className="text-xs leading-relaxed mb-6" style={{ color: colors.textMuted }}>
              {FREE_PLAN_AI_LIMIT_NOTE}
            </p>

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

          {/* 有料プラン (金額のある間隔ごとに金額、CTA は買える間隔だけ。billing/03 §10.1) */}
          {showPaidCards &&
            cards.map(({ plan, amounts, purchasable }, index) => {
              const catalogFeatures = PLAN_CATALOG.find((entry) => entry.plan_key === plan.plan_key)?.features ?? [];
              return (
                <motion.div
                  key={plan.plan_key}
                  className="relative p-6 rounded-3xl flex flex-col"
                  style={{ background: colors.card, border: `1px solid ${colors.border}` }}
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: CARD_DELAY_STEP_SEC * (index + 1) }}
                >
                  <div className="text-center mb-6">
                    <div className="w-14 h-14 mx-auto mb-4 rounded-2xl flex items-center justify-center" style={{ background: `${colors.primary}15`, color: colors.primary }}>
                      <Crown size={24} />
                    </div>
                    <h3 className="text-xl font-bold mb-1" style={{ color: colors.text }}>{plan.display_name}</h3>
                    {plan.trial_days > 0 && (
                      <p className="text-sm" style={{ color: colors.textMuted }}>{plan.trial_days}日間無料</p>
                    )}
                  </div>

                  {catalogFeatures.length > 0 && (
                    <ul className="space-y-3 mb-6">
                      {catalogFeatures.map((feature) => (
                        <li key={feature} className="flex items-center gap-3 text-sm">
                          <Check size={18} style={{ color: colors.success }} />
                          <span style={{ color: colors.textLight }}>{feature}</span>
                        </li>
                      ))}
                    </ul>
                  )}

                  <div className="space-y-4 mt-auto">
                    {amounts.map((interval) => {
                      const amount = amountJpyFor(plan, interval) ?? 0;
                      return (
                        <div key={interval} className="space-y-2">
                          <div className="flex items-baseline justify-center gap-1">
                            <span className="text-3xl font-bold" style={{ color: colors.text }}>¥{amount.toLocaleString(PRICE_LOCALE)}</span>
                            <span className="text-sm" style={{ color: colors.textMuted }}>{INTERVAL_DISPLAY[interval].unit}</span>
                          </div>
                          {purchasable.includes(interval) && (
                            <Link
                              href={checkoutHref(plan, interval)}
                              className="block w-full py-3 rounded-full font-bold text-sm text-center text-white"
                              style={{ background: colors.primary }}
                            >
                              {INTERVAL_DISPLAY[interval].cta}
                            </Link>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </motion.div>
              );
            })}
        </div>

        {/* お支払いの方法の注記 (有料のカードを描くときだけ。アプリ内課金の価格はストアの表示が正。billing/03 §10.1・Q-1) */}
        {showPaidCards && (
          <p className="max-w-3xl mx-auto -mt-12 mb-8 text-xs leading-relaxed text-center" style={{ color: colors.textMuted }}>
            {PAID_PLAN_PAYMENT_NOTE}
          </p>
        )}

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
