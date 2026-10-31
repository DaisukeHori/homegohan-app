/**
 * #2134 U2 / #2139 T1: 一覧の並びの鍵 (src/lib/api/list-order.ts の LIST_ORDERS) を、実物の PostgREST が受け付けることを確かめる。
 *
 * 単体テストの偽物は、表に無い列で並べてもエラーにしない。ここでは各一覧の表に、route と同じ鍵 (いままでの鍵のあとに
 * 一意の鍵の昇順。新しい側から読む一覧は、元の一覧の鍵をそっくり逆にしたもの) で order を重ねた問い合わせをローカルの PostgREST に送り、
 * エラーにならないこと (= どの鍵の列も表にある) を見る。
 * 同じ値の行が id の順になることは PostgreSQL の ORDER BY の約束で、鍵の並びは tests/list-order-tiebreak-2134.test.ts が見る。
 *
 * 前提: ローカル Supabase (scripts/supabase-local.sh)。Next の開発サーバーは要らない (PostgREST を直接呼ぶ)。
 *   bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local
 *   npx vitest run --config vitest.integration.config.ts tests/integration/rls/list-order-tiebreak.test.ts
 * 本番には接続しない。
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import ws from 'ws';
import { LIST_ORDERS, orderListBy } from '@/lib/api/list-order';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!url || !serviceKey) {
  throw new Error('NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY が未設定です。');
}

function client(key: string): SupabaseClient {
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
    realtime: { transport: ws as unknown as typeof WebSocket },
  });
}

const srAdmin = client(serviceKey);

/** 列の有無を見るだけなので、読む行は 1 行で足りる */
const PROBE_ROW_LIMIT = 1;

describe('#2134 U2 / #2139 T1 一覧の並びの鍵を PostgREST が受け付ける', () => {
  it.each(Object.entries(LIST_ORDERS))('%s: 表の全部の鍵の列を読んで並べてもエラーにならない', async (name, order) => {
    // id の無い表 (user_badges) もあるので、読むのは並びの鍵の列だけにする (select でも列の有無を確かめる)
    const columns = [...new Set(order.keys.map((key) => key.column))].join(',');
    const { error } = await orderListBy(srAdmin.from(order.table).select(columns), order).limit(PROBE_ROW_LIMIT);
    expect(error, `${name} (${order.table})`).toBeNull();
  });
});
