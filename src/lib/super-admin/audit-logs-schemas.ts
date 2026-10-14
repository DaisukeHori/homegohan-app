/**
 * 監査ログ スキーマ定義
 * operator/07-audit-monitoring.md §3-4 + operator/02-api-spec.md §6 準拠
 * SELECT は super_admin のみ
 */
import { z } from 'zod';
import { CalendarDateSchema } from '@/lib/calendar-date-schema';

export const AuditLogQuerySchema = z.object({
  actor_id: z.string().uuid().optional(),
  target_id: z.string().uuid().optional(),
  action_type: z.string().optional(),
  severity: z.enum(['info', 'warn', 'critical']).optional(),
  // 期間の開始日・終了日 (どちらの日も含む。JST の暦日)。存在しない日付は 400 (#1433)
  from: CalendarDateSchema.optional(),
  to: CalendarDateSchema.optional(),
  page: z.coerce.number().int().min(1).default(1),
  per_page: z.coerce.number().int().min(1).max(200).default(50),
});

export type AuditLogQuery = z.infer<typeof AuditLogQuerySchema>;

export interface AuditLogEntry {
  id: string;
  actor_id: string | null;
  actor_email_snapshot: string | null;
  actor_role_snapshot: string | null;
  action_type: string;
  target_id: string | null;
  target_type: string | null;
  details: Record<string, unknown>;
  severity: 'info' | 'warn' | 'critical';
  ip_address: string | null;
  user_agent: string | null;
  session_id: string | null;
  impersonated_by: string | null;
  created_at: string;
}

export interface AuditLogListResponse {
  data: AuditLogEntry[];
  meta: {
    total: number;
    page: number;
    per_page: number;
  };
}
