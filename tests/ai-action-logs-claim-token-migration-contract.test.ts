// @vitest-environment node
/**
 * #2299 の B の前段 W2a: AI 相談の提案の記録 (ai_action_logs) に claim_token の列を足す migration
 * (supabase/migrations/20261107140000_ai_action_logs_claim_token.sql) を、ファイルの読み取りで確かめる (DB には接続しない)。
 *
 *   T-1 migration はちょうど 1 本。頭の行と「戻し方」の参照が対になり、戻し口が実在して対の migration を指す。
 *       version は 20261107120000_ai_action_logs_select_only.sql より後 (末尾の検証が、外したあとの権限を見るため)
 *   T-2 本冊は claim_token uuid を NULL 可・既定値なしで足し (ADD COLUMN IF NOT EXISTS)、列のコメントを付ける。
 *       行に書かない・権限 (GRANT / REVOKE) とポリシーに触れない・lock_timeout がある
 *   T-3 本冊の末尾の DO ブロックが、列 (型・NULL 可・既定値) と権限 (authenticated の書き込み・列の書き込み・anon・service_role) を見る
 *   T-4 戻し口は claim_token を DROP COLUMN IF EXISTS するだけ (権限・ポリシー・ほかの列に触れない)
 *   T-5 型の生成物 (src/types/database.types.ts・packages/shared/src/database.types.ts) の ai_action_logs の Row / Insert / Update に
 *       claim_token があり、生成物の形 (Row は `string | null`・Insert / Update は省略可) で、列の並び (名前の順) に入っている
 * 実際の挙動は tests/integration/rls/ai-action-logs-claim-token-2299.test.ts (実 DB) が確かめる。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const MIGRATIONS_DIR = path.join(ROOT, 'supabase', 'migrations');
const ROLLBACKS_DIR = path.join(ROOT, 'supabase', 'rollbacks');
const TYPE_FILES = ['src/types/database.types.ts', 'packages/shared/src/database.types.ts'] as const;

const TABLE = 'ai_action_logs';
const COLUMN = 'claim_token';
/** 本冊の名前 (version を除く) */
const MIGRATION_NAME = 'ai_action_logs_claim_token';
/** 表の権限を authenticated は読むだけ・anon は無しにした migration の名前 (本冊はこれより後に当たる) */
const SELECT_ONLY_MIGRATION_NAME = 'ai_action_logs_select_only';
/** 本冊が付ける列のコメント */
const COLUMN_COMMENT =
  '実行の印 (approved) を付けたリクエストごとの token。書き戻しはこの token で絞り、別のリクエストの印を上書きしない (#2299)。';

const stripLineComments = (sql: string): string => sql.replace(/--.*$/gm, '');

const migrationFileNames = fs
  .readdirSync(MIGRATIONS_DIR)
  .filter((name) => name.endsWith('.sql'))
  .sort();
const migrationFiles = migrationFileNames.filter((name) => name.endsWith(`_${MIGRATION_NAME}.sql`));
const migrationFile = migrationFiles[0] ?? '';
const selectOnlyFile = migrationFileNames.find((name) => name.endsWith(`_${SELECT_ONLY_MIGRATION_NAME}.sql`)) ?? '';
const rawMigration = migrationFile ? fs.readFileSync(path.join(MIGRATIONS_DIR, migrationFile), 'utf-8') : '';
const migrationSql = stripLineComments(rawMigration);
const rollbackFile = migrationFile.replace(/\.sql$/, '.down.sql');
const rollbackPath = path.join(ROLLBACKS_DIR, rollbackFile);
const rawRollback = migrationFile && fs.existsSync(rollbackPath) ? fs.readFileSync(rollbackPath, 'utf-8') : '';
const rollbackSql = stripLineComments(rawRollback);

const TABLE_REF = String.raw`(?:"?public"?\.)?"?${TABLE}"?`;

