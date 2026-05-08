/**
 * インフラ監視 スキーマ定義
 * operator/01-data-model.md §3.12 + operator/02-api-spec.md §13 準拠
 */
import { z } from 'zod';

export const InfraMetricsQuerySchema = z.object({
  metric_name: z.string().optional(),
  source: z.enum(['vercel', 'supabase', 'gemini', 'xai', 'anthropic', 'openai', 'custom']).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(200),
});

export const InfraAlertsQuerySchema = z.object({
  resolved: z.enum(['true', 'false']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  per_page: z.coerce.number().int().min(1).max(100).default(50),
});

export type InfraMetricsQuery = z.infer<typeof InfraMetricsQuerySchema>;
export type InfraAlertsQuery = z.infer<typeof InfraAlertsQuerySchema>;

export interface InfraMetric {
  id: string;
  metric_name: string;
  source: string;
  value: number;
  unit: string | null;
  tags: Record<string, unknown>;
  recorded_at: string;
}

export interface InfraAlert {
  id: string;
  metric_name: string;
  threshold: number;
  comparison: '>' | '>=' | '<' | '<=' | '=';
  triggered_at: string;
  resolved_at: string | null;
  details: Record<string, unknown> | null;
  ack_by: string | null;
  ack_at: string | null;
  created_at: string;
}

export interface InfraDashboard {
  vercel: {
    error_rate: number | null;
    p95_ms: number | null;
    deploy_status: 'healthy' | 'degraded' | 'down' | 'unknown';
  };
  supabase: {
    db_connections: number | null;
    p95_query_ms: number | null;
    edge_fn_status: 'healthy' | 'degraded' | 'down' | 'unknown';
  };
  llm_apis: {
    xai: { p95_ms: number | null; error_rate: number | null } | null;
    gemini: { p95_ms: number | null; error_rate: number | null } | null;
    anthropic: { p95_ms: number | null; error_rate: number | null } | null;
  };
  cache_hit_rate: number | null;
  active_incidents: number;
  last_updated: string;
}
