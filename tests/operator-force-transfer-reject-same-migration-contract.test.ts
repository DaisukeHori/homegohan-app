/**
 * #2093 W5: 運営の強制譲渡の RPC が、譲渡先がすでに今のオーナー / 代表者 (新 = 旧) でも membership_audit に旧 = 新の行を書いて
 * しまう欠陥の修正 (supabase/migrations/20261030120000_operator_force_transfer_reject_same.sql) を、ファイルどうしの突き合わせで
 * 確かめる (DB には接続しない)。
 *
 * 後の migration がこの 2 つの関数を古い本文で作り直して判定を落とさないよう、「最新の定義」(supabase/migrations を version 順に見て、
 * 最後に CREATE OR REPLACE したもの) で確かめる。
 *
 *   1. 最新の定義は、組織 / 家族の行を FOR NO KEY UPDATE で読んだ直後に、新 = 旧なら ALREADY_OWNER / ALREADY_REPRESENTATIVE
 *      (P0001) を RAISE する。判定は、新オーナーの行のロック・在籍の判定・役割の更新・membership_audit の INSERT より前
 *   2. この migration の定義は、前の定義 (20261023140000_operator_transfer_return_old_owner.sql) の本文に判定を 1 つ足しただけ
 *      (見出し (引数・戻り値・SECURITY DEFINER・search_path) は同じ。コメントと空白を除いて比べる)
 *   3. migration は関数の本文の置き換えだけ (権限の付け外し・DROP・データを書き換える文が無い。権限は CREATE OR REPLACE で残る)
 *   4. 戻し口が実在し、2 つの関数を前の定義に逐語で戻す
 *   5. route は RPC の ALREADY_OWNER / ALREADY_REPRESENTATIVE を 409 の code に写す (code の語は route の定数と同じ)
 * 実際の挙動は tests/integration/security/operator-transfer-old-owner.test.ts の OTO-8〜OTO-11 (実 DB)、
 * route の 409 は src/__tests__/api/operator/membership/org-transfer.test.ts・family-transfer.test.ts と
 * tests/operator-membership-rpc-errors-1917.test.ts が確かめる。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  OPERATOR_FORCE_TRANSFER_ALREADY_OWNER_CODE,
  OPERATOR_FORCE_TRANSFER_ALREADY_REPRESENTATIVE_CODE,
} from '@/lib/membership/operator-force-transfer-result';

const ROOT = path.resolve(__dirname, '..');
const MIGRATIONS_DIR = path.join(ROOT, 'supabase', 'migrations');
const MIGRATION = '20261030120000_operator_force_transfer_reject_same';
const MIGRATION_PATH = path.join(MIGRATIONS_DIR, `${MIGRATION}.sql`);
const ROLLBACK_PATH = path.join(ROOT, 'supabase', 'rollbacks', `${MIGRATION}.down.sql`);
const PREVIOUS_FILE = '20261023140000_operator_transfer_return_old_owner.sql';

interface TransferFunction {
  name: 'operator_force_owner_transfer' | 'operator_force_representative_transfer';
  /** この migration より前の最後の定義の行 (1 始まり・両端を含む) */
  previous: { file: string; from: number; to: number };
  /** 行のロックの下で旧オーナー / 旧代表者を読む文 (コメントを除き空白をまとめた形) */
  lockedRead: string;
  /** 足した判定 (コメントを除き空白をまとめた形) */
  guard: string;
  /** RAISE するコード */
  code: string;
  /** 判定より後にだけ現れてよい文 (ほかの行のロック・書き込み・監査) */
  laterStatements: RegExp[];
  /** route のファイル (RPC のコードを 409 に写す) */
  route: string;
  /** route が 409 の code に使う定数の名前 */
  routeConstant: string;
}

