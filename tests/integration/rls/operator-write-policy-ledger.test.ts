/**
 * 運営のロールで判定する、書き込みを許す public のポリシー (以下「この型」) の台帳 (tests/helpers/operator-write-policy-ledger.ts) を、
 * 実 DB の pg_policies と突き合わせる (常設の検査)。migration の文面との突き合わせは tests/operator-write-policy-ledger.test.ts。
 * こちらは migration を流した実 DB を見るので、文面の読み取りが拾えない書き方 (DO ブロックの中の動的な SQL など) で作られた
 * ポリシーも拾う。migration でこの型のポリシーを足す・消す・名前を変えたら、台帳の行を足す・消す・直す。
 *
 * 前提: ローカル Supabase (scripts/supabase-local.sh)。Next の開発サーバーは要らない。
 *   bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local
 *   npx vitest run --config vitest.integration.config.ts tests/integration/rls/operator-write-policy-ledger.test.ts
 * カタログはローカルスタックの postgres-meta (/pg/query、service_role キーが必要) で読む。本番には接続しない。
 */

import { describe, expect, it } from 'vitest';
import {
  isOperatorRoleExpression,
  operatorWritePolicyLedgerRows,
  operatorWritePolicyRow,
} from '../../helpers/operator-write-policy-ledger';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!url || !serviceKey) {
  throw new Error('NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY が未設定です。');
}

/** カタログを読む時間の上限 (ミリ秒) */
const TEST_TIMEOUT_MS = 60_000;

/** ローカルスタックの postgres-meta で SQL を読む (service_role キーが要る) */
async function pgQuery<T = Record<string, unknown>>(query: string): Promise<T[]> {
  const res = await fetch(`${url}/pg/query`, {
    method: 'POST',
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`pg/query ${res.status}: ${JSON.stringify(body)}`);
  return body as T[];
}

describe('運営のロールで判定する書き込みのポリシーの台帳 (いまの状態・実 DB)', () => {
  it('実 DB の、運営のロールで判定する書き込みを許す public のポリシーは、台帳と過不足なく一致する', async () => {
    const rows = await pgQuery<{ tablename: string; policyname: string; cmd: string; qual: string | null; with_check: string | null }>(`
      SELECT tablename, policyname, cmd, qual, with_check
      FROM pg_policies WHERE schemaname = 'public' AND cmd <> 'SELECT'`);
    const actual = rows
      .filter((r) => isOperatorRoleExpression(`${r.qual ?? ''} ${r.with_check ?? ''}`))
      .map((r) => operatorWritePolicyRow(r.tablename, r.policyname, r.cmd))
      .sort();
    expect(actual).toEqual(operatorWritePolicyLedgerRows());
  }, TEST_TIMEOUT_MS);
});
