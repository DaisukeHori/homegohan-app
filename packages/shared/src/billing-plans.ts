/**
 * 有料プランの表示の正本 (billing/03 §8.9)。Web (公開の面・契約の画面) とモバイル (購入の画面・究極モードの錠) が
 * `@homegohan/shared` から読む。純粋な TypeScript (import なし・Intl を使わない。React Native の Hermes でも同じ結果になる)。
 *  - プランの説明の箇条書き・価格の写し・AI の回数の表示 (PLAN_CATALOG ほか)。価格の正本は DB (subscription_plans)。ここの価格は
 *    特定商取引法の表記 (静的なページ) に書くための写しで、tests/billing-plan-catalog.test.ts が migration の値と一致することを見る
 *  - ストアの表示名と購読の管理のページ (IAP_STORE_LABELS・STORE_SUBSCRIPTION_MANAGEMENT_URL)・退会の確認の文 (STORE_SUBSCRIPTION_DELETION_NOTICE)
 *  - GET /api/billing/subscription の data の形 (BillingSummaryWire) と、その読み取り (parseBillingSummaryWire)・状態の文 (subscriptionStatusLines)
 * 文に未完成や予定を示す語 (準備中・販売開始前・近日・予定・まだ・確定次第・これから) を書かない。
 */

// ─────────────────────────────────────────────────────────────────────────────
// ストア (src/lib/billing/iap-core.ts の IAP_STORES と同じ 2 値。tests/billing-iap-core.test.ts のテスト 95 が突き合わせる)
// ─────────────────────────────────────────────────────────────────────────────

export const PURCHASE_STORES = ["app_store", "play_store"] as const;
export type PurchaseStore = (typeof PURCHASE_STORES)[number];
export function isPurchaseStore(value: unknown): value is PurchaseStore {
  return typeof value === "string" && (PURCHASE_STORES as readonly string[]).includes(value);
}
/** ストアの表示名 (画面の文) */
export const IAP_STORE_LABELS: Readonly<Record<PurchaseStore, string>> = {
  app_store: "App Store",
  play_store: "Google Play",
};
/** ストアの購読の管理のページ (RevenueCat の CustomerInfo.managementURL が null のときと、Web の契約の画面の行き先) */
export const STORE_SUBSCRIPTION_MANAGEMENT_URL: Readonly<Record<PurchaseStore, string>> = {
  app_store: "https://apps.apple.com/account/subscriptions",
  play_store: "https://play.google.com/store/account/subscriptions",
};
/**
 * 退会の確認に出す固定の文 (billing/03 §10.4)。ストアの購読はストアが契約の主体で、当社の退会では解約されない。
 * 退会の API を呼ぶ 4 つの入口 (Web の設定・凍結中と同意の前の退会の共通の部品 (`/frozen/account`・`/legal-consent/account`)・規約の同意の画面の「登録をやめる」・アプリの設定のアカウント) が出す。
 * ストアの契約が無い人にも出す (退会の時に契約の有無を読みに行かない)
 */
export const STORE_SUBSCRIPTION_DELETION_NOTICE =
  "App Store / Google Play でお申し込みの有料プランは、退会しても自動では解約されません。各ストアの定期購読の管理から解約してください。";

// ─────────────────────────────────────────────────────────────────────────────
// プランの説明 (Q-2・Q-3・Q-4・Q-16 の確定値 (発注者の選択 2026-10-19。§0.4 の追記 3)。値を変えるときは、この節の数と migration の値を一緒に変える)
// ─────────────────────────────────────────────────────────────────────────────

export const PAID_PLAN_KEYS = ["pro", "family_basic", "family_pro"] as const;
export type PaidPlanKey = (typeof PAID_PLAN_KEYS)[number];

export interface PlanCatalogEntry {
  plan_key: PaidPlanKey;
  display_name: string;
  monthly_price_jpy: number;
  yearly_price_jpy: number;
  trial_days: number;
  /** 家族の人数の上限 (個人は null) */
  max_members: number | null;
  /** 画面に出す内容の箇条書き (無料との違い) */
  features: readonly string[];
}

