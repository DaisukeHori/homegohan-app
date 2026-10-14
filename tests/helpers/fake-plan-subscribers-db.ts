/**
 * 契約者数の確認 (#1127) 用の、service_role クライアントの偽物。
 *
 * personal_subscriptions / family_groups / organizations の行を持ち、コードが付けた絞り込み
 * (.eq / .in) を実際に適用して、select(列, { count: 'exact', head: true }) の件数を返す。
 * そのため「終了済みの契約まで数えてしまう」「plan_key で絞り忘れる」「列名を取り違える」といった
 * 不具合を、結果の食い違いとしてテストで再現できる。
 *
 * ほかの偽クライアントとの使い分け:
 *   - tests/helpers/fake-supabase.ts: テーブルごとの結果キュー方式。in を持たず、行も持たない
 *   - tests/helpers/fake-postgrest.ts: 行を持つが eq / range 向けで、in と head を持たない
 *   - こちら: 件数取得 (head) に絞り、eq と in を実際に適用する。呼ばれた絞り込みも記録する
 *
 * PostgREST の応答を真似る点:
 *   - head: true なら data は null (行の中身は返らない)
 *   - count: 'exact' を付けたときだけ count が数値で返る (付け忘れると null)
 *   - 絞り込みの列が行に無ければ、その行は一致しない (NULL と同じ)
 * 知らないテーブル・知らないメソッドを呼ぶと例外にする (想定外のテーブルを読んでいたら気付けるように)。
 */
import { vi } from 'vitest';

export type PlanSubscriberTable = 'personal_subscriptions' | 'family_groups' | 'organizations';
export type FakeRow = Record<string, unknown>;

export interface FakeDbError {
  message: string;
  code?: string;
}

export interface FakePlanSubscribersDbOptions {
  /** テーブル名 -> 行。書かなかったテーブルは空 */
  tables?: Partial<Record<PlanSubscriberTable, FakeRow[]>>;
  /** テーブル名 -> 返すエラー (DB エラーの再現) */
  errors?: Partial<Record<PlanSubscriberTable, FakeDbError>>;
  /** count を null で返すテーブル (件数が返らない異常の再現) */
  nullCount?: PlanSubscriberTable[];
}

export interface RecordedCountQuery {
  table: string;
  /** select の第 1 引数 (列) */
  columns: string;
  /** select の第 2 引数 */
  options: { count?: string; head?: boolean } | undefined;
  eq: Array<[string, unknown]>;
  in: Array<[string, unknown[]]>;
}

const KNOWN_TABLES: readonly string[] = ['personal_subscriptions', 'family_groups', 'organizations'];

export function createFakePlanSubscribersDb(options: FakePlanSubscribersDbOptions = {}) {
  const queries: RecordedCountQuery[] = [];

  function execute(query: RecordedCountQuery) {
    const table = query.table as PlanSubscriberTable;
    const error = options.errors?.[table];
    if (error) return { data: null, error, count: null };

    const matched = (options.tables?.[table] ?? []).filter(
      (row) =>
        query.eq.every(([column, value]) => row[column] === value) &&
        query.in.every(([column, values]) => values.includes(row[column])),
    );

    const count = query.options?.count === 'exact' && !options.nullCount?.includes(table) ? matched.length : null;
    const data = query.options?.head ? null : matched.map((row) => ({ ...row }));
    return { data, error: null, count };
  }

  const from = vi.fn((table: string) => {
    if (!KNOWN_TABLES.includes(table)) {
      throw new Error(`fake-plan-subscribers-db: 想定外のテーブル "${table}" を読もうとした`);
    }
    const query: RecordedCountQuery = { table, columns: '', options: undefined, eq: [], in: [] };
    queries.push(query);

    const builder = {
      select: (columns: string, selectOptions?: { count?: string; head?: boolean }) => {
        query.columns = columns;
        query.options = selectOptions;
        return builder;
      },
      eq: (column: string, value: unknown) => {
        query.eq.push([column, value]);
        return builder;
      },
      in: (column: string, values: unknown[]) => {
        query.in.push([column, values]);
        return builder;
      },
      // 本物と同じく、await された時点で結果が決まる thenable
      then: (onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) =>
        Promise.resolve(execute(query)).then(onFulfilled, onRejected),
    };
    return builder;
  });

  return { client: { from }, from, queries };
}

/** テーブルごとに発行されたクエリ (1 テーブル 1 回の想定) */
export function queryOf(queries: RecordedCountQuery[], table: PlanSubscriberTable): RecordedCountQuery {
  const found = queries.filter((q) => q.table === table);
  if (found.length !== 1) throw new Error(`${table} へのクエリが ${found.length} 回ある (1 回のはず)`);
  return found[0]!;
}
