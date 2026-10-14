/**
 * #1102 stripe-price-sync の処理本体 (Deno / Stripe / Supabase に依存しない部分)
 *
 * index.ts (Deno.serve) から、リクエストの検証 (parseSyncRequest) と、月額・年額の Price の作成と旧 Price の
 * 無効化 (syncPlanPrices) を切り出したもの。Stripe の呼び出しと DB の読み取りは deps として渡すので、
 * tests/stripe-price-sync-deactivation.test.ts が fetch / DB を差し替えて検証できる。
 *
 * 契約 (オーナー判断 2026-10-08, #1102):
 *   - 価格変更は新規契約だけに適用する。applies_to は new_only だけを受け付け、それ以外は 400。
 *     (既存サブスクリプションを新しい Price へ切り替える処理は無い。旧 Price を無効化しても、
 *      既存の契約はその Price で請求され続ける。無効化すると新規の購入に選ばれなくなるだけ)
 *   - 月額 (new_monthly_price_jpy) と年額 (new_yearly_price_jpy) を 1 回の呼び出しで両方受け付ける。
 *     指定された方の interval ごとに、新しい Price を 1 本ずつ作る。
 *   - 旧 Price は、同じ interval のものだけを無効化する。
 *       月額の旧 Price = subscription_plans.stripe_price_id
 *       年額の旧 Price = subscription_plans.stripe_yearly_price_id
 *     無効化の前に、旧 Price を Stripe から取り直して recurring.interval が今回作った Price と同じか確かめる
 *     (deactivation.ts のガード。#1041 round-4 (C)。旧仕様の「最後に触った側」の値が残っていても、
 *      別の interval の現役の Price を無効化しない)。
 */

import {
  decideOldPriceDeactivation,
  type DeactivationSkipReason,
  type OldPriceFetchResult,
  type StripePriceInterval,
} from "./deactivation.ts";

export type CreatePriceResult =
  | { ok: true; id: string }
  | { ok: false; status: number; message: string };

/** 検証を通ったリクエスト */
export interface SyncRequest {
  planId: string;
  stripeProductId: string;
  /** 月額を変えないときは null */
  newMonthlyPriceJpy: number | null;
  /** 年額を変えないときは null */
  newYearlyPriceJpy: number | null;
  planKey?: string;
  actorId?: string;
  reason?: string;
}

export type ParseResult =
  | { ok: true; value: SyncRequest }
  | { ok: false; status: number; error: string };

function badRequest(error: string): { ok: false; status: number; error: string } {
  return { ok: false, status: 400, error };
}

/** 価格 (JPY)。未指定 (undefined / null) は null、指定されたら 0 以上の整数でなければならない */
function parseAmount(value: unknown, name: string): { ok: true; value: number | null } | { ok: false; error: string } {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    return { ok: false, error: `${name} は 0 以上の整数で指定してください` };
  }
  return { ok: true, value };
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * リクエストボディを検証する。
 * applies_to は new_only だけを受け付ける (省略は new_only 扱い)。旧い呼び出し元が on_renewal / immediately を
 * 送ってきても、既存契約へは反映できないので、黙って new_only として処理せず 400 にする。
 */
export function parseSyncRequest(body: unknown): ParseResult {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return badRequest("Invalid JSON body");
  }
  const b = body as Record<string, unknown>;

  if (typeof b.plan_id !== "string" || !b.plan_id) return badRequest("plan_id is required");
  if (typeof b.stripe_product_id !== "string" || !b.stripe_product_id) {
    return badRequest("stripe_product_id is required");
  }

  if (b.applies_to !== undefined && b.applies_to !== null && b.applies_to !== "new_only") {
    return badRequest(
      "applies_to は new_only のみ指定できます (価格変更は新規契約だけに適用され、既存契約の価格は変更できません)",
    );
  }

  const monthly = parseAmount(b.new_monthly_price_jpy, "new_monthly_price_jpy");
  if (!monthly.ok) return badRequest(monthly.error);
  const yearly = parseAmount(b.new_yearly_price_jpy, "new_yearly_price_jpy");
  if (!yearly.ok) return badRequest(yearly.error);
  if (monthly.value === null && yearly.value === null) {
    return badRequest("new_monthly_price_jpy または new_yearly_price_jpy の少なくとも一方が必要です");
  }

  return {
    ok: true,
    value: {
      planId: b.plan_id,
      stripeProductId: b.stripe_product_id,
      newMonthlyPriceJpy: monthly.value,
      newYearlyPriceJpy: yearly.value,
      planKey: optionalString(b.plan_key),
      actorId: optionalString(b.actor_id),
      reason: optionalString(b.reason),
    },
  };
}

/** Stripe の呼び出しと DB の読み取り (index.ts が実体を渡し、テストが差し替える) */
export interface SyncDeps {
  /** 指定の interval で新しい Price を作る */
  createPrice(params: { interval: StripePriceInterval; unitAmountJpy: number }): Promise<CreatePriceResult>;
  /** 旧 Price の recurring.interval を Stripe から取る (失敗は { ok: false }。例外にしない) */
  fetchPriceInterval(priceId: string): Promise<OldPriceFetchResult>;
  /** Price を active=false にする (失敗しても例外にしない。ベストエフォート) */
  deactivatePrice(priceId: string): Promise<void>;
  /** subscription_plans の現在の Price ID を読む (月額 = stripe_price_id / 年額 = stripe_yearly_price_id)。読めなければ throw */
  loadCurrentPriceIds(): Promise<{ month: string | null; year: string | null }>;
}

