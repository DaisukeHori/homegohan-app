/**
 * 課金の核 (billing/01) の定数・Zod・型・純関数・ポート。I/O を持たない (fetch / DB / env を読まない)。
 * 正典は docs/design/billing/01-billing-core.md §8.1。import してよいのは zod だけ (tests/billing-core.test.ts が見張る)。
 */
import { z } from 'zod';

// ─────────────────────────────────────────────────────────────────────────────
// 定数 (根拠つき。運用で変える値は無い — すべて Stripe の仕様か本冊の契約に固定される)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Stripe API の版。すべての REST 呼び出しに `Stripe-Version` ヘッダーで付ける (アカウントの既定の版に依存しない)。
 * この版では Subscription の current_period_start / current_period_end が最上位にあり、Invoice の subscription が最上位の文字列
 * (2025-03-31.basil 以降は SubscriptionItem / invoice.parent に移る)。版を上げるときは §8.1 の Zod と §6.4 の snapshot を一緒に見直す。
 * operator/05 §15 が名指しした版と同じ。
 */
export const STRIPE_API_VERSION = '2024-12-18.acacia';
export const STRIPE_API_BASE_URL = 'https://api.stripe.com/v1';
/** Stripe が署名を載せるヘッダー (小文字で読む。Headers.get は大文字小文字を区別しない) */
export const STRIPE_SIGNATURE_HEADER = 'stripe-signature';
/**
 * Webhook の本文の上限 (バイト)。Stripe のイベントは数十 KB (invoice は lines を含む) で、1 MiB を超えるものは届かない。
 * 署名を確かめる前に巨大な本文で HMAC・JSON の処理をさせないための上限 (Resend の受け口の 256 KiB と同じ考え方。Stripe の方が大きい)
 */
export const STRIPE_WEBHOOK_MAX_BODY_BYTES = 1024 * 1024;
/** processing のままこの時間を過ぎたイベントは、再送で再び処理の権利を取れる (billing_claim_stripe_event の p_stuck_after。関数の最長実行時間 maxDuration を十分に超える値) */
export const STRIPE_EVENT_STUCK_MINUTES = 15;
/**
 * Webhook の route の最長実行時間 (秒)。Stripe の取り直し 1 回 + RPC 1 回で足りる値 (Vercel の既定 10 秒だと Stripe が遅いときに切れる)。
 * route の `export const maxDuration` は Next の route segment config で、静的解析できるリテラルしか書けない (import した定数は解析されない)。
 * そのため route には同じ値を数値リテラルで書き、この定数と一致することを tests/webhooks-stripe-route.test.ts (テスト 86) が見張る。
 */
export const STRIPE_WEBHOOK_MAX_DURATION_SECONDS = 30;
/** Stripe の list API の 1 ページの件数の上限 (Stripe の仕様の最大値)。退会で顧客の契約を列挙するときに使う */
export const STRIPE_LIST_PAGE_LIMIT = 100;
/** stripe_webhook_events.error_message に残す長さ (固定のコードだけを入れるので十分) */
export const STRIPE_EVENT_ERROR_MAX_CHARS = 500;
/** Checkout / Portal の表示言語 */
export const STRIPE_LOCALE = 'ja';
/** サブスクリプションの数量は常に 1 (座席課金はしない) */
export const CHECKOUT_LINE_ITEM_QUANTITY = 1;
/** Stripe が success_url の中で Checkout Session の id に置き換える文字列 (Stripe の仕様) */
export const CHECKOUT_SESSION_ID_PLACEHOLDER = '{CHECKOUT_SESSION_ID}';
export const BILLING_PAGE_PATH = '/account/billing';
export const BILLING_CHECKOUT_PAGE_PATH = '/account/billing/checkout';
export const CHECKOUT_RESULT_QUERY = 'checkout';
export const CHECKOUT_RESULT_SUCCESS = 'success';
export const CHECKOUT_RESULT_CANCELLED = 'cancelled';
export const CHECKOUT_SESSION_QUERY = 'session_id';
/** Stripe の Idempotency-Key (顧客の作成)。同じ利用者の同時の 2 本が同じ顧客を返すようにする。Stripe はキーを 24 時間覚える */
export const CUSTOMER_IDEMPOTENCY_KEY_PREFIX = 'billing-customer:';
/** 無料プランの plan_key (docs/design/CLAUDE.md 横断ルール A で許された唯一のハードコード) */
export const FREE_PLAN_KEY = 'free';
/** 試用の出どころ (personal_subscriptions.trial_source) */
export const TRIAL_SOURCE_CHECKOUT = 'checkout';
/** 1 秒のミリ秒 */
export const MS_PER_SECOND = 1000;
/** アドバイザリロックの接頭辞 (cross/02 §6.2 の命名。SQL 側 §6.4 と同じ文字列) */
export const BILLING_LOCK_PREFIX_USER = 'billing-user:';
export const BILLING_LOCK_PREFIX_SUBSCRIPTION = 'stripe-subscription:';

export const PURCHASABLE_PLAN_TYPES = ['personal', 'family'] as const;
export const BILLING_INTERVALS = ['month', 'year'] as const;
export type BillingInterval = (typeof BILLING_INTERVALS)[number];

/** Stripe の Subscription.status の全 8 値 (Stripe の仕様) */
export const STRIPE_SUBSCRIPTION_STATUSES = [
  'incomplete',
  'incomplete_expired',
  'trialing',
  'active',
  'past_due',
  'canceled',
  'unpaid',
  'paused',
] as const;
export type StripeSubscriptionStatus = (typeof STRIPE_SUBSCRIPTION_STATUSES)[number];
/** Stripe がそこから別の status に戻さない終端の値 (Stripe の仕様)。退会の解約はこれ以外を解約する */
export const STRIPE_TERMINAL_SUBSCRIPTION_STATUSES = ['canceled', 'incomplete_expired'] as const satisfies readonly StripeSubscriptionStatus[];
export function isTerminalStripeStatus(value: StripeSubscriptionStatus): boolean {
  return (STRIPE_TERMINAL_SUBSCRIPTION_STATUSES as readonly string[]).includes(value);
}

