import "@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "@supabase/supabase-js";
import { requireServiceRole } from "../_shared/auth.ts";
import { fetchStripePriceInterval } from "./deactivation.ts";
import { parseSyncRequest, syncPlanPrices, type CreatePriceResult, type SyncDeps } from "./sync.ts";

/**
 * Stripe Price 同期 Edge Function
 *
 * #1041 round-2 (C) 修正: 本関数が存在しなかったため
 * `POST /api/super-admin/plans/[id]/price-change` が `stripe_product_id` を
 * 持つプランで Edge Function 呼び出し時に常に 404 (→ 502) となり、
 * Stripe 連携が必要なプランでは価格変更機能が恒久的に使えなかった。
 *
 * 呼び出し元: src/app/api/super-admin/plans/[id]/price-change/route.ts
 *
 * 契約 (#1102。オーナー判断 2026-10-08: 価格変更は新規契約だけに適用し、年額用の Stripe 価格 ID の欄を追加する):
 *   POST /functions/v1/stripe-price-sync
 *   Authorization: Bearer <SUPABASE_SERVICE_ROLE_KEY> (呼び出し元が付与)
 *   Body: {
 *     plan_id: string,
 *     stripe_product_id: string,
 *     new_monthly_price_jpy?: number | null,   // 月額を変えるときだけ指定 (0 以上の整数)
 *     new_yearly_price_jpy?: number | null,    // 年額を変えるときだけ指定 (0 以上の整数)。月額と同時に指定してもよい
 *     applies_to?: 'new_only',                 // new_only のみ。省略は new_only 扱い。それ以外は 400
 *     plan_key?: string, actor_id?: string, reason?: string,   // Stripe Price の metadata に付ける
 *   }
 *   200 {
 *     success: true,
 *     month: { new_stripe_price_id, deactivated, deactivation_skipped_reason? } | null,  // 月額を変えなかったときは null
 *     year:  { new_stripe_price_id, deactivated, deactivation_skipped_reason? } | null,  // 年額を変えなかったときは null
 *   }
 *   4xx/5xx { error: string }
 *
 * 処理の本体は ./sync.ts (テストしやすいよう Deno / Stripe / DB に依存しない形で切り出してある):
 *   - 指定された interval ごとに、新しい Stripe Price を 1 本ずつ作る
 *   - 旧 Price は同じ interval のものだけを active=false にする
 *       月額の旧 Price = subscription_plans.stripe_price_id / 年額の旧 Price = subscription_plans.stripe_yearly_price_id
 *     無効化の前に旧 Price を Stripe から取り直して interval を確かめる (./deactivation.ts のガード。
 *     #1041 round-4 (C): 別の interval の現役の Price を無効化しない。取り直しに失敗したときも無効化しない)
 *   - 既存サブスクリプションの Price は切り替えない。旧 Price を無効化しても、既存の契約はその Price で
 *     請求され続け、新規の購入に選ばれなくなるだけ
 *   DB (subscription_plans の stripe_price_id / stripe_yearly_price_id) の更新は呼び出し元 (route.ts) が行う。
 *   この関数は旧 Price の ID を読むだけで、DB に書かない。
 *
 * Stripe Price は作成後に unit_amount を変更できない (Stripe の設計) ため、
 * operator/04-plan-management.md §3.3 の通り新規 Price を作成し、旧 Price を active=false にする。
 * 旧 Price の deactivate はベストエフォート (失敗しても致命的にしない —
 * 呼び出し元にとって必須の契約は新価格の作成・返却のみ)。
 *
 * Stripe SDK (npm:stripe) は Deno ランタイムでの互換性検証コストが高く、
 * 本リポジトリは既に Stripe を REST API 直叩き (fetch) で扱っている
 * (src/app/api/admin/finance/reconciliation/route.ts と同じ方針) ため、
 * SDK を追加せず fetch ベースで実装する
 * (deploy-supabase-functions.yml の「raw jsr:/npm: import 禁止」チェックにも
 * 抵触しない)。
 *
 * #1041 round-3 (S) 修正: 作成する Stripe Price に metadata
 * (plan_key / changed_by / reason) を付与し、Stripe 側からもどのプラン・誰が・
 * なぜ変更したか追跡できるようにする。
 *
 * (#1041 round-3 (C2) / round-4 (C) の経緯: 以前は subscription_plans.stripe_price_id が 1 プランにつき
 * 1 本しか保持できず、月額・年額を同時に同期できなかった。この列は「直近に触った interval の Price」を
 * 指す意味になり、旧 Price を interval 確認なしに無効化すると現役の Price を殺す事故が起き得たため、
 * ./deactivation.ts のガードを入れた。#1102 で年額用の列 stripe_yearly_price_id を足し、
 * stripe_price_id は月額に決めたので、月額・年額を同時に扱える。ガードは別 interval の値が残っていた場合の
 * 安全網として残してある。)
 */

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
// SERVICE_ROLE_JWT を優先し、なければ SUPABASE_SERVICE_ROLE_KEY を使用 (他関数と同じ規約)
const SUPABASE_SERVICE_ROLE_KEY =
  Deno.env.get("SERVICE_ROLE_JWT") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const STRIPE_SECRET_KEY = Deno.env.get("STRIPE_SECRET_KEY") ?? "";
