/**
 * #1216 sales_lead_activities.lead_id の索引の回帰テスト (DB カタログと実行計画の確認)
 *
 * 修正前: sales_lead_activities (営業活動ログ) の索引は主キー (id) だけで、外部キー列 lead_id に索引が無かった。
 * リード詳細 (GET /api/admin/sales/leads/[id]) と活動履歴 (GET /api/admin/sales/leads/[id]/activities) は
 * どちらも `WHERE lead_id = $1 ORDER BY created_at DESC` で 1 件のリードの履歴を取るため、
 * 全リード分の活動ログを全件読んで (Seq Scan)、並べ替えて (Sort) いた。
 * リードを DELETE したときの ON DELETE CASCADE も、消す活動を探すのに全件を読んでいた。
 *
 * 修正後 (migration 20261007160200): idx_sales_lead_activities_lead_created を (lead_id, created_at DESC) で足す。
 *   - S-1: 索引が public.sales_lead_activities にあり、有効な btree (UNIQUE でも部分索引でもない) で、キーが (lead_id, created_at DESC)
 *   - S-2: 2 つの API のクエリの実行計画が、この索引の Index Scan 1 つだけになる (Seq Scan も Sort も出ない)
 *
 * 読み取り専用 (行は作らない・消さない)。ローカルスタックの postgres-meta (/pg/query、service_role キーが必要) で
 * カタログと EXPLAIN を読むだけで、本番には接続しない。
 * CI の security-regression は tests/integration/rls と tests/integration/security だけを実行するため、
 * RLS のテストではないがこのテストも rls に置く。
 *
 * 実行 (ローカル Supabase: bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local):
 *   npx vitest run --config vitest.integration.config.ts tests/integration/rls/sales-lead-activities-index.test.ts
 */

import { describe, it, expect } from 'vitest';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!url || !serviceKey) {
  throw new Error('NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY が未設定です。');
}

const INDEX_NAME = 'idx_sales_lead_activities_lead_created';

/** ローカルスタックの postgres-meta でカタログを読む (読み取り専用の確認にだけ使う) */
async function pgQuery<T = Record<string, unknown>>(query: string): Promise<T[]> {
  const res = await fetch(`${url}/pg/query`, {
    method: 'POST',
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`pg/query ${res.status}: ${JSON.stringify(body)}`);
  return body as T[];
}

/** EXPLAIN (FORMAT JSON) の計画ノード (このテストで見る項目だけ) */
interface PlanNode {
  'Node Type': string;
  'Index Name'?: string;
  Plans?: PlanNode[];
}

function flattenPlan(node: PlanNode): PlanNode[] {
  return [node, ...(node.Plans ?? []).flatMap(flattenPlan)];
}

describe('#1216 sales_lead_activities.lead_id の索引', () => {
  it('S-1: idx_sales_lead_activities_lead_created が (lead_id, created_at DESC) の有効な btree 索引として存在する', async () => {
    const rows = await pgQuery<{
      name: string;
      method: string;
      is_valid: boolean;
      is_ready: boolean;
      is_unique: boolean;
      is_partial: boolean;
      def: string;
    }>(`
      SELECT i.relname::text AS name,
             am.amname::text AS method,
             ix.indisvalid AS is_valid,
             ix.indisready AS is_ready,
             ix.indisunique AS is_unique,
             ix.indpred IS NOT NULL AS is_partial,
             pg_get_indexdef(ix.indexrelid) AS def
        FROM pg_index ix
        JOIN pg_class i ON i.oid = ix.indexrelid
        JOIN pg_class t ON t.oid = ix.indrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
        JOIN pg_am am ON am.oid = i.relam
       WHERE n.nspname = 'public'
         AND t.relname = 'sales_lead_activities'
         AND i.relname = '${INDEX_NAME}'
    `);

    // 索引が無い (修正前) と、ここで失敗する
    expect(rows.map((r) => r.name)).toEqual([INDEX_NAME]);

    const [index] = rows;
    expect(index.method).toBe('btree');
    expect(index.is_valid).toBe(true);
    expect(index.is_ready).toBe(true);
    expect(index.is_unique).toBe(false);
    expect(index.is_partial).toBe(false);
    // 先頭の列は外部キー lead_id、2 列目は API の並び順 (created_at DESC)。INCLUDE 列や条件は付かない
    expect(index.def).toMatch(/ USING btree \(lead_id, created_at DESC\)$/);
  });

  it('S-2: リード詳細・活動履歴 API のクエリ (WHERE lead_id = ? ORDER BY created_at DESC) は、この索引だけで順序どおりに読める (Seq Scan も Sort も出ない)', async () => {
    // 行が少ないテーブルは索引があっても Seq Scan の方が安いと見積もられるため、この問い合わせの間だけ
    // Seq Scan とビットマップスキャンを無効にして、「索引を順に読むだけの計画が選べるか」を確かめる。
    // 複数の文を 1 回で送ると 1 つのトランザクションとして実行されるので、SET LOCAL はこの EXPLAIN にだけ効く
    // (接続を使い回す次の問い合わせには残らない)。EXPLAIN は計画を作るだけで、行は読まない。
    // 計画が返るのは最後の文 (EXPLAIN) の結果。UUID は存在しない値でよい。
    const rows = await pgQuery<{ 'QUERY PLAN': { Plan: PlanNode }[] }>(`
      SET LOCAL enable_seqscan = off;
      SET LOCAL enable_bitmapscan = off;
      EXPLAIN (FORMAT JSON)
      SELECT id, lead_id, actor_id, activity_type, details, created_at
        FROM public.sales_lead_activities
       WHERE lead_id = '00000000-0000-0000-0000-000000000000'
       ORDER BY created_at DESC
    `);
    expect(rows).toHaveLength(1);

    const steps = flattenPlan(rows[0]['QUERY PLAN'][0].Plan).map((node) =>
      node['Index Name'] ? `${node['Node Type']} using ${node['Index Name']}` : node['Node Type'],
    );
    // 索引が無い (修正前) と ['Sort', 'Seq Scan'] になる
    expect(steps).toEqual([`Index Scan using ${INDEX_NAME}`]);
  });
});
