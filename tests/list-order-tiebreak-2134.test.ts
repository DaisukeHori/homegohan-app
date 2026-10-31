/**
 * #2134 U2: 一覧の並びは、最後に一意の鍵 id の昇順を重ねて、同じ値の行の順を決める (ソースの突き合わせ)。
 *
 * 一覧を 1 つの鍵 (作った日時・始まる日・参加した日など) だけで並べると、同じ値の行の順は DB 任せで、開くたびに
 * 入れ替わりうる。いまは src/lib/api/list-order.ts の LIST_ORDERS に一覧ごとの鍵を書き、route は orderListBy で並べる。
 * ここでは次を確かめる:
 *   1. LIST_ORDERS の各一覧の鍵 (いままでの鍵のあとに id の昇順)。NULL の位置は、いままでの order と同じ
 *   2. orderListBy は鍵をこの順に order へ渡し、最後の order の戻り値を返す
 *   3. 一覧の route の GET は orderListBy(…, LIST_ORDERS.<一覧>) で並べ、その一覧の表を読み、ほかに .order( を書かない
 *   4. src/app/api/org と src/app/api/operator/membership の route は、どれも .order( を直接書かない
 *      (並びは LIST_ORDERS か orderOrgMemberList を通す。新しい一覧が 1 つの鍵だけで並べるのを止める)
 * 実物の PostgREST が鍵の列を受け付けることは tests/integration/rls/list-order-tiebreak.test.ts が確かめる。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ID_TIEBREAK_KEY, LIST_ORDERS, orderListBy, type ListOrderKey } from '@/lib/api/list-order';

const ROOT = process.cwd();

/** route の .order( を走査する場所 (並びを LIST_ORDERS / orderOrgMemberList に寄せた範囲) */
const SCANNED_ROUTE_DIRS = ['src/app/api/org', 'src/app/api/operator/membership'];

const ASC_NULLS_LAST = { ascending: true, nullsFirst: false };
const DESC_NULLS_FIRST = { ascending: false, nullsFirst: true };
const DESC_NULLS_LAST = { ascending: false, nullsFirst: false };

/** 一覧ごとの、期待する表と鍵 (最後の id の昇順を含む) と、それで並べる route */
const EXPECTED: Record<keyof typeof LIST_ORDERS, { route: string; table: string; keys: ListOrderKey[] }> = {
  orgMyChallenges: {
    route: 'src/app/api/org/my-challenges/route.ts',
    table: 'organization_challenges',
    keys: [{ column: 'start_date', options: DESC_NULLS_FIRST }, ID_TIEBREAK_KEY],
  },
  orgChallenges: {
    route: 'src/app/api/org/challenges/route.ts',
    table: 'organization_challenges',
    keys: [{ column: 'created_at', options: DESC_NULLS_FIRST }, ID_TIEBREAK_KEY],
  },
  orgInvites: {
    route: 'src/app/api/org/invites/route.ts',
    table: 'organization_invites',
    keys: [{ column: 'created_at', options: DESC_NULLS_FIRST }, ID_TIEBREAK_KEY],
  },
  orgDepartments: {
    route: 'src/app/api/org/departments/route.ts',
    table: 'departments',
    keys: [
      { column: 'display_order', options: ASC_NULLS_LAST },
      { column: 'created_at', options: ASC_NULLS_LAST },
      ID_TIEBREAK_KEY,
    ],
  },
  operatorMembershipAudit: {
    route: 'src/app/api/operator/membership/audit/route.ts',
    table: 'membership_audit',
    keys: [{ column: 'created_at', options: DESC_NULLS_FIRST }, ID_TIEBREAK_KEY],
  },
  operatorOrgTransferCandidates: {
    route: 'src/app/api/operator/membership/org/[id]/candidates/route.ts',
    table: 'user_profiles',
    keys: [{ column: 'last_login_at', options: DESC_NULLS_LAST }, ID_TIEBREAK_KEY],
  },
  operatorFamilyTransferCandidates: {
    route: 'src/app/api/operator/membership/family/[id]/candidates/route.ts',
    table: 'family_members',
    keys: [{ column: 'joined_at', options: ASC_NULLS_LAST }, ID_TIEBREAK_KEY],
  },
};

