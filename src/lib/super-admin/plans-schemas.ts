/**
 * super_admin プラン定義 API 用 Zod スキーマ
 * operator/02-api-spec.md §17 / operator/04-plan-management.md §3.1 準拠
 *
 * route.ts には inline 定義しない (family/02 §15.6.1 確定ルール)。
 * このファイルから import して使用する。
 */

import { z } from 'zod';
import { ORG_PLAN_VALUES_WIRE, ORG_SUBSCRIPTION_PLAN_KEY_PREFIX, isOrgPlanKey } from '@homegohan/shared';

// ─────────────────────────────────────────────────────────────────────────────
// 定数
// ─────────────────────────────────────────────────────────────────────────────

/** 9 種公式 plan_key (operator/01-data-model.md §3.2 seed) */
export const OFFICIAL_PLAN_KEYS = [
  'free',
  'pro',
  'family_basic',
  'family_pro',
  'family_addon',
  'org_starter',
  'org_standard',
  'org_pro',
  'org_enterprise',
] as const;

export const PLAN_TYPES = ['personal', 'family', 'org'] as const;
export const PLAN_STATUSES = ['draft', 'public', 'private', 'deprecated'] as const;

/**
 * 価格変更の適用範囲。新規契約のみ (new_only) だけを受け付ける。
 *
 * #1102 (オーナー判断 2026-10-08): 価格変更は新規契約だけに適用する。既存の契約者の請求額は変えない
 * (既存サブスクリプションの Stripe 価格の切り替えは作らない)。
 * 従来は on_renewal (次回更新時から全契約) / immediately (即時に全契約) も選べたが、実際に既存契約へ反映する処理は
 * 無く、選んでも請求額は変わらない偽の選択肢だったため、400 で拒否する。
 * DB の plan_price_history.applies_to の CHECK は旧値 (on_renewal / immediately) を許したままにしている (過去の行を読めるように)。
 */
export const PRICE_APPLIES_TO = ['new_only'] as const;

/** applies_to に new_only 以外が来たときのメッセージ (route が最初の issue の message をそのまま UI / 呼び出し元へ返す) */
export const PRICE_APPLIES_TO_MESSAGE =
  '価格変更は新規契約のみに適用されます。適用先 (applies_to) には新規契約のみ (new_only) だけを指定できます (既存契約の価格は変更できません)';

/**
 * プランステータス遷移マップ (operator/04-plan-management.md §3.4 ライフサイクル準拠)
 *
 * #1041 (プラン状態遷移一方向ロック) 修正: 従来は public/private 到達後、
 * status キー自体が恒久的に disallowedKeys 扱いとなり publish/unpublish/deprecate
 * が一切できなくなっていた。ここで許可される遷移を明示的に定義し、
 * それ以外の遷移のみを拒否するようにする。
 *
 *   draft --> public   : 新規申込受付開始
 *   public --> private  : 新規申込停止 (既存契約は継続)
 *   private --> public  : 再公開
 *   public --> deprecated  : 廃止
 *   private --> deprecated : 廃止
 *   deprecated --> private : 緊急ロールバック (un-deprecate、public には戻さない)
 */
export const PLAN_STATUS_TRANSITIONS: Record<(typeof PLAN_STATUSES)[number], ReadonlyArray<(typeof PLAN_STATUSES)[number]>> = {
  draft: ['public', 'private'],
  public: ['private', 'deprecated'],
  private: ['public', 'deprecated'],
  deprecated: ['private'],
};

export function isAllowedPlanStatusTransition(
  from: string,
  to: string,
): boolean {
  if (from === to) return true;
  const allowed = PLAN_STATUS_TRANSITIONS[from as (typeof PLAN_STATUSES)[number]];
  return Array.isArray(allowed) && (allowed as readonly string[]).includes(to);
}

/**
 * 個人・家族のプランに組織のプランの値 (isOrgPlanKey: standard / premium / enterprise と org_ で始まる key) を付けたときの文 (#1912)。
 * 付けると利用者の画面に「組織のプラン」と出てしまう
 */
export const PERSONAL_FAMILY_PLAN_KEY_MESSAGE = `個人・家族のプランのキー (plan_key) には、組織のプランの値 (${ORG_PLAN_VALUES_WIRE.join(' / ')} と ${ORG_SUBSCRIPTION_PLAN_KEY_PREFIX} で始まる値) を使えません`;

/**
 * 組織のプランの plan_key が org_ で始まらないときの文 (#1912)。始まらないと利用者の画面に「有料プラン」と出てしまう
 */