const STRIPE_API_BASE = "https://api.stripe.com/v1";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function createStripePrice(params: {
  productId: string;
  unitAmountJpy: number;
  interval: "month" | "year";
  metadata?: { planKey?: string; changedBy?: string; reason?: string };
}): Promise<CreatePriceResult> {
  const form = new URLSearchParams();
  form.set("product", params.productId);
  form.set("currency", "jpy");
  // JPY は Stripe の zero-decimal 通貨のため unit_amount は円単位の整数そのまま (x100 しない)
  form.set("unit_amount", String(Math.round(params.unitAmountJpy)));
  form.set("recurring[interval]", params.interval);
  // #1041 round-3 (S): Stripe 側からもトレーサビリティを確保する
  if (params.metadata?.planKey) form.set("metadata[plan_key]", params.metadata.planKey);
  if (params.metadata?.changedBy) form.set("metadata[changed_by]", params.metadata.changedBy);
  if (params.metadata?.reason) form.set("metadata[reason]", params.metadata.reason);

  let res: Response;
  try {
    res = await fetch(`${STRIPE_API_BASE}/prices`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${STRIPE_SECRET_KEY}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: form.toString(),
    });
  } catch (err) {
    return { ok: false, status: 502, message: `Stripe API へのリクエストに失敗しました: ${err}` };
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message =
      (data as { error?: { message?: string } })?.error?.message ?? `Stripe API error (HTTP ${res.status})`;
    return { ok: false, status: res.status, message };
  }
  const id = (data as { id?: string }).id;
  if (!id) {
    return { ok: false, status: 502, message: "Stripe Price 作成レスポンスに id がありません" };
  }
  return { ok: true, id };
}

/** 旧 Price を active=false にする。失敗してもログのみ (non-fatal)。 */
async function deactivateStripePrice(priceId: string): Promise<void> {
  const form = new URLSearchParams();
  form.set("active", "false");
  try {
    const res = await fetch(`${STRIPE_API_BASE}/prices/${encodeURIComponent(priceId)}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${STRIPE_SECRET_KEY}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: form.toString(),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(`[stripe-price-sync] 旧 Price (${priceId}) の deactivate に失敗 (non-fatal):`, res.status, body);
    }
  } catch (err) {
    console.error(`[stripe-price-sync] 旧 Price (${priceId}) の deactivate 呼び出しに失敗 (non-fatal):`, err);
  }
}

/** subscription_plans の現在の Price ID (月額 = stripe_price_id / 年額 = stripe_yearly_price_id) を service-role で読む */
async function loadCurrentPriceIds(planId: string): Promise<{ month: string | null; year: string | null }> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("SUPABASE_URL / service role key が未設定のため、旧 Price ID を読めません");
  }
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const { data, error } = await supabase
    .from("subscription_plans")
    .select("stripe_price_id, stripe_yearly_price_id")
    .eq("id", planId)
    .maybeSingle();
  // 読めなかった (例: 列が無い・権限・通信) ときは「旧 Price なし」にせず、読めなかったこととして扱う
  // (呼び出し側が old_price_fetch_failed として、旧 Price の無効化を全部スキップする)
  if (error) throw error;
  const row = data as { stripe_price_id?: string | null; stripe_yearly_price_id?: string | null } | null;
  return { month: row?.stripe_price_id ?? null, year: row?.stripe_yearly_price_id ?? null };
}

// 内部専用 (ブラウザからは呼ばれない) なので CORS は付けない (#1167)。
// ブラウザの事前確認 (OPTIONS) は下の認証で 401 になり、CORS ヘッダーが無いためブラウザ側で止まる。
Deno.serve(async (req) => {
  // cron/内部専用: service role key の完全一致 (SERVICE_ROLE_JWT /
  // SUPABASE_SERVICE_ROLE_KEY のどちらでも可)、または CRON_SECRET/SERVICE_ROLE_SECRET
  // のいずれかを満たせば許可 (regenerate-embeddings と同じ規約)。
  const authHeader = req.headers.get("Authorization") ?? "";
  const bearerToken = authHeader.replace(/^Bearer\s+/i, "").trim();
  const isServiceRoleKey =
    !!bearerToken &&
    (bearerToken === Deno.env.get("SERVICE_ROLE_JWT") || bearerToken === Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"));
  if (!isServiceRoleKey) {
    const authError = await requireServiceRole(req);
    if (authError) return authError;
  }

  if (!STRIPE_SECRET_KEY) {
    // 判定不能 (Stripe 呼び出し不可) な場合は成功を偽装せず、明示的にサービス
    // 利用不可を返す (fail-closed。呼び出し元は 502 として扱い DB を更新しない)。
    return jsonResponse({ error: "STRIPE_SECRET_KEY is not configured" }, 503);
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  // リクエストの検証 (plan_id / stripe_product_id / 金額 / applies_to は new_only のみ)。詳細は ./sync.ts
  const parsed = parseSyncRequest(body);
  if (!parsed.ok) {
    return jsonResponse({ error: parsed.error }, parsed.status);
  }
  const request = parsed.value;

  const deps: SyncDeps = {
    createPrice: ({ interval, unitAmountJpy }) =>
      createStripePrice({
        productId: request.stripeProductId,
        unitAmountJpy,
        interval,
        metadata: { planKey: request.planKey, changedBy: request.actorId, reason: request.reason },
      }),
    fetchPriceInterval: (priceId) =>
      fetchStripePriceInterval({
        priceId,
        stripeApiBase: STRIPE_API_BASE,
        stripeSecretKey: STRIPE_SECRET_KEY,
      }),
    deactivatePrice: deactivateStripePrice,
    loadCurrentPriceIds: () => loadCurrentPriceIds(request.planId),
  };

  const outcome = await syncPlanPrices(request, deps);
  if (!outcome.ok) {
    return jsonResponse({ error: outcome.error }, outcome.status);
  }

  return jsonResponse({
    success: true,
    month: outcome.month,
    year: outcome.year,
  });
});