/** 文 (; で区切る) に分け、空白をそろえる。DO ブロックの中身は 1 つの文として扱わない (ここでは DO の外の文だけを数える) */
function topLevelStatements(sql: string): string[] {
  const withoutDo = sql.replace(/DO\s+\$(\w*)\$[\s\S]*?\$\1\$\s*;/g, '');
  return withoutDo
    .split(';')
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter((s) => s.length > 0);
}

function doBlock(sql: string): string {
  return /DO\s+\$(\w*)\$([\s\S]*?)\$\1\$\s*;/.exec(sql)?.[2] ?? '';
}

describe('T-1 migration と戻し口の対 (#2299 W2a)', () => {
  it('migration はちょうど 1 本。頭の行と「戻し方」が対になり、戻し口が実在して対の migration を指す', () => {
    expect(migrationFiles).toHaveLength(1);
    const lines = rawMigration.split('\n');
    expect(lines[0]).toBe(`-- migration: ${migrationFile}`);
    expect(lines[1]).toBe(`-- 戻し方: supabase/rollbacks/${rollbackFile}`);
    expect(fs.existsSync(rollbackPath)).toBe(true);
    expect(rawRollback.split('\n')[0]).toBe(`-- rollback: ${migrationFile}`);
  });

  it('本冊の version は、権限を読むだけにした migration より後 (末尾の検証がその権限を前提にする)', () => {
    expect(selectOnlyFile).not.toBe('');
    expect(migrationFile.localeCompare(selectOnlyFile)).toBeGreaterThan(0);
  });
});

