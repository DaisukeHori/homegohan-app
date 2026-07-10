import "@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "@supabase/supabase-js";
import { requireServiceRole } from "../_shared/auth.ts";

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
 * 契約:
 *   POST /functions/v1/stripe-price-sync
 *   Authorization: Bearer <SUPABASE_SERVICE_ROLE_KEY> (呼び出し元が付与)
 *   Body: {
 *     plan_id: string,
 *     stripe_product_id: string,
 *     new_monthly_price_jpy?: number | null,
 *     new_yearly_price_jpy?: number | null,
 *     applies_to: 'new_only' | 'on_renewal' | 'immediately',
 *     actor_id: string,
 *     reason: string,
 *   }
 *   200 { success: true, new_stripe_price_id: string }
 *
 * Stripe Price は作成後に unit_amount を変更できない (Stripe の設計) ため、
 * operator/04-plan-management.md §3.3 の通り新規 Price を作成し、旧 Price
 * (DB の subscription_plans.stripe_price_id) を active=false にする。
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
 * #1041 round-3 (C2) 修正: subscription_plans.stripe_price_id は 1 プランにつき
 * 1 本しか保持できず、月額・年額を同時に Stripe へ同期することはできない。
 * 呼び出し元 (route.ts) 側で両方非 null の場合は 422 で拒否しているが、
 * defense in depth としてここでも両方来た場合は黙って片方 (月額優先) だけ
 * 処理せず 400 で拒否する。
 *
 * #1041 round-3 (S) 修正: 作成する Stripe Price に metadata
 * (plan_key / changed_by / reason) を付与し、Stripe 側からもどのプラン・誰が・
 * なぜ変更したか追跡できるようにする。
 */

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
// SERVICE_ROLE_JWT を優先し、なければ SUPABASE_SERVICE_ROLE_KEY を使用 (他関数と同じ規約)
const SUPABASE_SERVICE_ROLE_KEY =
  Deno.env.get("SERVICE_ROLE_JWT") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const STRIPE_SECRET_KEY = Deno.env.get("STRIPE_SECRET_KEY") ?? "";
const STRIPE_API_BASE = "https://api.stripe.com/v1";

interface SyncRequestBody {
  plan_id?: string;
  plan_key?: string;
  stripe_product_id?: string;
  new_monthly_price_jpy?: number | null;
  new_yearly_price_jpy?: number | null;
  applies_to?: string;
  actor_id?: string;
  reason?: string;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

type CreatePriceResult =
  | { ok: true; id: string }
  | { ok: false; status: number; message: string };

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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      },
    });
  }

  // cron/内部専用: service role key の完全一致 (SERVICE_ROLE_JWT /
  // SUPABASE_SERVICE_ROLE_KEY のどちらでも可)、または CRON_SECRET/SERVICE_ROLE_SECRET
  // のいずれかを満たせば許可 (regenerate-embeddings と同じ規約)。
  const authHeader = req.headers.get("Authorization") ?? "";
  const bearerToken = authHeader.replace(/^Bearer\s+/i, "").trim();
  const isServiceRoleKey =
    !!bearerToken &&
    (bearerToken === Deno.env.get("SERVICE_ROLE_JWT") || bearerToken === Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"));
  if (!isServiceRoleKey) {
    const authError = requireServiceRole(req);
    if (authError) return authError;
  }

  if (!STRIPE_SECRET_KEY) {
    // 判定不能 (Stripe 呼び出し不可) な場合は成功を偽装せず、明示的にサービス
    // 利用不可を返す (fail-closed。呼び出し元は 502 として扱い DB を更新しない)。
    return jsonResponse({ error: "STRIPE_SECRET_KEY is not configured" }, 503);
  }

  let body: SyncRequestBody;
  try {
    body = (await req.json()) as SyncRequestBody;
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  const { plan_id, plan_key, stripe_product_id, new_monthly_price_jpy, new_yearly_price_jpy, actor_id, reason } = body;

  if (!plan_id || typeof plan_id !== "string") {
    return jsonResponse({ error: "plan_id is required" }, 400);
  }
  if (!stripe_product_id || typeof stripe_product_id !== "string") {
    return jsonResponse({ error: "stripe_product_id is required" }, 400);
  }

  // #1041 round-3 (C2): 呼び出し元 (route.ts) で既に拒否しているはずだが、
  // defense in depth として両方来た場合は片方を黙って処理せず 400 で拒否する。
  if (typeof new_monthly_price_jpy === "number" && typeof new_yearly_price_jpy === "number") {
    return jsonResponse(
      {
        error:
          "new_monthly_price_jpy と new_yearly_price_jpy を同時に指定することはできません (1プランにつき Stripe Price ID は1本しか保持できません)",
      },
      400,
    );
  }

  let unitAmountJpy: number;
  let interval: "month" | "year";
  if (typeof new_monthly_price_jpy === "number") {
    unitAmountJpy = new_monthly_price_jpy;
    interval = "month";
  } else if (typeof new_yearly_price_jpy === "number") {
    unitAmountJpy = new_yearly_price_jpy;
    interval = "year";
  } else {
    return jsonResponse(
      { error: "new_monthly_price_jpy または new_yearly_price_jpy のいずれかが必要です" },
      400,
    );
  }

  const created = await createStripePrice({
    productId: stripe_product_id,
    unitAmountJpy,
    interval,
    metadata: {
      planKey: typeof plan_key === "string" ? plan_key : undefined,
      changedBy: typeof actor_id === "string" ? actor_id : undefined,
      reason: typeof reason === "string" ? reason : undefined,
    },
  });
  if (!created.ok) {
    console.error("[stripe-price-sync] Stripe Price 作成失敗:", created.status, created.message);
    return jsonResponse({ error: created.message }, 502);
  }

  // 旧 Price の deactivate はベストエフォート (DB 参照は service-role で行う)。
  if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
    try {
      const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
      const { data: plan } = await supabase
        .from("subscription_plans")
        .select("stripe_price_id")
        .eq("id", plan_id)
        .maybeSingle();
      const oldPriceId = (plan as { stripe_price_id?: string | null } | null)?.stripe_price_id;
      if (oldPriceId && oldPriceId !== created.id) {
        await deactivateStripePrice(oldPriceId);
      }
    } catch (err) {
      console.error("[stripe-price-sync] 旧 Price ID 取得に失敗 (non-fatal):", err);
    }
  }

  return jsonResponse({ success: true, new_stripe_price_id: created.id });
});
