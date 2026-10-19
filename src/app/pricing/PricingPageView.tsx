"use client";

/**
 * /pricing の見た目 (billing/01 §10.1)。page.tsx (Server Component) が「買えるプラン」と、アプリの WebView で開いたか (is_native_app) を渡す。
 * この部品は Supabase も Cookie も読まない。
 *
 * - 買えるプランが 0 件 → フリーのカードだけ (案内の段落・FAQ)。有料プランのカードは出さない (#1911: 未完成のものを「準備中」と出さない)
 * - 1 件以上 → 買えるプランごとにカードを 1 枚。カードの中は買える間隔 (isPurchasable が真) ごとに 1 行ずつ、金額と CTA
 *   (買えない間隔は金額も CTA も出さない。間隔の切替は置かない)
 * - アプリの WebView (isNativeApp) では有料プランのカードと CTA を描かない (アプリ内に価格・購入の導線を出さない。§10.4)
 */

import Link from "next/link";
import { motion } from "framer-motion";
import { Check, Sparkles, Crown, ArrowRight, HelpCircle } from "lucide-react";
import {
  BILLING_CHECKOUT_PAGE_PATH,
  BILLING_INTERVALS,
  amountJpyFor,
  isPurchasable,
  type BillingInterval,
  type PurchasablePlan,
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

// 現在ご利用いただける機能。実際にある機能だけを載せ、紹介ページ (src/components/marketing/landing-copy.ts の claims) と同じ言い方にする (#1867)。
// - 写真の記録のコメントは定型の文 (supabase/functions/_shared/nutrition-pipeline.ts の buildTemplatePraiseAndTip) なので、
//   AI が書くコメントのようには書かず、食事の記録の画面の見出し「記録コメント」で言う (claims の praise の行)
// - 週ごとのレポートの機能は無い (API も画面も無い) ので載せない
// - 期間の上限・広告など、実際には無い制限は書かない。実際にある制限は、AI を使う機能の 1 日の利用回数の上限 (#1149) だけで、
//   それは AI_DAILY_LIMIT_NOTE で書く
const freeFeatures = [
  "写真で食事の記録（AIが料理を認識して栄養を推定）",
  "記録をほめるひと言（記録コメント）と栄養メモ",
  "献立の提案",
  "健康の記録",
  "バッジ",
  "過去の記録の閲覧",
];

/**
 * AI を使う機能の 1 日の利用回数の上限 (#1149)。数える: src/lib/plan/entitlements.ts の consumeAiUsage・
 * 上限に達したときの文: supabase/functions/_shared/ai-daily-limit.ts。回数の数字は運営画面で変えられるので書かない
 * (紹介ページの claims の ai-daily-limit の行と同じ扱い)
 */
const AI_DAILY_LIMIT_NOTE =
  "AIを使う機能（写真の解析や献立の提案など）は、1日にご利用いただける回数に上限があり、上限に達した日は翌日0時からまたお使いいただけます。";

const faqs = [
  { q: "現在、料金はかかりますか？", a: `現在ご提供している機能は無料でご利用いただけます。${AI_DAILY_LIMIT_NOTE}` },
];

/** 買える間隔ごとの金額の単位と CTA の文 (billing/01 §10.1 の表) */
const INTERVAL_DISPLAY: Readonly<Record<BillingInterval, { unit: string; cta: string }>> = {
  month: { unit: "/ 月（税込）", cta: "月額で始める" },
  year: { unit: "/ 年（税込）", cta: "年額で始める" },
};

/** 金額の書き方の言語 (「1,480」のような桁区切り) */
const PRICE_LOCALE = "ja-JP";

/** 確認画面 (/account/billing/checkout) への行き先 */
function checkoutHref(plan: PurchasablePlan, interval: BillingInterval): string {
  return `${BILLING_CHECKOUT_PAGE_PATH}?plan_key=${encodeURIComponent(plan.plan_key)}&interval=${interval}`;
}

export interface PricingPageViewProps {
  /** 公開のプランのうち月額の Price のあるもの (listPurchasablePlans。並びは display_order) */
  plans: PurchasablePlan[];
  /** アプリの WebView で開いた (Cookie is_native_app=1) */
  isNativeApp: boolean;
}

export default function PricingPageView({ plans, isNativeApp }: PricingPageViewProps) {
  // 買えるプラン = 買える間隔が 1 つ以上あるもの (金額が NULL か 0 の間隔は買えないので、ここで外す)
  const purchasable = plans
    .map((plan) => ({ plan, intervals: BILLING_INTERVALS.filter((interval) => isPurchasable(plan, interval)) }))
    .filter(({ intervals }) => intervals.length > 0);
  const onSale = purchasable.length > 0;
  // アプリの WebView では有料プランのカードと CTA を描かない (§10.4)
  const showPaidCards = onSale && !isNativeApp;

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
          {!onSale && (
            <p className="text-lg" style={{ color: colors.textLight }}>
              現在は無料でご利用いただけます。
            </p>
          )}
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
                <span className="text-sm" style={{ color: colors.textMuted }}>現在は無料</span>
              </div>
            </div>

            <ul className="space-y-3 mb-6">
              {freeFeatures.map((feature) => (
                <li key={feature} className="flex items-center gap-3 text-sm">
                  <Check size={18} style={{ color: colors.success }} />
                  <span style={{ color: colors.textLight }}>{feature}</span>
                </li>
              ))}
            </ul>

            <p className="text-xs leading-relaxed mb-6" style={{ color: colors.textMuted }}>
              {AI_DAILY_LIMIT_NOTE}
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

          {/* 有料プラン (買える間隔ごとに金額と CTA。§10.1) */}
          {showPaidCards &&
            purchasable.map(({ plan, intervals }, index) => (
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

                <div className="space-y-4 mt-auto">
                  {intervals.map((interval) => {
                    const amount = amountJpyFor(plan, interval) ?? 0;
                    return (
                      <div key={interval} className="space-y-2">
                        <div className="flex items-baseline justify-center gap-1">
                          <span className="text-3xl font-bold" style={{ color: colors.text }}>¥{amount.toLocaleString(PRICE_LOCALE)}</span>
                          <span className="text-sm" style={{ color: colors.textMuted }}>{INTERVAL_DISPLAY[interval].unit}</span>
                        </div>
                        <Link
                          href={checkoutHref(plan, interval)}
                          className="block w-full py-3 rounded-full font-bold text-sm text-center text-white"
                          style={{ background: colors.primary }}
                        >
                          {INTERVAL_DISPLAY[interval].cta}
                        </Link>
                      </div>
                    );
                  })}
                </div>
              </motion.div>
            ))}
        </div>

        {/* FAQ (買えるプランがあるときは描かない) */}
        {!onSale && (
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
