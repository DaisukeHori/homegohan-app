/**
 * #1542: migration 20261017010000_drop_auth_login_lock_objects.sql (と、そのロールバック) の contract テスト (DB は使わない)
 *
 * #1165 でログインのロックをやめたあとも DB に残っていた、ロックのための関数 4 本と列 auth_login_failures.locked_until を消す。
 * 本物の DB で消えていること・ロールバックで戻ること・何度流しても同じことは
 * tests/integration/security/auth-login-lock.test.ts (L-5) が確かめる。ここでは、ファイルの文面で崩れやすい所を確かめる。
 *   1. 消すのは 4 本の関数と 1 つの列だけ。関数は IF EXISTS と引数の型までの完全形で消す
 *      (引数の型が作ったときと違うと、IF EXISTS で黙って何も消えない。型は 20261010130000 の CREATE から求めて突き合わせる)
 *   2. 関数を先に消し、列はそのあと (3 本の関数の本文が列を参照しているため)
 *   3. 引き続き使う関数 (ハッシュ・回数・記録の消去・掃除) とテーブルには触れない
 *   4. 4 本の関数と列を作った (最後に定義した) のは 20261010130000 だけで、本 migration より後に作り直す migration も無い
 *   5. ロールバックは、関数を 20261010130000 と同じ定義・同じ権限で作り直し、列を同じ型で戻す
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const MIGRATIONS_DIR = path.join(ROOT, 'supabase/migrations');
const MIGRATION_STEM = '20261017010000_drop_auth_login_lock_objects';
const MIGRATION_FILE = `${MIGRATION_STEM}.sql`;
const ROLLBACK_PATH = path.join(ROOT, 'supabase/rollbacks', `${MIGRATION_STEM}.down.sql`);
/** 4 本の関数と列を作った migration */
const ORIGIN_FILE = '20261010130000_auth_login_failures.sql';

/** 消す関数 (#1542 の Issue に挙がった 4 本) */
const DROPPED_FUNCTIONS = [
  'auth_login_lock_status',
  'auth_login_record_failure',
  'auth_login_apply_lock',
  'auth_login_account_user_id',
] as const;
const DROPPED_COLUMN = 'locked_until';
const TABLE = 'public.auth_login_failures';

/** 引き続き使う関数 (消さない・触れない) */
const KEPT_FUNCTIONS = [
  'auth_login_email_hash',
  'auth_login_clear_failures',
  'auth_login_failure_count',
  'auth_login_count_failure',
  'cleanup_stale_auth_login_failures',
] as const;

/** SQL のコメント (-- から行末、/* ... *\/) を除く */
function stripSqlComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '');
}