/** AI の 1 日の回数 (Q-2 の確定値。ai_daily_limits の既定の行と同じ値。tests/billing-plan-catalog.test.ts が突き合わせる) */
export const PLAN_AI_DAILY_LIMITS = { free: 3, pro: 30, family_basic: 30, family_pro: 50 } as const;
/** 究極モードの 1 日の回数 (Q-3 の確定値。ai_plan_feature_caps の既定の行と同じ値) */
export const PLAN_ULTIMATE_DAILY_CAPS = { free: 0, pro: 2, family_basic: 2, family_pro: 3 } as const;
/** 献立の作成と作り直し (menu_generation) の 1 日の回数 (Q-3 の確定値。ai_plan_feature_caps の既定の行と同じ値。無料は 1 日の合計 (PLAN_AI_DAILY_LIMITS.free) と同じ値) */
export const PLAN_MENU_GENERATION_DAILY_CAPS = { free: 3, pro: 10, family_basic: 10, family_pro: 15 } as const;
/** 有料プランの無料体験の日数 (§0.4 の決定。subscription_plans.trial_days の既定の値と同じ。Web の Checkout の体験の日数) */
export const PLAN_TRIAL_DAYS = 7;
/** 家族の人数の上限 (subscription_plans.max_members の値と同じ) */
export const FAMILY_PLAN_MAX_MEMBERS = { family_basic: 4, family_pro: 8 } as const;

/**
 * 有料プランの料理画像の説明 (meal_image_auto と image_generation。無料では作らない。Q-3)。自動で作るのは、記録した献立と AI が作った献立の
 * 主菜の 1 品だけ (Q-16。主菜の無い献立は先頭の料理)。献立の画像は、献立の編集の「AIで画像生成」からも作れる (image_generation。Q-18)
 */
const PAID_MEAL_IMAGE_FEATURE = "料理画像の作成 (記録した献立と AI が作った献立の主菜の画像を AI が作ります)";

export const PLAN_CATALOG: readonly PlanCatalogEntry[] = [
  {
    plan_key: "pro",
    display_name: "個人 Pro",
    monthly_price_jpy: 580,
    yearly_price_jpy: 5800,
    trial_days: PLAN_TRIAL_DAYS,
    max_members: null,
    features: [
      `AI を使う機能を 1 日 ${PLAN_AI_DAILY_LIMITS.pro} 回まで (無料プランは ${PLAN_AI_DAILY_LIMITS.free} 回)`,
      `献立の作成と作り直しを 1 日 ${PLAN_MENU_GENERATION_DAILY_CAPS.pro} 回まで (無料プランは ${PLAN_MENU_GENERATION_DAILY_CAPS.free} 回)`,
      `究極モード (AI が献立を見直して栄養バランスを改善) を 1 日 ${PLAN_ULTIMATE_DAILY_CAPS.pro} 回まで`,
      PAID_MEAL_IMAGE_FEATURE,
    ],
  },
  {
    plan_key: "family_basic",
    display_name: "家族 Basic",
    monthly_price_jpy: 980,
    yearly_price_jpy: 9800,
    trial_days: PLAN_TRIAL_DAYS,
    max_members: FAMILY_PLAN_MAX_MEMBERS.family_basic,
    features: [
      `家族グループ (${FAMILY_PLAN_MAX_MEMBERS.family_basic} 人まで)。家族の献立の表示・共有の設定・子供の記録`,
      `メンバー 1 人ごとに AI を使う機能を 1 日 ${PLAN_AI_DAILY_LIMITS.family_basic} 回まで`,
      `献立の作成と作り直しを 1 日 ${PLAN_MENU_GENERATION_DAILY_CAPS.family_basic} 回まで・究極モードを 1 日 ${PLAN_ULTIMATE_DAILY_CAPS.family_basic} 回まで`,
      PAID_MEAL_IMAGE_FEATURE,
    ],
  },
  {
    plan_key: "family_pro",
    display_name: "家族 Pro",
    monthly_price_jpy: 1480,
    yearly_price_jpy: 14800,
    trial_days: PLAN_TRIAL_DAYS,
    max_members: FAMILY_PLAN_MAX_MEMBERS.family_pro,
    features: [
      `家族グループ (${FAMILY_PLAN_MAX_MEMBERS.family_pro} 人まで)。家族の献立の表示・共有の設定・子供の記録`,
      `メンバー 1 人ごとに AI を使う機能を 1 日 ${PLAN_AI_DAILY_LIMITS.family_pro} 回まで`,
      `献立の作成と作り直しを 1 日 ${PLAN_MENU_GENERATION_DAILY_CAPS.family_pro} 回まで・究極モードを 1 日 ${PLAN_ULTIMATE_DAILY_CAPS.family_pro} 回まで`,
      PAID_MEAL_IMAGE_FEATURE,
    ],
  },
];