export const ORG_PLAN_KEY_PREFIX_MESSAGE = `組織のプランのキー (plan_key) は、組織のプランの頭の文字 (${ORG_SUBSCRIPTION_PLAN_KEY_PREFIX}) で始まる値にしてください`;

// ─────────────────────────────────────────────────────────────────────────────
// スキーマ定義
// ─────────────────────────────────────────────────────────────────────────────

/** プラン新規作成リクエスト */
export const PlanCreateSchema = z.object({
  plan_key: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-z0-9_]+$/, '英小文字・数字・アンダースコアのみ'),
  display_name: z.string().min(1).max(200),
  plan_type: z.enum(PLAN_TYPES),
  description: z.string().max(5000).optional(),
  monthly_price_jpy: z.number().int().min(0).nullable().optional(),
  yearly_price_jpy: z.number().int().min(0).nullable().optional(),
  max_members: z.number().int().min(1).nullable().optional(),
  max_family_seats: z.number().int().min(0).nullable().optional(),
  feature_package_ids: z.array(z.string().uuid()).optional().default([]),
  display_order: z.number().int().min(0).optional().default(0),
  trial_days: z.number().int().min(0).optional().default(0),
  min_contract_months: z.number().int().min(1).optional().default(1),
  auto_renew_default: z.boolean().optional().default(true),
  banner_url: z.string().url().nullable().optional(),
}).refine((data) => {
  // 組織プランは trial_days = 0 を強制
  if (data.plan_type === 'org' && (data.trial_days ?? 0) > 0) {
    return false;
  }
  return true;
}, { message: '組織プランには試用期間を設定できません', path: ['trial_days'] })
  // plan_key の形とプランの種別を揃える (#1912)。利用者の画面の表示名 (packages/shared の planDisplayName) は
  // plan_key の形 (isOrgPlanKey) だけで「組織のプラン」か「有料プラン」かを決めるので、作成の時点で食い違いを断る。
  // 更新 (PlanUpdateSchema) は plan_key・plan_type を受けない (Zod が捨てる) ので、作成のあとで食い違いは生まれない
  .refine((data) => data.plan_type === 'org' || !isOrgPlanKey(data.plan_key), {
    message: PERSONAL_FAMILY_PLAN_KEY_MESSAGE,
    path: ['plan_key'],
  })
  .refine((data) => data.plan_type !== 'org' || data.plan_key.startsWith(ORG_SUBSCRIPTION_PLAN_KEY_PREFIX), {
    message: ORG_PLAN_KEY_PREFIX_MESSAGE,
    path: ['plan_key'],
  });

export type PlanCreateInput = z.infer<typeof PlanCreateSchema>;

/** プラン更新リクエスト (status 別制限は API で適用) */
export const PlanUpdateSchema = z.object({
  display_name: z.string().min(1).max(200).optional(),
  description: z.string().max(5000).nullable().optional(),
  banner_url: z.string().url().nullable().optional(),
  feature_package_ids: z.array(z.string().uuid()).optional(),
  display_order: z.number().int().min(0).optional(),
  max_members: z.number().int().min(1).nullable().optional(),
  max_family_seats: z.number().int().min(0).nullable().optional(),
  trial_days: z.number().int().min(0).optional(),
  min_contract_months: z.number().int().min(1).optional(),
  auto_renew_default: z.boolean().optional(),
  stripe_product_id: z.string().max(255).nullable().optional(),
  status: z.enum(PLAN_STATUSES).optional(),
  ends_at: z.string().datetime().nullable().optional(),
});

export type PlanUpdateInput = z.infer<typeof PlanUpdateSchema>;

/**
 * プランの状態の画面の名前 (super_admin のプランの一覧・詳細の画面 (src/app/super-admin/plans) の STATUS_LABELS と同じ語)。
 * 運営の API の失敗の文で、状態の値 (draft など) を括弧に入れて添える前に置く (#1917 の続き)
 */
export const PLAN_STATUS_LABELS: Readonly<Record<(typeof PLAN_STATUSES)[number], string>> = {
  draft: '下書き',
  public: '公開中',
  private: '非公開',
  deprecated: '廃止',
};

