/**
 * user_sessions_metadata (ログイン履歴・セッション) の読み書き。I/O は supabase-js の client を引数で受け、テストでは偽物を渡す。
 * 設計の正典 docs/design/cross/16-auth-history-sessions.md §13.1 (シグネチャ)・§13.5 (recordWebLoginContext)・§13.6 (エラー表)。
 *
 * timestamptz の列 (名前が _at で終わる列) を .gte / .gt / .lte / .lt で絞るのは listPriorLogins の 1 か所だけ
 * (取り置きの時刻の条件は SQL の中 §11.4。tests/jst-today-source-scan.test.ts の規則 G の許可リストに件数 1 で載せている)。
 */
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { ipNetworkOf } from './ip-network';
import { LIST_ORDERS, orderListBy } from '../../api/list-order';

export type ContextSource = 'auth' | 'web' | 'mobile';
export type EndedReason = 'signed_out' | 'revoked_by_user' | 'idle_expired';
export type AlertStatus = 'pending' | 'processing' | 'done';
/**
 * user_sessions_metadata の 1 行 (database.types.ts の Row と同じ列)。PostgREST の data (enum の列も string) を、
 * 各関数は SessionRowSchema.array().parse (PriorLoginRow は .pick(...)) で絞って返す。合わなければ例外 (型の断定はしない)
 */
export const SessionRowSchema = z.object({
  session_id: z.string(), user_id: z.string(), ip_address: z.string().nullable(), ip_network: z.string().nullable(),
  user_agent: z.string().nullable(), device_name: z.string().nullable(), device_family: z.string().nullable(),
  country_code: z.string().nullable(), context_source: z.enum(['auth', 'web', 'mobile']),
  created_at: z.string(), last_active_at: z.string(), revoked_at: z.string().nullable(),
  ended_reason: z.enum(['signed_out', 'revoked_by_user', 'idle_expired']).nullable(),
  is_new_device: z.boolean().nullable(), is_new_ip: z.boolean().nullable(), is_new_country: z.boolean().nullable(),
  alert_status: z.enum(['pending', 'processing', 'done']), alert_claimed_at: z.string().nullable(),
  alert_attempts: z.number().int(), alert_sent_at: z.string().nullable(),
});
export type SessionRow = z.infer<typeof SessionRowSchema>;
export type RevokeOutcome = 'revoked' | 'not_found' | 'current';
/** worker の判定が読む前の行の列 */
export type PriorLoginRow = Pick<SessionRow, 'user_agent' | 'device_family' | 'ip_network' | 'country_code'>;

const TABLE = 'user_sessions_metadata';
/** SessionRowSchema の列すべて (select の列の並び) */
const SESSION_ROW_COLUMNS = Object.keys(SessionRowSchema.shape).join(', ');
const PriorLoginRowSchema = SessionRowSchema.pick({ user_agent: true, device_family: true, ip_network: true, country_code: true });
const PRIOR_LOGIN_COLUMNS = Object.keys(PriorLoginRowSchema.shape).join(', ');
const RevokeOutcomeSchema = z.enum(['revoked', 'not_found', 'current']);
/** UPDATE ... RETURNING で「書けた行があるか」を数えるための列 */
const UpdatedRowsSchema = z.array(z.object({ session_id: z.string() }));

/**
 * DB・GoTrue の失敗を例外にする。文面は固定し、元のエラー (PostgREST・GoTrue の英文に値が入りうる) は cause にだけ持たせる
 * (route は internalError に渡し、本文には出さない)
 */
function storeError(operation: string, cause: unknown): Error {
  const error = new Error(`ログイン履歴の${operation}に失敗しました`);
  Object.defineProperty(error, 'cause', { value: cause, enumerable: false });
  return error;
}

