/**
 * super_admin 機能パッケージ API 用 Zod スキーマ
 * operator/01-data-model.md §3.3 / operator/02-api-spec.md 準拠
 *
 * route.ts には inline 定義しない (family/02 §15.6.1 確定ルール)。
 */

import { z } from 'zod';

// ─────────────────────────────────────────────────────────────────────────────
// 定数
// ─────────────────────────────────────────────────────────────────────────────

export const FEATURE_PACKAGE_STATUSES = ['active', 'deprecated'] as const;
export type FeaturePackageStatus = (typeof FEATURE_PACKAGE_STATUSES)[number];

/** 機能パッケージの状態の画面の名前 (機能パッケージ詳細の状態のバッジと同じ) */
export const FEATURE_PACKAGE_STATUS_LABELS: Readonly<Record<FeaturePackageStatus, string>> = {
  active: '有効',
  deprecated: '廃止',
};

/**
 * 作成で、同じ package_key (一意の制約の違反 23505) の機能パッケージがすでにあるときの文 (HTTP は 409・code は OP_PACKAGE_KEY_DUPLICATE)。
 * 呼び名は運営の画面の欄名 (新規作成・詳細の「パッケージの鍵」) と同じにする (#2166 X2)
 */
export const PACKAGE_KEY_DUPLICATE_MESSAGE = '同じパッケージの鍵 (package_key) がすでにあります';

/**
 * 機能パッケージの状態の遷移表 (#2064)。画面のボタンと同じ 1 つだけを許す:
 *   active → deprecated (詳細の「廃止する」)。deprecated からはどこへも変えない (終端。廃止の取り消しは無い)
 * ここに無い変更 (同じ状態への変更・廃止の取り消し) は PATCH が 409 で断る。
 * DB には遷移を止めるトリガーが無い (CHECK feature_packages_status_check は値の範囲だけ) ので、守りは PATCH の route だけ
 */
export const FEATURE_PACKAGE_STATUS_TRANSITIONS: Readonly<Record<FeaturePackageStatus, readonly FeaturePackageStatus[]>> = {
  active: ['deprecated'],
  deprecated: [],
};

export function isFeaturePackageStatus(value: unknown): value is FeaturePackageStatus {
  return typeof value === 'string' && (FEATURE_PACKAGE_STATUSES as readonly string[]).includes(value);
}

/** from (今の状態) から to へ変えてよいか。from が知らない値なら、どこへも変えない */
export function isAllowedFeaturePackageStatusTransition(from: string, to: FeaturePackageStatus): boolean {
  return isFeaturePackageStatus(from) && FEATURE_PACKAGE_STATUS_TRANSITIONS[from].includes(to);
}

/** 遷移表に無い状態の変更を断るときのエラーの code (HTTP は 409) */
export const FEATURE_PACKAGE_INVALID_TRANSITION_ERROR_CODE = 'OP_FEATURE_PACKAGE_INVALID_TRANSITION';

/** 状態の値を「画面の名前 (値)」にする (表に無い値は「不明な状態 (値)」。英字の値を括弧の外に出さない) */
function featurePackageStatusLabel(status: string): string {
  const label = isFeaturePackageStatus(status) ? FEATURE_PACKAGE_STATUS_LABELS[status] : '不明な状態';
  return `${label} (${status})`;
}

/** 遷移表にある遷移を「a → b」の形で並べた文 (断るときの文に添える) */
const ALLOWED_FEATURE_PACKAGE_TRANSITIONS_TEXT = FEATURE_PACKAGE_STATUSES.flatMap((from) =>
  FEATURE_PACKAGE_STATUS_TRANSITIONS[from].map((to) => `${featurePackageStatusLabel(from)} → ${featurePackageStatusLabel(to)}`),
).join('・');

/** 遷移表に無い状態の変更を断るときの文。変えられる遷移も添える */
export function featurePackageStatusTransitionMessage(from: string, to: FeaturePackageStatus): string {
  return `機能パッケージの状態は ${featurePackageStatusLabel(from)} から ${featurePackageStatusLabel(to)} へは変えられません (変えられるのは ${ALLOWED_FEATURE_PACKAGE_TRANSITIONS_TEXT} だけです)`;
}

// ─────────────────────────────────────────────────────────────────────────────
// スキーマ定義
// ─────────────────────────────────────────────────────────────────────────────

/** 機能パッケージ新規作成リクエスト */
export const FeaturePackageCreateSchema = z.object({
  package_key: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-z0-9_]+$/, '英小文字・数字・アンダースコアのみ'),
  display_name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  feature_flags: z.array(z.string().max(100)).min(1, '少なくとも1つの機能フラグを指定してください'),
  display_order: z.number().int().min(0).optional().default(0),
});

export type FeaturePackageCreateInput = z.infer<typeof FeaturePackageCreateSchema>;

/** 機能パッケージ更新リクエスト */
export const FeaturePackageUpdateSchema = z.object({
  display_name: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).nullable().optional(),
  feature_flags: z.array(z.string().max(100)).min(1).optional(),
  display_order: z.number().int().min(0).optional(),
  status: z.enum(FEATURE_PACKAGE_STATUSES).optional(),
});

export type FeaturePackageUpdateInput = z.infer<typeof FeaturePackageUpdateSchema>;

/** 一覧クエリパラメータ */
export const FeaturePackagesQuerySchema = z.object({
  status: z.enum(FEATURE_PACKAGE_STATUSES).optional(),
  page: z.coerce.number().int().min(1).optional().default(1),
  per_page: z.coerce.number().int().min(1).max(200).optional().default(50),
});

export type FeaturePackagesQueryInput = z.infer<typeof FeaturePackagesQuerySchema>;