/** 1 つの interval の同期結果 */
export interface IntervalSyncResult {
  new_stripe_price_id: string;
  /** 旧 Price を無効化したか */
  deactivated: boolean;
  /** 無効化しなかった理由 (deactivated が false のときだけ付く) */
  deactivation_skipped_reason?: DeactivationSkipReason;
}

export type SyncOutcome =
  | {
    ok: true;
    /** 月額を変えなかったときは null */
    month: IntervalSyncResult | null;
    /** 年額を変えなかったときは null */
    year: IntervalSyncResult | null;
  }
  | { ok: false; status: number; error: string };

const INTERVAL_LABELS: Record<StripePriceInterval, string> = { month: "月額", year: "年額" };

/**
 * 指定された interval ごとに新しい Price を作り、同じ interval の旧 Price だけを無効化する。
 *
 * 順序:
 *   1. 新しい Price をすべて作る (月額 → 年額)。途中で失敗したら、すでに作った新しい Price を無効化して
 *      (誰も参照していない Price を残さない。ベストエフォート)、エラーを返す。旧 Price には一切触れない。
 *   2. 旧 Price の ID を DB から 1 回読む。読めなければ、無効化は全部スキップする (old_price_fetch_failed)。
 *   3. interval ごとに、旧 Price が今回作った Price と同じ interval か確かめてから無効化する。
 *      旧 Price の無効化の失敗はベストエフォート (新しい Price の作成が、呼び出し元にとって必須の契約)。
 */
export async function syncPlanPrices(request: SyncRequest, deps: SyncDeps): Promise<SyncOutcome> {
  const targets: Array<{ interval: StripePriceInterval; amount: number }> = [];
  if (request.newMonthlyPriceJpy !== null) targets.push({ interval: "month", amount: request.newMonthlyPriceJpy });
  if (request.newYearlyPriceJpy !== null) targets.push({ interval: "year", amount: request.newYearlyPriceJpy });

  // 1. 新しい Price を作る
  const created: Array<{ interval: StripePriceInterval; priceId: string }> = [];
  for (const target of targets) {
    const result = await deps.createPrice({ interval: target.interval, unitAmountJpy: target.amount });
    if (!result.ok) {
      console.error(
        `[stripe-price-sync] Stripe Price 作成失敗 (${target.interval}):`,
        result.status,
        result.message,
      );
      // すでに作った新しい Price は誰も参照しない。残さないよう無効化する (旧 Price には触れない)
      for (const already of created) {
        await deps.deactivatePrice(already.priceId);
      }
      return {
        ok: false,
        status: 502,
        error: `${INTERVAL_LABELS[target.interval]}の Stripe Price の作成に失敗しました: ${result.message}`,
      };
    }
    created.push({ interval: target.interval, priceId: result.id });
  }

  // 2. 旧 Price の ID を読む
  let current: { month: string | null; year: string | null } | null = null;
  try {
    current = await deps.loadCurrentPriceIds();
  } catch (err) {
    console.error("[stripe-price-sync] 旧 Price ID 取得に失敗 (non-fatal):", err);
  }

  // 3. interval ごとに、同じ interval の旧 Price だけを無効化する
  const results: Record<StripePriceInterval, IntervalSyncResult | null> = { month: null, year: null };
  for (const { interval, priceId } of created) {
    if (current === null) {
      results[interval] = {
        new_stripe_price_id: priceId,
        deactivated: false,
        deactivation_skipped_reason: "old_price_fetch_failed",
      };
      continue;
    }

    // 月額の旧 Price は stripe_price_id、年額の旧 Price は stripe_yearly_price_id だけを見る (別の interval の列は見ない)
    const oldPriceId = current[interval];

    let oldPriceFetch: OldPriceFetchResult = { ok: false };
    if (oldPriceId && oldPriceId !== priceId) {
      oldPriceFetch = await deps.fetchPriceInterval(oldPriceId);
    }

    const decision = decideOldPriceDeactivation({
      oldPriceId,
      newPriceId: priceId,
      newInterval: interval,
      oldPriceFetch,
    });

    if (decision.deactivate) {
      // decideOldPriceDeactivation が deactivate:true を返すのは、oldPriceId が非 null で、
      // interval が一致すると確認できたときだけ。
      await deps.deactivatePrice(oldPriceId as string);
      results[interval] = { new_stripe_price_id: priceId, deactivated: true };
    } else {
      if (decision.reason === "interval_mismatch") {
        console.warn(
          `[stripe-price-sync] 旧 Price (${oldPriceId}) は今回作成した interval (${interval}) と異なるため deactivate をスキップしました (現役 Price 保護)`,
        );
      }
      results[interval] = {
        new_stripe_price_id: priceId,
        deactivated: false,
        deactivation_skipped_reason: decision.reason,
      };
    }
  }

  return { ok: true, month: results.month, year: results.year };
}
