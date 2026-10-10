/**
 * #1165 ログイン失敗のロックの記録 (supabase/migrations/20261010130000_auth_login_failures.sql の関数) の偽物。
 * 単体テスト用。DB の関数と同じ規則で動く:
 *   - キーは lower(btrim(メールアドレス))
 *   - auth_login_lock_status: 行があれば 1 行、無ければ 0 行
 *   - auth_login_record_failure: 回数を 1 増やし (無ければ 1 で作る)、増やした後の回数と期限を 1 行で返す
 *   - auth_login_apply_lock: 期限を延ばす (今の期限より短くはしない)。行が無ければ何もしない
 *   - auth_login_clear_failures: 行を消す
 *   - auth_login_account_user_id: accounts に登録したメールアドレスの user_id。無ければ null
 * 本物の DB での挙動は tests/integration/security/auth-login-lock.test.ts が確かめる。
 */
import type { LoginLockRpcClient } from '@/lib/auth/login-lock';

export interface FakeLockRow {
  failure_count: number;
  locked_until: string | null;
}

export interface FakeLoginLockStore {
  client: LoginLockRpcClient;
  rows: Map<string, FakeLockRow>;
  accounts: Map<string, string>;
  calls: Array<{ fn: string; args: Record<string, unknown> }>;
  /** 次の呼び出しで、この関数がエラーを返すようにする */
  failNext(fn: string, error?: unknown): void;
  row(email: string): FakeLockRow | undefined;
}

const key = (email: unknown) => String(email ?? '').trim().toLowerCase();

export function createFakeLoginLockStore(): FakeLoginLockStore {
  const rows = new Map<string, FakeLockRow>();
  const accounts = new Map<string, string>();
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const failures = new Map<string, unknown>();

  const client: LoginLockRpcClient = {
    async rpc(fn, args) {
      calls.push({ fn, args });
      if (failures.has(fn)) {
        const error = failures.get(fn);
        failures.delete(fn);
        return { data: null, error };
      }
      const email = key(args.p_email);
      switch (fn) {
        case 'auth_login_lock_status': {
          const row = rows.get(email);
          return { data: row ? [{ ...row }] : [], error: null };
        }
        case 'auth_login_record_failure': {
          const row = rows.get(email) ?? { failure_count: 0, locked_until: null };
          row.failure_count += 1;
          rows.set(email, row);
          return { data: [{ ...row }], error: null };
        }
        case 'auth_login_apply_lock': {
          const row = rows.get(email);
          if (row) {
            const next = String(args.p_locked_until);
            if (!row.locked_until || new Date(next) > new Date(row.locked_until)) row.locked_until = next;
          }
          return { data: null, error: null };
        }
        case 'auth_login_clear_failures':
          rows.delete(email);
          return { data: null, error: null };
        case 'auth_login_account_user_id':
          return { data: accounts.get(email) ?? null, error: null };
        default:
          return { data: null, error: { code: 'PGRST202', message: `unknown function ${fn}` } };
      }
    },
  };

  return {
    client,
    rows,
    accounts,
    calls,
    failNext(fn, error = { code: '57P01', message: 'terminating connection' }) {
      failures.set(fn, error);
    },
    row: (email) => rows.get(key(email)),
  };
}
