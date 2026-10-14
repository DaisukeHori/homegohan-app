/**
 * route の単体テスト用に、「ログイン中のユーザー」「本人のセッションの client」「service_role の client」を作る小物。
 *
 * - 本人のセッションの client (createClient()) は、RLS で本人に見える行だけを入れた DB を渡して作る
 *   (user_profiles は本人の行だけ、など。RLS そのものは再現しないので、見える行を呼び出し側が決める)
 * - service_role の client (getSupabaseAdmin()) は、全ての行を入れた DB を渡して作る
 *   -> route が認可の後に service_role で読むべき所を、セッションの client で読んでしまうと、
 *      他人の行が見えず、テストが失敗する
 */
import type { Row, SchemaDb } from './schema-checked-db';

export interface FakeUser {
  id: string;
  email?: string;
}

/** supabase-js の client のうち、route が使う部分 (auth.getUser / from / rpc) */
export function makeClient(db: SchemaDb, user: FakeUser | null, rpc?: (...args: any[]) => unknown) {
  return {
    auth: {
      getUser: async () =>
        user
          ? { data: { user }, error: null }
          : { data: { user: null }, error: { message: 'Auth session missing!' } },
    },
    from: (table: string) => db.from(table),
    rpc: rpc ?? (async () => ({ data: null, error: null })),
  };
}

/** user_profiles の行 (必要な列だけ上書きする) */
export function profileRow(id: string, extra: Row = {}): Row {
  return {
    id,
    nickname: `ニック-${id.slice(0, 4)}`,
    roles: ['user'],
    organization_id: null,
    org_role: null,
    department_id: null,
    frozen_at: null,
    unban_at: null,
    ...extra,
  };
}

/** 数字から決まる、見分けやすい UUID (形式は v4) */
export function uuid(n: number): string {
  const hex = n.toString(16).padStart(12, '0');
  return `00000000-0000-4000-8000-${hex}`;
}

export function jsonRequest(url: string, method: string, body?: unknown, headers: Record<string, string> = {}) {
  return new Request(url, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
}