/** TypeScript の行コメントとブロックコメントを外す (文字列の中の // は対象の route に無い前提) */
function stripTsComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/** route の GET の本体 (export async function GET から次の export async function まで) */
function getHandlerBody(file: string): string {
  const text = stripTsComments(readFileSync(join(ROOT, file), 'utf8'));
  const start = text.indexOf('export async function GET');
  expect(start, file).toBeGreaterThan(-1);
  const next = text.indexOf('export async function', start + 1);
  return text.slice(start, next === -1 ? undefined : next);
}

/** dir の下の route.ts を全部 (リポジトリの根からの相対パス) */
function routeFiles(dir: string): string[] {
  const found: string[] = [];
  const walk = (absolute: string) => {
    for (const name of readdirSync(absolute)) {
      const child = join(absolute, name);
      if (statSync(child).isDirectory()) walk(child);
      else if (name === 'route.ts') found.push(relative(ROOT, child));
    }
  };
  walk(join(ROOT, dir));
  return found.sort();
}

describe('#2134 U2 一覧の並びの同じ値の順', () => {
  it('LIST_ORDERS の一覧は、期待する表から、いままでの鍵のあとに id の昇順を重ねて読む', () => {
    expect(Object.keys(LIST_ORDERS).sort()).toEqual(Object.keys(EXPECTED).sort());
    for (const [name, expected] of Object.entries(EXPECTED)) {
      const order = LIST_ORDERS[name as keyof typeof LIST_ORDERS];
      expect(order.table, name).toBe(expected.table);
      expect(order.keys, name).toEqual(expected.keys);
    }
  });

  it('どの一覧も、最後の鍵は一意の id の昇順で、id はそこにしか出ない', () => {
    expect(ID_TIEBREAK_KEY).toEqual({ column: 'id', options: ASC_NULLS_LAST });
    for (const [name, order] of Object.entries(LIST_ORDERS)) {
      expect(order.keys.at(-1), name).toEqual(ID_TIEBREAK_KEY);
      expect(order.keys.filter((key) => key.column === 'id'), name).toHaveLength(1);
    }
  });

  it('orderListBy は鍵をこの順に order へ渡し、最後の order の戻り値を返す', () => {
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

    const ordered = orderListBy(makeQuery(0), LIST_ORDERS.orgDepartments);

    expect(calls).toEqual([
      ['display_order', ASC_NULLS_LAST],
      ['created_at', ASC_NULLS_LAST],
      ['id', ASC_NULLS_LAST],
    ]);
    expect(ordered.depth).toBe(LIST_ORDERS.orgDepartments.keys.length);
  });

  it.each(Object.entries(EXPECTED))('%s: route の GET は LIST_ORDERS のこの一覧で並べ、その表を読み、ほかに .order( を書かない', (name, expected) => {
    const body = getHandlerBody(expected.route);
    expect(body).toContain('orderListBy(');
    expect(body).toContain(`LIST_ORDERS.${name}`);
    expect(body).toContain(`.from('${expected.table}')`);
    expect(body).not.toMatch(/\.order\(/);
  });

  it.each(SCANNED_ROUTE_DIRS)('%s の route は .order( を直接書かない (並びは LIST_ORDERS か orderOrgMemberList を通す)', (dir) => {
    const files = routeFiles(dir);
    expect(files.length, dir).toBeGreaterThan(0);
    const offenders = files.filter((file) => /\.order\(/.test(stripTsComments(readFileSync(join(ROOT, file), 'utf8'))));
    expect(offenders).toEqual([]);
  });

  it('走査の範囲に、LIST_ORDERS で並べる route が全部入っている', () => {
    const scanned = SCANNED_ROUTE_DIRS.flatMap(routeFiles);
    for (const expected of Object.values(EXPECTED)) {
      expect(scanned).toContain(expected.route);
    }
  });
});