/** personal_subscriptions.status の全 8 値 (§6.2 の CHECK と同じ) */
export const SUBSCRIPTION_STATUSES = [
  'incomplete',
  'trialing',
  'active',
  'paused',
  'cancelled',
  'expired',
  'past_due',
  'grace',
] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];
/** 利用者ごとに 1 行だけ持てる「終わっていない」状態 (部分 UNIQUE idx_personal_subscriptions_active_per_user の述語と同じ) */
export const LIVE_SUBSCRIPTION_STATUSES = ['trialing', 'active', 'paused', 'past_due', 'grace'] as const satisfies readonly SubscriptionStatus[];
/** 権利が効く状態 (DB の get_effective_plan と同じ。paused は対象外) */
export const ENTITLED_SUBSCRIPTION_STATUSES = ['trialing', 'active', 'grace', 'past_due'] as const satisfies readonly SubscriptionStatus[];

export function isSubscriptionStatus(value: string): value is SubscriptionStatus {
  return (SUBSCRIPTION_STATUSES as readonly string[]).includes(value);
}
export function isLiveStatus(value: string): boolean {
  return (LIVE_SUBSCRIPTION_STATUSES as readonly string[]).includes(value);
}
export function isBillingInterval(value: string): value is BillingInterval {
  return (BILLING_INTERVALS as readonly string[]).includes(value);
}

/**
 * Stripe の status → DB の status の写像 (正本は §6.4 の SQL。ここは画面の表示とテストの期待値のための同じ表)。
 * 保持の規則 (grace / paused を保つ) は現在の行を見る必要があるので SQL だけが持つ。
 */
export const STRIPE_TO_DB_STATUS: Readonly<Record<StripeSubscriptionStatus, SubscriptionStatus>> = {
  incomplete: 'incomplete',
  incomplete_expired: 'expired',
  trialing: 'trialing',
  active: 'active',
  past_due: 'past_due',
  unpaid: 'past_due',
  canceled: 'cancelled',
  paused: 'expired',
};

// ─────────────────────────────────────────────────────────────────────────────
// イベントの振り分け (受け取るイベントは Stripe の Dashboard でこの一覧だけを登録する。§17)
// ─────────────────────────────────────────────────────────────────────────────

export const STRIPE_EVENT_ACTIONS = {
  'checkout.session.completed': 'sync_checkout_session',
  'customer.subscription.created': 'sync_subscription',
  'customer.subscription.updated': 'sync_subscription',
  'customer.subscription.deleted': 'sync_subscription',
  'customer.subscription.paused': 'sync_subscription',
  'customer.subscription.resumed': 'sync_subscription',
  // 次の 3 つと invoice.payment_action_required も、ほかと同じ「取り直しの合図」(写像はイベントの種類を見ない)。
  // 遷移は §7.3 の trial_will_end / pending_update_applied / pending_update_expired / payment_action_required の行
  'customer.subscription.trial_will_end': 'sync_subscription',
  'customer.subscription.pending_update_applied': 'sync_subscription',
  'customer.subscription.pending_update_expired': 'sync_subscription',
  'invoice.paid': 'sync_invoice_subscription',
  'invoice.payment_action_required': 'sync_invoice_subscription',
  'invoice.payment_failed': 'audit_payment_failed_and_sync',
} as const;
export type StripeEventAction = (typeof STRIPE_EVENT_ACTIONS)[keyof typeof STRIPE_EVENT_ACTIONS] | 'ignore';
/** Dashboard に登録するイベントの一覧 (順序は固定。§17 の手順と tests/billing-core.test.ts が突き合わせる) */
export const STRIPE_SUBSCRIBED_EVENT_TYPES = Object.keys(STRIPE_EVENT_ACTIONS) as ReadonlyArray<keyof typeof STRIPE_EVENT_ACTIONS>;

export function classifyStripeEvent(eventType: string): StripeEventAction {
  const table: Readonly<Record<string, StripeEventAction>> = STRIPE_EVENT_ACTIONS;
  return Object.hasOwn(table, eventType) ? table[eventType] : 'ignore';
}

// ─────────────────────────────────────────────────────────────────────────────
// 監査 (admin_audit_logs.action_type)。system.* は actor_id = NULL、user.* は actor_id = 本人
// ─────────────────────────────────────────────────────────────────────────────

export const BILLING_AUDIT_ACTIONS = [
  'user.billing.checkout_started',
  'user.billing.cancel_scheduled',
  'user.billing.cancel_revoked',
  'system.billing.subscription_created',
  'system.billing.subscription_status_changed',
  'system.payment.failed',
  'system.stripe.event_failed',
  'system.billing.account_deletion_stripe_cancelled',
  'system.billing.orphan_subscription_cancelled',
] as const;
export type BillingAuditAction = (typeof BILLING_AUDIT_ACTIONS)[number];
export type BillingAuditSeverity = 'info' | 'warn' | 'critical';
/**
 * admin_audit_logs.target_type (varchar(30)・NULL 可) に入れる値。
 * 'user' = target_id は利用者の id。'stripe_event' = 利用者を解決できない Webhook の失敗 (system.stripe.event_failed)。
 * 'stripe_subscription' = 退会した利用者の顧客に残った契約を解約した (system.billing.orphan_subscription_cancelled。利用者はもういない)。
 * 後の 2 つは target_id を NULL にし、Stripe の id は details に入れる (target_id は uuid 型なので evt_… / sub_… は入らない)
 */
export const BILLING_AUDIT_TARGET_TYPES = ['user', 'stripe_event', 'stripe_subscription'] as const;
export type BillingAuditTargetType = (typeof BILLING_AUDIT_TARGET_TYPES)[number];
/**
 * 監査の details の値。admin_audit_logs.details は jsonb (生成された型は Json) なので、JSON にそのまま入る値だけにする
 * (unknown を許すと repository.ts の insert で Json に代入できない)
 */
