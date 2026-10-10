/**
 * #1165 ログインの連続失敗の回数の記録 (supabase/migrations/20261010160000_auth_login_failure_window.sql の関数) の偽物。
 * 単体テスト用。DB の関数と同じ規則で動く:
 *   - キーは lower(btrim(メールアドレス))
 *   - auth_login_failure_count(p_email, p_reset_after_minutes): 回数。最後の失敗から p_reset_after_minutes 分が経っていれば 0
 *     (「last_failed_at > いま - 間隔」なら数えたまま)。行が無ければ 0
 *   - auth_login_count_failure(p_email, p_reset_after_minutes): 1 回数えて、数えた後の回数を返す。
 *     最後の失敗から p_reset_after_minutes 分が経っていれば (「last_failed_at <= いま - 間隔」) 1 からやり直す
 *   - どちらも p_reset_after_minutes が整数で 1 以上でなければ 22023 のエラー
 *   - auth_login_clear_failures: 行を消す
 *   - ロックのための古い関数 (auth_login_lock_status / auth_login_record_failure / auth_login_apply_lock /
 *     auth_login_account_user_id) は、アプリから呼ばれてはいけないので、知らない関数としてエラーを返す
 * 「いま」は now (書き換えられる)。本物の DB での挙動は tests/integration/security/auth-login-lock.test.ts が確かめる。
 */
import type { LoginFailureRpcClient } from '@/lib/auth/login-failures';

const MS_PER_MINUTE = 60_000;

export interface FakeFailureRow {
  failure_count: number;
  /** 最後に失敗した時刻 */
  last_failed_at: Date;
}

export interface FakeLoginFailureStore {
  client: LoginFailureRpcClient;
  rows: Map<string, FakeFailureRow>;
  calls: Array<{ fn: string; args: Record<string, unknown> }>;
  /** DB の now()。テストで進められる */
  now: Date;
  /** 次の呼び出しで、この関数がエラーを返すようにする */
  failNext(fn: string, error?: unknown): void;
  row(email: string): FakeFailureRow | undefined;
  /** 最後の失敗が、いまから minutesAgo 分前の行を置く */
  setFailures(email: string, failureCount: number, minutesAgo?: number): void;
}

const key = (email: unknown) => String(email ?? '').trim().toLowerCase();

const INVALID_PARAMETER = { code: '22023', message: 'p_reset_after_minutes must be 1 or more' };

function resetMinutes(args: Record<string, unknown>): number | null {
  const value = args.p_reset_after_minutes;
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 ? value : null;
}

export function createFakeLoginFailureStore(now: Date = new Date('2026-10-10T03:00:00.000Z')): FakeLoginFailureStore {
  const rows = new Map<string, FakeFailureRow>();
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const failures = new Map<string, unknown>();

  const store: FakeLoginFailureStore = {
    client: {
      async rpc(fn, args) {
        calls.push({ fn, args });
        if (failures.has(fn)) {
          const error = failures.get(fn);
          failures.delete(fn);
          return { data: null, error };
        }
        const email = key(args.p_email);
        switch (fn) {
          case 'auth_login_failure_count': {
            const minutes = resetMinutes(args);
            if (minutes === null) return { data: null, error: INVALID_PARAMETER };
            const row = rows.get(email);
            const threshold = store.now.getTime() - minutes * MS_PER_MINUTE;
            return { data: row && row.last_failed_at.getTime() > threshold ? row.failure_count : 0, error: null };
          }
          case 'auth_login_count_failure': {
            const minutes = resetMinutes(args);
            if (minutes === null) return { data: null, error: INVALID_PARAMETER };
            const row = rows.get(email);
            const threshold = store.now.getTime() - minutes * MS_PER_MINUTE;
            const count = row && row.last_failed_at.getTime() > threshold ? row.failure_count + 1 : 1;
            rows.set(email, { failure_count: count, last_failed_at: new Date(store.now) });
            return { data: count, error: null };
          }
          case 'auth_login_clear_failures':
            rows.delete(email);
            return { data: null, error: null };
          default:
            return { data: null, error: { code: 'PGRST202', message: `unknown function ${fn}` } };
        }
      },
    },
    rows,
    calls,
    now,
    failNext(fn, error = { code: '57P01', message: 'terminating connection' }) {
      failures.set(fn, error);
    },
    row: (email) => rows.get(key(email)),
    setFailures(email, failureCount, minutesAgo = 0) {
      rows.set(key(email), {
        failure_count: failureCount,
        last_failed_at: new Date(store.now.getTime() - minutesAgo * MS_PER_MINUTE),
      });
    },
  };
  return store;
}