/** 無料プランでできること (料金ページのフリーのカード・FAQ。実際にある機能だけ) */
export const FREE_PLAN_FEATURES: readonly string[] = [
  "写真で食事の記録 (AI が料理を認識して栄養を推定)",
  "記録をほめるひと言 (記録コメント) と栄養メモ",
  `献立の作成と作り直し (1 日 ${PLAN_MENU_GENERATION_DAILY_CAPS.free} 回まで)`,
  "健康の記録",
  "バッジ",
  "過去の記録の閲覧",
];
/**
 * 無料プランの AI の 1 日の回数の文 (料金ページのフリーのカード・FAQ)。前半は #1867 の Q-12 の共通の文
 * (「1日にご利用いただける回数に上限があり、上限に達した日は翌日0時からまたお使いいただけます。」。tests/public-claims-guard.test.ts の
 * AI_DAILY_LIMIT_PHRASE) を逐語で含め、後半に無料プランの回数 (PLAN_AI_DAILY_LIMITS.free) を書く
 */
export const FREE_PLAN_AI_LIMIT_NOTE = `AIを使う機能（写真の解析や献立の作成など）は、1日にご利用いただける回数に上限があり、上限に達した日は翌日0時からまたお使いいただけます。無料プランの上限は1日${PLAN_AI_DAILY_LIMITS.free}回です。`;
/** 有料プランで増えるものの 1 文 (FAQ・紹介ページの要点と料金の章と FAQ。PLAN_CATALOG の features と同じ範囲。§10.5) */
export const PAID_PLAN_SUMMARY = "有料プランでは、AI を使う回数の上限が上がり、究極モード・料理画像の作成・家族グループが使えます。";

/** 金額の 3 桁区切り (Intl を使わない。"5,800円") */
const THOUSANDS_GROUP = 3;
export function formatJpy(amount: number): string {
  const digits = String(Math.trunc(Math.abs(amount)));
  const groups: string[] = [];
  for (let end = digits.length; end > 0; end -= THOUSANDS_GROUP) groups.unshift(digits.slice(Math.max(0, end - THOUSANDS_GROUP), end));
  return `${amount < 0 ? "-" : ""}${groups.join(",")}円`;
}

/** 特定商取引法の表記の「販売価格」の文 (税込。§10.2) */
export function planCatalogPriceText(): string {
  return PLAN_CATALOG.map(
    (plan) =>
      `${plan.display_name}: 月額 ${formatJpy(plan.monthly_price_jpy)} / 年額 ${formatJpy(plan.yearly_price_jpy)} (税込)${plan.max_members === null ? "" : `・${plan.max_members} 人まで`}`,
  ).join("\n");
}

/** /faq と料金の案内の「料金はかかりますか？」の答え (§10.5)。無料プランの範囲・回数の上限・有料で増えるもの */
export const FREE_PLAN_FAQ_ANSWER = `無料プランでは、写真での食事の記録、記録をほめるひと言、献立の作成、健康の記録などをお使いいただけます。${FREE_PLAN_AI_LIMIT_NOTE}${PAID_PLAN_SUMMARY}`;