export type BillingAuditDetailValue = string | number | boolean | null;
export type BillingAuditEntry =
  | {
      actor_id: string | null;
      action_type: Exclude<BillingAuditAction, 'system.stripe.event_failed' | 'system.billing.orphan_subscription_cancelled'>;
      target_type: 'user';
      /** 利用者の id */
      target_id: string;
      severity: BillingAuditSeverity;
      /** 個人情報 (メール・氏名・カード) と秘密を入れない */
      details: Record<string, BillingAuditDetailValue>;
    }
  | {
      actor_id: null;
      action_type: 'system.stripe.event_failed';
      target_type: 'stripe_event';
      target_id: null;
      severity: BillingAuditSeverity;
      /** { event_id, event_type, error_code } だけ */
      details: { event_id: string; event_type: string; error_code: string };
    }
  | {
      actor_id: null;
      action_type: 'system.billing.orphan_subscription_cancelled';
      target_type: 'stripe_subscription';
      target_id: null;
      severity: BillingAuditSeverity;
      /** { stripe_subscription_id, stripe_status (解約する前の Stripe の status), source (写像の p_source と同じ) } だけ */
      details: { stripe_subscription_id: string; stripe_status: StripeSubscriptionStatus; source: string };
    };

// ─────────────────────────────────────────────────────────────────────────────
// エラー (応答の本文は固定の文。生のエラー文は入れない)
// ─────────────────────────────────────────────────────────────────────────────

/** 本冊のエラーコードと HTTP ステータス。[NEW] の行は cross/04 §4.2 に追記する (§16.2) */
export const BILLING_ERROR_HTTP_STATUS = {
  BILL_INVALID_INPUT: 400,
  BILL_PLAN_NOT_PURCHASABLE: 422,
  BILL_CUSTOMER_NOT_FOUND: 404,
  BILL_NO_LIVE_SUBSCRIPTION: 409,
  BILL_CANCEL_NOT_SCHEDULED: 409,
  BILL_CHECKOUT_SESSION_MISMATCH: 403,
  OP_SUBSCRIPTION_ALREADY_ACTIVE: 409,
  EXT_STRIPE_NOT_CONFIGURED: 503,
  EXT_STRIPE_API_FAILED: 502,
} as const;
export type BillingErrorCode = keyof typeof BILLING_ERROR_HTTP_STATUS;

export const BILLING_ERROR_MESSAGES: Readonly<Record<BillingErrorCode, string>> = {
  BILL_INVALID_INPUT: '入力値が不正です',
  BILL_PLAN_NOT_PURCHASABLE: 'このプランは現在お申し込みできません',
  BILL_CUSTOMER_NOT_FOUND: 'お支払い情報がまだありません',
  BILL_NO_LIVE_SUBSCRIPTION: '有効な契約がありません',
  BILL_CANCEL_NOT_SCHEDULED: '解約は予約されていません',
  BILL_CHECKOUT_SESSION_MISMATCH: 'このお申し込みは確認できません',
  OP_SUBSCRIPTION_ALREADY_ACTIVE: 'すでに有効な契約があります',
  EXT_STRIPE_NOT_CONFIGURED: 'お支払いを受け付けていません',
  EXT_STRIPE_API_FAILED: '決済サービスとの通信に失敗しました。しばらくしてからお試しください',
};

export class BillingError extends Error {
  readonly code: BillingErrorCode;
  constructor(code: BillingErrorCode) {
    super(BILLING_ERROR_MESSAGES[code]);
    this.name = 'BillingError';
    this.code = code;
  }
}

/** STRIPE_SECRET_KEY が無い (503)。message に変数名を入れない (#1182・#1434) */
export class StripeNotConfiguredError extends Error {
  constructor() {
    super('決済サービスの設定がありません');
    this.name = 'StripeNotConfiguredError';
  }
}

