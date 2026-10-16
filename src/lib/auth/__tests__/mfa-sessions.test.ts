/**
 * #1707 運営ロールの MFA: 別の super_admin による解除 (段 C) が対象の全セッションを終える facade のテスト。
 * docs/design/cross/12-operator-mfa.md §12.6・§13.6・§21.1 (mfa-sessions.test.ts)。rpc は偽物を渡す
 */
import { describe, expect, it, vi } from 'vitest';
import {
  OPERATOR_MFA_END_SESSIONS_ERROR_MESSAGE,
  OPERATOR_MFA_END_SESSIONS_RPC,
  endUserSessions,
  type OperatorSessionRpcClient,
} from '@/lib/auth/mfa/sessions';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const RAW_POSTGREST_TEXT = 'permission denied for function operator_mfa_end_sessions secret_detail';

function fakeClient(result: { data: unknown; error: unknown }) {
  const rpc = vi.fn(async () => result);
  const client: OperatorSessionRpcClient = { rpc };
  return { client, rpc };
}

describe('endUserSessions', () => {
  it("endUserSessions は rpc('operator_mfa_end_sessions', { p_user_id: userId }) を 1 回呼び、数の data (0 を含む) をそのまま返す", async () => {
    expect(OPERATOR_MFA_END_SESSIONS_RPC).toBe('operator_mfa_end_sessions');
    for (const ended of [2, 0]) {
      const { client, rpc } = fakeClient({ data: ended, error: null });
      await expect(endUserSessions(client, USER_ID)).resolves.toBe(ended);
      expect(rpc).toHaveBeenCalledTimes(1);
      expect(rpc).toHaveBeenCalledWith('operator_mfa_end_sessions', { p_user_id: USER_ID });
    }
  });

  it('endUserSessions は rpc の error と、数でない data (null・文字列・負・小数) で固定の文 (OPERATOR_MFA_END_SESSIONS_ERROR_MESSAGE) の Error を投げ、cause に元の値を持つ (message に PostgREST の文を入れない §23 N-5)', async () => {
    expect(OPERATOR_MFA_END_SESSIONS_ERROR_MESSAGE).toBe('対象のセッションの終了に失敗しました');
    const rpcError = { message: RAW_POSTGREST_TEXT, code: '42501', details: null, hint: null };
    const cases: Array<{ data: unknown; error: unknown; cause: unknown }> = [
      { data: null, error: rpcError, cause: rpcError },
      // error があれば data が数でも投げる
      { data: 1, error: rpcError, cause: rpcError },
      { data: null, error: null, cause: null },
      { data: '2', error: null, cause: '2' },
      { data: -1, error: null, cause: -1 },
      { data: 1.5, error: null, cause: 1.5 },
      { data: Number.NaN, error: null, cause: Number.NaN },
    ];
    for (const { data, error, cause } of cases) {
      const { client } = fakeClient({ data, error });
      const thrown = await endUserSessions(client, USER_ID).then(
        () => null,
        (e: unknown) => e,
      );
      expect(thrown, JSON.stringify({ data, error })).toBeInstanceOf(Error);
      const err = thrown as Error;
      expect(err.message).toBe(OPERATOR_MFA_END_SESSIONS_ERROR_MESSAGE);
      expect(err.message).not.toContain(RAW_POSTGREST_TEXT);
      expect(Object.is(err.cause, cause) || err.cause === cause).toBe(true);
    }
  });
});