/** /faq の「有料プランはありますか？」の答え (§10.5)。価格は PLAN_CATALOG から組む (価格を変えたら一緒に変わる) */
export const PAID_PLANS_FAQ_ANSWER = `${PLAN_CATALOG.map(
  (plan) =>
    `${plan.display_name} (月額 ${formatJpy(plan.monthly_price_jpy)} / 年額 ${formatJpy(plan.yearly_price_jpy)}${plan.max_members === null ? "" : `・${plan.max_members} 人まで`})`,
).join("、")}があります。Web でお申し込みの場合、どのプランも ${PLAN_TRIAL_DAYS} 日間の無料体験つきです (同じプランにつき 1 回)。App Store・Google Play でお申し込みの場合の無料体験は、各ストアの表示によります。`;

/** free の plan_key の表示名 */
export const FREE_PLAN_DISPLAY_NAME = "無料プラン";
/**
 * 組織のプランの値の表示名 (#1912)。組織のプランの値 (isOrgPlanKey) は内部の値 (plan_key) を利用者の画面に出さず、この固定の名前を出す
 */
export const ORG_PLAN_DISPLAY_NAME = "組織のプラン";
/**
 * PLAN_CATALOG にも free にも無く、組織のプランの値でもない plan_key の表示名 (#1912)。private の家族の追加枠 (family_addon) や、
 * 運営の画面で新しく作った個人・家族のプラン (Stripe の price が付けば買え、手動の付与もできる) が契約の plan_key になったときに出す。
 * 内部の値 (plan_key) は利用者の画面に出さない
 */
export const PAID_PLAN_GENERIC_DISPLAY_NAME = "有料プラン";
/**
 * organizations.plan に書ける値 (#1912)。正本は src/lib/org-plans.ts の ORG_PLAN_VALUES。shared は src を import できない
 * (依存の向きは src → shared だけ) ので同じ一覧の写しを持ち、tests/billing-plan-display-name.test.ts が正本と一致することを見る
 */
export const ORG_PLAN_VALUES_WIRE = ["standard", "premium", "enterprise"] as const;
/** subscription_plans の plan_type = 'org' の行の plan_key の接頭辞 (org_starter・org_standard など。get_effective_plan が組織の利用者にそのまま返す) */
export const ORG_SUBSCRIPTION_PLAN_KEY_PREFIX = "org_";
/**
 * 組織のプランの値か (#1912)。organizations.plan の値 (ORG_PLAN_VALUES_WIRE) と、subscription_plans の plan_type = 'org' の行の
 * plan_key (ORG_SUBSCRIPTION_PLAN_KEY_PREFIX で始まる key)
 */
export function isOrgPlanKey(planKey: string): boolean {
  return (ORG_PLAN_VALUES_WIRE as readonly string[]).includes(planKey) || planKey.startsWith(ORG_SUBSCRIPTION_PLAN_KEY_PREFIX);
}
/** PLAN_CATALOG にある (表示名と説明を持つ有料の) plan_key か */
export function isCatalogPlanKey(planKey: string): planKey is PaidPlanKey {
  return PLAN_CATALOG.some((plan) => plan.plan_key === planKey);
}
/**
 * plan_key の利用者向けの表示名。free は「無料プラン」、PLAN_CATALOG にある key はその display_name、
 * 組織のプランの値 (isOrgPlanKey) は ORG_PLAN_DISPLAY_NAME、それ以外 (家族の追加枠・運営が新しく作った個人や家族のプラン・未知の値) は
 * PAID_PLAN_GENERIC_DISPLAY_NAME (内部の値をそのまま返さない。#1912)。
 * 運営の画面など生の plan_key を見せたいところは、この関数を通さず key を直接出す
 */