/** Stripe の REST が 2xx 以外を返した (502)。生の文面は rawMessage に持ち、ログにだけ残す (応答の本文には出さない) */
export class StripeApiError extends Error {
  readonly status: number;
  readonly stripeType: string | null;
  readonly stripeCode: string | null;
  readonly requestId: string | null;
  readonly rawMessage: string | null;
  constructor(input: { status: number; stripeType?: string | null; stripeCode?: string | null; requestId?: string | null; rawMessage?: string | null }) {
    super('Stripe API の呼び出しに失敗しました');
    this.name = 'StripeApiError';
    this.status = input.status;
    this.stripeType = input.stripeType ?? null;
    this.stripeCode = input.stripeCode ?? null;
    this.requestId = input.requestId ?? null;
    this.rawMessage = input.rawMessage ?? null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Stripe のオブジェクト (本冊が読む項目だけ。looseObject = 知らない項目は捨てずに通す)
// ─────────────────────────────────────────────────────────────────────────────

const UnixSeconds = z.number().int();
const StripeMetadata = z.record(z.string(), z.string());

export const StripePriceSchema = z.looseObject({
  id: z.string(),
  recurring: z.looseObject({ interval: z.string() }).nullable().optional(),
});
export const StripeSubscriptionItemSchema = z.looseObject({
  id: z.string(),
  price: StripePriceSchema,
});
export const StripeSubscriptionSchema = z.looseObject({
  id: z.string(),
  object: z.literal('subscription'),
  customer: z.string(),
  status: z.enum(STRIPE_SUBSCRIPTION_STATUSES),
  metadata: StripeMetadata.nullable().optional(),
  items: z.looseObject({ data: z.array(StripeSubscriptionItemSchema) }),
  start_date: UnixSeconds,
  current_period_start: UnixSeconds.nullable().optional(),
  current_period_end: UnixSeconds.nullable().optional(),
  trial_start: UnixSeconds.nullable().optional(),
  trial_end: UnixSeconds.nullable().optional(),
  cancel_at: UnixSeconds.nullable().optional(),
  cancel_at_period_end: z.boolean(),
  canceled_at: UnixSeconds.nullable().optional(),
  ended_at: UnixSeconds.nullable().optional(),
  pause_collection: z.looseObject({ behavior: z.string() }).nullable().optional(),
  livemode: z.boolean().optional(),
});
export type StripeSubscription = z.infer<typeof StripeSubscriptionSchema>;

export const StripeCheckoutSessionSchema = z.looseObject({
  id: z.string(),
  object: z.literal('checkout.session'),
  mode: z.string(),
  status: z.enum(['open', 'complete', 'expired']).nullable().optional(),
  url: z.string().nullable().optional(),
  client_reference_id: z.string().nullable().optional(),
  customer: z.string().nullable().optional(),
  subscription: z.string().nullable().optional(),
  metadata: StripeMetadata.nullable().optional(),
});
export type StripeCheckoutSession = z.infer<typeof StripeCheckoutSessionSchema>;

/** GET /v1/checkout/sessions?customer=…&status=open の 1 ページ (Stripe の list オブジェクト)。退会で開いたままの Session を閉じるときに使う */
export const StripeCheckoutSessionListSchema = z.looseObject({
  object: z.literal('list'),
  data: z.array(StripeCheckoutSessionSchema),
  has_more: z.boolean(),
});
export type StripeCheckoutSessionList = z.infer<typeof StripeCheckoutSessionListSchema>;

/** GET /v1/subscriptions?customer=… の 1 ページ (Stripe の list オブジェクト) */
export const StripeSubscriptionListSchema = z.looseObject({
  object: z.literal('list'),
  data: z.array(StripeSubscriptionSchema),
  has_more: z.boolean(),
});
export type StripeSubscriptionList = z.infer<typeof StripeSubscriptionListSchema>;

export const StripeCustomerSchema = z.looseObject({
  id: z.string(),
  object: z.literal('customer'),
});
export type StripeCustomer = z.infer<typeof StripeCustomerSchema>;

export const StripeBillingPortalSessionSchema = z.looseObject({
  id: z.string(),
  url: z.string(),
});

/** invoice の subscription は acacia では最上位、basil では parent.subscription_details にある。展開されていれば { id } の形 */
const SubscriptionRef = z.union([z.string(), z.looseObject({ id: z.string() })]);
export const StripeInvoiceRefSchema = z.looseObject({
  id: z.string(),
  object: z.literal('invoice'),
  subscription: SubscriptionRef.nullable().optional(),
  parent: z
    .looseObject({
      subscription_details: z.looseObject({ subscription: SubscriptionRef.nullable().optional() }).nullable().optional(),
    })
    .nullable()
    .optional(),
  amount_due: z.number().int().optional(),
  attempt_count: z.number().int().optional(),
});
export type StripeInvoiceRef = z.infer<typeof StripeInvoiceRefSchema>;

/** イベントの外形。中身 (data.object) は、写しを決めるのに id と object 以外を信じない (必ず取り直す。§4.1)。支払失敗の監査の details だけは請求の値を読む (§8.6) */
export const StripeEventEnvelopeSchema = z.looseObject({
  id: z.string().startsWith('evt_'),
  object: z.literal('event'),
  type: z.string(),
  created: UnixSeconds,
  livemode: z.boolean(),
  data: z.looseObject({
    object: z.looseObject({ id: z.string().optional(), object: z.string().optional() }),
  }),
});
export type StripeEventEnvelope = z.infer<typeof StripeEventEnvelopeSchema>;

export const StripeApiErrorBodySchema = z.looseObject({
  error: z.looseObject({
    type: z.string().optional(),
    code: z.string().optional(),
    message: z.string().optional(),
    param: z.string().optional(),
  }),
});

// ─────────────────────────────────────────────────────────────────────────────
// API の入力
// ─────────────────────────────────────────────────────────────────────────────

export const CheckoutRequestSchema = z.object({
  plan_key: z.string().min(1).max(100),
  interval: z.enum(BILLING_INTERVALS),
});
export type CheckoutRequest = z.infer<typeof CheckoutRequestSchema>;

export const CheckoutSyncRequestSchema = z.object({
  session_id: z.string().startsWith('cs_').max(255),
});
export type CheckoutSyncRequest = z.infer<typeof CheckoutSyncRequestSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// プラン
// ─────────────────────────────────────────────────────────────────────────────

/** subscription_plans の本冊が読む列 */
export interface PurchasablePlan {
  plan_key: string;
  display_name: string;
  plan_type: string;
  status: string;
  monthly_price_jpy: number | null;
  yearly_price_jpy: number | null;
  trial_days: number;
  stripe_price_id: string | null;
  stripe_yearly_price_id: string | null;
}
/** 公開の面が読む列 (PurchasablePlan に max_members を足した形。billing/03 §8.6) */
export interface PublicPlan extends PurchasablePlan {
  max_members: number | null;
}

export function priceIdFor(plan: PurchasablePlan, interval: BillingInterval): string | null {
  return interval === 'month' ? plan.stripe_price_id : plan.stripe_yearly_price_id;
}
export function amountJpyFor(plan: PurchasablePlan, interval: BillingInterval): number | null {
  return interval === 'month' ? plan.monthly_price_jpy : plan.yearly_price_jpy;
}
/** 買える = public・個人/家族・free でない・その interval の Stripe Price がある・金額が正 */
export function isPurchasable(plan: PurchasablePlan, interval: BillingInterval): boolean {
  const amount = amountJpyFor(plan, interval);
  return (
    plan.status === 'public' &&
    (PURCHASABLE_PLAN_TYPES as readonly string[]).includes(plan.plan_type) &&
    plan.plan_key !== FREE_PLAN_KEY &&
    priceIdFor(plan, interval) !== null &&
    amount !== null &&
    amount > 0
  );
}
/** 同じプランの試用は 1 回だけ (operator/04 §5.2)。2 回目以降は試用なしで買える */
export function trialDaysFor(planTrialDays: number, trialAlreadyUsed: boolean): number {
  return trialAlreadyUsed ? 0 : Math.max(0, planTrialDays);
}

// ─────────────────────────────────────────────────────────────────────────────
// Stripe の Subscription → snapshot (billing_apply_stripe_subscription の p_snapshot)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * interface ではなく type にする: type のオブジェクト型は暗黙の index signature を持つので、生成された型 Json
 * (RPC の p_snapshot) にそのまま代入できる (as unknown as を書かない)。StoredStripeEventPayload も同じ
 */
export type SubscriptionSnapshot = {
  stripe_subscription_id: string;
  stripe_customer_id: string;
  /** Checkout の metadata.user_id。無ければ null (SQL が顧客の対応表・既存の行で解決する) */
  user_id: string | null;
  /** metadata.plan_key → Price からの解決。どちらも無ければ null。SQL は既存の行があればその plan_key を使い (行を作ったときに決まり、以後変わらない。§7.3)、行が無くて null なら BILL_UNKNOWN_PLAN */
  plan_key: string | null;
  stripe_price_id: string | null;
  billing_interval: BillingInterval | null;
  stripe_status: StripeSubscriptionStatus;
  pause_collection: boolean;
  start_date: string;
  current_period_start: string | null;
  current_period_end: string | null;
  trial_start: string | null;
  trial_end: string | null;
  cancel_at: string | null;
  cancel_at_period_end: boolean;
  canceled_at: string | null;
  ended_at: string | null;
};

export function unixToIso(seconds: number | null | undefined): string | null {
  return typeof seconds === 'number' ? new Date(seconds * MS_PER_SECOND).toISOString() : null;
}

export function primaryPrice(sub: StripeSubscription): { priceId: string | null; interval: BillingInterval | null } {
  const item = sub.items.data[0];
  if (!item) return { priceId: null, interval: null };
  const interval = item.price.recurring?.interval ?? null;
  return { priceId: item.price.id, interval: interval !== null && isBillingInterval(interval) ? interval : null };
}

/** plan_key の解決: Checkout で付けた metadata.plan_key が最優先。無ければ Price から引いた値 (Dashboard で作られた契約) */
export function resolvePlanKey(sub: StripeSubscription, planKeyByPriceId: string | null): string | null {
  const fromMetadata = sub.metadata?.plan_key;
  if (fromMetadata && fromMetadata.length > 0) return fromMetadata;
  return planKeyByPriceId;
}

export function projectSubscription(sub: StripeSubscription, planKey: string | null): SubscriptionSnapshot {
  const { priceId, interval } = primaryPrice(sub);
  const userId = sub.metadata?.user_id;
  return {
    stripe_subscription_id: sub.id,
    stripe_customer_id: sub.customer,
    user_id: userId && userId.length > 0 ? userId : null,
    plan_key: planKey,
    stripe_price_id: priceId,
    billing_interval: interval,
    stripe_status: sub.status,
    pause_collection: sub.pause_collection != null,
    start_date: unixToIso(sub.start_date) ?? new Date(0).toISOString(),
    current_period_start: unixToIso(sub.current_period_start),
    current_period_end: unixToIso(sub.current_period_end),
    trial_start: unixToIso(sub.trial_start),
    trial_end: unixToIso(sub.trial_end),
    cancel_at: unixToIso(sub.cancel_at),
    cancel_at_period_end: sub.cancel_at_period_end,
    canceled_at: unixToIso(sub.canceled_at),
    ended_at: unixToIso(sub.ended_at),
  };
}

/** invoice から subscription の id を取り出す (acacia / basil のどちらの形でも) */
export function invoiceSubscriptionId(invoice: StripeInvoiceRef): string | null {
  const ref = invoice.subscription ?? invoice.parent?.subscription_details?.subscription ?? null;
  if (ref === null) return null;
  return typeof ref === 'string' ? ref : ref.id;
}

// ─────────────────────────────────────────────────────────────────────────────
// stripe_webhook_events.payload に残すイベントの写し (最小化。氏名・メールアドレス・住所を DB に残さない。§9.6)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * data.object から残す項目 (許可リスト)。値が文字列・数値・真偽・null のときだけ残す (入れ子のオブジェクトは残さない)。
 * 選んだ根拠: 処理 (§4.1) が読む id / object、既存の Finance の route (src/app/api/admin/finance/invoices/route.ts・[id]/route.ts。
 * §2.2 F25) が読む項目のうち個人を指さないもの (金額・通貨・請求書番号・期間)、Portal での解約の予約の記録 (§7.3) に要る
 * status / cancel_at_period_end / cancel_at、Checkout Session の mode。customer と subscription は別に、文字列の id に正規化して残す。
 * 残さないもの: customer_email / customer_name / customer_address / customer_phone / customer_shipping / customer_details /
 * invoice_pdf / hosted_invoice_url / lines / metadata ほか、ここに無い項目すべて
 */
export const STORED_STRIPE_EVENT_OBJECT_FIELDS = [
  'id',
  'object',
  'status',
  'mode',
  'created',
  'currency',
  'amount_due',
  'amount_paid',
  'attempt_count',
  'number',
  'period_start',
  'period_end',
  'cancel_at_period_end',
  'cancel_at',
] as const;
export type StoredStripeScalar = string | number | boolean | null;

/** billing_claim_stripe_event の p_payload に渡す写し。data.object の値は平らな値だけ (イベントそのものは型で渡せない)。type にする理由は SubscriptionSnapshot と同じ */
export type StoredStripeEventPayload = {
  id: string;
  object: 'event';
  type: string;
  created: number;
  livemode: boolean;
  data: { object: Record<string, StoredStripeScalar> };
};

function isStoredStripeScalar(value: unknown): value is StoredStripeScalar {
  return value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

/** 文字列の id か、展開された { id } から id を取り出す (customer / subscription の参照) */
function stripeRefId(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && value !== null && 'id' in value && typeof value.id === 'string') return value.id;
  return null;
}

/**
 * イベントを DB に残す形に縮める。subscription は invoice なら acacia / basil のどちらの形からも取り
 * (invoiceSubscriptionId)、それ以外 (Checkout Session) は data.object.subscription から取って、文字列の id で最上位に置く
 */
export function minimizeStripeEventPayload(event: StripeEventEnvelope): StoredStripeEventPayload {
  const source: Readonly<Record<string, unknown>> = event.data.object;
  const object: Record<string, StoredStripeScalar> = {};
  for (const field of STORED_STRIPE_EVENT_OBJECT_FIELDS) {
    const value = source[field];
    if (isStoredStripeScalar(value)) object[field] = value;
  }
  const customer = stripeRefId(source['customer']);
  if (customer !== null) object['customer'] = customer;
  const invoice = StripeInvoiceRefSchema.safeParse(source);
  const subscription = invoice.success ? invoiceSubscriptionId(invoice.data) : stripeRefId(source['subscription']);
  if (subscription !== null) object['subscription'] = subscription;
  return { id: event.id, object: 'event', type: event.type, created: event.created, livemode: event.livemode, data: { object } };
}

// ─────────────────────────────────────────────────────────────────────────────
// Checkout のパラメータ (Stripe の form-encode) と鍵のモード
// ─────────────────────────────────────────────────────────────────────────────

export type StripeFormValue = string | number | boolean | StripeFormParams | StripeFormValue[];
export interface StripeFormParams {
  [key: string]: StripeFormValue | null | undefined;
}

/** Stripe の REST は application/x-www-form-urlencoded。入れ子は a[b][0][c]=v の形。null / undefined は送らない */
export function toFormBody(params: StripeFormParams): string {
  const pairs: string[] = [];
  const walk = (prefix: string, value: StripeFormValue | null | undefined): void => {
    if (value === null || value === undefined) return;
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(`${prefix}[${index}]`, item));
      return;
    }
    if (typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) walk(prefix === '' ? key : `${prefix}[${key}]`, child);
      return;
    }
    pairs.push(`${encodeURIComponent(prefix)}=${encodeURIComponent(String(value))}`);
  };
  walk('', params);
  return pairs.join('&');
}