/** 空白を 1 つに詰める */
function squash(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

/** コメントを除いた SQL を、$$ ... $$ の外のセミコロンで文に分ける (空白を詰めた文の配列) */
function statements(sql: string): string[] {
  const code = stripSqlComments(sql);
  const out: string[] = [];
  let current = '';
  let inDollar = false;
  for (let i = 0; i < code.length; i += 1) {
    if (code.startsWith('$$', i)) {
      inDollar = !inDollar;
      current += '$$';
      i += 1;
      continue;
    }
    if (code[i] === ';' && !inDollar) {
      if (current.trim()) out.push(squash(current));
      current = '';
      continue;
    }
    current += code[i];
  }
  if (current.trim()) out.push(squash(current));
  return out;
}

/** CREATE 文の引数の並び (`p_email text, p_locked_until timestamptz`) から、引数の型だけの並び (`text, timestamptz`) を作る */
function argumentTypes(parameterList: string): string {
  return parameterList
    .split(',')
    .map((parameter) => parameter.trim().split(/\s+/).slice(1).join(' '))
    .join(', ');
}

const readMigration = (file: string) => fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
const migrationStatements = statements(readMigration(MIGRATION_FILE));
const originStatements = statements(readMigration(ORIGIN_FILE));
const rollbackStatements = statements(fs.readFileSync(ROLLBACK_PATH, 'utf8'));

/** 関数の CREATE 文 (CREATE OR REPLACE FUNCTION public.<名前>( ...) */
function createStatementOf(list: readonly string[], name: string): string | undefined {
  return list.find((statement) => new RegExp(`^CREATE OR REPLACE FUNCTION public\\.${name}\\(`).test(statement));
}

/** 関数の CREATE 文から、引数の型だけの並び */
function signatureTypesOf(createStatement: string, name: string): string {
  const match = createStatement.match(new RegExp(`FUNCTION public\\.${name}\\(([^)]*)\\)`));
  if (!match) throw new Error(`${name} の引数の並びが読めない`);
  return argumentTypes(match[1]);
}

/** 関数の権限の文 (REVOKE / GRANT ... ON FUNCTION public.<名前>(...)) */
function privilegeStatementsOf(list: readonly string[], name: string): string[] {
  return list.filter((statement) => new RegExp(`^(?:REVOKE|GRANT) .* ON FUNCTION public\\.${name}\\(`).test(statement));
}

/** 本 migration の文として期待するもの (関数の引数の型は 20261010130000 の CREATE から求める) */
function expectedMigrationStatements(): string[] {
  return [
    ...DROPPED_FUNCTIONS.map((name) => {
      const created = createStatementOf(originStatements, name);
      if (!created) throw new Error(`${ORIGIN_FILE} に ${name} の CREATE が無い`);
      return `DROP FUNCTION IF EXISTS public.${name}(${signatureTypesOf(created, name)})`;
    }),
    `ALTER TABLE ${TABLE} DROP COLUMN IF EXISTS ${DROPPED_COLUMN}`,
  ];
}

describe('#1542 本 migration が消すもの', () => {
  it('文は、4 本の関数の DROP FUNCTION IF EXISTS (引数の型は 20261010130000 の CREATE と同じ) と、列の DROP COLUMN IF EXISTS だけ', () => {
    expect(migrationStatements).toEqual(expectedMigrationStatements());
  });

  it('関数を消してから列を消す (3 本の関数の本文が列を参照している)', () => {
    const lastFunctionDrop = Math.max(...DROPPED_FUNCTIONS.map((name) => migrationStatements.findIndex((s) => s.includes(`public.${name}(`))));
    const columnDrop = migrationStatements.findIndex((s) => s.includes(`DROP COLUMN IF EXISTS ${DROPPED_COLUMN}`));
    expect(columnDrop).toBeGreaterThan(lastFunctionDrop);
    // 列を参照している関数 (前提の確認): 20261010130000 の本文に locked_until が出てくる
    for (const name of ['auth_login_lock_status', 'auth_login_record_failure', 'auth_login_apply_lock']) {
      expect(createStatementOf(originStatements, name), name).toMatch(/\blocked_until\b/);
    }
  });

  it('引き続き使う関数とテーブルには触れない (テーブルを消さない)', () => {
    const code = migrationStatements.join('\n');
    for (const name of KEPT_FUNCTIONS) expect(code, name).not.toContain(name);
    expect(code).not.toMatch(/\bDROP\s+TABLE\b/i);
    expect(code).not.toMatch(/\bCREATE\b/i);
  });

  it('検出力: 引数の型を作ったときの並びから求める (型の違う DROP は期待の文に入らない)', () => {
    expect(argumentTypes('p_email text, p_locked_until timestamptz')).toBe('text, timestamptz');
    expect(argumentTypes('p_email text')).toBe('text');
    const expected = expectedMigrationStatements();
    expect(expected).toContain('DROP FUNCTION IF EXISTS public.auth_login_apply_lock(text, timestamptz)');
    expect(expected).not.toContain('DROP FUNCTION IF EXISTS public.auth_login_apply_lock(text)');
    expect(expected).not.toContain('DROP FUNCTION IF EXISTS public.auth_login_apply_lock');
  });
});

describe('#1542 ほかの migration との関係', () => {
  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((file) => /^\d{14}_.*\.sql$/.test(file))
    .sort();

  it('4 本の関数を作ったのは 20261010130000 だけ (最後の定義 = ロールバックが写す定義)', () => {
    for (const name of DROPPED_FUNCTIONS) {
      const creators = files.filter((file) => createStatementOf(statements(readMigration(file)), name) !== undefined);
      expect(creators, name).toEqual([ORIGIN_FILE]);
    }
  });

  it('コメントを除いたコードで locked_until が出てくるのは、20261010130000 と本 migration だけ (列を足し直す・読む migration が無い)', () => {
    const users = files.filter((file) => /\blocked_until\b/.test(stripSqlComments(readMigration(file))));
    expect(users).toEqual([ORIGIN_FILE, MIGRATION_FILE]);
  });

  it('本 migration より後に、4 本の関数の名前をコードに書いた migration は無い', () => {
    const later = files.filter((file) => file > MIGRATION_FILE);
    for (const file of later) {
      const code = stripSqlComments(readMigration(file));
      for (const name of DROPPED_FUNCTIONS) expect(code, `${file}: ${name}`).not.toContain(name);
    }
  });
});

describe('#1542 ロールバック', () => {
  it('4 本の関数を、20261010130000 と同じ CREATE 文で作り直す', () => {
    for (const name of DROPPED_FUNCTIONS) {
      const original = createStatementOf(originStatements, name);
      expect(original, name).toBeDefined();
      expect(createStatementOf(rollbackStatements, name), name).toBe(original);
    }
  });

  it('関数の権限 (REVOKE / GRANT) も 20261010130000 と同じ', () => {
    for (const name of DROPPED_FUNCTIONS) {
      const original = privilegeStatementsOf(originStatements, name);
      expect(original.length, `${name} の権限の文が 20261010130000 に無い`).toBeGreaterThan(0);
      expect(privilegeStatementsOf(rollbackStatements, name), name).toEqual(original);
    }
  });

  it('列を 20261010130000 と同じ型 (timestamptz・NULL 可) とコメントで、関数より先に戻す', () => {
    const originTable = originStatements.find((s) => s.startsWith(`CREATE TABLE IF NOT EXISTS ${TABLE} (`)) ?? '';
    expect(originTable).toMatch(new RegExp(`\\b${DROPPED_COLUMN} timestamptz,`));
    const addColumn = `ALTER TABLE ${TABLE} ADD COLUMN IF NOT EXISTS ${DROPPED_COLUMN} timestamptz`;
    expect(rollbackStatements[0]).toBe(addColumn);
    const commentOf = (list: readonly string[]) =>
      list.find((s) => s.startsWith(`COMMENT ON COLUMN ${TABLE}.${DROPPED_COLUMN} IS`));
    expect(commentOf(rollbackStatements)).toBe(commentOf(originStatements));
  });

  it('ロールバックは消した 4 本の関数と列のほかに何も作らない・消さない', () => {
    const created = rollbackStatements
      .map((s) => s.match(/^CREATE OR REPLACE FUNCTION public\.([a-z_]+)\(/)?.[1])
      .filter((name): name is string => name !== undefined)
      .sort();
    expect(created).toEqual([...DROPPED_FUNCTIONS].sort());
    expect(rollbackStatements.join('\n')).not.toMatch(/\bDROP\b/i);
  });
});
