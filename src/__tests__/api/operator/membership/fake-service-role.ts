/**
 * membership 系 API の単体テスト用フェイク。
 * 運営の強制譲渡・強制解散・候補者一覧のほか、移譲の承諾・メールアドレスの解決
 * (src/lib/membership/resolve-auth-emails.ts) のテストからも使う。
 *
 * tests/helpers/fake-supabase.ts は「呼び出し順に用意した結果を返すキュー式」だが、
 * 強制譲渡の通知不具合 (#1209) の原因は「RPC が行を書き換えた後に読み直すと値が変わる」ことなので、
 * ここでは状態を持つ最小のインメモリ DB にしている。
 * RPC のシミュレータが tables を書き換えたあとの読み取りは更新後の値を返す。
 * そのため「RPC の後に読み直して旧オーナーを決める」実装は、本番と同じ理由でテストでも壊れる。
 */
import { vi } from 'vitest';

export type Row = Record<string, unknown>;
export type Tables = Record<string, Row[]>;
export type FakeAuthUser = { id: string; email: string | null };

type QueryResult = { data: unknown; error: unknown };

interface FakeQuery extends PromiseLike<QueryResult> {
  select(columns?: string): FakeQuery;
  eq(column: string, value: unknown): FakeQuery;
  neq(column: string, value: unknown): FakeQuery;
  in(column: string, values: unknown[]): FakeQuery;
  order(column: string, options?: { ascending?: boolean; nullsFirst?: boolean }): FakeQuery;
  single(): Promise<QueryResult>;
  maybeSingle(): Promise<QueryResult>;
}

export type FakeServiceRole = ReturnType<typeof createFakeServiceRole>;

/** auth.admin.listUsers() に page / perPage を渡さないときに返る件数 (GoTrue の既定)。#1204 の原因 */
export const LIST_USERS_DEFAULT_PER_PAGE = 50;

/**
 * 登録順で先頭 count 件を占める「無関係のユーザー」。実際の宛先をこの後ろに並べると、
 * listUsers() を引数なしで呼ぶ実装は宛先を見つけられない (本番で登録ユーザーが 50 人を超えた状態)。
 */
export function leadingUsers(count: number): FakeAuthUser[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    email: `leading-user-${index + 1}@example.test`,
  }));
}

export function createFakeServiceRole(init: { tables: Tables; users: FakeAuthUser[] }) {
  const { tables, users } = init;

  /** 読み取り・RPC・auth 呼び出しの発生順 ('read:<table>' / 'rpc:<name>' / 'auth:<method>') */
  const events: string[] = [];
  /** getUserById が例外 (Auth API への接続失敗など) で失敗するユーザー ID */
  const authFailures = new Set<string>();
  /** テーブル名 -> その読み取りで返すエラー (設定すると data は null になる) */
  const readErrors: Record<string, unknown> = {};
  /** select(...) に渡された列の指定 (存在しない列を読んでいないかの確認に使う) */
  const selects: Array<{ table: string; columns: string | undefined }> = [];

  const from = vi.fn((table: string): FakeQuery => {
    const filters: Array<(row: Row) => boolean> = [];
    let columns: string[] | null = null;
    let sortBy: { column: string; ascending: boolean; nullsFirst: boolean } | null = null;

    // select に書いた列だけを返す (select していない列を実装が読んでいたらテストで気づける)
    const execute = (): { rows: Row[]; error: unknown } => {
      events.push(`read:${table}`);
      if (table in readErrors) return { rows: [], error: readErrors[table] };
      const matched = (tables[table] ?? []).filter((row) => filters.every((matches) => matches(row)));
      if (sortBy) {
        const { column, ascending, nullsFirst } = sortBy;
        matched.sort((a, b) => {
          const left = a[column] ?? null;
          const right = b[column] ?? null;
          if (left === null && right === null) return 0;
          if (left === null) return nullsFirst ? -1 : 1;
          if (right === null) return nullsFirst ? 1 : -1;
          if (left === right) return 0;
          return (left as string | number) < (right as string | number) === ascending ? -1 : 1;
        });
      }
      const rows = matched.map((row) =>
        columns ? Object.fromEntries(columns.map((column) => [column, row[column]])) : { ...row },
      );
      return { rows, error: null };
    };

    // PostgREST と同じく、single() は 0 件・複数件でエラー、maybeSingle() は 0 件なら data: null
    const toSingle = (allowEmpty: boolean): QueryResult => {
      const { rows, error } = execute();
      if (error) return { data: null, error };
      if (rows.length === 1) return { data: rows[0], error: null };
      if (rows.length === 0 && allowEmpty) return { data: null, error: null };
      return {
        data: null,
        error: { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' },
      };
    };

    const query: FakeQuery = {
      select(cols) {
        selects.push({ table, columns: cols });
        const names = cols?.split(',').map((name) => name.trim()).filter(Boolean) ?? [];
        columns = names.length === 0 || names.includes('*') ? null : names;
        return query;
      },
      eq(column, value) {
        filters.push((row) => row[column] === value);
        return query;
      },
      // SQL の <> と同じく、列が NULL の行は一致しない
      neq(column, value) {
        filters.push((row) => (row[column] ?? null) !== null && row[column] !== value);
        return query;
      },
      in(column, values) {
        filters.push((row) => values.includes(row[column]));
        return query;
      },
      // PostgreSQL の既定どおり、NULL は昇順なら最後、降順なら最初 (nullsFirst で上書きできる)
      order(column, options) {
        const ascending = options?.ascending ?? true;
        sortBy = { column, ascending, nullsFirst: options?.nullsFirst ?? !ascending };
        return query;
      },
      single: async () => toSingle(false),
      maybeSingle: async () => toSingle(true),
      then(onFulfilled, onRejected) {
        const { rows, error } = execute();
        const result: QueryResult = error ? { data: null, error } : { data: rows, error: null };
        return Promise.resolve(result).then(onFulfilled, onRejected);
      },
    };
    return query;
  });

  // 実装がどちらで宛先メールを引いても同じ結果になるよう、listUsers / getUserById の両方を用意する。
  // listUsers は本物と同じく、page / perPage を渡さなければ先頭 50 件しか返さない (#1204)。
  const auth = {
    admin: {
      listUsers: vi.fn(async (params?: { page?: number; perPage?: number }) => {
        events.push('auth:listUsers');
        const perPage = params?.perPage ?? LIST_USERS_DEFAULT_PER_PAGE;
        const page = params?.page ?? 1;
        const pageUsers = users.slice((page - 1) * perPage, page * perPage);
        return { data: { users: pageUsers.map((user) => ({ ...user })) }, error: null };
      }),
      getUserById: vi.fn(async (id: string) => {
        events.push('auth:getUserById');
        if (authFailures.has(id)) throw new Error('fetch failed');
        const user = users.find((candidate) => candidate.id === id);
        return user
          ? { data: { user: { ...user } }, error: null }
          : { data: { user: null }, error: { message: 'User not found', status: 404 } };
      }),
    },
  };

  return { client: { from, auth }, from, auth, tables, users, events, readErrors, selects, authFailures };
}

/** 本文中の「▼ <見出し>」の次の行を返す (見出しが無ければ undefined) */
export function valueUnder(text: string, heading: string): string | undefined {
  return text.match(new RegExp(`▼ ${heading}\\n([^\\n]*)`))?.[1];
}