export interface CheckoutSessionInput {
  customerId: string;
  userId: string;
  planKey: string;
  interval: BillingInterval;
  priceId: string;
  trialDays: number;
  /** getSiteUrl() の値 (末尾の / なし) */
  siteUrl: string;
}

export function checkoutReturnUrls(siteUrl: string): { successUrl: string; cancelUrl: string } {
  const base = `${siteUrl}${BILLING_PAGE_PATH}?${CHECKOUT_RESULT_QUERY}=`;
  return {
    successUrl: `${base}${CHECKOUT_RESULT_SUCCESS}&${CHECKOUT_SESSION_QUERY}=${CHECKOUT_SESSION_ID_PLACEHOLDER}`,
    cancelUrl: `${base}${CHECKOUT_RESULT_CANCELLED}`,
  };
}

/** POST /v1/checkout/sessions の本文 (form-encode 前)。metadata は SQL が利用者とプランを解決するのに使う */
export function buildCheckoutSessionParams(input: CheckoutSessionInput): StripeFormParams {
  const { successUrl, cancelUrl } = checkoutReturnUrls(input.siteUrl);
  const metadata: StripeFormParams = { user_id: input.userId, plan_key: input.planKey, interval: input.interval };
  const subscriptionData: StripeFormParams = { metadata };
  if (input.trialDays > 0) subscriptionData.trial_period_days = input.trialDays;
  return {
    mode: 'subscription',
    customer: input.customerId,
    client_reference_id: input.userId,
    line_items: [{ price: input.priceId, quantity: CHECKOUT_LINE_ITEM_QUANTITY }],
    success_url: successUrl,
    cancel_url: cancelUrl,
    locale: STRIPE_LOCALE,
    allow_promotion_codes: true,
    payment_method_collection: 'always',
    metadata,
    subscription_data: subscriptionData,
  };
}

