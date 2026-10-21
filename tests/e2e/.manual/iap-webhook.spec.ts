/**
 * billing/03 §14.3 テスト 81: RevenueCat の Webhook の受け口 (POST /api/webhooks/revenuecat) を、動いているアプリに対して確かめる。
 *
 * RevenueCat の署名の秘密と、確かめる先のアプリ (PLAYWRIGHT_BASE_URL) が要るので CI では流さない (tests/e2e/.manual/)。
 * 手動の full suite (npx playwright test) からは外れないので、E2E_REVENUECAT_WEBHOOK=1 を付けたときだけ動かす
 * (billing-checkout.spec.ts と同じ、前提が無ければ全部スキップする形)。
 *   1. 署名した TEST のイベントを送ると 200 で ignored (取り直しも写像もしない)。同じ id をもう一度送ると duplicate
 *   2. 署名の無いイベントは 401
 *   3. (任意) E2E_SUPABASE_URL・E2E_SUPABASE_SERVICE_ROLE_KEY を付けたときだけ、revenuecat_webhook_events の TEST の行が completed で、
 *      E2E_IAP_SANDBOX_USER_ID の利用者に iap_is_sandbox = true の live なストアの行があるかを読み取りで確かめる (TestFlight の sandbox の
 *      購入のあと。§17.4)。書き込みはしない
 * 秘密の値は環境変数で渡し、ファイルに書かない。
 */
import crypto from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { test, expect } from "@playwright/test";

const ENABLED = process.env.E2E_REVENUECAT_WEBHOOK === "1";
const WEBHOOK_SECRET = process.env.REVENUECAT_WEBHOOK_SECRET ?? "";
const SUPABASE_URL = process.env.E2E_SUPABASE_URL ?? "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.E2E_SUPABASE_SERVICE_ROLE_KEY ?? "";
const SANDBOX_USER_ID = process.env.E2E_IAP_SANDBOX_USER_ID ?? "";
const WEBHOOK_PATH = "/api/webhooks/revenuecat";
const MS_PER_SECOND = 1000;
/** ストアの行のうち権利のある状態 (billing/03 §6.4) */
const LIVE_STORE_STATUSES = ["trialing", "active", "past_due"];

test.skip(
  !ENABLED || WEBHOOK_SECRET.length === 0,
  "RevenueCat の Webhook を確かめる手動の spec。E2E_REVENUECAT_WEBHOOK=1 と REVENUECAT_WEBHOOK_SECRET を付けて実行する (billing/03 §14.3・§17.4)",
);

function signedHeaders(body: string): Record<string, string> {
  const t = String(Math.floor(Date.now() / MS_PER_SECOND));
  const v1 = crypto.createHmac("sha256", WEBHOOK_SECRET).update(`${t}.${body}`).digest("hex");
  return { "content-type": "application/json", "x-revenuecat-webhook-signature": `t=${t},v1=${v1}` };
}

test.describe("billing/03 §14.3 RevenueCat の Webhook の受け口", () => {
  test("E2E: a signed TEST event is ignored with 200, its redelivery is a duplicate, and an unsigned event is 401", async ({ request }) => {
    const eventId = `e2e-test-${Date.now()}`;
    const body = JSON.stringify({ api_version: "1.0", event: { id: eventId, type: "TEST", event_timestamp_ms: Date.now() } });

    const first = await request.post(WEBHOOK_PATH, { data: body, headers: signedHeaders(body) });
    expect(first.status()).toBe(200);
    expect(await first.json()).toEqual({ received: true, action: "ignored", detail: "TEST" });

    const again = await request.post(WEBHOOK_PATH, { data: body, headers: signedHeaders(body) });
    expect(again.status()).toBe(200);
    expect(await again.json()).toEqual({ received: true, duplicate: true });

    const unsigned = await request.post(WEBHOOK_PATH, { data: body, headers: { "content-type": "application/json" } });
    expect(unsigned.status()).toBe(401);

    test.skip(SUPABASE_URL.length === 0 || SUPABASE_SERVICE_ROLE_KEY.length === 0, "DB の読み取りは E2E_SUPABASE_URL と E2E_SUPABASE_SERVICE_ROLE_KEY を付けたときだけ");
    const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
    const { data: eventRow, error: eventError } = await db
      .from("revenuecat_webhook_events")
      .select("event_type, processing_status")
      .eq("id", eventId)
      .maybeSingle();
    expect(eventError).toBeNull();
    expect(eventRow).toEqual({ event_type: "TEST", processing_status: "completed" });

    test.skip(SANDBOX_USER_ID.length === 0, "sandbox の購入の確かめは E2E_IAP_SANDBOX_USER_ID を付けたときだけ (TestFlight で買ったあと)");
    const { data: storeRows, error: storeError } = await db
      .from("personal_subscriptions")
      .select("status, iap_store, iap_is_sandbox, plan_key")
      .eq("user_id", SANDBOX_USER_ID)
      .not("iap_store", "is", null);
    expect(storeError).toBeNull();
    expect((storeRows ?? []).some((row) => row.iap_is_sandbox === true && LIVE_STORE_STATUSES.includes(row.status))).toBe(true);
  });
});
