/**
 * 呼び出しを記録する Supabase の偽クライアント (Edge Function のハンドラ試験用)。
 *
 * ほかの偽クライアントとの使い分け:
 *   - tests/helpers/fake-supabase.ts: 「テーブルごとの結果キュー」方式。eq / order / limit などの一部のメソッドしか持たない
 *   - tests/helpers/fake-postgrest.ts: 行を持ち、eq / range / max_rows を実際に適用する (select / eq / order / range だけ)
 *   - こちら (recording-supabase.ts): 呼ばれたメソッドと引数をそのまま記録し、結果は respond 関数が決める。
 *     in / gte / lte / upsert / or / maybeSingle など、どのメソッドも受け付ける。次の用途向け:
 *       - どのテーブルに、どのメソッドが、どんな引数で呼ばれたかを検査する
 *         (例: 存在しない meal_plan_days ではなく user_daily_meals で絞っているか)
 *       - range によるページ送りや、in の ids の分割を再現する
 *
 * `from(table)` が返すクエリは、本物と同じく「await された時点で」結果が決まる thenable。
 * どのメソッド名でも受け付けてチェーンを返すので、テストが知らないメソッドを足されても壊れない。
 * 結果は、そのクエリの記録 (table と呼ばれたメソッド) を渡す respond 関数が決める。
 */

export interface RecordedCall {
  method: string;
  args: unknown[];
}

export interface RecordedQuery {
  table: string;
  calls: RecordedCall[];
}

export interface QueryOutcome {
  data?: unknown;
  error?: { message: string; code?: string; details?: string; hint?: string } | null;
}

export type Responder = (query: RecordedQuery) => QueryOutcome | Promise<QueryOutcome>;

export function createRecordingSupabase(respond: Responder) {
  const queries: RecordedQuery[] = [];

  const client = {
    from(table: string) {
      const query: RecordedQuery = { table, calls: [] };
      queries.push(query);

      const builder: unknown = new Proxy(
        {},
        {
          get(_target, prop) {
            if (typeof prop === 'symbol') return undefined;
            if (prop === 'then') {
              return (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
                Promise.resolve(respond(query))
                  .then((outcome) => ({ data: outcome.data ?? null, error: outcome.error ?? null }))
                  .then(resolve, reject);
            }
            return (...args: unknown[]) => {
              query.calls.push({ method: prop, args });
              return builder;
            };
          },
        },
      );
      return builder;
    },
  };

  return { client, queries };
}

/** クエリで method が呼ばれたときの引数を、呼ばれた順に返す */
export function argsOf(query: RecordedQuery, method: string): unknown[][] {
  return query.calls.filter((c) => c.method === method).map((c) => c.args);
}

/** そのテーブルへ発行されたクエリ (発行順) */
export function queriesOf(queries: RecordedQuery[], table: string): RecordedQuery[] {
  return queries.filter((q) => q.table === table);
}

/** クエリの最初のメソッド (select / upsert / insert など) */
export function firstMethodOf(query: RecordedQuery): string | undefined {
  return query.calls[0]?.method;
}

/** eq(column, value) の value。無ければ undefined */
export function eqValue(query: RecordedQuery, column: string): unknown {
  return argsOf(query, 'eq').find((args) => args[0] === column)?.[1];
}

/**
 * PostgREST の応答を真似て、rows から返す範囲を決める。
 * range(from, to) が指定されていればその範囲、無ければ先頭から。どちらも 1 回に最大 cap 行 (Max rows)。
 */
export function pageOf<T>(rows: T[], query: RecordedQuery, cap = 1000): T[] {
  const range = argsOf(query, 'range')[0] as [number, number] | undefined;
  if (!range) return rows.slice(0, cap);
  const [from, to] = range;
  return rows.slice(from, Math.min(to + 1, from + cap));
}
