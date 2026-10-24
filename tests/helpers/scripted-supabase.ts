/**
 * from(...) を呼んだ順に、決めておいた結果を 1 つずつ返す Supabase の偽クライアント (docs/design/cross/22-dish-favorites.md §7.15.1)。
 *
 * ほかの偽クライアントとの使い分け:
 *   - tests/helpers/fake-supabase.ts: 表ごとの結果の列。ilike・upsert を持たず、結果に status が無い
 *   - tests/helpers/recording-supabase.ts: どのメソッドも受けるが、結果は data と error だけ (count・status を返せない)
 *   - こちら: どのメソッドも受けて記録し (Proxy)、await・maybeSingle()・single() で、その from の結果 (data・error・count・status) を返す。
 *     一覧の 416 の数え直し (resolveBeyondLastPage は status と count を読む) と、upsert・ilike の引数の検査に使う
 *
 * 結果が足りないとき (並べた数より多く from を呼んだとき) は例外にする (呼び出しの数をテストが決める)。
 */

/** 1 回の from(...) の結果 (supabase-js の応答のうち、呼び出し側が読む項目) */
export interface ScriptedResult {
  data?: unknown;
  error?: unknown;
  count?: number | null;
  status?: number;
}

/** builder に掛けた呼び出し 1 つ (メソッド名と引数) */
export interface ScriptedCall {
  method: string;
  args: unknown[];
}

/** from(...) 1 回分の記録 */
export interface ScriptedQuery {
  table: string;
  calls: ScriptedCall[];
}

/** 結果が無い項目を補う (supabase-js と同じく、無い data・error・count は null。status は 200) */
const HTTP_OK = 200;

function settled(result: ScriptedResult): Required<ScriptedResult> {
  return { data: result.data ?? null, error: result.error ?? null, count: result.count ?? null, status: result.status ?? HTTP_OK };
}

export interface ScriptedSupabase {
  /** route や server.ts に渡す偽物 (from だけを持つ) */
  db: { from: (table: string) => unknown };
  /** from を呼んだ順の記録 */
  queries: ScriptedQuery[];
}

export function createScriptedSupabase(results: ReadonlyArray<ScriptedResult>): ScriptedSupabase {
  const queue = [...results];
  const queries: ScriptedQuery[] = [];

  function from(table: string): unknown {
    const next = queue.shift();
    if (next === undefined) throw new Error(`scripted-supabase: from('${table}') に返す結果がありません`);
    const result = settled(next);
    const query: ScriptedQuery = { table, calls: [] };
    queries.push(query);

    const builder: unknown = new Proxy(
      {},
      {
        get(_target, prop) {
          if (typeof prop === 'symbol') return undefined;
          if (prop === 'then') {
            return (onFulfilled?: (value: Required<ScriptedResult>) => unknown, onRejected?: (reason: unknown) => unknown) =>
              Promise.resolve(result).then(onFulfilled, onRejected);
          }
          if (prop === 'maybeSingle' || prop === 'single') {
            return (...args: unknown[]) => {
              query.calls.push({ method: prop, args });
              return Promise.resolve(result);
            };
          }
          return (...args: unknown[]) => {
            query.calls.push({ method: prop, args });
            return builder;
          };
        },
      },
    );
    return builder;
  }

  return { db: { from }, queries };
}
