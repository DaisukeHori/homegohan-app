/**
 * apps/mobile/src/lib/iap-catalog.ts (新設。import なしで単独で型検査できる)
 * カタログ (GET /api/billing/iap/catalog) の読み取りと offerings の突き合わせ (純粋。RN の API は使わない。__tests__/lib/iap-catalog.test.ts)。
 * 画面に出すのは、カタログにあり、かつ offerings にある商品だけ (どちらか一方に無い商品は出さない。R18)。
 * 無料体験の文は、ストアが返す商品の導入価格 (introPrice) と体験の対象の判定から作る (DB の trial_days からは作らない。R15・S29)
 */
export interface CatalogPlanLike {
  plan_key: string;
  display_name: string;
  max_members: number | null;
  products: Array<{ billing_interval: "month" | "year"; product_id: string }>;
}
/** react-native-purchases の PurchasesIntroPrice のうち読む項目 (price は現地の通貨の金額。0 = 無料体験) */
export interface IntroPriceLike {
  price: number;
  periodUnit: string;
  periodNumberOfUnits: number;
  cycles: number;
}
export interface PackageLike {
  identifier: string;
  product: { identifier: string; priceString: string; introPrice: IntroPriceLike | null };
}
/** 体験の対象かの判定 (iOS の checkTrialOrIntroductoryPriceEligibility の 4 値を写したもの。purchases.ts の fetchTrialEligibility が作る) */
export type TrialEligibility = "eligible" | "ineligible" | "unknown" | "no_offer";
/** 画面に出す無料体験 (lengthText は「7 日間」「1 か月」の形) */
export interface StoreTrial {
  lengthText: string;
}
export interface PurchasablePlanCard {
  plan_key: string;
  display_name: string;
  max_members: number | null;
  options: Array<{
    billing_interval: "month" | "year";
    product_id: string;
    priceString: string;
    packageIdentifier: string;
    /** この利用者が受けられる無料体験 (無ければ null) */
    trial: StoreTrial | null;
  }>;
}

/** 1 週間の日数 (ストアの体験の期間の単位 WEEK を日に直す。Web の体験の日数と同じ書き方にするため) */
const DAYS_PER_WEEK = 7;
/** 導入価格の期間の単位 → 日数への掛け算と文の単位。知らない単位は体験の文を出さない */
const TRIAL_PERIOD_UNITS: Readonly<Record<string, { multiplier: number; suffix: string }>> = {
  DAY: { multiplier: 1, suffix: "日間" },
  WEEK: { multiplier: DAYS_PER_WEEK, suffix: "日間" },
  MONTH: { multiplier: 1, suffix: "か月" },
  YEAR: { multiplier: 1, suffix: "年" },
};

/**
 * この利用者に出してよい無料体験 (R15・S29)。
 *   - 導入価格が無い、または 0 円でない (割引の導入価格) → null (無料体験ではない)
 *   - App Store: 体験の対象かを SDK に尋ねた答えが eligible のときだけ。unknown・ineligible・no_offer・答えが無いときは出さない
 *     (SDK の案内:「The best course of action on unknown status is to display the non-intro pricing」)
 *   - Google Play: Google が対象の利用者にだけ offer を返すので、導入価格があれば出す (判定の答えは使わない)
 */
export function storeTrialOf(
  store: "app_store" | "play_store",
  pkg: PackageLike,
  eligibility: Readonly<Record<string, TrialEligibility>>,
): StoreTrial | null {
  const intro = pkg.product.introPrice;
  if (intro === null || intro.price !== 0) return null;
  if (store === "app_store" && eligibility[pkg.product.identifier] !== "eligible") return null;
  const unit = TRIAL_PERIOD_UNITS[intro.periodUnit];
  if (unit === undefined) return null;
  const length = intro.periodNumberOfUnits * Math.max(1, intro.cycles) * unit.multiplier;
  if (!Number.isInteger(length) || length <= 0) return null;
  return { lengthText: `${length} ${unit.suffix}` };
}

export function matchCatalogWithPackages(
  store: "app_store" | "play_store",
  plans: readonly CatalogPlanLike[],
  packages: readonly PackageLike[],
  eligibility: Readonly<Record<string, TrialEligibility>>,
): PurchasablePlanCard[] {
  const byProduct = new Map<string, PackageLike>();
  for (const pkg of packages) byProduct.set(pkg.product.identifier, pkg);
  const cards: PurchasablePlanCard[] = [];
  for (const plan of plans) {
    const options: PurchasablePlanCard["options"] = [];
    for (const product of plan.products) {
      const pkg = byProduct.get(product.product_id);
      if (pkg === undefined) continue;
      options.push({
        billing_interval: product.billing_interval,
        product_id: product.product_id,
        priceString: pkg.product.priceString,
        packageIdentifier: pkg.identifier,
        trial: storeTrialOf(store, pkg, eligibility),
      });
    }
    if (options.length > 0) cards.push({ plan_key: plan.plan_key, display_name: plan.display_name, max_members: plan.max_members, options });
  }
  return cards;
}

/** 月額 / 年額の行の文 (自動更新の説明を含む。ストアの審査の要件 P9・P10)。体験の文は storeTrialOf が返したときだけ */
export function renewalText(interval: "month" | "year", priceString: string, trial: StoreTrial | null): string {
  const period = interval === "month" ? "1 か月" : "1 年";
  const trialText = trial === null ? "" : `${trial.lengthText}の無料体験のあと、`;
  return `${trialText}${period}ごとに ${priceString} が自動で更新されます。解約しない限り更新が続きます。`;
}

const CATALOG_INTERVALS: ReadonlyArray<"month" | "year"> = ["month", "year"];
const isCatalogInterval = (value: unknown): value is "month" | "year" =>
  typeof value === "string" && (CATALOG_INTERVALS as readonly string[]).includes(value);

/**
 * GET /api/billing/iap/catalog の data を読む。store が違う・形が違う項目は捨てる (全体の形が違えば空。画面はプランの一覧を出さない)
 */
export function parseIapCatalogPlans(data: unknown, store: string): CatalogPlanLike[] {
  if (!data || typeof data !== "object" || Array.isArray(data)) return [];
  const record = data as { store?: unknown; plans?: unknown };
  if (record.store !== store || !Array.isArray(record.plans)) return [];
  const plans: CatalogPlanLike[] = [];
  for (const item of record.plans) {
    if (!item || typeof item !== "object") continue;
    const plan = item as { plan_key?: unknown; display_name?: unknown; max_members?: unknown; products?: unknown };
    if (typeof plan.plan_key !== "string" || typeof plan.display_name !== "string") continue;
    if (!(plan.max_members === null || (typeof plan.max_members === "number" && Number.isInteger(plan.max_members)))) continue;
    if (!Array.isArray(plan.products)) continue;
    const products: CatalogPlanLike["products"] = [];
    for (const entry of plan.products) {
      if (!entry || typeof entry !== "object") continue;
      const product = entry as { billing_interval?: unknown; product_id?: unknown };
      if (isCatalogInterval(product.billing_interval) && typeof product.product_id === "string" && product.product_id !== "") {
        products.push({ billing_interval: product.billing_interval, product_id: product.product_id });
      }
    }
    if (products.length > 0) {
      plans.push({ plan_key: plan.plan_key, display_name: plan.display_name, max_members: plan.max_members, products });
    }
  }
  return plans;
}
