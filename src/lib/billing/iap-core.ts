/**
 * アプリ内課金 (billing/03) の定数・Zod・型・純関数・ポート。I/O を持たない (fetch / DB / env を読まない)。
 * import してよいのは zod だけ (tests/billing-iap-core.test.ts が見張る)。
 */
import { z } from 'zod';

// ─────────────────────────────────────────────────────────────────────────────
// 定数 (根拠つき)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 本冊が扱うストア (personal_subscriptions.iap_store / plan_store_products.store の CHECK と同じ 2 値)。
 * 画面が使う表示名と管理のページ (IAP_STORE_LABELS・STORE_SUBSCRIPTION_MANAGEMENT_URL) は packages/shared/src/billing-plans.ts
 * (Web とモバイルが読む)。その PURCHASE_STORES とこの一覧が同じことを tests/billing-iap-core.test.ts (テスト 95) が見る
 */
export const IAP_STORES = ['app_store', 'play_store'] as const;
export type IapStore = (typeof IAP_STORES)[number];
export function isIapStore(value: string): value is IapStore {
  return (IAP_STORES as readonly string[]).includes(value);
}
/** RevenueCat の customer info の subscriptions[].store の値 → 本冊のストア (それ以外 (promotional / stripe / amazon …) は扱わない) */
export const REVENUECAT_STORE_TO_IAP_STORE: Readonly<Record<string, IapStore>> = {
  app_store: 'app_store',
  play_store: 'play_store',
};

/** RevenueCat REST API v1 (GET /subscribers/{app_user_id}。認証は Authorization: Bearer <secret API key>) */
export const REVENUECAT_API_BASE_URL = 'https://api.revenuecat.com/v1';
/** Webhook の本文の api_version (RevenueCat は項目の追加を版を変えずに行うので、違う値は warn して処理を続ける) */
export const REVENUECAT_WEBHOOK_API_VERSION = '1.0';
/** 署名のヘッダー (小文字で読む)。形は `t=<unix 秒>,v1=<HMAC-SHA256 hex>`、署名の対象は `<t>.<生の本文>` */
export const REVENUECAT_SIGNATURE_HEADER = 'x-revenuecat-webhook-signature';
/** Webhook の本文の上限 (バイト)。イベントは数 KB (subscriber_attributes を含めても数十 KB)。Resend の受け口と同じ 256 KiB */
export const REVENUECAT_WEBHOOK_MAX_BODY_BYTES = 256 * 1024;
/** processing のままこの時間を過ぎたイベントは、再送で再び処理の権利を取れる (billing_claim_revenuecat_event の p_stuck_after。核と同じ値) */
export const REVENUECAT_EVENT_STUCK_MINUTES = 15;
/** Webhook の route の最長実行時間 (秒)。RevenueCat の取り直し (利用者 1〜2 人) + RPC が収まる値。route には同じ値をリテラルで書く (核と同じ理由) */
export const REVENUECAT_WEBHOOK_MAX_DURATION_SECONDS = 30;
/** 1 回の RevenueCat API 呼び出しの上限 (ms)。maxDuration の中に取り直し 2 回 + RPC が収まる値 */
export const REVENUECAT_REQUEST_TIMEOUT_MS = 10_000;
/** revenuecat_webhook_events.error_message に残す長さ (固定のコードだけ) */
export const REVENUECAT_EVENT_ERROR_MAX_CHARS = 500;
/** 期限を過ぎたストアの行を読むときの再同期の間隔 (ms)。読むたびに RevenueCat を呼ばない下限 (5 分 = SDK のキャッシュの更新と同じ値) */
export const IAP_LAZY_RESYNC_MIN_INTERVAL_MS = 5 * 60 * 1000;
/** RevenueCat の Offering の識別子 (Dashboard で作る 1 つだけ。§17) */
export const REVENUECAT_OFFERING_ID = 'default';
/** 写像の p_source */
export const IAP_SYNC_SOURCE = 'iap_sync';
export const IAP_LAZY_RESYNC_SOURCE = 'iap_lazy_resync';
export function revenueCatWebhookSource(eventId: string): string {
  return `revenuecat:${eventId}`;
}
/**
 * 同じグループの新しい購読に置き換えられた購読を終わらせる写像の p_source の後ろに付ける印 (§7.3 の「同じグループの 2 つの live」の行)。
 * 監査 (system.billing.subscription_status_changed) の details.source で、置き換えによる終わりを見分ける (§13.3 の運営の処置)
 */
