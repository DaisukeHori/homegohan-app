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
 *  - 一覧・検索 (#1326) は「1 回の検索 = 1 行」で記録し、details は buildListViewDetails() で作る
 *    (検索条件と件数だけ。返した行の ID や値は入れない)。0 件のときは記録しない。
 *  - admin / super-admin の route は admin_audit_logs へ直接 INSERT せず、x-forwarded-for も直接読まない
 *    (tests/admin-view-audit-1326.test.ts が検査する)。
 *  - ip_address は利用者の IP (src/lib/admin/client-ip.ts の extractClientIp)。request を必ず渡すこと (#1571。
 *    渡さないと ip_address / user_agent が null になる。tests/admin-mutation-audit-coverage-1571.test.ts が検査する)。
 *    サーバーコンポーネントから adminFetch で呼んだときも、adminFetch が署名して転送した利用者の IP が入る
 *    (Vercel は内部の呼び出しの x-forwarded-for をサーバーの IP に付け直すため)。
 *  - 定期処理 (pg_cron) が DB の中で書く行 (例: handson_tour_sandbox_cleanup) は、操作した利用者がいないので
 *    ip_address は NULL のまま (#1571)。
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { createLogger } from '@/lib/db-logger';
import { extractClientIp } from '@/lib/admin/client-ip';

// 利用者の IP の取り出しは src/lib/admin/client-ip.ts (#1571)。ここからも読めるように再び公開する
// (auth/login・legal/accept・ai/consent などが '@/lib/admin/audit' から読む)
export { extractClientIp };

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
 * 一覧・検索の閲覧ログ (#1326) で、検索条件の 1 つの値として残す文字列の長さの上限。
 * 検索語は運営者が入力した値なので残すが、巨大な入力で監査行が膨らまないように切り詰める。
 */
const LIST_FILTER_VALUE_MAX_LENGTH = 200;

/**
 * 一覧・検索を「1 回の検索 = 1 行」で記録するときの details を作る (#1326)。
 *
 * - filters: 検索条件 (クエリ文字列を検証したあとの値)。未指定 (undefined / null / 空文字) の条件は落とす。
 *   文字列は LIST_FILTER_VALUE_MAX_LENGTH 文字に切り詰める。
 * - returned_count: この応答で返した行数。total: 条件に合う全件数 (取れないときは null)。
 * 返した個々の行の ID や値は入れない (1 画面で多数の行を返すため。開示請求の照会は詳細の閲覧ログで行う)。
 */
export function buildListViewDetails(
  filters: Record<string, string | number | boolean | null | undefined>,
  returnedCount: number,
  total: number | null,
): Record<string, unknown> {
  const kept: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(filters)) {
    if (value === undefined || value === null || value === '') continue;
    kept[key] = typeof value === 'string' ? value.slice(0, LIST_FILTER_VALUE_MAX_LENGTH) : value;
  }
  return { filters: kept, returned_count: returnedCount, total };
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
