// @vitest-environment node
/**
 * #2178 Y3-b: recipe_collections に一意の索引 (user_id, name) を足す migration (*_recipe_collections_user_name_unique.sql) と
 * 戻し口の contract テスト (DB には接続しない)。
 *
 * 本物の DB での振る舞い (同じ名前の 2 件目の insert が一意の違反・executor が重複を作らない・戻し口) は
 * tests/integration/rls/recipe-collections-user-name-unique.test.ts が確かめる。ここでは文面だけで崩れやすい所を確かめる。
 *   C-1 migration はちょうど 1 本。1 行目の見出しと 2 行目の「戻し方」がファイル名と一致し、戻し口が実在して、その 1 行目が対の
 *       migration を指す (tests/migration-file-version-integrity.test.ts の決まり)。番号は直前に main にあった最大より大きい
 *   C-2 migration の文 (コメントを除く) は、lock_timeout と CREATE UNIQUE INDEX IF NOT EXISTS の 2 文だけ。
 *       GRANT / REVOKE / ALTER TABLE / CREATE POLICY / INSERT / UPDATE / DELETE を書かない (追加だけの migration)
 *   C-3 索引の名前と列は、アプリが upsert の onConflict に渡す定数 (src/lib/recipes/collections.ts) と同じ。部分索引 (WHERE) にしない
 *   C-4 戻し口の文は、lock_timeout と DROP INDEX IF EXISTS の 2 文だけ。GRANT を書かない
 *   C-5 ほかの migration は、この索引の名前を作らない・消さない (付け直しの漏れ・重なりの番兵)
 *   C-6 アプリのコードで recipe_collections を作る所は insert を使わず、onConflict = 索引の列の upsert だけ
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  RECIPE_COLLECTIONS_USER_NAME_CONFLICT_TARGET,
  RECIPE_COLLECTIONS_USER_NAME_UNIQUE_COLUMNS,
  RECIPE_COLLECTIONS_USER_NAME_UNIQUE_INDEX,
} from '@/lib/recipes/collections';
import {
  CREATE_UNIQUE_INDEX_STATEMENT,
  DROP_UNIQUE_INDEX_STATEMENT,
  MIGRATION_LOCK_TIMEOUT_STATEMENT,
  PRECEDING_MIGRATION_VERSION,
  RECIPE_COLLECTIONS_TABLE,
  RECIPE_COLLECTIONS_USER_NAME_UNIQUE_MIGRATION_NAME,
  sqlStatementsOf,
  stripSqlComments,
} from './helpers/recipe-collections-user-name-unique';

const ROOT = path.resolve(__dirname, '..');
const MIGRATIONS_DIR = path.join(ROOT, 'supabase', 'migrations');
const ROLLBACKS_DIR = path.join(ROOT, 'supabase', 'rollbacks');
const EXECUTOR = path.join(ROOT, 'src', 'lib', 'ai', 'consultation-action-executor.ts');
/** 版の番号 = YYYYMMDDHHMMSS の 14 桁 (tests/migration-file-version-integrity.test.ts と同じ形) */
const VERSION_LENGTH = 14;
/** recipe_collections を書くアプリのコードを探すディレクトリ (運営の画面・Edge Function・モバイルを含む) */
const WRITER_DIRS = ['src', 'lib', 'apps', 'packages', 'supabase/functions', 'components'] as const;
/** 走査の対象 (型の生成物とテストと node_modules は除く) */
const SOURCE_FILE = /\.(?:ts|tsx)$/;
const SKIPPED_DIR = /(?:^|\/)(?:node_modules|\.next|dist|__tests__|tests)(?:\/|$)/;
const TEST_FILE = /\.(?:test|spec)\.tsx?$/;
const GENERATED_TYPES = /database\.types\.ts$/;

const read = (file: string): string => fs.readFileSync(file, 'utf-8');
const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const migrationFiles = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
const ownMigrations = migrationFiles.filter((f) => f.endsWith(`_${RECIPE_COLLECTIONS_USER_NAME_UNIQUE_MIGRATION_NAME}.sql`));
const MIGRATION_FILE = ownMigrations[0] ?? '';
const MIGRATION_STEM = MIGRATION_FILE.replace(/\.sql$/, '');
const ROLLBACK_FILE = `${MIGRATION_STEM}.down.sql`;
const migrationSql = MIGRATION_FILE ? read(path.join(MIGRATIONS_DIR, MIGRATION_FILE)) : '';
const rollbackPath = path.join(ROLLBACKS_DIR, ROLLBACK_FILE);
const rollbackSql = fs.existsSync(rollbackPath) ? read(rollbackPath) : '';

function listSourceFiles(dir: string): string[] {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return [];
  const out: string[] = [];
  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      const rel = path.relative(ROOT, full);
      if (entry.isDirectory()) {
        if (!SKIPPED_DIR.test(rel)) walk(full);
      } else if (SOURCE_FILE.test(entry.name) && !TEST_FILE.test(entry.name) && !GENERATED_TYPES.test(entry.name)) {
        out.push(rel);
      }
    }
  };
  walk(abs);
  return out;
}

