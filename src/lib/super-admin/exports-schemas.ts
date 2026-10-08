/**
 * データエクスポート スキーマ定義
 * operator/02-api-spec.md §16 + operator/03-ui-spec.md §28 準拠
 *
 * 注意 (#1126): データエクスポート機能は準備中 (未対応) で、API (/api/super-admin/exports) は
 * 全メソッドが 501 (OP_NOT_SUPPORTED) を返す。ここにあるスキーマと型は、機能を作るときの
 * 設計 (リクエスト・一覧・状態の形) を残してあるだけで、いまはどの API からも使っていない。
 * 実装するときは、専用の exports テーブルとファイルを作る処理を先に用意すること
 * (以前のように、本人の GDPR 削除要求の表 gdpr_deletion_requests を代用しない)。
 */
import { z } from 'zod';

/** API (501) の本文。画面の「準備中（未対応）」と同じ内容を伝える */
export const EXPORTS_NOT_SUPPORTED_MESSAGE =
  'データのエクスポートは準備中（未対応）です。依頼を受け付けても、ファイルを作る処理がまだ無いため、現在は利用できません。';

export const ExportType = ['user_data', 'audit_logs', 'meal_records', 'org_data', 'gdpr'] as const;
export const ExportFormat = ['csv', 'json', 'parquet'] as const;

export const CreateExportSchema = z.object({
  export_type: z.enum(ExportType),
  format: z.enum(ExportFormat).default('csv'),
  filters: z.object({
    registered_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    registered_to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    plan_key: z.string().optional(),
    org_id: z.string().uuid().optional(),
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  }).optional(),
  mask_pii: z.boolean().default(true),
});

export const ListExportsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  per_page: z.coerce.number().int().min(1).max(100).default(50),
  status: z.enum(['pending', 'processing', 'completed', 'failed']).optional(),
});

export type CreateExportInput = z.infer<typeof CreateExportSchema>;
export type ListExportsQuery = z.infer<typeof ListExportsQuerySchema>;

export type ExportStatus = 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled';

export interface DataExport {
  id: string;
  export_type: typeof ExportType[number];
  format: typeof ExportFormat[number];
  filters: Record<string, unknown> | null;
  mask_pii: boolean;
  status: ExportStatus;
  file_url: string | null;
  file_size_bytes: number | null;
  row_count: number | null;
  error_message: string | null;
  requested_by: string;
  started_at: string | null;
  completed_at: string | null;
  expires_at: string | null;
  created_at: string;
}
