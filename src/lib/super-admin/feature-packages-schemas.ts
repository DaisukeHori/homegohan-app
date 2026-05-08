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
