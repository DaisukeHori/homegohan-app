/**
 * 運営操作の監査ログ (admin_audit_logs) 記録ヘルパー (#1200)
 *
 * 管理者・サポートがユーザーの個人情報 (PII) を閲覧したときなど、運営側の操作を
 * admin_audit_logs に 1 行記録する。「誰が・いつ・誰の情報を見たか」を、
 * 開示請求や内部統制の調査で答えられるようにするのが目的。
 *
 * 使い方 (route 側):
 *   const supabase = await createClient(); // ログインした本人の権限で動く client
 *   await recordAdminAudit({
 *     supabase,
 *     actorId: actor.id,
 *     actionType: 'admin.user.view',
 *     targetId: id, // 閲覧された本人 (ユーザー) の id
 *     targetType: 'user',
 *     details: { viewed_fields: [...] }, // 閲覧した「項目名」だけを入れる (値や email は入れない)
 *     request,
 *   });
 *
 * 注意:
 *  - RLS (audit_logs_insert_admins) は actor_id = auth.uid() かつ運営ロールのときだけ
 *    INSERT を許す。そのため user-scoped client (createClient()) を渡すこと。
 *    service_role を使う場合は、呼び出し側が必ず認可 (requireRole 等) を先に通すこと。
 *  - 閲覧の記録は fail-open。記録に失敗しても例外は投げず、閲覧そのものは止めない。
 *    失敗は db-logger 経由で app_logs に error として残す。
 *    返金のように「記録できないなら実行しない」操作は、戻り値の ok を見て呼び出し側で止めること。
 *  - action_type の命名は `admin.<対象>.<操作>` (docs/design/operator/07-audit-monitoring.md §4)。
 */

import { isIP } from 'net';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createLogger } from '@/lib/db-logger';

export type AdminAuditSeverity = 'info' | 'warn' | 'critical';

export interface RecordAdminAuditParams {
  /** admin_audit_logs に INSERT する Supabase client (user-scoped を推奨。上記の注意を参照) */
  supabase: Pick<SupabaseClient<any, any, any>, 'from'>;
  /** 操作した運営ユーザーの id。RLS により auth.uid() と一致している必要がある */
  actorId: string;
  /** 例: 'admin.user.view' */
  actionType: string;
  /** 操作・閲覧された対象の id (uuid)。閲覧ログでは「情報を見られた本人」の id */
  targetId?: string | null;
  /** 例: 'user' (varchar(30)) */
  targetType?: string | null;
  /** 補足情報。閲覧ログには項目名だけを入れ、値・email などの個人情報は入れない */
  details?: Record<string, unknown>;
  /** 既定は 'info' */
  severity?: AdminAuditSeverity;
  /** IP アドレスと User-Agent を取り出すためのリクエスト */
  request?: Pick<Request, 'headers'>;
  /** 失敗時に db-logger (app_logs.function_name) へ出す名前。例: 'api/admin/users/[id] GET' */
  routeName?: string;
}

export type RecordAdminAuditResult = { ok: true } | { ok: false; error: string };

const DEFAULT_ROUTE_NAME = 'admin-audit';

/** User-Agent は長さに上限を設けて保存する (巨大なヘッダで行が膨らまないように) */
const USER_AGENT_MAX_LENGTH = 512;

/**
 * リクエストヘッダからクライアントの IP アドレスを 1 つ取り出す。
 *
 * ip_address 列は inet 型。x-forwarded-for は "client, proxy1, proxy2" のように
 * 複数 IP が入ることがあり、そのまま渡すと INSERT が失敗して監査行ごと失われる。
 * そのため先頭の 1 つだけを取り、IP として正しいときだけ返す。
 * 正しくなければ x-real-ip を試し、それも正しくなければ null (監査行は ip_address=null で残す)。
 * IPv6 のゾーン ID (fe80::1%eth0) は inet が受け付けないので除外する。
 * 値はプロキシ (Vercel など) が付けたものを信頼する前提の最善努力で、認可の判断には使わない。
 */
export function extractClientIp(headers: Pick<Headers, 'get'> | null | undefined): string | null {
  if (!headers) return null;
  const candidates = [headers.get('x-forwarded-for')?.split(',')[0], headers.get('x-real-ip')];
  for (const candidate of candidates) {
    const ip = candidate?.trim();
    if (ip && !ip.includes('%') && isIP(ip) !== 0) return ip;
  }
  return null;
}

function extractUserAgent(headers: Pick<Headers, 'get'> | null | undefined): string | null {
  const userAgent = headers?.get('user-agent')?.trim();
  return userAgent ? userAgent.slice(0, USER_AGENT_MAX_LENGTH) : null;
}

function logAuditFailure(params: RecordAdminAuditParams, error: Error, errorCode?: string): void {
  try {
    createLogger(params.routeName ?? DEFAULT_ROUTE_NAME).error(
      '監査ログ (admin_audit_logs) への記録に失敗しました',
      error,
      {
        action_type: params.actionType,
        actor_id: params.actorId,
        target_id: params.targetId ?? null,
        target_type: params.targetType ?? null,
        error_code: errorCode ?? null,
      },
    );
  } catch {
    // ログ出力の失敗で、呼び出し元の処理を止めない
  }
}

/**
 * 運営操作を admin_audit_logs に 1 行記録する。例外は投げない (fail-open)。
 *
 * @returns 記録できたら { ok: true }。失敗したら { ok: false, error } を返し、
 *          失敗内容は db-logger で app_logs にも残す。
 */
export async function recordAdminAudit(
  params: RecordAdminAuditParams,
): Promise<RecordAdminAuditResult> {
  try {
    const { error } = await params.supabase.from('admin_audit_logs').insert({
      actor_id: params.actorId,
      action_type: params.actionType,
      target_id: params.targetId ?? null,
      target_type: params.targetType ?? null,
      details: params.details ?? {},
      severity: params.severity ?? 'info',
      ip_address: extractClientIp(params.request?.headers),
      user_agent: extractUserAgent(params.request?.headers),
    });

    if (!error) return { ok: true };

    logAuditFailure(params, new Error(error.message), error.code);
    return { ok: false, error: error.message };
  } catch (err) {
    const failure = err instanceof Error ? err : new Error(String(err));
    logAuditFailure(params, failure);
    return { ok: false, error: failure.message };
  }
}
