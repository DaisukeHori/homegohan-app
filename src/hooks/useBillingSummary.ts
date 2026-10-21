"use client";

/**
 * 本人の契約の要約 (GET /api/billing/subscription の data) を読む (billing/03 §10.3)。
 *
 * - enabled が偽から真になるたびに 1 回だけ読む (究極モードの錠は、献立の作成のモーダルが開くたびに読む: useBillingSummary(open))
 * - 応答が 2xx なら本文の data を @homegohan/shared の parseBillingSummaryWire で読む。401・失敗・形が違うときは null
 *   (null のとき画面は錠を出さない。使えるかどうかはサーバの判定が最後の砦)
 * - SWR は使わない (読み直すのは開くときだけで、ほかの画面と要約を共有しない)
 */

import { useEffect, useState } from "react";
import { parseBillingSummaryWire, type BillingSummaryWire } from "@homegohan/shared";

/** 契約の要約の API (src/app/api/billing/subscription/route.ts) */
export const BILLING_SUBSCRIPTION_API_PATH = "/api/billing/subscription";

export function useBillingSummary(enabled: boolean): BillingSummaryWire | null {
  const [summary, setSummary] = useState<BillingSummaryWire | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const run = async () => {
      try {
        const res = await fetch(BILLING_SUBSCRIPTION_API_PATH);
        if (!res.ok) {
          if (!cancelled) setSummary(null);
          return;
        }
        const body: unknown = await res.json();
        const data = typeof body === "object" && body !== null && "data" in body ? (body as { data: unknown }).data : null;
        if (!cancelled) setSummary(parseBillingSummaryWire(data));
      } catch {
        if (!cancelled) setSummary(null);
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  return summary;
}
