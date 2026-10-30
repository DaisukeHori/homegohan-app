/**
 * #2128 V3: 組織のメンバーの名前の一覧の並びの守り (ソースの突き合わせ)。
 *
 * GET /api/org/members と GET /api/org/owner-transfer/candidates は、参加した日 (date 型) が同じ人の順が
 * 読み込みのたびに入れ替わりえた。いまは orderOrgMemberList (src/lib/membership/org-member-list-order.ts) で
 * 参加した日の昇順 (空は最後) → 組織内の役割の昇順 → id の昇順の 3 つの order を DB に送る。
 *
 * 役割の昇順が「オーナー → 管理者 → メンバー」になるのは、org_role が enum org_role_enum で、PostgreSQL が enum を
 * 宣言の順で並べるから (文字列の順なら admin → member → owner になる)。ここでは次を確かめる:
 *   1. migration の org_role_enum の宣言の順が 'owner', 'admin', 'member' で、値を足す・名前を変える・型を作り直す migration が無い
 *   2. 単体テストの偽物 (fake-service-role) が使う enum の順が、その宣言の順と同じ
 *   3. 並びの鍵が 3 つ (joined_org_at 昇順・空は最後 / org_role 昇順 / id 昇順) で、この順に送る
 *   4. 2 つの route の GET は orderOrgMemberList で並べ、ほかに .order( を書かない
 * 実物の PostgREST での並びは tests/integration/rls/org-member-list-order.test.ts が確かめる。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ORG_MEMBER_LIST_ORDER, orderOrgMemberList } from '@/lib/membership/org-member-list-order';
import { FAKE_ENUM_COLUMN_ORDERS } from '@/__tests__/api/operator/membership/fake-service-role';

const ROOT = process.cwd();
const MIGRATIONS_DIR = join(ROOT, 'supabase/migrations');
/** DB の org_role_enum の宣言の順 (オーナー → 管理者 → メンバー) */
const DECLARED_ORG_ROLE_ORDER = ['owner', 'admin', 'member'];
const ROUTE_FILES = ['src/app/api/org/members/route.ts', 'src/app/api/org/owner-transfer/candidates/route.ts'];

/** SQL の行コメント (-- …) を外す */
function stripSqlLineComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, '');
}

/** TypeScript の行コメントとブロックコメントを外す (文字列の中の // は route に無い前提) */
function stripTsComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

function migrationFiles(): Array<{ file: string; sql: string }> {
  return readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith('.sql') && !file.endsWith('.down.sql'))
    .sort()
    .map((file) => ({ file, sql: stripSqlLineComments(readFileSync(join(MIGRATIONS_DIR, file), 'utf8')) }));
}

/** route の GET の本体 (export async function GET から次の export async function まで) */
function getHandlerBody(file: string): string {
  const text = stripTsComments(readFileSync(join(ROOT, file), 'utf8'));
  const start = text.indexOf('export async function GET');
  expect(start, file).toBeGreaterThan(-1);
  const next = text.indexOf('export async function', start + 1);
  return text.slice(start, next === -1 ? undefined : next);
}

describe('#2128 V3 組織のメンバーの一覧の並び', () => {
  it('migration の org_role_enum は owner → admin → member の順に 1 回だけ宣言され、値を足す・名前を変える・作り直す migration は無い', () => {
    const declarations: Array<{ file: string; values: string[] }> = [];
    const alterations: string[] = [];
    for (const { file, sql } of migrationFiles()) {
      for (const match of sql.matchAll(/CREATE\s+TYPE\s+(?:"?public"?\.)?"?org_role_enum"?\s+AS\s+ENUM\s*\(([^)]*)\)/gi)) {
        declarations.push({ file, values: [...match[1].matchAll(/'([^']*)'/g)].map((value) => value[1]) });
      }
      for (const match of sql.matchAll(/ALTER\s+TYPE\s+(?:"?public"?\.)?"?org_role_enum"?\s+(ADD|RENAME)\s+VALUE[^;]*/gi)) {
        alterations.push(`${file}: ${match[0]}`);
      }
      for (const match of sql.matchAll(/DROP\s+TYPE\s+(?:IF\s+EXISTS\s+)?(?:"?public"?\.)?"?org_role_enum"?/gi)) {
        alterations.push(`${file}: ${match[0]}`);
      }
    }
    expect(declarations).toHaveLength(1);
    expect(declarations[0].values).toEqual(DECLARED_ORG_ROLE_ORDER);
    expect(alterations).toEqual([]);
  });

  it('単体テストの偽物が org_role を並べる順は、DB の宣言の順と同じ', () => {
    expect(FAKE_ENUM_COLUMN_ORDERS.org_role).toEqual(DECLARED_ORG_ROLE_ORDER);
  });

  it('並びの鍵は 参加した日の昇順 (空は最後) → 組織内の役割の昇順 → id の昇順', () => {
    expect(ORG_MEMBER_LIST_ORDER).toEqual([
      { column: 'joined_org_at', options: { ascending: true, nullsFirst: false } },
      { column: 'org_role', options: { ascending: true, nullsFirst: false } },
      { column: 'id', options: { ascending: true, nullsFirst: false } },
    ]);
  });

  it('orderOrgMemberList は鍵をこの順に order へ渡し、最後の order の戻り値を返す', () => {
    const calls: Array<[string, { ascending: boolean; nullsFirst: boolean }]> = [];
    interface RecordingQuery {
      depth: number;
      order(column: string, options: { ascending: boolean; nullsFirst: boolean }): RecordingQuery;
    }
    const makeQuery = (depth: number): RecordingQuery => ({
      depth,
      order(column, options) {
        calls.push([column, options]);
        return makeQuery(depth + 1);
      },
    });

    const ordered = orderOrgMemberList(makeQuery(0));

    expect(calls.map(([column]) => column)).toEqual(['joined_org_at', 'org_role', 'id']);
    expect(ordered.depth).toBe(ORG_MEMBER_LIST_ORDER.length);
  });

  it.each(ROUTE_FILES)('%s の GET は orderOrgMemberList で並べ、ほかに .order( を書かない', (file) => {
    const body = getHandlerBody(file);
    expect(body).toContain('orderOrgMemberList(');
    expect(body).not.toMatch(/\.order\(/);
  });
});