export const IAP_SUPERSEDED_SOURCE_SUFFIX = ':superseded';
export function supersededStoreSource(source: string): string {
  return `${source}${IAP_SUPERSEDED_SOURCE_SUFFIX}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// イベントの振り分け (すべて「取り直しの合図」。遷移は取り直した姿で決まる。§7.3)
// ─────────────────────────────────────────────────────────────────────────────

export type RevenueCatEventAction = 'sync' | 'sync_transfer' | 'ignore';
/** 一次情報 (RevenueCat の event types) の全 21 種。知らない種類は sync (app_user_id があれば取り直す。無ければ ignored) */
export const REVENUECAT_EVENT_ACTIONS = {
  TEST: 'ignore',
  INITIAL_PURCHASE: 'sync',
  RENEWAL: 'sync',
  CANCELLATION: 'sync',
  UNCANCELLATION: 'sync',
  NON_RENEWING_PURCHASE: 'sync',
  SUBSCRIPTION_PAUSED: 'sync',
  EXPIRATION: 'sync',
  BILLING_ISSUE: 'sync',
  PRODUCT_CHANGE: 'sync',
  SUBSCRIPTION_EXTENDED: 'sync',
  REFUND_REVERSED: 'sync',
  INVOICE_ISSUANCE: 'ignore',
  TRANSFER: 'sync_transfer',
  TEMPORARY_ENTITLEMENT_GRANT: 'sync',
  VIRTUAL_CURRENCY_TRANSACTION: 'ignore',
  EXPERIMENT_ENROLLMENT: 'ignore',
  PURCHASE_REDEEMED: 'sync',
  SUBSCRIBER_ALIAS: 'ignore',
  PRICE_INCREASE_CONSENT_REQUIRED: 'ignore',
  PRICE_INCREASE_CONSENT_APPROVED: 'ignore',
} as const satisfies Record<string, RevenueCatEventAction>;
export const REVENUECAT_EVENT_TYPES = Object.keys(REVENUECAT_EVENT_ACTIONS) as ReadonlyArray<keyof typeof REVENUECAT_EVENT_ACTIONS>;

export function classifyRevenueCatEvent(eventType: string): RevenueCatEventAction {
  const table: Readonly<Record<string, RevenueCatEventAction>> = REVENUECAT_EVENT_ACTIONS;
  return Object.hasOwn(table, eventType) ? table[eventType] : 'sync';
}

// ─────────────────────────────────────────────────────────────────────────────
// 監査 (admin_audit_logs.action_type)。状態の変化は写像が核と同じ名前で書く。ここは Webhook の失敗だけ
// ─────────────────────────────────────────────────────────────────────────────

export const IAP_AUDIT_ACTIONS = ['system.revenuecat.event_failed'] as const;
export type IapAuditAction = (typeof IAP_AUDIT_ACTIONS)[number];
export interface IapAuditEntry {
  actor_id: null;
  action_type: IapAuditAction;
  target_type: 'revenuecat_event';
  target_id: null;
  severity: 'warn';
  /** { event_id, event_type, error_code } だけ (個人情報を入れない) */
  details: { event_id: string; event_type: string; error_code: string };
}

// ─────────────────────────────────────────────────────────────────────────────
// エラー (応答の本文は固定の文。未完成や予定を示す語 (準備中・まだ・近日・予定 など) を使わない。R3)
// ─────────────────────────────────────────────────────────────────────────────

export const IAP_ERROR_HTTP_STATUS = {
  BILL_IAP_INVALID_INPUT: 400,
  BILL_IAP_UNKNOWN_PRODUCT: 422,
  BILL_IAP_SYNC_CONFLICT: 409,
  EXT_REVENUECAT_NOT_CONFIGURED: 503,
  EXT_REVENUECAT_API_FAILED: 502,
} as const;
export type IapErrorCode = keyof typeof IAP_ERROR_HTTP_STATUS;

export const IAP_ERROR_MESSAGES: Readonly<Record<IapErrorCode, string>> = {
  BILL_IAP_INVALID_INPUT: '入力値が不正です',
  BILL_IAP_UNKNOWN_PRODUCT: 'この購入をご利用のプランに結び付けられませんでした。お問い合わせフォームからご連絡ください',
  BILL_IAP_SYNC_CONFLICT:
    'すでに別のご契約があるため、この購入をご利用のプランに反映できませんでした。お問い合わせフォームからご連絡ください。二重のお支払いにならないよう対応します',
  EXT_REVENUECAT_NOT_CONFIGURED: '購入の確認を完了できませんでした。時間をおいてお試しください',
  EXT_REVENUECAT_API_FAILED: '購入の確認サービスとの通信に失敗しました。しばらくしてからお試しください',
};

export class IapError extends Error {
  readonly code: IapErrorCode;
  constructor(code: IapErrorCode) {
    super(IAP_ERROR_MESSAGES[code]);
    this.name = 'IapError';
    this.code = code;
  }
}

/** REVENUECAT_SECRET_API_KEY が無い (503)。message に変数名を入れない */
export class RevenueCatNotConfiguredError extends Error {
  constructor() {
    super('購入の確認サービスの設定がありません');
    this.name = 'RevenueCatNotConfiguredError';
  }
}

/**
 * RevenueCat の REST が 2xx 以外を返した・応答の形が違った・届かなかった (時間切れ・接続の失敗。status = null) (502)。
 * 生の文面は rawMessage に持ち、ログにだけ残す
 */
export class RevenueCatApiError extends Error {
  readonly status: number | null;
  readonly rawMessage: string | null;
  constructor(input: { status: number | null; rawMessage?: string | null }) {
    super('RevenueCat API の呼び出しに失敗しました');
    this.name = 'RevenueCatApiError';
    this.status = input.status;
    this.rawMessage = input.rawMessage ?? null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// RevenueCat のオブジェクト (本冊が読む項目だけ。looseObject = 知らない項目は捨てずに通す)
// ─────────────────────────────────────────────────────────────────────────────

const IsoDateTime = z.string().min(1);

/** Webhook の event (一次情報の項目のうち本冊が読むもの) */
export const RevenueCatEventSchema = z.looseObject({
  id: z.string().min(1),
  type: z.string().min(1),
  app_id: z.string().optional(),
  event_timestamp_ms: z.number().int(),
  app_user_id: z.string().optional(),
  original_app_user_id: z.string().optional(),
  aliases: z.array(z.string()).optional(),
  product_id: z.string().optional(),
  store: z.string().optional(),
  environment: z.string().optional(),
  transferred_from: z.array(z.string()).optional(),
  transferred_to: z.array(z.string()).optional(),
});
export type RevenueCatEvent = z.infer<typeof RevenueCatEventSchema>;

export const RevenueCatWebhookEnvelopeSchema = z.looseObject({
  api_version: z.string(),
  event: RevenueCatEventSchema,
});
export type RevenueCatWebhookEnvelope = z.infer<typeof RevenueCatWebhookEnvelopeSchema>;

/** GET /v1/subscribers の subscriptions[<product_id>] */
export const RevenueCatSubscriptionSchema = z.looseObject({
  expires_date: IsoDateTime.nullable().optional(),
  purchase_date: IsoDateTime,
  original_purchase_date: IsoDateTime.nullable().optional(),
  period_type: z.string(),
  store: z.string(),
  is_sandbox: z.boolean().optional(),
  unsubscribe_detected_at: IsoDateTime.nullable().optional(),
  billing_issues_detected_at: IsoDateTime.nullable().optional(),
  grace_period_expires_date: IsoDateTime.nullable().optional(),
  auto_resume_date: IsoDateTime.nullable().optional(),
  refunded_at: IsoDateTime.nullable().optional(),
  store_transaction_id: z.union([z.string(), z.number()]).nullable().optional(),
  ownership_type: z.string().optional(),
});
export type RevenueCatSubscription = z.infer<typeof RevenueCatSubscriptionSchema>;

export const RevenueCatSubscriberSchema = z.looseObject({
  original_app_user_id: z.string(),
  first_seen: IsoDateTime.optional(),
  management_url: z.string().nullable().optional(),
  subscriptions: z.record(z.string(), RevenueCatSubscriptionSchema),
});
export const RevenueCatCustomerInfoSchema = z.looseObject({
  request_date: IsoDateTime,
  request_date_ms: z.number().int().optional(),
  subscriber: RevenueCatSubscriberSchema,
});
export type RevenueCatCustomerInfo = z.infer<typeof RevenueCatCustomerInfoSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// app_user_id = Supabase の auth.users.id (UUID)。匿名 ID ($RCAnonymousID:…) は当社の利用者ではないので無視する (R10)
// ─────────────────────────────────────────────────────────────────────────────

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isUserAppUserId(value: string | undefined | null): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

/** イベントから、取り直す利用者 (app_user_id) の一覧。sync は 1 人、TRANSFER は移動元と移動先の全員、ignore は空 */
export function appUserIdsToSync(event: RevenueCatEvent): string[] {
  const action = classifyRevenueCatEvent(event.type);
  if (action === 'ignore') return [];
  const candidates =
    action === 'sync_transfer' ? [...(event.transferred_from ?? []), ...(event.transferred_to ?? [])] : [event.app_user_id];
  const unique = new Set<string>();
  for (const id of candidates) if (isUserAppUserId(id)) unique.add(id.toLowerCase());
  return [...unique];
}

// ─────────────────────────────────────────────────────────────────────────────
// 商品の対応 (plan_store_products の行) と、取り直した契約 → snapshot (billing_apply_store_subscription の p_snapshot)
// ─────────────────────────────────────────────────────────────────────────────

export const IAP_BILLING_INTERVALS = ['month', 'year'] as const;
export type IapBillingInterval = (typeof IAP_BILLING_INTERVALS)[number];

export interface PlanStoreProductRow {
  plan_key: string;
  store: IapStore;
  billing_interval: IapBillingInterval;
  product_id: string;
  /** true = いま売る商品 (カタログに出す)。false = 購入の履歴の商品として plan_key・間隔を引くためだけに残す行 (§6.3) */
  offered: boolean;
}

/** ストアの行が取る status (核の 8 値のうち 5 つ。§6.4) */
export const STORE_SUBSCRIPTION_STATUSES = ['trialing', 'active', 'past_due', 'cancelled', 'expired'] as const;
export type StoreSubscriptionStatus = (typeof STORE_SUBSCRIPTION_STATUSES)[number];
export const LIVE_STORE_SUBSCRIPTION_STATUSES = ['trialing', 'active', 'past_due'] as const satisfies readonly StoreSubscriptionStatus[];
export function isLiveStoreStatus(status: StoreSubscriptionStatus): boolean {
  return (LIVE_STORE_SUBSCRIPTION_STATUSES as readonly string[]).includes(status);
}

/**
 * interface ではなく type にする: 生成された型 Json (RPC の p_snapshot) にそのまま代入できるように (核の SubscriptionSnapshot と同じ理由)
 */
export type StoreSubscriptionSnapshot = {
  user_id: string;
  iap_store: IapStore;
  iap_product_id: string;
  /** plan_store_products から引いた plan_key。無ければ null (SQL は既存の行があればその plan_key、無ければ BILL_UNKNOWN_PLAN) */
  plan_key: string | null;
  billing_interval: IapBillingInterval | null;
  iap_status: StoreSubscriptionStatus;
  is_sandbox: boolean;
  purchase_date: string;
  original_purchase_date: string | null;
  expires_date: string | null;
  cancel_at_period_end: boolean;
  refunded_at: string | null;
  store_transaction_id: string | null;
};

const RC_PERIOD_TYPE_TRIAL = 'trial';

function parseMs(value: string | null | undefined): number | null {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * 取り直した契約の姿 → status (§7.3 の規則)。
 * ストアの猶予期間 (grace period) の間は expires_date を過ぎていても権利が続く (P13)。そのときは grace_period_expires_date が
 * いまより先なので past_due にする (権利あり・お支払いの問題の文)。猶予が無いか尽きたら expired
 */
export function deriveStoreStatus(sub: RevenueCatSubscription, nowMs: number): StoreSubscriptionStatus {
  if (parseMs(sub.refunded_at) !== null) return 'cancelled';
  const expiresMs = parseMs(sub.expires_date);
  if (expiresMs === null) return 'active';
  if (expiresMs > nowMs) {
    if (parseMs(sub.billing_issues_detected_at) !== null) return 'past_due';
    return sub.period_type.toLowerCase() === RC_PERIOD_TYPE_TRIAL ? 'trialing' : 'active';
  }
  const graceMs = parseMs(sub.grace_period_expires_date);
  if (graceMs !== null && graceMs > nowMs) return 'past_due';
  return 'expired';
}

export interface ProjectStoreSubscriptionInput {
  userId: string;
  store: IapStore;
  productId: string;
  sub: RevenueCatSubscription;
  /** plan_store_products の行 (無ければ null) */
  mapping: PlanStoreProductRow | null;
  /**
   * selectStoreSubscriptions の supersededAt。null でなければ、同じグループの新しい購読に置き換えられた購読として、
   * この時刻を expires_date にした expired の snapshot を作る (§7.3 の「同じグループの 2 つの live」の行)
   */
  supersededAt: string | null;
  nowMs: number;
}

export function projectStoreSubscription(input: ProjectStoreSubscriptionInput): StoreSubscriptionSnapshot {
  const { sub } = input;
  const transactionId = sub.store_transaction_id;
  const status: StoreSubscriptionStatus = input.supersededAt === null ? deriveStoreStatus(sub, input.nowMs) : 'expired';
  return {
    user_id: input.userId,
    iap_store: input.store,
    iap_product_id: input.productId,
    plan_key: input.mapping?.plan_key ?? null,
    billing_interval: input.mapping?.billing_interval ?? null,
    iap_status: status,
    is_sandbox: sub.is_sandbox ?? false,
    purchase_date: sub.purchase_date,
    original_purchase_date: sub.original_purchase_date ?? null,
    expires_date: input.supersededAt ?? sub.expires_date ?? null,
    cancel_at_period_end: parseMs(sub.unsubscribe_detected_at) !== null && status !== 'expired',
    refunded_at: sub.refunded_at ?? null,
    store_transaction_id: transactionId === null || transactionId === undefined ? null : String(transactionId),
  };
}

/**
 * 取り直した subscriptions に無くなった live なストアの行 (TRANSFER で別の利用者へ移った・RevenueCat 側で消えた) を終わらせる snapshot。
 * purchase_date は既存の行の値 (current_period_start か starts_at) を渡す (SQL は purchase_date を必須にしている)。
 * is_sandbox と billing_interval は既存の行の値をそのまま渡す (終わらせても、テストの購入の印と間隔を書き換えない。SQL の UPDATE は
 * snapshot の値で上書きするため)
 */
export function projectMissingSubscription(input: {
  userId: string;
  store: IapStore;
  productId: string;
  planKey: string;
  purchaseDate: string;
  isSandbox: boolean;
  billingInterval: IapBillingInterval | null;
  nowMs: number;
}): StoreSubscriptionSnapshot {
  return {
    user_id: input.userId,
    iap_store: input.store,
    iap_product_id: input.productId,
    plan_key: input.planKey,
    billing_interval: input.billingInterval,
    iap_status: 'expired',
    is_sandbox: input.isSandbox,
    purchase_date: input.purchaseDate,
    original_purchase_date: null,
    expires_date: new Date(input.nowMs).toISOString(),
    cancel_at_period_end: false,
    refunded_at: null,
    store_transaction_id: null,
  };
}

export interface SelectedStoreSubscription {
  productId: string;
  store: IapStore;
  sub: RevenueCatSubscription;
  mapping: PlanStoreProductRow | null;
  /**
   * 同じグループの新しい購読に置き換えられた (権利にしない) なら、置き換えた購読の purchase_date (この購読を終わらせる時刻)。
   * それ以外は null (§7.3 の「同じグループの 2 つの live」の行。S36)
   */
  supersededAt: string | null;
}

/**
 * 同じストアの取り直しに 2 つ以上の商品が live で並ぶとき、新しい 1 つだけを権利にし、ほかを置き換えられた購読として終わらせるストア
 * (§7.3 の「同じグループの 2 つの live」の行・S36)。
 *   - App Store: 本冊の 6 商品は 1 つの Subscription Group (§17.2 の homegohan_plans) にあり、上位への変更と期間が同じ crossgrade は
 *     すぐに効き、体験 (introductory offer) の間の上位への変更では Apple が体験を取り消さずに残す (P18)。2 つの live は二重購読ではない
 *   - Google Play は入れない: 購読の置き換えはアプリの購入の流れからしか始まらず (P18)、当社のアプリは契約中に購入のカードを出さない
 *     (§10.6)。2 つの live は二重購読なので、写像の 5. の BILL_LIVE_ROW_CONFLICT のまま (S25)
 */
export const SUPERSEDE_WITHIN_GROUP_STORES = ['app_store'] as const satisfies readonly IapStore[];

/**
 * 同じグループの live な 2 つの購読のどちらを権利にするかの順 (正の数 = a のほうが新しい = a を権利にする)。
 *   1. purchase_date の新しい方 (上位への変更・crossgrade で新しく始まった購読。更新でも進む)
 *   2. expires_date の遅い方 (無い = 期限なしを最も遅いとする)
 *   3. product_id の辞書順で後ろの方 (同じ取り直しで必ず同じ答えにする)
 */
export function compareStoreSubscriptionRecency(
  a: Pick<SelectedStoreSubscription, 'productId' | 'sub'>,
  b: Pick<SelectedStoreSubscription, 'productId' | 'sub'>,
): number {
  const purchaseA = parseMs(a.sub.purchase_date) ?? 0;
  const purchaseB = parseMs(b.sub.purchase_date) ?? 0;
  if (purchaseA !== purchaseB) return purchaseA - purchaseB;
  const expiresA = parseMs(a.sub.expires_date) ?? Number.POSITIVE_INFINITY;
  const expiresB = parseMs(b.sub.expires_date) ?? Number.POSITIVE_INFINITY;
  if (expiresA !== expiresB) return expiresA < expiresB ? -1 : 1;
  if (a.productId === b.productId) return 0;
  return a.productId < b.productId ? -1 : 1;
}

/**
 * 取り直した subscriptions のうち本冊のストア (app_store / play_store) のものを、適用する順 (live でないもの・置き換えられたものが先、
 * 次に expires_date の早い順) に並べる。SUPERSEDE_WITHIN_GROUP_STORES のストアで live が 2 つ以上なら、compareStoreSubscriptionRecency で
 * 最も新しい 1 つを除いた購読に supersededAt (= 最も新しい購読の purchase_date) を付ける。
 * 順が要る理由: 月額 → 年額の変更 (§7.3 PRODUCT_CHANGE) と同じグループの中の変更 (S36) で、古い行を先に expired にしてから新しい行を
 * 写さないと、写像の 5. が BILL_LIVE_ROW_CONFLICT にする
 */
export function selectStoreSubscriptions(
  info: RevenueCatCustomerInfo,
  products: readonly PlanStoreProductRow[],
  nowMs: number,
): SelectedStoreSubscription[] {
  const byStoreAndProduct = new Map<string, PlanStoreProductRow>();
  for (const row of products) byStoreAndProduct.set(`${row.store}:${row.product_id}`, row);
  const selected: SelectedStoreSubscription[] = [];
  for (const [productId, sub] of Object.entries(info.subscriber.subscriptions)) {
    const store = REVENUECAT_STORE_TO_IAP_STORE[sub.store.toLowerCase()];
    if (store === undefined) continue;
    selected.push({ productId, store, sub, mapping: byStoreAndProduct.get(`${store}:${productId}`) ?? null, supersededAt: null });
  }
  const isLive = (entry: SelectedStoreSubscription): boolean => isLiveStoreStatus(deriveStoreStatus(entry.sub, nowMs));
  for (const store of SUPERSEDE_WITHIN_GROUP_STORES) {
    const live = selected.filter((entry) => entry.store === store && isLive(entry));
    if (live.length < 2) continue;
    const winner = live.reduce((best, entry) => (compareStoreSubscriptionRecency(entry, best) > 0 ? entry : best));
    for (const entry of live) if (entry !== winner) entry.supersededAt = winner.sub.purchase_date;
  }
  const rank = (entry: SelectedStoreSubscription): number => (entry.supersededAt === null && isLive(entry) ? 1 : 0);
  return selected.sort((a, b) => rank(a) - rank(b) || (parseMs(a.sub.expires_date) ?? 0) - (parseMs(b.sub.expires_date) ?? 0));
}

/**
 * plan_store_products に対応の行が無い商品の扱い (S15・S28)。
 *   - 対応の行がある、または利用者の行がすでにある → apply (行があれば SQL がその行の plan_key を使う。§6.4 の 4.)
 *   - 対応の行も利用者の行も無く、置き換えられた購読 (supersededAt あり) → skip (権利にしないので履歴の行を作らない。S36)
 *   - 対応の行も利用者の行も無く、live (trialing / active / past_due) → reject (BILL_IAP_UNKNOWN_PRODUCT。運営が行を足すまで写せない)
 *   - 対応の行も利用者の行も無く、live でない (期限切れ・返金済みの履歴) → skip (履歴の行を作らない。ほかの商品の同期を止めない)
 */
export type UnmappedStoreSubscriptionDecision = 'apply' | 'skip' | 'reject';
export function unmappedStoreSubscriptionDecision(
  entry: Pick<SelectedStoreSubscription, 'sub' | 'mapping' | 'supersededAt'>,
  hasExistingRow: boolean,
  nowMs: number,
): UnmappedStoreSubscriptionDecision {
  if (entry.mapping !== null || hasExistingRow) return 'apply';
  if (entry.supersededAt !== null) return 'skip';
  return isLiveStoreStatus(deriveStoreStatus(entry.sub, nowMs)) ? 'reject' : 'skip';
}

/** 期限を過ぎたストアの行を読むときに、RevenueCat から取り直すか (遅延の再同期。Q-11・S12) */
export function needsLazyResync(
  row: { iap_store: string | null; current_period_end: string | null; iap_synced_at: string | null } | null,
  nowMs: number,
): boolean {
  if (row === null || row.iap_store === null) return false;
  const periodEnd = parseMs(row.current_period_end);
  if (periodEnd === null || periodEnd > nowMs) return false;
  const synced = parseMs(row.iap_synced_at);
  return synced === null || nowMs - synced >= IAP_LAZY_RESYNC_MIN_INTERVAL_MS;
}

// ─────────────────────────────────────────────────────────────────────────────
// revenuecat_webhook_events.payload に残すイベントの写し (最小化。subscriber_attributes・aliases・価格・国は残さない)
// ─────────────────────────────────────────────────────────────────────────────

export type StoredRevenueCatEventPayload = {
  id: string;
  type: string;
  api_version: string;
  event_timestamp_ms: number;
  app_user_id: string | null;
  original_app_user_id: string | null;
  product_id: string | null;
  store: string | null;
  environment: string | null;
  transferred_from: string[] | null;
  transferred_to: string[] | null;
};

export function minimizeRevenueCatEventPayload(envelope: RevenueCatWebhookEnvelope): StoredRevenueCatEventPayload {
  const { event } = envelope;
  return {
    id: event.id,
    type: event.type,
    api_version: envelope.api_version,
    event_timestamp_ms: event.event_timestamp_ms,
    app_user_id: event.app_user_id ?? null,
    original_app_user_id: event.original_app_user_id ?? null,
    product_id: event.product_id ?? null,
    store: event.store ?? null,
    environment: event.environment ?? null,
    transferred_from: event.transferred_from ?? null,
    transferred_to: event.transferred_to ?? null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// API の入出力
// ─────────────────────────────────────────────────────────────────────────────

export const IapCatalogQuerySchema = z.object({ store: z.enum(IAP_STORES) });
export type IapCatalogQuery = z.infer<typeof IapCatalogQuerySchema>;

/**
 * GET /api/billing/iap/catalog の data。アプリは product_id を offerings の package.product.identifier と突き合わせる。
 * 無料体験の日数は返さない (アプリの購入の画面の体験の文は、ストアの商品の導入価格と体験の対象の判定から作る。§8.10 storeTrialOf)
 */
export interface IapCatalogPlan {
  plan_key: string;
  display_name: string;
  max_members: number | null;
  products: Array<{ billing_interval: IapBillingInterval; product_id: string }>;
}
export interface IapCatalog {
  store: IapStore;
  plans: IapCatalogPlan[];
}

/** 公開のプランの最小の形 (listPublicPlans の行のうちカタログが使う列) */
export interface CatalogPlanRow {
  plan_key: string;
  display_name: string;
  max_members: number | null;
}

/** 公開のプランとストアの商品の行から、そのストアのカタログを組む (売る行 (offered) が無いプランは出さない。R18) */
export function buildIapCatalog(store: IapStore, plans: readonly CatalogPlanRow[], products: readonly PlanStoreProductRow[]): IapCatalog {
  const result: IapCatalogPlan[] = [];
  for (const plan of plans) {
    const rows = products
      .filter((row) => row.offered && row.store === store && row.plan_key === plan.plan_key)
      .sort((a, b) => IAP_BILLING_INTERVALS.indexOf(a.billing_interval) - IAP_BILLING_INTERVALS.indexOf(b.billing_interval));
    if (rows.length === 0) continue;
    result.push({
      plan_key: plan.plan_key,
      display_name: plan.display_name,
      max_members: plan.max_members,
      products: rows.map((row) => ({ billing_interval: row.billing_interval, product_id: row.product_id })),
    });
  }
  return { store, plans: result };
}

// ─────────────────────────────────────────────────────────────────────────────
// 写像の戻り値・ポート (実装は revenuecat-gateway.ts / iap-repository.ts。テストは偽物を渡す)
// ─────────────────────────────────────────────────────────────────────────────

export type ApplyStoreSubscriptionResult =
  | { applied: true; subscription_id: string; user_id: string; status_from: string | null; status_to: StoreSubscriptionStatus; plan_key: string }
  | { applied: false; skipped: 'stale'; subscription_id: string; user_id: string }
  | { applied: false; skipped: 'user_deleted' };

export type RevenueCatEventClaim = 'claimed' | 'completed' | 'in_progress';
export const REVENUECAT_EVENT_CLAIMS = ['claimed', 'completed', 'in_progress'] as const satisfies readonly RevenueCatEventClaim[];
export function isRevenueCatEventClaim(value: unknown): value is RevenueCatEventClaim {
  return typeof value === 'string' && (REVENUECAT_EVENT_CLAIMS as readonly string[]).includes(value);
}

export interface RevenueCatGateway {
  /** GET /v1/subscribers/{app_user_id} (無ければ作られる。情報の取得なので X-Platform は付けない) */
  getSubscriber(appUserId: string): Promise<RevenueCatCustomerInfo>;
}

/**
 * 利用者のストアの行 (状態を問わず全部)。取り直した subscriptions に無くなった live な行を終わらせるためと、
 * 対応の行が無い商品に利用者の行があるか (unmappedStoreSubscriptionDecision) を見るために読む
 */
export interface StoreSubscriptionRow {
  iap_store: IapStore;
  iap_product_id: string;
  plan_key: string;
  status: string;
  billing_interval: IapBillingInterval | null;
  iap_is_sandbox: boolean;
  current_period_start: string | null;
  starts_at: string;
}

/** 行の status が live (trialing / active / past_due。ストアの行が取る 5 値のうち。§6.4) か */
export function isLiveStoreRowStatus(status: string): boolean {
  return (LIVE_STORE_SUBSCRIPTION_STATUSES as readonly string[]).includes(status);
}

/** ストアの行の (store, product_id) の鍵 (selectStoreSubscriptions と行を突き合わせる) */
export function storeSubscriptionKey(store: IapStore, productId: string): string {
  return `${store}:${productId}`;
}

export interface IapRepository {
  listStoreProducts(): Promise<PlanStoreProductRow[]>;
  listStoreSubscriptions(userId: string): Promise<StoreSubscriptionRow[]>;
  applyStoreSubscription(input: { snapshot: StoreSubscriptionSnapshot; fetchedAt: Date; source: string }): Promise<ApplyStoreSubscriptionResult>;
  claimRevenueCatEvent(payload: StoredRevenueCatEventPayload): Promise<RevenueCatEventClaim>;
  finishRevenueCatEvent(eventId: string, outcome: { ok: true } | { ok: false; errorCode: string }): Promise<void>;
  recordIapAudit(entry: IapAuditEntry): Promise<void>;
}

/** 同期 1 回の結果 (利用者 1 人分) */
export interface StoreSyncOutcome {
  user_id: string;
  applied: number;
  stale: number;
  /** 取り直した subscriptions に当社のストアの契約が無かった (何も作らない) */
  no_subscription: boolean;
  /** 取り直した subscriptions に無くなった live な行を expired にした数 */
  ended: number;
  /** 対応の行も利用者の行も無い、live でない商品を飛ばした数 (S28) */
  skipped_unknown: number;
}
