/**
 * 課金の API の読み書き (billing/03 §8.10)。購入の画面 (app/settings/plan.tsx) と究極モードの錠 (V4GenerateModal) が使う。
 * 応答の data は @homegohan/shared の parseBillingSummaryWire と ./iap-catalog の parseIapCatalogPlans で読む。
 * Web の購入のページ (料金・契約の管理) のパスは書かない (__tests__/app/no-web-purchase-links.test.ts)
 */
import { parseBillingSummaryWire, type BillingSummaryWire, type PurchaseStore } from "@homegohan/shared";
import { getApi } from "./api";
import { parseIapCatalogPlans, type CatalogPlanLike } from "./iap-catalog";

export const BILLING_SUBSCRIPTION_API_PATH = "/api/billing/subscription";
export const IAP_CATALOG_API_PATH = "/api/billing/iap/catalog";
export const IAP_SYNC_API_PATH = "/api/billing/iap/sync";

/** 契約の状態を読めなかったときの文 (要約の形が違う・通信の失敗) */
export const BILLING_SUMMARY_LOAD_FAILED_MESSAGE = "契約の状態を読み込めませんでした。時間をおいてお試しください。";
/** 購入・同期を完了できなかったときの汎用の文 (ストアやサーバの生の文は出さない) */
export const BILLING_PURCHASE_FAILED_MESSAGE = "購入を完了できませんでした。時間をおいてお試しください。";

/** 要約の形が想定と違った */
export class BillingSummaryShapeError extends Error {
  constructor() {
    super(BILLING_SUMMARY_LOAD_FAILED_MESSAGE);
    this.name = "BillingSummaryShapeError";
  }
}

function summaryOrThrow(body: { data?: unknown } | null | undefined): BillingSummaryWire {
  const summary = parseBillingSummaryWire(body?.data);
  if (summary === null) throw new BillingSummaryShapeError();
  return summary;
}

/** GET /api/billing/subscription */
export async function fetchBillingSummary(): Promise<BillingSummaryWire> {
  return summaryOrThrow(await getApi().get<{ data?: unknown }>(BILLING_SUBSCRIPTION_API_PATH));
}

/** GET /api/billing/iap/catalog?store=… (形が違えば空) */
export async function fetchIapCatalog(store: PurchaseStore): Promise<CatalogPlanLike[]> {
  const body = await getApi().get<{ data?: unknown }>(`${IAP_CATALOG_API_PATH}?store=${store}`);
  return parseIapCatalogPlans(body?.data, store);
}

/** POST /api/billing/iap/sync (本文なし)。同期後の要約を返す */
export async function syncIapPurchases(): Promise<BillingSummaryWire> {
  return summaryOrThrow(await getApi().post<{ data?: unknown }>(IAP_SYNC_API_PATH));
}

/** サーバが固定の文を返す同期のエラーのコード (src/lib/billing/iap-core.ts の IAP_ERROR_MESSAGES の 4 つ。文はサーバの固定の文をそのまま出す) */
const IAP_FIXED_MESSAGE_CODES: ReadonlySet<string> = new Set([
  "BILL_IAP_SYNC_CONFLICT",
  "BILL_IAP_UNKNOWN_PRODUCT",
  "EXT_REVENUECAT_NOT_CONFIGURED",
  "EXT_REVENUECAT_API_FAILED",
]);
// "HTTP 409 Conflict: {...}" (api-error.ts と同じ形)
const HTTP_ERROR_PATTERN = /^HTTP (\d{3})[^:]*:\s*([\s\S]+)$/;

/**
 * 同期・購入の失敗を画面の文にする。HTTP のエラーで本文が { error: { code, message } } かつ code が IAP_FIXED_MESSAGE_CODES のときは
 * サーバの固定の文、それ以外の HTTP のエラーは BILLING_PURCHASE_FAILED_MESSAGE。HTTP の形でない例外 (getApi の通信の失敗の固定の文・
 * withFriendlyErrors が置き換えた例外) は、その message をそのまま返す
 */
export function billingErrorMessageOf(error: unknown): string {
  const raw = (error as { message?: unknown } | null | undefined)?.message;
  if (typeof raw !== "string" || raw === "") return BILLING_PURCHASE_FAILED_MESSAGE;
  const match = HTTP_ERROR_PATTERN.exec(raw);
  if (match === null) return raw;
  try {
    const body: unknown = JSON.parse(match[2]);
    const nested = body && typeof body === "object" ? (body as { error?: unknown }).error : null;
    if (nested && typeof nested === "object") {
      const { code, message } = nested as { code?: unknown; message?: unknown };
      if (typeof code === "string" && IAP_FIXED_MESSAGE_CODES.has(code) && typeof message === "string") return message;
    }
  } catch {
    // 本文が JSON でない
  }
  return BILLING_PURCHASE_FAILED_MESSAGE;
}