const FUNCTIONS: readonly TransferFunction[] = [
  {
    name: 'operator_force_owner_transfer',
    previous: { file: PREVIOUS_FILE, from: 43, to: 92 },
    lockedRead: 'SELECT owner_id INTO v_old_owner_id FROM organizations WHERE id = p_organization_id FOR NO KEY UPDATE;',
    guard: "IF p_new_owner_id = v_old_owner_id THEN RAISE EXCEPTION 'ALREADY_OWNER' USING ERRCODE = 'P0001'; END IF;",
    code: OPERATOR_FORCE_TRANSFER_ALREADY_OWNER_CODE,
    laterStatements: [
      /\bFROM\s+user_profiles\s+WHERE\s+id\s*=\s*p_new_owner_id\s+FOR\s+NO\s+KEY\s+UPDATE\b/i,
      /\bRAISE\s+EXCEPTION\s+'TARGET_NOT_IN_ORG'/i,
      /\bUPDATE\s+(?:public\.)?(?:user_profiles|organizations)\b/i,
      /\bINSERT\s+INTO\s+(?:public\.)?membership_audit\b/i,
    ],
    route: 'src/app/api/operator/membership/org/[id]/transfer/route.ts',
    routeConstant: 'OPERATOR_FORCE_TRANSFER_ALREADY_OWNER_CODE',
  },
  {
    name: 'operator_force_representative_transfer',
    previous: { file: PREVIOUS_FILE, from: 105, to: 154 },
    lockedRead: 'SELECT representative_id INTO v_old_rep_id FROM family_groups WHERE id = p_family_id FOR NO KEY UPDATE;',
    guard: "IF p_new_rep_id = v_old_rep_id THEN RAISE EXCEPTION 'ALREADY_REPRESENTATIVE' USING ERRCODE = 'P0001'; END IF;",
    code: OPERATOR_FORCE_TRANSFER_ALREADY_REPRESENTATIVE_CODE,
    laterStatements: [
      /\bFROM\s+family_members\b/i,
      /\bRAISE\s+EXCEPTION\s+'TARGET_NOT_IN_FAMILY'/i,
      /\bUPDATE\s+(?:public\.)?(?:family_members|family_groups)\b/i,
      /\bINSERT\s+INTO\s+(?:public\.)?membership_audit\b/i,
    ],
    route: 'src/app/api/operator/membership/family/[id]/transfer/route.ts',
    routeConstant: 'OPERATOR_FORCE_TRANSFER_ALREADY_REPRESENTATIVE_CODE',
  },
];

/** エラーの順番 (最新の定義の本文で、この順に現れる。業務のコードはこれだけ) */
const RAISE_ORDER: Record<TransferFunction['name'], readonly string[]> = {
  operator_force_owner_transfer: ['NOT_OPERATOR', 'OPERATOR_MFA_REQUIRED', 'ALREADY_OWNER', 'TARGET_NOT_IN_ORG'],
  operator_force_representative_transfer: ['NOT_OPERATOR', 'OPERATOR_MFA_REQUIRED', 'ALREADY_REPRESENTATIVE', 'TARGET_NOT_IN_FAMILY'],
};

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

