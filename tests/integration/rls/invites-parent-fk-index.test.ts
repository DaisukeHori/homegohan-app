/**
 * #1218 招待テーブル (organization_invites / family_invites) の親 FK 索引の回帰テスト
 *
 * 修正前の状態 (本番スナップショット supabase/baseline/prod_schema.sql):
 *   親テーブルへの FK 列 (organization_invites.organization_id / family_invites.family_id) を先頭キーに持つ索引は、
 *   どちらのテーブルにも `WHERE status = 'pending'` 付きの部分ユニーク索引
 *   (uniq_org_invites_pending / uniq_family_invites_pending) だけだった。
 *   部分索引は、問い合わせの条件に `status = 'pending'` が含まれるときにしか使えない。ところが次の 3 つは status で絞らない。
 *     - GET /api/org/invites     .eq('organization_id', ...).order('created_at', { ascending: false })
 *     - GET /api/family/invites  .eq('family_id', ...).order('created_at', { ascending: false })
 *     - 親 (organizations / family_groups) を消したときの ON DELETE CASCADE (DELETE ... WHERE <FK 列> = ?)
 *   招待は accepted / rejected / expired / revoked になっても消されず溜まり続けるので、これらは
 *   招待の総数に比例して遅くなる (全表スキャン + Sort)。
 *
 * 修正後 (supabase/migrations/20261007160100_add_invites_parent_fk_indexes.sql):
 *   通常の (部分でない) btree 索引を足す。
 *     idx_organization_invites_org_created ON organization_invites (organization_id, created_at DESC)
 *     idx_family_invites_family_created    ON family_invites (family_id, created_at DESC)
 *
 * このテストが見ること (ローカルスタックの postgres-meta /pg/query で pg_indexes と EXPLAIN を読むだけ。
 * 行は作らないので後片付けは要らない。本番には接続しない):
 *   I-1: 索引の定義 (名前・列・並び順・部分索引でないこと)
 *   I-2: 一覧の問い合わせ (<FK 列> = ? ORDER BY created_at DESC) が、その索引だけで絞り込みと並び順をまかなえる
 *   I-3: 親を消したときの ON DELETE CASCADE が発行する DELETE ... WHERE <FK 列> = ? が、その索引で走れる
 *
 * I-2 / I-3 は enable_seqscan / enable_bitmapscan / enable_sort を切って EXPLAIN する。表が空か小さいと、索引があっても
 * Seq Scan がコスト上いちばん安くなり、コストの比較では「索引が使えるか」を確かめられないため。
 * 3 つを切ると、索引が条件 (と並び順) に合っていなければ Seq Scan (+ Sort) にしかなれず、合っていれば Index Scan だけの計画になる。
 * SET LOCAL は、1 回の /pg/query に複数文を入れたときの暗黙のトランザクションの中だけで効く (次の呼び出しには残らない)。
 *
 * 置き場所が rls/ なのは、CI の security-regression (ローカル Supabase を立てるジョブ) が tests/integration/rls と
 * tests/integration/security だけを実行するため。
 *
 * 実行 (ローカル Supabase: bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local):
 *   npx vitest run --config vitest.integration.config.ts tests/integration/rls/invites-parent-fk-index.test.ts
 */

import { describe, it, expect } from 'vitest';

// ---------------------------------------------------------------
// 環境変数
// ---------------------------------------------------------------
const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!url || !serviceKey) {
  throw new Error('NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY が未設定です。');
}

/** ローカルスタックの postgres-meta でカタログと実行計画を読む (読み取り専用の確認にだけ使う) */
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

// ---------------------------------------------------------------
// EXPLAIN (FORMAT JSON) の読み取り
// ---------------------------------------------------------------
interface PlanNode {
  'Node Type': string;
  'Index Name'?: string;
  Plans?: PlanNode[];
}

/** 計画の木を行きがけ順に平らにして、'Sort' / 'Seq Scan' / 'Index Scan using <索引名>' のような文字列にする */
function describePlan(node: PlanNode): string[] {
  const label = node['Index Name'] ? `${node['Node Type']} using ${node['Index Name']}` : node['Node Type'];
  return [label, ...(node.Plans ?? []).flatMap(describePlan)];
}

/**
 * seq scan / bitmap scan / sort を切って EXPLAIN し、計画のノード一覧を返す。
 * 索引が問い合わせに合っているなら Index Scan だけになり、合っていないなら Seq Scan (+ Sort) にしかなれない。
 */
async function explainIndexOnly(statement: string): Promise<string[]> {
  const rows = await pgQuery<{ 'QUERY PLAN': Array<{ Plan: PlanNode }> }>(`
    SET LOCAL enable_seqscan = off;
    SET LOCAL enable_bitmapscan = off;
    SET LOCAL enable_sort = off;
    EXPLAIN (FORMAT JSON) ${statement}
  `);
  return describePlan(rows[0]['QUERY PLAN'][0].Plan);
}

// ---------------------------------------------------------------
// 対象 (テーブル / 親 FK 列 / 追加する索引 / その一覧 API)
// ---------------------------------------------------------------
const NIL_UUID = '00000000-0000-0000-0000-000000000000';

const TARGETS = [
  {
    table: 'organization_invites',
    fk: 'organization_id',
    index: 'idx_organization_invites_org_created',
    listing: 'GET /api/org/invites',
  },
  {
    table: 'family_invites',
    fk: 'family_id',
    index: 'idx_family_invites_family_created',
    listing: 'GET /api/family/invites',
  },
] as const;

describe('#1218 招待テーブルの親 FK 索引', () => {
  it.each(TARGETS)(
    'I-1: $table は $fk を先頭キーにした通常の (部分でない) btree 索引 $index を持つ',
    async ({ table, fk, index }) => {
      const rows = await pgQuery<{ indexdef: string }>(`
        SELECT indexdef FROM pg_indexes
        WHERE schemaname = 'public' AND tablename = '${table}' AND indexname = '${index}'
      `);
      // UNIQUE でも WHERE 付きでもない (部分索引だと status 絞り込みなしの一覧に使えない)
      expect(rows.map((r) => r.indexdef)).toEqual([
        `CREATE INDEX ${index} ON public.${table} USING btree (${fk}, created_at DESC)`,
      ]);
    },
  );

  it.each(TARGETS)(
    'I-2: $listing の問い合わせ ($fk = ? ORDER BY created_at DESC) は $index だけで絞り込みと並び順をまかなえる (Seq Scan・Sort なし)',
    async ({ table, fk, index }) => {
      const plan = await explainIndexOnly(`
        SELECT * FROM public.${table}
        WHERE ${fk} = '${NIL_UUID}'
        ORDER BY created_at DESC
      `);
      expect(plan).toEqual([`Index Scan using ${index}`]);
    },
  );

  it.each(TARGETS)(
    'I-3: $table の親を消したときの ON DELETE CASCADE (DELETE ... WHERE $fk = ?) は $index で走れる',
    async ({ table, fk, index }) => {
      const plan = await explainIndexOnly(`
        DELETE FROM public.${table}
        WHERE ${fk} = '${NIL_UUID}'
      `);
      expect(plan).toEqual(['ModifyTable', `Index Scan using ${index}`]);
    },
  );
});