export function planDisplayName(planKey: string): string {
  if (planKey === "free") return FREE_PLAN_DISPLAY_NAME;
  const catalogName = PLAN_CATALOG.find((plan) => plan.plan_key === planKey)?.display_name;
  if (catalogName !== undefined) return catalogName;
  return isOrgPlanKey(planKey) ? ORG_PLAN_DISPLAY_NAME : PAID_PLAN_GENERIC_DISPLAY_NAME;
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/billing/subscription・POST /api/billing/iap/sync の data の形 (src/lib/billing/core.ts の BillingSummary と同じ形。
// tests/billing-summary-wire.test.ts のテスト 94 が型と値で突き合わせる)
// ─────────────────────────────────────────────────────────────────────────────

export const SUBSCRIPTION_STATUSES_WIRE = ["incomplete", "trialing", "active", "paused", "cancelled", "expired", "past_due", "grace"] as const;
export type SubscriptionStatusWire = (typeof SUBSCRIPTION_STATUSES_WIRE)[number];
export const BILLING_SOURCES_WIRE = ["stripe", "manual", "app_store", "play_store"] as const;
export type BillingSourceWire = (typeof BILLING_SOURCES_WIRE)[number];
export const BILLING_INTERVALS_WIRE = ["month", "year"] as const;
export type BillingIntervalWire = (typeof BILLING_INTERVALS_WIRE)[number];

export interface PlanFeaturesWire {
  ai_daily_limit: number | null;
  ai_feature_caps: Record<string, number | null>;
}

export interface BillingSummaryWire {
  plan_key: string;
  effective_plan_key: string;
  status: SubscriptionStatusWire | null;
  source: BillingSourceWire | null;
  manage_in_store: PurchaseStore | null;
  billing_interval: BillingIntervalWire | null;
  current_period_end: string | null;
  trial_ends_at: string | null;
  cancel_at_period_end: boolean;
  cancel_at: string | null;
  has_customer: boolean;
  can_purchase: boolean;
  can_cancel: boolean;
  can_resume: boolean;
  features: PlanFeaturesWire;
}

const isStringOrNull = (value: unknown): value is string | null => value === null || typeof value === "string";
const isIntOrNull = (value: unknown): value is number | null => value === null || (typeof value === "number" && Number.isInteger(value));
function isOneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}

function parsePlanFeaturesWire(value: unknown): PlanFeaturesWire | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (!isIntOrNull(record.ai_daily_limit)) return null;
  const caps = record.ai_feature_caps;
  if (!caps || typeof caps !== "object" || Array.isArray(caps)) return null;
  const featureCaps: Record<string, number | null> = {};
  for (const [feature, cap] of Object.entries(caps as Record<string, unknown>)) {
    if (!isIntOrNull(cap)) return null;
    featureCaps[feature] = cap;
  }
  return { ai_daily_limit: record.ai_daily_limit, ai_feature_caps: featureCaps };
}

