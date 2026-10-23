/**
 * #1917 の続き: 運営の強制譲渡の RPC が、ロックの下で読んだ旧オーナー / 旧代表者を返すようにした migration
 * (supabase/migrations/20261023140000_operator_transfer_return_old_owner.sql) を、ファイルどうしの突き合わせで確かめる (DB には接続しない)。
 *
 *   1. 2 つの関数 (operator_force_owner_transfer / operator_force_representative_transfer) の本文は、前の定義の逐語に
 *      RETURNS (jsonb) と最後の RETURN (更新した後の行 + ロックの下で読んだ旧オーナー / 旧代表者) だけを変えたもの
 *      (権限・MFA・ロックとその順・判定・書き込み・membership_audit は同じ)。
 *   2. 戻り値の旧オーナー / 旧代表者は、組織 / 家族の行の FOR NO KEY UPDATE で読んだ変数で、membership_audit に書くのと同じ変数。
 *   3. 戻り値の型を変えるので DROP してから作り、本番の権限 (supabase/baseline/prod_function_acl.sql) を付け直す。
 *   4. 後の migration が古い本文で作り直して戻り値の旧オーナー / 旧代表者を落とさないよう、最新の定義でも 2. を見る。
 *   5. 戻り値のキーが route の Zod スキーマ (src/lib/membership/operator-force-transfer-result.ts) と同じ。型の生成物も jsonb (Json)。
 *   6. 戻し口が実在し、2 つの関数を前の定義に逐語で戻し、権限を付け直す。
 * 実際の挙動 (戻り値・同時の譲渡・権限) は tests/integration/security/operator-transfer-old-owner.test.ts (実 DB) が確かめる。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  OperatorForceOwnerTransferResultSchema,
  OperatorForceRepresentativeTransferResultSchema,
} from '@/lib/membership/operator-force-transfer-result';

const ROOT = path.resolve(__dirname, '..');
const MIGRATIONS_DIR = path.join(ROOT, 'supabase', 'migrations');
const MIGRATION = '20261023140000_operator_transfer_return_old_owner';
const MIGRATION_PATH = path.join(MIGRATIONS_DIR, `${MIGRATION}.sql`);
const ROLLBACK_PATH = path.join(ROOT, 'supabase', 'rollbacks', `${MIGRATION}.down.sql`);
const PROD_FUNCTION_ACL_PATH = path.join(ROOT, 'supabase', 'baseline', 'prod_function_acl.sql');
const TYPE_FILES = ['src/types/database.types.ts', 'packages/shared/src/database.types.ts'] as const;

interface TransferFunction {
  name: 'operator_force_owner_transfer' | 'operator_force_representative_transfer';
  /** この migration より前の最後の定義: ファイルと、その中の関数の行 (1 始まり・両端を含む) */
  previous: { file: string; from: number; to: number };
  /** 前の定義の RETURNS の型 (見出しの中の書き方のまま) */
  previousReturns: string;
  /** この migration の RETURNS の型 (見出しの中の書き方のまま) */
  returns: string;
  /** 前の定義の最後の RETURN */
  previousReturn: string;
  /** この migration の最後の RETURN */
  newReturn: string;
  /** 行のロックの下で旧オーナー / 旧代表者を読む文 */
  lockedRead: RegExp;
  /** membership_audit の metadata に書く、旧オーナー / 旧代表者の組 */
  auditPair: string;
  /** 戻り値の jsonb のキー (行・旧オーナー / 旧代表者) */
  rowKey: string;
  priorKey: string;
  /** route の Zod スキーマのキー */
  schemaKeys: string[];
  /** route のファイル (この関数を呼ぶ唯一の場所) */
  route: string;
}