const migrations = fs
  .readdirSync(MIGRATIONS_DIR)
  .filter((file) => file.endsWith('.sql'))
  .sort()
  .map((file) => ({ file, sql: fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8') }));

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

/** ファイルの from〜to 行 (1 始まり・両端を含む) を改行でつないで返す */
function linesOf(file: string, from: number, to: number): string {
  return fs
    .readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8')
    .split('\n')
    .slice(from - 1, to)
    .join('\n');
}

const readMigration = (): string => (fs.existsSync(MIGRATION_PATH) ? fs.readFileSync(MIGRATION_PATH, 'utf-8') : '');
const readRollback = (): string => (fs.existsSync(ROLLBACK_PATH) ? fs.readFileSync(ROLLBACK_PATH, 'utf-8') : '');

/** 文の中で pattern が最初に現れる位置。無ければテストを落とす */
function indexOf(text: string, pattern: RegExp | string, label: string): number {
  const at = typeof pattern === 'string' ? text.indexOf(pattern) : text.search(pattern);
  expect(at, `${label} が無い`).toBeGreaterThanOrEqual(0);
  return at;
}

describe.each(FUNCTIONS)('$name: 最新の定義は、新 = 旧なら書く前に断る', (fn) => {
  it('migration のファイルが実在し、最新の定義はこの migration かそれより後', () => {
    expect(fs.existsSync(MIGRATION_PATH), MIGRATION_PATH).toBe(true);
    const latest = latestOf(fn.name);
    expect(latest.file >= `${MIGRATION}.sql`, latest.file).toBe(true);
  });

  it(`行のロックの下で旧を読んだ直後に ${fn.code} を RAISE し、ほかの行のロック・在籍の判定・役割の更新・membership_audit の INSERT はどれも判定より後`, () => {
    const body = squash(stripLineComments(latestOf(fn.name).body));
    const readAt = indexOf(body, fn.lockedRead, '行のロックの下の読み取り');
    const guardAt = indexOf(body, fn.guard, `${fn.code} の判定`);
    // 読み取りの直後 (間に文が無い)
    expect(body.slice(readAt + fn.lockedRead.length, guardAt).trim()).toBe('');
    for (const later of fn.laterStatements) {
      expect(indexOf(body, later, later.source), later.source).toBeGreaterThan(guardAt);
    }
    // 判定はちょうど 1 回
    expect(body.split(fn.guard)).toHaveLength(2);
  });

  it('エラーの順番は 権限 → MFA → 新 = 旧 → 在籍 で、ほかの業務のコードは RAISE しない。どれも P0001', () => {
    const body = stripLineComments(latestOf(fn.name).body);
    const raised = [...body.matchAll(/RAISE\s+EXCEPTION\s+'([A-Z][A-Z0-9_]*)'/g)].map((m) => m[1]);
    expect(raised).toEqual([...RAISE_ORDER[fn.name]]);
    for (const code of raised) expect(body).toMatch(new RegExp(`RAISE\\s+EXCEPTION\\s+'${code}'\\s+USING\\s+ERRCODE\\s*=\\s*'P0001'`));
  });
});

describe.each(FUNCTIONS)('$name: この migration の定義', (fn) => {
  it('前の定義は 20261023140000 の行 (土台の行がずれたら気づく)', () => {
    const previous = previousOf(fn.name);
    expect(previous.file).toBe(fn.previous.file);
    const source = linesOf(fn.previous.file, fn.previous.from, fn.previous.to);
    expect(source).toMatch(new RegExp(`^CREATE OR REPLACE FUNCTION "?public"?\\."?${fn.name}"?\\(`));
    expect(source).toMatch(/END \$\$;$/);
    expect(squash(source)).toBe(squash(previous.statement));
  });

  it('この migration の定義はちょうど 1 つで、見出し (引数・RETURNS jsonb・SECURITY DEFINER・search_path) は前の定義と同じ', () => {
    const own = definitionsIn(`${MIGRATION}.sql`, readMigration(), fn.name);
    expect(own).toHaveLength(1);
    expect(squash(own[0].header)).toBe(squash(previousOf(fn.name).header));
  });

  it('コメントを除くと、本文は前の定義の、行のロックの下の読み取りの直後に判定を 1 つ足しただけ', () => {
    const [own] = definitionsIn(`${MIGRATION}.sql`, readMigration(), fn.name);
    expect(own, 'この migration の定義').toBeDefined();
    const previousBody = squash(stripLineComments(previousOf(fn.name).body));
    expect(previousBody.split(fn.lockedRead)).toHaveLength(2);
    expect(squash(stripLineComments(own.body))).toBe(previousBody.replace(fn.lockedRead, `${fn.lockedRead} ${fn.guard}`));
  });
});

describe('migration の形', () => {
  it('1 行目の見出しと戻し方の案内が、このファイルと戻し口を指す', () => {
    const lines = readMigration().split('\n');
    expect(lines[0]).toBe(`-- migration: ${MIGRATION}.sql`);
    expect(lines[1]).toBe(`-- 戻し方: supabase/rollbacks/${MIGRATION}.down.sql`);
  });

  it('作り直す関数は 2 つだけ', () => {
    const created = [...stripLineComments(readMigration()).matchAll(/CREATE\s+OR\s+REPLACE\s+FUNCTION\s+(?:"?public"?\.)?"?(\w+)"?/gi)]
      .map((m) => m[1])
      .sort();
    expect(created).toEqual(FUNCTIONS.map(({ name }) => name).sort());
  });

  it('権限の付け外し・DROP・データを書き換える文が無い (関数の本文の置き換えだけ。権限は CREATE OR REPLACE で残る)', () => {
    const outsideBodies = stripLineComments(readMigration()).replace(/\$\$[\s\S]*?\$\$/g, '');
    expect(outsideBodies).toMatch(/CREATE\s+OR\s+REPLACE\s+FUNCTION/i);
    expect(outsideBodies).not.toMatch(/\b(?:GRANT|REVOKE|DROP|ALTER|UPDATE|INSERT|DELETE|TRUNCATE)\b/i);
  });

  it('この migration の version (先頭の 14 桁) は、ほかの migration と重ならない (main を取り込んだあとの番号の付け直しの見張り)', () => {
    const version = MIGRATION.slice(0, MIGRATION.indexOf('_'));
    expect(version).toMatch(/^\d{14}$/);
    expect(migrations.filter(({ file }) => file.startsWith(`${version}_`)).map(({ file }) => file)).toEqual([`${MIGRATION}.sql`]);
  });
});

describe('戻し口', () => {
  it('戻し口が実在し、1 行目が自分の migration を指す', () => {
    expect(fs.existsSync(ROLLBACK_PATH), ROLLBACK_PATH).toBe(true);
    expect(readRollback().split('\n', 1)[0]).toBe(`-- rollback: ${MIGRATION}.sql`);
  });

  it.each(FUNCTIONS)('$name を前の定義 (20261023140000) に逐語で戻す (判定は無い)', (fn) => {
    const rollback = readRollback();
    expect(rollback).toContain(linesOf(fn.previous.file, fn.previous.from, fn.previous.to));
    const restored = definitionsIn(path.basename(ROLLBACK_PATH), rollback, fn.name);
    expect(restored).toHaveLength(1);
    expect(squash(stripLineComments(restored[0].body))).not.toContain(fn.guard);
  });

  it('戻し口は関数の置き換えだけで、戻す関数はこの migration が作り直す 2 つと同じ (権限の付け外し・DROP・データを書き換える文が無い)', () => {
    const code = stripLineComments(readRollback());
    const restored = [...code.matchAll(/CREATE\s+OR\s+REPLACE\s+FUNCTION\s+(?:"?public"?\.)?"?(\w+)"?/gi)].map((m) => m[1]).sort();
    expect(restored).toEqual(FUNCTIONS.map(({ name }) => name).sort());
    expect(code.replace(/\$\$[\s\S]*?\$\$/g, '')).not.toMatch(/\b(?:GRANT|REVOKE|DROP|ALTER|UPDATE|INSERT|DELETE|TRUNCATE)\b/i);
  });
});

describe.each(FUNCTIONS)('$name: route は RPC のコードを 409 の code に写す', (fn) => {
  it('RPC が RAISE する語は route の 409 の code の定数と同じ', () => {
    expect(fn.guard).toContain(`'${fn.code}'`);
  });

  it('route は RPC のエラーの分岐で、この code を語として判定する (dbErrorMentionsCode)', () => {
    const route = fs.readFileSync(path.join(ROOT, fn.route), 'utf-8');
    const rpcErrorAt = indexOf(route, 'if (rpcError) {', 'RPC のエラーの分岐');
    expect(route.indexOf(`dbErrorMentionsCode(rpcError, ${fn.routeConstant})`, rpcErrorAt)).toBeGreaterThan(rpcErrorAt);
  });
});