/** API の data を BillingSummaryWire として読む。形が違えば null (画面は「契約の状態を読み込めませんでした」) */
export function parseBillingSummaryWire(data: unknown): BillingSummaryWire | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const r = data as Record<string, unknown>;
  const features = parsePlanFeaturesWire(r.features);
  if (
    typeof r.plan_key !== "string" ||
    typeof r.effective_plan_key !== "string" ||
    !(r.status === null || isOneOf(SUBSCRIPTION_STATUSES_WIRE, r.status)) ||
    !(r.source === null || isOneOf(BILLING_SOURCES_WIRE, r.source)) ||
    !(r.manage_in_store === null || isPurchaseStore(r.manage_in_store)) ||
    !(r.billing_interval === null || isOneOf(BILLING_INTERVALS_WIRE, r.billing_interval)) ||
    !isStringOrNull(r.current_period_end) ||
    !isStringOrNull(r.trial_ends_at) ||
    typeof r.cancel_at_period_end !== "boolean" ||
    !isStringOrNull(r.cancel_at) ||
    typeof r.has_customer !== "boolean" ||
    typeof r.can_purchase !== "boolean" ||
    typeof r.can_cancel !== "boolean" ||
    typeof r.can_resume !== "boolean" ||
    features === null
  ) {
    return null;
  }
  return {
    plan_key: r.plan_key,
    effective_plan_key: r.effective_plan_key,
    status: r.status,
    source: r.source,
    manage_in_store: r.manage_in_store,
    billing_interval: r.billing_interval,
    current_period_end: r.current_period_end,
    trial_ends_at: r.trial_ends_at,
    cancel_at_period_end: r.cancel_at_period_end,
    cancel_at: r.cancel_at,
    has_customer: r.has_customer,
    can_purchase: r.can_purchase,
    can_cancel: r.can_cancel,
    can_resume: r.can_resume,
    features,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 契約の状態の文 (src/lib/billing/core.ts の billingStatusLines と同じ文。モバイルの購入の画面が使う。
// tests/billing-status-lines-parity.test.ts のテスト 93 が、live の 5 値 × 解約の予約の有無 × 日付の有無で両者の一致を見る)
// ─────────────────────────────────────────────────────────────────────────────

/** live な 5 値の 1 行目の文 (core.ts の BILLING_STATUS_TEXT と同じ) */
export const SUBSCRIPTION_STATUS_TEXT_WIRE = {
  trialing: "無料期間中",
  active: "ご利用中",
  past_due: "お支払いに問題があります。お支払い方法をご確認ください",
  grace: "お支払いが確認できないため一部の機能を制限しています",
  paused: "一時停止中",
} as const;
type LiveStatusWire = keyof typeof SUBSCRIPTION_STATUS_TEXT_WIRE;
const LIVE_STATUSES_WIRE: readonly LiveStatusWire[] = ["trialing", "active", "past_due", "grace", "paused"];
/** 解約の予約で日付が無いときの文 (core.ts の BILLING_CANCEL_SCHEDULED_WITHOUT_DATE_TEXT と同じ) */
export const CANCEL_SCHEDULED_WITHOUT_DATE_TEXT_WIRE = "期間の終わりに解約されます";

/** 日本時間の UTC からのずれ (ミリ秒)。日本は夏時間が無い */
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
/** Date の月 (0 始まり) を暦の月にする */
const MONTH_INDEX_OFFSET = 1;

/** ISO の日時を日本時間の日付「2026年10月21日」にする (Intl を使わない)。null・日時として読めない値は null */
export function formatBillingDateWire(iso: string | null): string | null {
  if (iso === null) return null;
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return null;
  const jst = new Date(time + JST_OFFSET_MS);
  return `${jst.getUTCFullYear()}年${jst.getUTCMonth() + MONTH_INDEX_OFFSET}月${jst.getUTCDate()}日`;
}

/**
 * 契約の状態の文 (core.ts の billingStatusLines と同じ規則)。1 行目 = status の文 (trialing は「無料期間中（X まで）」)、
 * 2 行目 = 解約の予約中なら「X に解約されます」(日付 = cancel_at、無ければ current_period_end)。live でなければ空
 */
export function subscriptionStatusLines(
  summary: Pick<BillingSummaryWire, "status" | "trial_ends_at" | "current_period_end" | "cancel_at_period_end" | "cancel_at">,
): string[] {
  const status = LIVE_STATUSES_WIRE.find((value) => value === summary.status);
  if (status === undefined) return [];
  const trialEnd = status === "trialing" ? formatBillingDateWire(summary.trial_ends_at) : null;
  const lines = [trialEnd === null ? SUBSCRIPTION_STATUS_TEXT_WIRE[status] : `${SUBSCRIPTION_STATUS_TEXT_WIRE[status]}（${trialEnd}まで）`];
  if (summary.cancel_at_period_end) {
    const cancelDate = formatBillingDateWire(summary.cancel_at ?? summary.current_period_end);
    lines.push(cancelDate === null ? CANCEL_SCHEDULED_WITHOUT_DATE_TEXT_WIRE : `${cancelDate}に解約されます`);
  }
  return lines;
}