const FUNCTIONS: readonly TransferFunction[] = [
  {
    name: 'operator_force_owner_transfer',
    previous: { file: '20261022160000_release_membership_owner_race.sql', from: 118, to: 165 },
    previousReturns: 'RETURNS "public"."organizations"',
    returns: 'RETURNS "jsonb"',
    previousReturn: 'RETURN v_org;',
    newReturn: "RETURN jsonb_build_object('organization', to_jsonb(v_org), 'old_owner_id', v_old_owner_id);",
    lockedRead: /SELECT owner_id INTO v_old_owner_id FROM organizations WHERE id = p_organization_id FOR NO KEY UPDATE;/,
    auditPair: "'old_owner_id', v_old_owner_id",
    rowKey: 'organization',
    priorKey: 'old_owner_id',
    schemaKeys: Object.keys(OperatorForceOwnerTransferResultSchema.shape),
    route: 'src/app/api/operator/membership/org/[id]/transfer/route.ts',
  },
  {
    name: 'operator_force_representative_transfer',
    previous: { file: '20261017130000_operator_mfa_db_gate.sql', from: 322, to: 369 },
    previousReturns: 'RETURNS family_groups',
    returns: 'RETURNS jsonb',
    previousReturn: 'RETURN v_fam;',
    newReturn: "RETURN jsonb_build_object('family_group', to_jsonb(v_fam), 'old_rep_id', v_old_rep_id);",
    lockedRead: /SELECT representative_id INTO v_old_rep_id FROM family_groups WHERE id = p_family_id FOR NO KEY UPDATE;/,
    auditPair: "'old_rep_id', v_old_rep_id",
    rowKey: 'family_group',
    priorKey: 'old_rep_id',
    schemaKeys: Object.keys(OperatorForceRepresentativeTransferResultSchema.shape),
    route: 'src/app/api/operator/membership/family/[id]/transfer/route.ts',
  },
];

/** ファイルの from〜to 行 (1 始まり・両端を含む) を改行でつないで返す */
function linesOf(file: string, from: number, to: number): string {
  return fs
    .readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8')
    .split('\n')
    .slice(from - 1, to)
    .join('\n');
}

