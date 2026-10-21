/**
 * RevenueCat (react-native-purchases) の薄い包み (billing/03 §8.10)。画面はこれだけを呼ぶ。
 *  - app_user_id = Supabase の利用者 id (useAuth().user.id)。ログインのたびに identify、サインアウトで logOut (別の利用者に購入を引き継がない)
 *  - 公開 SDK キー (EXPO_PUBLIC_REVENUECAT_APPLE_API_KEY / EXPO_PUBLIC_REVENUECAT_GOOGLE_API_KEY) はビルド時に埋め込む。名前は直接書く (src/lib/env.ts の規則)
 *  - キーが無いビルドでは configure せず、isAvailable() が false (購入の画面はストアの購入を出さない)
 *  - Expo Go では動かない (開発ビルドが要る。P1)
 */
import { Platform } from "react-native";
import Purchases, {
  INTRO_ELIGIBILITY_STATUS,
  LOG_LEVEL,
  type CustomerInfo,
  type PurchasesOfferings,
  type PurchasesPackage,
} from "react-native-purchases";
import type { TrialEligibility } from "./iap-catalog";

function apiKeyForPlatform(): string | null {
  // 名前を直接書く (Metro の置き換えは process.env.EXPO_PUBLIC_X の形だけ)
  const apple = process.env.EXPO_PUBLIC_REVENUECAT_APPLE_API_KEY;
  const google = process.env.EXPO_PUBLIC_REVENUECAT_GOOGLE_API_KEY;
  const key = Platform.OS === "ios" ? apple : Platform.OS === "android" ? google : undefined;
  return key !== undefined && key.trim() !== "" ? key.trim() : null;
}

let configuredAppUserId: string | null = null;

/** このビルドでストアの購入を扱えるか (キーがある・iOS か Android) */
export function isPurchasesAvailable(): boolean {
  return apiKeyForPlatform() !== null;
}

/** ログイン中の利用者で RevenueCat を使えるようにする。2 回目以降は logIn で切り替える (同じ id なら何もしない) */
export async function identifyPurchases(userId: string): Promise<void> {
  const apiKey = apiKeyForPlatform();
  if (apiKey === null) return;
  if (configuredAppUserId === null) {
    if (__DEV__) await Purchases.setLogLevel(LOG_LEVEL.DEBUG);
    Purchases.configure({ apiKey, appUserID: userId });
    configuredAppUserId = userId;
    return;
  }
  if (configuredAppUserId !== userId) {
    await Purchases.logIn(userId);
    configuredAppUserId = userId;
  }
}

/** サインアウトのとき。匿名でなければ logOut (次の利用者に購入を引き継がない)。失敗しても投げない */
export async function resetPurchasesOnSignOut(): Promise<void> {
  if (configuredAppUserId === null) return;
  try {
    if (!(await Purchases.isAnonymous())) await Purchases.logOut();
  } catch {
    // 通信の失敗など。次の identify が logIn で切り替える
  } finally {
    configuredAppUserId = null;
  }
}

export async function fetchOfferings(): Promise<PurchasesOfferings> {
  return Purchases.getOfferings();
}

export type PurchaseOutcome = { ok: true; customerInfo: CustomerInfo } | { ok: false; cancelled: true } | { ok: false; cancelled: false; error: unknown };

/** 購入 (ストアのシートを出す)。利用者の取り消しは cancelled */
export async function purchase(pkg: PurchasesPackage): Promise<PurchaseOutcome> {
  try {
    const { customerInfo } = await Purchases.purchasePackage(pkg);
    return { ok: true, customerInfo };
  } catch (error) {
    const cancelled = typeof error === "object" && error !== null && "userCancelled" in error && (error as { userCancelled?: unknown }).userCancelled === true;
    return cancelled ? { ok: false, cancelled: true } : { ok: false, cancelled: false, error };
  }
}

/** 購入の復元 (利用者がボタンを押したときだけ呼ぶ。P3) */
export async function restore(): Promise<CustomerInfo> {
  return Purchases.restorePurchases();
}

export async function currentCustomerInfo(): Promise<CustomerInfo | null> {
  if (configuredAppUserId === null) return null;
  return Purchases.getCustomerInfo();
}

/** SDK の体験の判定 (INTRO_ELIGIBILITY_STATUS) → 画面の判定 (iap-catalog.ts の TrialEligibility) */
const TRIAL_ELIGIBILITY_OF_STATUS: Readonly<Record<INTRO_ELIGIBILITY_STATUS, TrialEligibility>> = {
  [INTRO_ELIGIBILITY_STATUS.INTRO_ELIGIBILITY_STATUS_UNKNOWN]: "unknown",
  [INTRO_ELIGIBILITY_STATUS.INTRO_ELIGIBILITY_STATUS_INELIGIBLE]: "ineligible",
  [INTRO_ELIGIBILITY_STATUS.INTRO_ELIGIBILITY_STATUS_ELIGIBLE]: "eligible",
  [INTRO_ELIGIBILITY_STATUS.INTRO_ELIGIBILITY_STATUS_NO_INTRO_OFFER_EXISTS]: "no_offer",
};

/**
 * 商品ごとの無料体験の対象の判定 (iOS だけ。SDK の checkTrialOrIntroductoryPriceEligibility。Android は常に UNKNOWN を返す SDK の仕様なので
 * 呼ばずに空を返す。Google Play は対象の利用者にだけ offer を返す)。失敗・未設定は空 (= 体験の文を出さない。iap-catalog.ts の storeTrialOf)
 */
export async function fetchTrialEligibility(productIds: readonly string[]): Promise<Record<string, TrialEligibility>> {
  if (Platform.OS !== "ios" || productIds.length === 0 || configuredAppUserId === null) return {};
  try {
    const result = await Purchases.checkTrialOrIntroductoryPriceEligibility([...productIds]);
    const eligibility: Record<string, TrialEligibility> = {};
    for (const [productId, value] of Object.entries(result)) eligibility[productId] = TRIAL_ELIGIBILITY_OF_STATUS[value.status] ?? "unknown";
    return eligibility;
  } catch {
    return {};
  }
}
