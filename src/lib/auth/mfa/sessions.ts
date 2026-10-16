/**
 * 運営ロールの MFA: 別の super_admin による解除 (段 C) が、対象の全セッションを終える facade
 * (#1707・#1176。docs/design/cross/12-operator-mfa.md §12.6・§11.5・§14.7)
 *
 * reset の route (src/app/api/super-admin/admins/[id]/mfa/reset/route.ts) だけが呼ぶ。service_role の client の rpc だけを使い、
 * client は route から受け取る (getSupabaseAdmin()。自前で作らない §23 N-4)。
 * 回復の route (§14.5) は本人の token で admin.auth.admin.signOut(token, 'global') を呼び、このファイルを使わない (§7.1)。
 * サーバー専用 (service_role の client を受け取る)。client component から import しない。
 */

/** reset の route が呼ぶ RPC (段 C の migration が作る関数 §11.5)。sessions.ts はこの名前以外の RPC を呼ばない */
export const OPERATOR_MFA_END_SESSIONS_RPC = 'operator_mfa_end_sessions';
/** 投げる Error の固定の文 (PostgREST の文は cause にだけ持つ §23 N-5) */
export const OPERATOR_MFA_END_SESSIONS_ERROR_MESSAGE = '対象のセッションの終了に失敗しました';

/**
 * service_role の client の rpc だけを使う (src/lib/auth/login-failures.ts の LoginFailureRpcClient と同じ型。テストでは偽物を渡す)。
 * route は `const sessions: OperatorSessionRpcClient = { rpc: (fn, args) => admin.rpc(fn, args) };` で包む
 * (admin = getSupabaseAdmin()。型の生成物に operator_mfa_end_sessions が入っているので admin.rpc の引数が合う §11.5)
 */
export interface OperatorSessionRpcClient {
  rpc(
    fn: typeof OPERATOR_MFA_END_SESSIONS_RPC,
    args: { p_user_id: string },
  ): PromiseLike<{ data: unknown; error: unknown }>;
}

/**
 * 対象の全セッションを終える (auth.sessions の user_id の行を全部消す = GoTrue の /logout?scope=global と同じ結果 §11.5)。
 * 消した行数を返す (0 はセッションが無かっただけで失敗ではない S-35)。
 * RPC の error と、数でない戻り (型の生成物と食い違う応答) は、固定の文の Error を投げ、元の値を cause に持つ (§13.6)。
 */
export async function endUserSessions(admin: OperatorSessionRpcClient, userId: string): Promise<number> {
  const { data, error } = await admin.rpc(OPERATOR_MFA_END_SESSIONS_RPC, { p_user_id: userId });
  if (error) throw new Error(OPERATOR_MFA_END_SESSIONS_ERROR_MESSAGE, { cause: error });
  if (typeof data !== 'number' || !Number.isInteger(data) || data < 0) {
    throw new Error(OPERATOR_MFA_END_SESSIONS_ERROR_MESSAGE, { cause: data });
  }
  return data;
}