/** 本人の client (RLS)。live の行を last_active_at の降順で */
export async function listLiveSessions(client: SupabaseClient, userId: string): Promise<SessionRow[]> {
  const { data, error } = await orderListBy(
    client.from(TABLE).select(SESSION_ROW_COLUMNS).eq('user_id', userId).is('revoked_at', null),
    LIST_ORDERS.authLiveSessions,
  );
  if (error) throw storeError('読み取り', error);
  return SessionRowSchema.array().parse(data ?? []);
}

/** 本人の client (RLS) または service_role。終わった行を含め created_at の降順で limit 件 */
export async function listLoginHistory(client: SupabaseClient, userId: string, limit: number): Promise<SessionRow[]> {
  const { data, error } = await orderListBy(
    client.from(TABLE).select(SESSION_ROW_COLUMNS).eq('user_id', userId),
    LIST_ORDERS.authLoginHistory,
  ).limit(limit);
  if (error) throw storeError('読み取り', error);
  return SessionRowSchema.array().parse(data ?? []);
}

/** 本人の client で rpc('auth_session_revoke'). 戻りの文字列を RevokeOutcome に絞る (それ以外は例外) */
export async function revokeSession(client: SupabaseClient, sessionId: string): Promise<RevokeOutcome> {
  const { data, error } = await client.rpc('auth_session_revoke', { p_session_id: sessionId });
  if (error) throw storeError('端末の失効', error);
  return RevokeOutcomeSchema.parse(data);
}

/**
 * service_role の client (getSupabaseAdmin())。admin.auth.admin.signOut(accessToken, 'others') で、GoTrue の POST /logout?scope=others を
 * 本人の access token で呼ぶ (JWT の session_id 以外の本人のセッションを DELETE。呼んだセッションは残る)。error が返れば例外を投げる。
 * createClient() の auth.signOut({ scope: 'others' }) は使わない (Bearer だけの要求では GoTrue を呼ばずに成功を返す §3)
 */
export async function signOutOtherSessions(admin: SupabaseClient, accessToken: string): Promise<void> {
  const { error } = await admin.auth.admin.signOut(accessToken, 'others');
  if (error) throw storeError('他の端末のログアウト', error);
}

/**
 * service_role。同じ user_id で session_id ≠ input.sessionId かつ created_at < input.createdAt の行 (live・終わった行の両方。期間では絞らない
 * — 保持は cleanup_ended_user_sessions_metadata が決め、live の行は消えない)。created_at の降順で input.limit 件 (LOGIN_ALERT_PRIOR_MAX_ROWS)
 */
export async function listPriorLogins(
  admin: SupabaseClient,
  input: { userId: string; sessionId: string; createdAt: string; limit: number },
): Promise<PriorLoginRow[]> {
  const { data, error } = await orderListBy(
    admin
      .from(TABLE)
      .select(PRIOR_LOGIN_COLUMNS)
      .eq('user_id', input.userId)
      .neq('session_id', input.sessionId)
      .lt('created_at', input.createdAt),
    LIST_ORDERS.authPriorLogins,
  ).limit(input.limit);
  if (error) throw storeError('読み取り', error);
  return PriorLoginRowSchema.array().parse(data ?? []);
}

/** service_role。本人の session_id の行に device_name と context_source = 'mobile' を書く。行が無ければ false */
export async function setCurrentDeviceName(
  admin: SupabaseClient,
  input: { userId: string; sessionId: string; deviceName: string },
): Promise<boolean> {
  const { data, error } = await admin
    .from(TABLE)
    .update({ device_name: input.deviceName, context_source: 'mobile' })
    .eq('user_id', input.userId)
    .eq('session_id', input.sessionId)
    .select('session_id');
  if (error) throw storeError('端末名の書き込み', error);
  return UpdatedRowsSchema.parse(data ?? []).length > 0;
}

/**
 * service_role。Web の route がログイン直後に呼ぶ。context_source = 'auth' かつ alert_status = 'pending' (判定の前) の行だけ上書きし、'web' にする
 * (revoked_at は見ない §10)。行が無い・既に web/mobile・判定に回った (processing / done) なら false。例外は投げず false (ログインを止めない)
 */
