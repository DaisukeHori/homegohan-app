/**
 * #1041 round-4 (C・Critical/Sonnet) 旧 Price deactivate の interval ガード
 *
 * 背景: `subscription_plans.stripe_price_id` は 1 プランにつき 1 本しか保持できない
 * (月額用・年額用を同時に持てる列が無い、単一列の構造的制約)。そのためこの列は
 * 「直近に触った interval の Price」を指す意味論になる。この制約を踏まえずに
 * DB の `stripe_price_id` をそのまま「今回変更した interval の旧 Price」とみなして
 * deactivate すると、以下のシナリオで現役 Price を無警告で殺してしまう:
 *
 *   1. 月額のみ変更 → Price A (interval=month) 作成、stripe_price_id が A に更新される
 *   2. 後日、年額のみ変更 → Price B (interval=year) 作成
 *      この時点で DB の stripe_price_id は A (月額・現役) を指しているが、
 *      interval を確認せずに deactivate すると A (現役の月額 Price) が
 *      無警告で deactivate されてしまう。
 *
 * → deactivate 前に旧 Price を Stripe から GET し、`recurring.interval` が
 *   今回作成した Price の interval と一致する場合のみ deactivate する。
 *   不一致なら「別 interval のまだ現役の Price」とみなしスキップする。
 *   GET 自体が失敗した場合も安全側 (deactivate しない) に倒す。
 */

export type StripePriceInterval = "month" | "year";

export type OldPriceFetchResult =
  | { ok: true; interval: StripePriceInterval | null }
  | { ok: false };

export type DeactivationSkipReason =
  | "no_old_price"
  | "old_price_fetch_failed"
  | "interval_mismatch";

export type DeactivationDecision =
  | { deactivate: true }
  | { deactivate: false; reason: DeactivationSkipReason };

/**
 * 旧 Price を deactivate すべきかを決定する純粋関数 (fetch から分離してユニットテスト容易にする)。
 */
export function decideOldPriceDeactivation(params: {
  oldPriceId: string | null | undefined;
  newPriceId: string;
  newInterval: StripePriceInterval;
  oldPriceFetch: OldPriceFetchResult;
}): DeactivationDecision {
  const { oldPriceId, newPriceId, oldPriceFetch, newInterval } = params;

  if (!oldPriceId || oldPriceId === newPriceId) {
    return { deactivate: false, reason: "no_old_price" };
  }

  if (!oldPriceFetch.ok) {
    // GET 失敗時は判定不能。誤って現役 Price を殺すリスクを避け、
    // deactivate しない (安全側・従来の best-effort 方針を維持)。
    return { deactivate: false, reason: "old_price_fetch_failed" };
  }

  if (oldPriceFetch.interval !== newInterval) {
    // 旧 Price は今回変更した interval とは異なる、まだ現役の Price である
    // 可能性が高い (①→② シナリオ)。deactivate しない。
    return { deactivate: false, reason: "interval_mismatch" };
  }

  return { deactivate: true };
}

/**
 * Stripe から旧 Price を GET し、`recurring.interval` を取得する。
 * `fetchImpl` を注入可能にしてユニットテストで fetch をモックできるようにする。
 */
export async function fetchStripePriceInterval(params: {
  priceId: string;
  stripeApiBase: string;
  stripeSecretKey: string;
  fetchImpl?: typeof fetch;
}): Promise<OldPriceFetchResult> {
  const fetchFn = params.fetchImpl ?? fetch;
  try {
    const res = await fetchFn(`${params.stripeApiBase}/prices/${encodeURIComponent(params.priceId)}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${params.stripeSecretKey}` },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(`[stripe-price-sync] 旧 Price (${params.priceId}) の取得に失敗:`, res.status, body);
      return { ok: false };
    }
    const data = (await res.json().catch(() => ({}))) as { recurring?: { interval?: string } };
    const interval = data.recurring?.interval;
    return { ok: true, interval: interval === "month" || interval === "year" ? interval : null };
  } catch (err) {
    console.error(`[stripe-price-sync] 旧 Price (${params.priceId}) の取得呼び出しに失敗:`, err);
    return { ok: false };
  }
}