/** POST /v1/customers/{id} の本文 (退会の匿名化。'' は Stripe で「消す」の意味) */
export function buildCustomerAnonymizeParams(anonymizedAtIso: string): StripeFormParams {
  return {
    name: '',
    email: '',
    phone: '',
    description: '',
    address: '',
    shipping: '',
    metadata: { user_id: '', anonymized_at: anonymizedAtIso },
  };
}

export type StripeKeyMode = 'live' | 'test';
/** 秘密鍵の接頭辞からモードを読む。Webhook の event.livemode と突き合わせる (テストのイベントを本番で処理しない) */
export function stripeKeyMode(secretKey: string): StripeKeyMode | null {
  if (/^(sk|rk)_live_/.test(secretKey)) return 'live';
  if (/^(sk|rk)_test_/.test(secretKey)) return 'test';
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// 画面に返す契約の要約 (GET /api/billing/subscription)
// ─────────────────────────────────────────────────────────────────────────────

/** personal_subscriptions の本冊が読む列 (DB の型そのまま。status は string で受けて検証する) */
export interface SubscriptionRowView {
  id: string;
  plan_key: string;
  status: string;
  stripe_subscription_id: string | null;
  billing_interval: string | null;
  current_period_end: string | null;
  trial_ends_at: string | null;
  cancel_at_period_end: boolean;
  cancel_at: string | null;
  /** アプリ内課金のストア (app_store / play_store)。NULL = Stripe か手動付与の行 (billing/03 §6.4) */
  iap_store: string | null;
  /** RevenueCat から取り直した時刻 (遅延の再同期の判定。billing/03 §8.4) */
  iap_synced_at: string | null;
}

/** いま効いているプランの AI の上限 (画面の錠と案内。billing/03 §8.6・§10.3・§10.6) */
export interface PlanFeatures {
  /** ai_daily_limits の値 (プランの行、無ければ free の行。NULL = 無制限。consume_ai_usage_at の c_default_plan と同じ倒し方) */
  ai_daily_limit: number | null;
  /**
   * ai_plan_feature_caps のそのプランの行だけ (feature → daily_cap。0 = 使えない・NULL = 機能ごとの上限なし。行の無い機能は入らない)。
   * free の行には倒さない (DB の consume_ai_usage_at・ai_plan_feature_daily_cap も c.plan_key = いまのプラン だけを見る)。
   * 行の無いプラン (組織の plan の standard・org_* など) は {} で、画面の錠は出ない (S26)
   */
  ai_feature_caps: Record<string, number | null>;
}
export const EMPTY_PLAN_FEATURES: PlanFeatures = { ai_daily_limit: null, ai_feature_caps: {} };

export interface BillingSummary {
  /** 個人契約の plan_key (live な行が無ければ free) */
  plan_key: string;
  /** いま効いているプラン (get_effective_plan。家族・組織を含む) */
  effective_plan_key: string;
  status: SubscriptionStatus | null;
  source: 'stripe' | 'manual' | 'app_store' | 'play_store' | null;
  /** ストアの契約なら、解約・支払い方法の変更をするストア (画面は管理のページへ案内する)。それ以外は null (billing/03 §8.6) */
  manage_in_store: 'app_store' | 'play_store' | null;
  billing_interval: BillingInterval | null;
  current_period_end: string | null;
  trial_ends_at: string | null;
  cancel_at_period_end: boolean;
  cancel_at: string | null;
  /** Billing Portal を開ける (顧客がある) */
  has_customer: boolean;
  can_purchase: boolean;
  can_cancel: boolean;
  can_resume: boolean;
  /** いま効いているプラン (effective_plan_key) の AI の上限 (画面の錠と案内。billing/03 §10.3・§10.6) */
  features: PlanFeatures;
}

export function summarizeSubscription(
  row: SubscriptionRowView | null,
  hasCustomer: boolean,
  effectivePlanKey: string,
  features: PlanFeatures,
): BillingSummary {
  const status = row !== null && isSubscriptionStatus(row.status) ? row.status : null;
  const live = status !== null && isLiveStatus(status);
  const stripeBacked = row !== null && row.stripe_subscription_id !== null;
  const storeBacked = row !== null && (row.iap_store === 'app_store' || row.iap_store === 'play_store') ? row.iap_store : null;
  const interval = row !== null && row.billing_interval !== null && isBillingInterval(row.billing_interval) ? row.billing_interval : null;
  return {
    plan_key: live && row !== null ? row.plan_key : FREE_PLAN_KEY,
    effective_plan_key: effectivePlanKey,
    status,
    source: row === null ? null : stripeBacked ? 'stripe' : storeBacked ?? 'manual',
    manage_in_store: live ? storeBacked : null,
    billing_interval: interval,
    current_period_end: row?.current_period_end ?? null,
    trial_ends_at: row?.trial_ends_at ?? null,
    cancel_at_period_end: row?.cancel_at_period_end ?? false,
    cancel_at: row?.cancel_at ?? null,
    has_customer: hasCustomer,
    can_purchase: !live,
    can_cancel: live && stripeBacked && row !== null && !row.cancel_at_period_end,
    can_resume: live && stripeBacked && row !== null && row.cancel_at_period_end,
    features,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 契約の状態の表示文 (/account/billing と /frozen/billing が同じ文を出す。§10.3 の表)
// ─────────────────────────────────────────────────────────────────────────────

/** live な 5 値 (LIVE_SUBSCRIPTION_STATUSES) */
export type LiveSubscriptionStatus = (typeof LIVE_SUBSCRIPTION_STATUSES)[number];

/**
 * status ごとの 1 行目の文 (§10.3 の表)。active は正常なので「ご利用中」だけを出す (お支払いの問題の文を付けない)。
 * trialing は billingStatusLines が試用の終わりの日付「（X まで）」(全角の括弧。X は日付で、「まで」との間に空白を入れない) を続ける
 */
export const BILLING_STATUS_TEXT: Readonly<Record<LiveSubscriptionStatus, string>> = {
  trialing: '無料期間中',
  active: 'ご利用中',
  past_due: 'お支払いに問題があります。お支払い方法をご確認ください',
  grace: 'お支払いが確認できないため一部の機能を制限しています',
  paused: '一時停止中',
};
/** 解約の予約中の 2 行目で、日付が無いとき (cancel_at も current_period_end も NULL。Stripe の予約では起きない) の文 */
export const BILLING_CANCEL_SCHEDULED_WITHOUT_DATE_TEXT = '期間の終わりに解約されます';
/** 画面の日付の書き方の言語 (Intl.DateTimeFormat の locales。日本語の「2026年10月21日」) */
export const BILLING_DISPLAY_LOCALE = 'ja-JP';
/**
 * 画面の日付の時間帯 (IANA の名前)。Stripe の日時は UTC の ISO で写る (§6.4) ので、利用者 (日本) の暦の日付に直す
 * (UTC のまま切ると、日本時間の 0〜9 時の終わりが前の日に見える)
 */
export const BILLING_DISPLAY_TIME_ZONE = 'Asia/Tokyo';
const BILLING_DATE_FORMAT = new Intl.DateTimeFormat(BILLING_DISPLAY_LOCALE, {
  timeZone: BILLING_DISPLAY_TIME_ZONE,
  year: 'numeric',
  month: 'long',
  day: 'numeric',
});

/** ISO の日時を日本時間の日付「2026年10月21日」にする。null・日時として読めない値は null */
export function formatBillingDate(iso: string | null): string | null {
  if (iso === null) return null;
  const time = Date.parse(iso);
  return Number.isNaN(time) ? null : BILLING_DATE_FORMAT.format(time);
}

/**
 * 契約の状態の表示 (§10.3 の表)。1 行目 = status の文 (trialing は「無料期間中（2026年10月21日まで）」。日付 = trial_ends_at)、
 * 2 行目 = 解約の予約中 (cancel_at_period_end) なら「2026年11月21日に解約されます」(日付 = cancel_at、無ければ current_period_end)。
 * status が null (live な行が無い) か live でないときは空の配列 (画面は状態の文を出さない)。/account/billing と /frozen/billing が使う
 */
export function billingStatusLines(
  summary: Pick<BillingSummary, 'status' | 'trial_ends_at' | 'current_period_end' | 'cancel_at_period_end' | 'cancel_at'>,
): string[] {
  const status = LIVE_SUBSCRIPTION_STATUSES.find((value) => value === summary.status);
  if (status === undefined) return [];
  const trialEnd = status === 'trialing' ? formatBillingDate(summary.trial_ends_at) : null;
  const lines = [trialEnd === null ? BILLING_STATUS_TEXT[status] : `${BILLING_STATUS_TEXT[status]}（${trialEnd}まで）`];
  if (summary.cancel_at_period_end) {
    const cancelDate = formatBillingDate(summary.cancel_at ?? summary.current_period_end);
    lines.push(cancelDate === null ? BILLING_CANCEL_SCHEDULED_WITHOUT_DATE_TEXT : `${cancelDate}に解約されます`);
  }
  return lines;
}

// ─────────────────────────────────────────────────────────────────────────────
// ポート (service.ts が使う。実装は stripe-gateway.ts / repository.ts。テストは偽物を渡す)
// ─────────────────────────────────────────────────────────────────────────────

export interface StripeGateway {
  readonly mode: StripeKeyMode | null;
  createCustomer(input: { userId: string; email: string | null }): Promise<StripeCustomer>;
  createCheckoutSession(params: StripeFormParams): Promise<StripeCheckoutSession>;
  retrieveCheckoutSession(sessionId: string): Promise<StripeCheckoutSession>;
  retrieveSubscription(subscriptionId: string): Promise<StripeSubscription>;
  /** 顧客の全契約 (status=all。終端の契約も含む)。has_more の間は starting_after でページを進めて全部返す */
  listCustomerSubscriptions(customerId: string): Promise<StripeSubscription[]>;
  updateCancelAtPeriodEnd(subscriptionId: string, cancelAtPeriodEnd: boolean): Promise<StripeSubscription>;
  cancelSubscriptionNow(subscriptionId: string): Promise<StripeSubscription>;
  /** 顧客の開いたままの Checkout Session (status=open)。has_more の間はページを進めて全部返す (退会。§11) */
  listOpenCheckoutSessions(customerId: string): Promise<StripeCheckoutSession[]>;
  /** Checkout Session を閉じる (POST /v1/checkout/sessions/{id}/expire)。閉じたあとは完了できない。open でない Session は Stripe が 4xx を返す */
  expireCheckoutSession(sessionId: string): Promise<StripeCheckoutSession>;
  anonymizeCustomer(customerId: string, anonymizedAtIso: string): Promise<void>;
  createBillingPortalSession(input: { customerId: string; returnUrl: string }): Promise<{ url: string }>;
}

export interface BillingCustomerRow {
  stripe_customer_id: string;
  user_id: string | null;
  anonymized_at: string | null;
}

export type ApplySubscriptionResult =
  | {
      applied: true;
      subscription_id: string;
      user_id: string;
      status_from: SubscriptionStatus | null;
      status_to: SubscriptionStatus;
      plan_key: string;
    }
  /** 古い取り直し。SQL は利用者を解決したあとで判定するので user_id は必ず入る (invoice.payment_failed の監査が使う。§8.6) */
  | { applied: false; skipped: 'stale'; subscription_id: string; user_id: string }
  /**
   * 退会済み (auth.users に無い、または metadata の無い契約で顧客の対応表が退会で匿名化済み。§6.4 (9) の 1.)。
   * customer_closed = 契約の顧客が当社の対応表にあり、その利用者が消えた (user_id IS NULL)。true で Stripe の status が終端でなければ、
   * syncSubscription が Stripe で即時解約する (§8.6・§7.3 の退会済みの行)
   */
  | { applied: false; skipped: 'user_deleted'; customer_closed: boolean };

/** billing_claim_stripe_event の戻り値。claimed = 処理する / completed = 処理済み (200) / in_progress = ほかが処理中 (409 で再送させる) */
export type StripeEventClaim = 'claimed' | 'completed' | 'in_progress';
export const STRIPE_EVENT_CLAIMS = ['claimed', 'completed', 'in_progress'] as const satisfies readonly StripeEventClaim[];
export function isStripeEventClaim(value: unknown): value is StripeEventClaim {
  return typeof value === 'string' && (STRIPE_EVENT_CLAIMS as readonly string[]).includes(value);
}

export interface BillingRepository {
  findPlan(planKey: string): Promise<PurchasablePlan | null>;
  findPlanKeyByPriceId(priceId: string): Promise<string | null>;
  /** live な行 (Stripe-backed でも手動でも) */
  findLiveSubscription(userId: string): Promise<SubscriptionRowView | null>;
  /** 同じ plan_key で trial_started_at が入った行がある (cancelled / expired の履歴を含む) */
  hasUsedTrial(userId: string, planKey: string): Promise<boolean>;
  /**
   * いま効いているプランの AI の上限 (billing/03 §8.6)。1 日の上限はプランの行、無ければ free の行。
   * 機能ごとの上限はそのプランの行だけで、free の行には倒さない
   */
  findPlanFeatures(planKey: string): Promise<PlanFeatures>;
  findCustomer(userId: string): Promise<BillingCustomerRow | null>;
  /** INSERT … ON CONFLICT (user_id) DO NOTHING のあと SELECT。同時の 2 本は同じ行を返す */
  saveCustomer(userId: string, stripeCustomerId: string): Promise<BillingCustomerRow>;
  markCustomerAnonymized(stripeCustomerId: string, anonymizedAtIso: string): Promise<void>;
  /** 退会で解約する対象のうち DB が知っているもの (stripe_subscription_id があり、status が cancelled 以外。expired は Stripe の paused のことがある)。Stripe の顧客の一覧と和を取り、Stripe の終端を除いて使う (§11) */
  listStripeBackedSubscriptions(userId: string): Promise<Array<{ stripe_subscription_id: string; status: string }>>;
  applyStripeSubscription(input: { snapshot: SubscriptionSnapshot; fetchedAt: Date; source: string }): Promise<ApplySubscriptionResult>;
  /** 処理の権利を取る。DB の payload に残すのは最小化した写しだけ (route は minimizeStripeEventPayload(event) を渡す。§9.6) */
  claimStripeEvent(payload: StoredStripeEventPayload): Promise<StripeEventClaim>;
  finishStripeEvent(eventId: string, outcome: { ok: true } | { ok: false; errorCode: string }): Promise<void>;
  recordAudit(entry: BillingAuditEntry): Promise<void>;
}