/** プランの更新 (PATCH) の項目の画面の名前。失敗の文で、項目名 (trial_days など) を括弧に入れて添える前に置く (#1917 の続き) */
export const PLAN_UPDATE_FIELD_LABELS: Readonly<Record<keyof PlanUpdateInput, string>> = {
  display_name: '表示名',
  description: '説明',
  banner_url: 'バナーの画像の URL',
  feature_package_ids: '機能のパッケージ',
  display_order: '表示の順番',
  max_members: 'メンバーの数の上限',
  max_family_seats: '家族の席の数の上限',
  trial_days: '試用の日数',
  min_contract_months: '最低の契約の月数',
  auto_renew_default: '自動更新の既定',
  stripe_product_id: 'Stripe の商品の ID',
  status: '状態',
  ends_at: '廃止の予定日',
};

/** 状態の値を「画面の名前 (値)」にする (表に無い値は「不明な状態 (値)」。英字の値を括弧の外に出さない) */
function planStatusLabel(status: string): string {
  const label = (PLAN_STATUS_LABELS as Readonly<Record<string, string>>)[status];
  return `${label ?? '不明な状態'} (${status})`;
}

/** 項目名を「画面の名前 (項目名)」にする (表に無い項目は「項目 (項目名)」) */
function planUpdateFieldLabel(key: string): string {
  const label = (PLAN_UPDATE_FIELD_LABELS as Readonly<Record<string, string>>)[key];
  return `${label ?? '項目'} (${key})`;
}

/**
 * 422 OP_PLAN_INVALID_TRANSITION の文: 許されていない状態の遷移 (#1917 の続き)。
 * 以前は `${from} から ${to} への遷移は許可されていません` で、英字の状態の値 (draft など) が括弧の外に出ていた
 */
export function planStatusTransitionMessage(from: string, to: string): string {
  return `プランの状態を ${planStatusLabel(from)} から ${planStatusLabel(to)} へ変えることはできません`;
}

/**
 * 422 OP_PLAN_STATUS_LOCKED の文: 公開中・非公開のプランで変えられない項目を送った (#1917 の続き)。
 * 以前は `公開中プランでは ${keys.join(', ')} は変更できません` で、英字の項目名 (trial_days など) が括弧の外に出ていた
 */
export function planStatusLockedFieldsMessage(keys: readonly string[]): string {
  return `公開中・非公開のプランでは、次の項目は変更できません: ${keys.map(planUpdateFieldLabel).join('、')}。価格の変更は price-change API を使ってください。`;
}

/**
 * 価格変更リクエスト
 *
 * 月額・年額は、変える方だけを指定する (両方を指定してもよい。#1102 で 1 回のリクエストで両方を Stripe へ同期できるようにした)。
 * applies_to は new_only だけ。省略すると new_only になり、on_renewal / immediately は 400 で拒否する (#1102)。
 */
export const PriceChangeSchema = z.object({
  new_monthly_price_jpy: z.number().int().min(0).nullable().optional(),
  new_yearly_price_jpy: z.number().int().min(0).nullable().optional(),
  applies_to: z.enum(PRICE_APPLIES_TO, { message: PRICE_APPLIES_TO_MESSAGE }).default('new_only'),
  reason: z.string().min(1).max(1000),
  effective_at: z.string().datetime(),
}).refine((data) => {
  // 少なくとも月額か年額のどちらかを指定
  return data.new_monthly_price_jpy != null || data.new_yearly_price_jpy != null;
}, { message: '月額または年額のいずれかを指定してください' });

export type PriceChangeInput = z.infer<typeof PriceChangeSchema>;

/** deprecate リクエスト */
export const PlanDeprecateSchema = z.object({
  superseded_by_plan_id: z.string().uuid().nullable().optional(),
  ends_at: z.string().datetime(),
  migration_message: z.string().min(1).max(2000),
});

export type PlanDeprecateInput = z.infer<typeof PlanDeprecateSchema>;

/** 一覧クエリパラメータ */
export const PlansQuerySchema = z.object({
  type: z.enum(PLAN_TYPES).optional(),
  status: z.enum(PLAN_STATUSES).optional(),
  page: z.coerce.number().int().min(1).optional().default(1),
  per_page: z.coerce.number().int().min(1).max(200).optional().default(50),
});

export type PlansQueryInput = z.infer<typeof PlansQuerySchema>;

/**
 * 価格影響シミュレーション クエリパラメータ
 *
 * applies_to は new_only だけ (省略時も new_only)。on_renewal / immediately は 400 で拒否する (#1102)。
 */
export const PriceImpactQuerySchema = z.object({
  new_monthly_price_jpy: z.coerce.number().int().min(0).optional(),
  applies_to: z.enum(PRICE_APPLIES_TO, { message: PRICE_APPLIES_TO_MESSAGE }).optional(),
});

export type PriceImpactQueryInput = z.infer<typeof PriceImpactQuerySchema>;