const migrations = fs
  .readdirSync(MIGRATIONS_DIR)
  .filter((file) => file.endsWith('.sql'))
  .sort()
  .map((file) => ({ file, sql: fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8') }));

interface FunctionDefinition {
  file: string;
  /** CREATE OR REPLACE FUNCTION ... AS $$ の手前まで (属性: RETURNS・SECURITY DEFINER・SET search_path など) */
  header: string;
  body: string;
  /** CREATE OR REPLACE FUNCTION から END $$; まで */
  statement: string;
}

/** SQL の行コメント (-- ...) を取り除く (コメントの中の語に反応しないため) */
const stripLineComments = (sql: string): string => sql.replace(/--.*$/gm, '');

/** 空白をまとめる (字下げ・改行の違いを無視して比べるため) */
const squash = (sql: string): string => sql.replace(/\s+/g, ' ').trim();

/** 関数 name の定義 (CREATE OR REPLACE FUNCTION) を、与えた SQL の出現順にすべて返す */
function definitionsIn(file: string, sql: string, name: string): FunctionDefinition[] {
  const found: FunctionDefinition[] = [];
  const pattern = new RegExp(`CREATE OR REPLACE FUNCTION\\s+(?:"?public"?\\.)?"?${name}"?\\s*\\(`, 'g');
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(sql))) {
    const rest = sql.slice(match.index);
    const opener = /\bAS\s+(\$[A-Za-z_]*\$)/.exec(rest);
    if (!opener) continue;
    const bodyStart = opener.index + opener[0].length;
    const bodyEnd = rest.indexOf(opener[1], bodyStart);
    if (bodyEnd < 0) continue;
    const statementEnd = rest.indexOf(';', bodyEnd);
    found.push({
      file,
      header: rest.slice(0, opener.index),
      body: rest.slice(bodyStart, bodyEnd),
      statement: rest.slice(0, statementEnd + 1),
    });
  }
  return found;
}

function latestOf(name: string): FunctionDefinition {
  const all = migrations.flatMap(({ file, sql }) => definitionsIn(file, sql, name));
  expect(all.length, `${name} の定義が migration に見つからない`).toBeGreaterThan(0);
  return all[all.length - 1];
}

/** この migration より前の最後の定義 */
function previousOf(name: string): FunctionDefinition {
  const earlier = migrations.filter(({ file }) => file < `${MIGRATION}.sql`).flatMap(({ file, sql }) => definitionsIn(file, sql, name));
  expect(earlier.length, `${name} の前の定義が見つからない`).toBeGreaterThan(0);
  return earlier[earlier.length - 1];
}

const migrationSql = fs.readFileSync(MIGRATION_PATH, 'utf-8');

/** この migration の中の定義 (ちょうど 1 つ) */
function ownDefinitionOf(name: string): FunctionDefinition {
  const defs = definitionsIn(`${MIGRATION}.sql`, migrationSql, name);
  expect(defs, name).toHaveLength(1);
  return defs[0];
}

/** 文の中で pattern が最初に現れる位置。無ければテストを落とす */
function indexOf(text: string, pattern: RegExp | string, label: string): number {
  const at = typeof pattern === 'string' ? text.indexOf(pattern) : text.search(pattern);
  expect(at, `${label} が無い`).toBeGreaterThanOrEqual(0);
  return at;
}

/** 権限の 2 文 (prod_function_acl.sql と同じ組: PUBLIC / anon から外し、authenticated と service_role に EXECUTE) */
const grantStatements = (name: string): string[] => [
  `REVOKE ALL ON FUNCTION public.${name}(uuid, uuid, text) FROM PUBLIC, anon, authenticated, service_role;`,
  `GRANT EXECUTE ON FUNCTION public.${name}(uuid, uuid, text) TO authenticated, service_role;`,
];

describe.each(FUNCTIONS)('$name: この migration の定義', (fn) => {
  const own = ownDefinitionOf(fn.name);
  const previous = previousOf(fn.name);

  it('前の定義は $previous.file の行 (土台の行がずれたら気づく)', () => {
    expect(previous.file).toBe(fn.previous.file);
    const source = linesOf(fn.previous.file, fn.previous.from, fn.previous.to);
    expect(source).toMatch(new RegExp(`^CREATE OR REPLACE FUNCTION "?public"?\\."?${fn.name}"?\\(`));
    expect(source).toMatch(/END \$\$;$/);
    expect(squash(source)).toBe(squash(previous.statement));
  });

  it('見出しは前の定義の RETURNS を jsonb に変えただけ (SECURITY DEFINER・search_path・引数は同じ)', () => {
    expect(squash(previous.header)).toContain(fn.previousReturns);
    expect(squash(own.header)).toBe(squash(previous.header).replace(fn.previousReturns, fn.returns));
    expect(own.header).toMatch(/SECURITY\s+DEFINER/i);
  });

  it('コメントを除くと、本文は前の定義の最後の RETURN を、更新した後の行とロックの下で読んだ旧オーナー / 旧代表者を返す 1 文に変えただけ', () => {
    const previousBody = squash(stripLineComments(previous.body));
    expect(previousBody.split(fn.previousReturn)).toHaveLength(2);
    expect(squash(stripLineComments(own.body))).toBe(previousBody.replace(fn.previousReturn, fn.newReturn));
  });

  it('DROP FUNCTION IF EXISTS → CREATE → 本番と同じ権限の 2 文 の順で、それぞれ 1 回だけ', () => {
    const code = stripLineComments(migrationSql);
    const drop = `DROP FUNCTION IF EXISTS public.${fn.name}(uuid, uuid, text);`;
    const [revoke, grant] = grantStatements(fn.name);
    for (const statement of [drop, revoke, grant]) expect(code.split(statement), statement).toHaveLength(2);
    const order = [indexOf(code, drop, 'DROP'), indexOf(code, own.statement.slice(0, 60), 'CREATE'), indexOf(code, revoke, 'REVOKE'), indexOf(code, grant, 'GRANT')];
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it('付け直す権限は本番の権限 (supabase/baseline/prod_function_acl.sql) と同じ組 (EXECUTE は authenticated と service_role だけ)', () => {
    const acl = fs.readFileSync(PROD_FUNCTION_ACL_PATH, 'utf-8').split('\n').filter((line) => line.includes(`public."${fn.name}"(`));
    expect(acl).toHaveLength(3);
    expect(acl[0]).toMatch(/^REVOKE ALL ON ROUTINE .* FROM PUBLIC, anon, authenticated, service_role;$/);
    expect(acl.slice(1).map((line) => line.replace(/^.* TO "(\w+)";$/, '$1')).sort()).toEqual(['authenticated', 'service_role']);
  });
});

describe.each(FUNCTIONS)('$name: 最新の定義 (後の migration が古い本文で作り直して、戻り値の旧オーナー / 旧代表者を落とさない)', (fn) => {
  const latest = latestOf(fn.name);
  const body = squash(stripLineComments(latest.body));

  it('最新の定義はこの migration かそれより後で、RETURNS jsonb', () => {
    expect(latest.file >= `${MIGRATION}.sql`, latest.file).toBe(true);
    expect(squash(latest.header)).toContain(fn.returns);
  });

  it('戻り値の旧オーナー / 旧代表者は、行のロックの下で読んだ変数で、membership_audit に書くのと同じ変数。最初のロックの読み取りより後に代入し直さない', () => {
    const readAt = indexOf(body, new RegExp(squash(fn.lockedRead.source)), '行のロックの下の読み取り');
    const auditAt = indexOf(body, fn.auditPair, 'membership_audit の旧オーナー / 旧代表者');
    const returnAt = indexOf(body, fn.newReturn, '戻り値');
    expect(readAt).toBeLessThan(auditAt);
    expect(auditAt).toBeLessThan(returnAt);
    const variable = fn.auditPair.split(', ')[1];
    // 変数に値を入れるのは、行のロックの下の読み取りの 1 回だけ
    expect(body.split(new RegExp(`INTO ${variable}\\b|${variable} :=`))).toHaveLength(2);
    // 最後の文が戻り値の RETURN (ほかの RETURN は無い)
    expect(body.match(/\bRETURN\b/g)).toHaveLength(1);
    expect(body.endsWith(`${fn.newReturn} END`)).toBe(true);
  });
});

describe.each(FUNCTIONS)('$name: 戻り値のキーと、route・型の生成物', (fn) => {
  it('戻り値の jsonb のキーは route の Zod スキーマのキーと同じ', () => {
    expect(fn.newReturn).toContain(`'${fn.rowKey}', to_jsonb(`);
    expect(fn.newReturn).toContain(`'${fn.priorKey}', `);
    expect([...fn.schemaKeys].sort()).toEqual([fn.rowKey, fn.priorKey].sort());
  });

  it('route はこの関数を 1 回だけ呼び、戻り値を Zod スキーマで読む (src の呼び出しはこの route だけ)', () => {
    const callers = listSourceFiles(path.join(ROOT, 'src')).filter((file) =>
      fs.readFileSync(file, 'utf-8').includes(`.rpc('${fn.name}'`),
    );
    expect(callers.map((file) => path.relative(ROOT, file).split(path.sep).join('/'))).toEqual([fn.route]);
    const route = fs.readFileSync(path.join(ROOT, fn.route), 'utf-8');
    expect(route.split(`.rpc('${fn.name}'`)).toHaveLength(2);
    expect(route).toMatch(/ResultSchema\.safeParse\(rpcData\)/);
  });

  it.each(TYPE_FILES)('型の生成物 %s の Returns は Json (SetofOptions の行の型は無い)', (typeFile) => {
    const source = fs.readFileSync(path.join(ROOT, typeFile), 'utf-8');
    const start = indexOf(source, `\n      ${fn.name}: {`, `${typeFile} の ${fn.name}`);
    const end = source.indexOf('\n      }\n', start);
    const entry = source.slice(start, end);
    expect(entry).toContain('Returns: Json');
    expect(entry).not.toContain('SetofOptions');
  });
});

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== '__tests__') out.push(...listSourceFiles(full));
    } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

describe('見出しと番号', () => {
  it('migration の 1 行目と戻し口の参照が自分を指す', () => {
    expect(migrationSql.split('\n', 1)[0]).toBe(`-- migration: ${MIGRATION}.sql`);
    expect(migrationSql).toContain(`supabase/rollbacks/${MIGRATION}.down.sql`);
  });

  it('この migration の version (先頭の 14 桁) は、ほかの migration と重ならない (main を取り込んだあとの番号の付け直しの見張り)', () => {
    const version = MIGRATION.slice(0, MIGRATION.indexOf('_'));
    expect(version).toMatch(/^\d{14}$/);
    expect(migrations.filter(({ file }) => file.startsWith(`${version}_`)).map(({ file }) => file)).toEqual([`${MIGRATION}.sql`]);
  });

  it('この migration が作り直す関数は 2 つだけで、ほかの表・ポリシーに触れない', () => {
    const code = stripLineComments(migrationSql);
    const created = [...code.matchAll(/CREATE OR REPLACE FUNCTION\s+(?:"?public"?\.)?"?(\w+)"?\s*\(/g)].map((m) => m[1]).sort();
    expect(created).toEqual(FUNCTIONS.map(({ name }) => name).sort());
    expect(code).not.toMatch(/\b(ALTER\s+TABLE|CREATE\s+POLICY|DROP\s+POLICY|ALTER\s+POLICY|UPDATE\s+public\.|DELETE\s+FROM)\b/i);
  });
});

describe('戻し口', () => {
  const rollback = fs.existsSync(ROLLBACK_PATH) ? fs.readFileSync(ROLLBACK_PATH, 'utf-8') : '';

  it('戻し口が実在し、1 行目が自分の migration を指す', () => {
    expect(fs.existsSync(ROLLBACK_PATH), ROLLBACK_PATH).toBe(true);
    expect(rollback.split('\n', 1)[0]).toBe(`-- rollback: ${MIGRATION}.sql`);
  });

  it.each(FUNCTIONS)('$name を前の定義 ($previous.file) に逐語で戻し、DROP → CREATE → 本番と同じ権限 の順', (fn) => {
    const source = linesOf(fn.previous.file, fn.previous.from, fn.previous.to);
    expect(rollback).toContain(source);
    const code = stripLineComments(rollback);
    const drop = `DROP FUNCTION IF EXISTS public.${fn.name}(uuid, uuid, text);`;
    const [revoke, grant] = grantStatements(fn.name);
    for (const statement of [drop, revoke, grant]) expect(code.split(statement), statement).toHaveLength(2);
    const order = [indexOf(code, drop, 'DROP'), indexOf(code, source.split('\n', 1)[0], 'CREATE'), indexOf(code, revoke, 'REVOKE'), indexOf(code, grant, 'GRANT')];
    expect(order).toEqual([...order].sort((a, b) => a - b));
    const restored = definitionsIn(ROLLBACK_PATH, code, fn.name);
    expect(restored).toHaveLength(1);
    expect(squash(restored[0].body)).toContain(fn.previousReturn);
    expect(restored[0].body).not.toContain(`jsonb_build_object('${fn.rowKey}'`);
  });

  it('戻し口が戻す関数は、この migration が作り直す 2 つと同じ', () => {
    const code = stripLineComments(rollback);
    const restored = [...code.matchAll(/CREATE OR REPLACE FUNCTION\s+(?:"?public"?\.)?"?(\w+)"?\s*\(/g)].map((m) => m[1]).sort();
    expect(restored).toEqual(FUNCTIONS.map(({ name }) => name).sort());
  });
});