describe('T-2 本冊の文 (#2299 W2a)', () => {
  const statements = topLevelStatements(migrationSql);

  it('DO ブロックの外の文は lock_timeout・ADD COLUMN・COMMENT ON COLUMN の 3 つだけ (この順)', () => {
    expect(statements).toEqual([
      "SET LOCAL lock_timeout = '10s'",
      `ALTER TABLE public.${TABLE} ADD COLUMN IF NOT EXISTS ${COLUMN} uuid`,
      `COMMENT ON COLUMN public.${TABLE}.${COLUMN} IS '${COLUMN_COMMENT}'`,
    ]);
  });

  it('列は NULL 可・既定値なし (NOT NULL・DEFAULT を付けない)', () => {
    const addColumn = statements.find((s) => /\bADD\s+COLUMN\b/i.test(s)) ?? '';
    expect(addColumn).not.toBe('');
    expect(addColumn).not.toMatch(/\bNOT\s+NULL\b|\bDEFAULT\b|\bPRIMARY\b|\bUNIQUE\b|\bREFERENCES\b|\bCHECK\b/i);
  });

  it('行に書かない・権限とポリシーに触れない (DO ブロックの中も含めて)', () => {
    expect(migrationSql).not.toMatch(/\bINSERT\s+INTO\b|\bUPDATE\s+(?:public\.)?\w+\s+SET\b|\bDELETE\s+FROM\b|\bTRUNCATE\b\s+(?:TABLE\s+)?(?!ON\b)[\w".]+\s*;/i);
    expect(migrationSql).not.toMatch(/\bGRANT\b|\bREVOKE\b/i);
    expect(migrationSql).not.toMatch(/\b(?:CREATE|DROP|ALTER)\s+POLICY\b/i);
    expect(migrationSql).not.toMatch(/\bDROP\s+COLUMN\b/i);
  });
});

describe('T-3 本冊の末尾の検証 (#2299 W2a)', () => {
  const block = doBlock(migrationSql);

  it('DO ブロックがあり、列の型・NULL 可・既定値を pg_attribute から見る', () => {
    expect(block).not.toBe('');
    expect(block).toMatch(new RegExp(String.raw`attrelid\s*=\s*'public\.${TABLE}'::regclass`));
    expect(block).toMatch(new RegExp(String.raw`attname\s*=\s*'${COLUMN}'`));
    expect(block).toMatch(/format_type\(/);
    expect(block).toMatch(/v_type\s*<>\s*'uuid'/);
    expect(block).toMatch(/IF\s+v_not_null\s+THEN/);
    expect(block).toMatch(/IF\s+v_has_default\s+THEN/);
  });

  it('authenticated の表の書き込み (INSERT・UPDATE・DELETE・TRUNCATE)・列の書き込み (INSERT・UPDATE)・anon の全部が無いこと、service_role が列を書けることを見る', () => {
    expect(block).toMatch(
      /ARRAY\['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'\][\s\S]*?has_table_privilege\('authenticated', 'public\.ai_action_logs', v_priv\)/,
    );
    expect(block).toMatch(/ARRAY\['INSERT', 'UPDATE'\][\s\S]*?has_column_privilege\('authenticated', 'public\.ai_action_logs', 'claim_token', v_priv\)/);
    expect(block).toMatch(
      /ARRAY\['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'\][\s\S]*?has_table_privilege\('anon', 'public\.ai_action_logs', v_priv\)/,
    );
    expect(block).toMatch(/has_table_privilege\('authenticated', 'public\.ai_action_logs', 'SELECT'\)/);
    expect(block).toMatch(/ARRAY\['SELECT', 'INSERT', 'UPDATE'\][\s\S]*?has_column_privilege\('service_role', 'public\.ai_action_logs', 'claim_token', v_priv\)/);
    expect((block.match(/RAISE\s+EXCEPTION/g) ?? []).length).toBeGreaterThanOrEqual(7);
  });
});

describe('T-4 戻し口 (#2299 W2a)', () => {
  it('lock_timeout と、claim_token の DROP COLUMN IF EXISTS だけ', () => {
    expect(rollbackSql).not.toBe('');
    expect(topLevelStatements(rollbackSql)).toEqual([
      "SET LOCAL lock_timeout = '10s'",
      `ALTER TABLE public.${TABLE} DROP COLUMN IF EXISTS ${COLUMN}`,
    ]);
    expect(rollbackSql).toMatch(new RegExp(String.raw`ALTER\s+TABLE\s+${TABLE_REF}\s+DROP\s+COLUMN\s+IF\s+EXISTS\s+${COLUMN}\s*;`, 'i'));
  });
});

describe('T-5 型の生成物 (#2299 W2a)', () => {
  /** 型ファイルの ai_action_logs の Row / Insert / Update の節の本文 */
  function sectionsOf(file: string): Record<'Row' | 'Insert' | 'Update', string> {
    const text = fs.readFileSync(path.join(ROOT, file), 'utf-8');
    const start = text.indexOf(`      ${TABLE}: {\n`);
    expect(start, `${file} に ${TABLE} が無い`).toBeGreaterThanOrEqual(0);
    const end = text.indexOf('        Relationships:', start);
    const table = text.slice(start, end);
    const section = (name: string): string => {
      const m = new RegExp(String.raw`\n        ${name}: \{\n([\s\S]*?)\n        \}`).exec(table);
      return m?.[1] ?? '';
    };
    return { Row: section('Row'), Insert: section('Insert'), Update: section('Update') };
  }

  const fieldNames = (section: string): string[] => [...section.matchAll(/^ {10}(\w+)\??:/gm)].map((m) => m[1]);

  for (const file of TYPE_FILES) {
    it(`${file}: Row は ${COLUMN}: string | null・Insert / Update は ${COLUMN}?: string | null で、名前の順に入っている`, () => {
      const sections = sectionsOf(file);
      expect(sections.Row).toMatch(new RegExp(String.raw`^ {10}${COLUMN}: string \| null$`, 'm'));
      expect(sections.Insert).toMatch(new RegExp(String.raw`^ {10}${COLUMN}\?: string \| null$`, 'm'));
      expect(sections.Update).toMatch(new RegExp(String.raw`^ {10}${COLUMN}\?: string \| null$`, 'm'));
      for (const name of ['Row', 'Insert', 'Update'] as const) {
        const names = fieldNames(sections[name]);
        expect(names, `${file} ${name}`).toContain(COLUMN);
        expect(names, `${file} ${name} が名前の順でない`).toEqual([...names].sort());
      }
    });
  }

  it('2 つの型ファイルの ai_action_logs の節は同じ', () => {
    const [a, b] = TYPE_FILES.map(sectionsOf);
    expect(a).toEqual(b);
  });
});