describe('#2178 Y3-b recipe_collections の一意の索引 (user_id, name) の migration と戻し口', () => {
  it('C-1: migration はちょうど 1 本で、見出し・戻し方・戻し口の見出しがファイル名と一致し、番号は直前の最大より大きい', () => {
    expect(ownMigrations).toHaveLength(1);
    const version = MIGRATION_FILE.slice(0, VERSION_LENGTH);
    expect(version).toMatch(/^\d{14}$/);
    expect(version > PRECEDING_MIGRATION_VERSION).toBe(true);
    const lines = migrationSql.split('\n');
    expect(lines[0]).toBe(`-- migration: ${MIGRATION_FILE}`);
    expect(lines[1]).toBe(`-- 戻し方: supabase/rollbacks/${ROLLBACK_FILE}`);
    expect(fs.existsSync(rollbackPath)).toBe(true);
    expect(rollbackSql.split('\n')[0]).toBe(`-- rollback: ${MIGRATION_FILE}`);
  });

  it('C-2: migration の文は lock_timeout と CREATE UNIQUE INDEX IF NOT EXISTS の 2 文だけ (追加だけ)', () => {
    expect(sqlStatementsOf(migrationSql)).toEqual([MIGRATION_LOCK_TIMEOUT_STATEMENT, CREATE_UNIQUE_INDEX_STATEMENT]);
    const body = stripSqlComments(migrationSql);
    for (const forbidden of [/\bGRANT\b/i, /\bREVOKE\b/i, /\bALTER\s+TABLE\b/i, /\bCREATE\s+POLICY\b/i, /\bINSERT\b/i, /\bUPDATE\b/i, /\bDELETE\b/i, /\bDROP\b/i]) {
      expect(body, String(forbidden)).not.toMatch(forbidden);
    }
  });

  it('C-3: 索引の名前と列はアプリの onConflict の定数と同じで、部分索引にしない', () => {
    const indexPattern = new RegExp(
      String.raw`CREATE\s+UNIQUE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+(\w+)\s+ON\s+public\.${escapeRegExp(RECIPE_COLLECTIONS_TABLE)}\s*\(([^)]*)\)\s*(WHERE\b[^;]*)?;`,
      'i',
    );
    const match = stripSqlComments(migrationSql).match(indexPattern);
    expect(match, 'CREATE UNIQUE INDEX の文が見つからない').not.toBeNull();
    const [, indexName, columnList, whereClause] = match ?? [];
    expect(indexName).toBe(RECIPE_COLLECTIONS_USER_NAME_UNIQUE_INDEX);
    const columns = (columnList ?? '').split(',').map((c) => c.trim());
    expect(columns).toEqual([...RECIPE_COLLECTIONS_USER_NAME_UNIQUE_COLUMNS]);
    expect(columns.join(',')).toBe(RECIPE_COLLECTIONS_USER_NAME_CONFLICT_TARGET);
    expect(whereClause).toBeUndefined();
  });

  it('C-4: 戻し口の文は lock_timeout と DROP INDEX IF EXISTS の 2 文だけで、GRANT を書かない', () => {
    expect(sqlStatementsOf(rollbackSql)).toEqual([MIGRATION_LOCK_TIMEOUT_STATEMENT, DROP_UNIQUE_INDEX_STATEMENT]);
    expect(stripSqlComments(rollbackSql)).not.toMatch(/\bGRANT\b/i);
  });

  it('C-5: ほかの migration は、この索引の名前を作らない・消さない', () => {
    const namePattern = new RegExp(String.raw`\b${escapeRegExp(RECIPE_COLLECTIONS_USER_NAME_UNIQUE_INDEX)}\b`);
    const others = migrationFiles
      .filter((f) => f !== MIGRATION_FILE)
      .filter((f) => namePattern.test(stripSqlComments(read(path.join(MIGRATIONS_DIR, f)))));
    expect(others).toEqual([]);
  });

  it('C-6: アプリのコードは recipe_collections を insert で作らず、作る所は onConflict = 索引の列の upsert だけ', () => {
    const files = WRITER_DIRS.flatMap(listSourceFiles);
    // 走査が壊れて素通りしない番兵: executor は必ず走査の対象に入る
    expect(files).toContain(path.relative(ROOT, EXECUTOR));
    const tableFrom = String.raw`from\(\s*['"]${escapeRegExp(RECIPE_COLLECTIONS_TABLE)}['"]\s*\)`;
    const insertPattern = new RegExp(String.raw`${tableFrom}\s*\.insert\(`);
    const upsertPattern = new RegExp(String.raw`${tableFrom}\s*\.upsert\(`, 'g');
    const inserting = files.filter((f) => insertPattern.test(read(path.join(ROOT, f))));
    expect(inserting).toEqual([]);
    const upserting = files.filter((f) => read(path.join(ROOT, f)).match(upsertPattern));
    expect(upserting).toEqual([path.relative(ROOT, EXECUTOR)]);
    const executor = read(EXECUTOR);
    expect(executor.match(upsertPattern)).toHaveLength(1);
    const upsertCall = executor.slice(executor.search(new RegExp(String.raw`${tableFrom}\s*\.upsert\(`)));
    const callEnd = upsertCall.indexOf('.select(');
    expect(callEnd).toBeGreaterThan(0);
    expect(upsertCall.slice(0, callEnd)).toMatch(/\{\s*onConflict:\s*RECIPE_COLLECTIONS_USER_NAME_CONFLICT_TARGET\s*\}/);
    expect(executor).toMatch(/import \{ RECIPE_COLLECTIONS_USER_NAME_CONFLICT_TARGET \} from '@\/lib\/recipes\/collections';/);
  });
});
