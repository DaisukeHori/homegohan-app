/**
 * 運営 membership API (強制譲渡など) の単体テスト用フェイク。
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
  in(column: string, values: unknown[]): FakeQuery;
  single(): Promise<QueryResult>;
  maybeSingle(): Promise<QueryResult>;
}

export type FakeServiceRole = ReturnType<typeof createFakeServiceRole>;

export function createFakeServiceRole(init: { tables: Tables; users: FakeAuthUser[] }) {
  const { tables, users } = init;

  /** 読み取り・RPC・auth 呼び出しの発生順 ('read:<table>' / 'rpc:<name>' / 'auth:<method>') */
  const events: string[] = [];
  /** テーブル名 -> その読み取りで返すエラー (設定すると data は null になる) */
  const readErrors: Record<string, unknown> = {};

  const from = vi.fn((table: string): FakeQuery => {
    const filters: Array<(row: Row) => boolean> = [];
    let columns: string[] | null = null;

    // select に書いた列だけを返す (select していない列を実装が読んでいたらテストで気づける)
    const execute = (): { rows: Row[]; error: unknown } => {
      events.push(`read:${table}`);
      if (table in readErrors) return { rows: [], error: readErrors[table] };
      const rows = (tables[table] ?? [])
        .filter((row) => filters.every((matches) => matches(row)))
        .map((row) =>
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
        const names = cols?.split(',').map((name) => name.trim()).filter(Boolean) ?? [];
        columns = names.length === 0 || names.includes('*') ? null : names;
        return query;
      },
      eq(column, value) {
        filters.push((row) => row[column] === value);
        return query;
      },
      in(column, values) {
        filters.push((row) => values.includes(row[column]));
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

  // 実装がどちらで宛先メールを引いても同じ結果になるよう、listUsers / getUserById の両方を用意する
  // (listUsers は本物と違いページ上限を再現しない。上限は #1204 の話でここでは扱わない)
  const auth = {
    admin: {
      listUsers: vi.fn(async () => {
        events.push('auth:listUsers');
        return { data: { users: users.map((user) => ({ ...user })) }, error: null };
      }),
      getUserById: vi.fn(async (id: string) => {
        events.push('auth:getUserById');
        const user = users.find((candidate) => candidate.id === id);
        return user
          ? { data: { user: { ...user } }, error: null }
          : { data: { user: null }, error: { message: 'User not found', status: 404 } };
      }),
    },
  };

  return { client: { from, auth }, from, auth, tables, users, events, readErrors };
}

/** 本文中の「▼ <見出し>」の次の行を返す (見出しが無ければ undefined) */
export function valueUnder(text: string, heading: string): string | undefined {
  return text.match(new RegExp(`▼ ${heading}\\n([^\\n]*)`))?.[1];
}