export async function recordWebLoginContext(
  admin: SupabaseClient,
  input: { userId: string; sessionId: string; ipAddress: string | null; userAgent: string | null; countryCode: string | null },
): Promise<boolean> {
  try {
    const { data, error } = await admin
      .from(TABLE)
      .update({
        ip_address: input.ipAddress,
        ip_network: ipNetworkOf(input.ipAddress),
        user_agent: input.userAgent,
        country_code: input.countryCode,
        context_source: 'web',
      })
      .eq('user_id', input.userId)
      .eq('session_id', input.sessionId)
      .eq('context_source', 'auth')
      .eq('alert_status', 'pending')
      .select('session_id');
    if (error) return false;
    const parsed = UpdatedRowsSchema.safeParse(data ?? []);
    return parsed.success && parsed.data.length > 0;
  } catch {
    return false;
  }
}

/**
 * service_role。取り置き (§10 の行) = admin.rpc('claim_login_alerts', { p_batch_size: batchSize, p_min_age_seconds: minAgeSeconds,
 * p_reclaim_minutes: reclaimMinutes, p_max_age_hours: maxAgeHours }) (§11.4)。時刻の条件は DB の now() で SQL の中にある。
 * 作成から maxAgeHours を過ぎた待ち・取り直しの行は、RPC が送らずに done にし (期限切れ)、戻りに入れない。
 * 戻りは取れた行だけ (processing にした行)。error は例外
 */
export async function claimLoginAlerts(
  admin: SupabaseClient,
  input: { batchSize: number; minAgeSeconds: number; reclaimMinutes: number; maxAgeHours: number },
): Promise<SessionRow[]> {
  const { data, error } = await admin.rpc('claim_login_alerts', {
    p_batch_size: input.batchSize,
    p_min_age_seconds: input.minAgeSeconds,
    p_reclaim_minutes: input.reclaimMinutes,
    p_max_age_hours: input.maxAgeHours,
  });
  if (error) throw storeError('通知の取り置き', error);
  return SessionRowSchema.array().parse(data ?? []);
}

/**
 * service_role。判定の結果と送信の結果を書く = admin.from('user_sessions_metadata').update({ alert_status: 'done', device_family: deviceFamily,
 * is_new_device: isNewDevice, is_new_ip: isNewIp, is_new_country: isNewCountry, alert_sent_at: sentAt?.toISOString() ?? null }).eq('session_id', sessionId)。
 * error は例外
 */
export async function finishLoginAlert(
  admin: SupabaseClient,
  input: { sessionId: string; deviceFamily: string; isNewDevice: boolean; isNewIp: boolean; isNewCountry: boolean; sentAt: Date | null },
): Promise<void> {
  const { error } = await admin
    .from(TABLE)
    .update({
      alert_status: 'done',
      device_family: input.deviceFamily,
      is_new_device: input.isNewDevice,
      is_new_ip: input.isNewIp,
      is_new_country: input.isNewCountry,
      alert_sent_at: input.sentAt?.toISOString() ?? null,
    })
    .eq('session_id', input.sessionId);
  if (error) throw storeError('通知の結果の書き込み', error);
}

/**
 * service_role。失敗した行を戻す = admin.rpc('release_login_alert', { p_session_id: sessionId, p_max_attempts: maxAttempts }) (§11.4)。
 * processing の行の alert_attempts を 1 増やし、maxAttempts に届けば done、届かなければ pending (processing でない行は変えない)。error は例外
 */
export async function releaseLoginAlert(admin: SupabaseClient, input: { sessionId: string; maxAttempts: number }): Promise<void> {
  const { error } = await admin.rpc('release_login_alert', { p_session_id: input.sessionId, p_max_attempts: input.maxAttempts });
  if (error) throw storeError('通知の戻し', error);
}
