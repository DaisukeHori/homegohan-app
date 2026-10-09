"use client";

// Vercel Speed Insights (表示速度の計測)
// Canonical: docs/design/operator/07-audit-monitoring.md §7.3

import { SpeedInsights } from "@vercel/speed-insights/next";
import { scrubSpeedInsightsEvent } from "@/lib/speed-insights-scrub";

/**
 * Vercel Speed Insights を、URL を直してから送る形で置く (#1179)。
 *
 * - root layout (src/app/layout.tsx) の body 内に 1 つだけ置く。画面には何も描画しない。
 * - 計測値の URL には `?` 以降 (招待先のメールアドレスなど) と、パスの招待トークンが入りうる。
 *   `beforeSend` で送る前に消す (src/lib/speed-insights-scrub.ts)。
 * - `beforeSend` は関数なので、サーバーコンポーネントの layout からは渡せない。このクライアント部品で包む。
 * - `<SpeedInsights />` を `beforeSend` なしで、ほかの場所に置かない
 *   (tests/speed-insights-scrub-1179.test.ts が、src の中で Speed Insights を読み込むのはこのファイルだけであることを検査する)。
 */
export function SpeedInsightsClient() {
  return <SpeedInsights beforeSend={scrubSpeedInsightsEvent} />;
}
