/**
 * ユニット/contract テスト用の簡易 Supabase クエリビルダーモック。
 *
 * `supabase.from(table)...` のメソッドチェーンを模倣する。各メソッドは
 * `this` を返し、最終的に `await` された時点 (`.then` 経由) か `.single()` /
 * `.maybeSingle()` 呼び出し時に、あらかじめ登録した結果を返す。
 *
 * 使い方:
 *   const supabase = createFakeSupabase({
 *     moderation_flags: [{ data: [...], error: null }],
 *   });
 *   // moderation_flags への 1 回目の `.from()` 呼び出しでこの結果が返る。
 *   // 2 回目以降は配列の次の要素、尽きたら最後の要素を使い回す。
 */
import { vi } from 'vitest';

export interface FakeQueryResult {
  data?: unknown;
  error?: unknown;
  count?: number | null;
}

type TableResults = Record<string, FakeQueryResult[]>;

export function createQueryBuilder(result: FakeQueryResult) {
  const resolved = Promise.resolve(result);
  const builder: Record<string, unknown> = {
    select: vi.fn(() => builder),
    eq: vi.fn(() => builder),
    order: vi.fn(() => builder),
    limit: vi.fn(() => builder),
    range: vi.fn(() => builder),
    is: vi.fn(() => builder),
    update: vi.fn(() => builder),
    insert: vi.fn(() => builder),
    delete: vi.fn(() => builder),
    single: vi.fn(() => resolved),
    maybeSingle: vi.fn(() => resolved),
    then: (onFulfilled: (v: FakeQueryResult) => unknown, onRejected?: (e: unknown) => unknown) =>
      resolved.then(onFulfilled, onRejected),
    catch: (onRejected: (e: unknown) => unknown) => resolved.catch(onRejected),
  };
  return builder;
}

export interface FakeSupabase {
  from: ReturnType<typeof vi.fn>;
  rpc: ReturnType<typeof vi.fn>;
  auth: { getUser: ReturnType<typeof vi.fn> };
  __queues: TableResults;
}

/**
 * テーブル名 -> 期待される呼び出し順の結果配列、を渡してフェイク Supabase クライアントを作る。
 * `rpcResults` は `.rpc(name, args)` 呼び出し順の結果配列 (省略時は { data: null, error: null })。
 */
export function createFakeSupabase(
  tableQueues: TableResults,
  rpcResults: FakeQueryResult[] = [],
): FakeSupabase {
  const queues: TableResults = Object.fromEntries(
    Object.entries(tableQueues).map(([k, v]) => [k, [...v]]),
  );
  const rpcQueue = [...rpcResults];

  const from = vi.fn((table: string) => {
    const queue = queues[table];
    if (!queue || queue.length === 0) {
      throw new Error(`fake-supabase: no queued result for table "${table}"`);
    }
    const result = queue.length > 1 ? queue.shift()! : queue[0];
    return createQueryBuilder(result);
  });

  const rpc = vi.fn(() => {
    const result = rpcQueue.length > 1 ? rpcQueue.shift()! : (rpcQueue[0] ?? { data: null, error: null });
    return Promise.resolve(result);
  });

  return {
    from,
    rpc,
    auth: { getUser: vi.fn() },
    __queues: queues,
  };
}
