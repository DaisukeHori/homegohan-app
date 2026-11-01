// @vitest-environment node
/**
 * #2183 Z3: レシピのコレクションにレシピを 1 つ足す関数 append_recipe_to_collection を足す migration
 * (*_recipe_collections_append_recipe_rpc.sql) と戻し口の contract テスト (DB には接続しない)。
 *
 * 本物の DB での振る舞い (同時に 2 本足しても両方残る・本人の行だけ・権限・戻し口) は
 * tests/integration/rls/recipe-collections-append-recipe-rpc.test.ts が確かめる。ここでは文面だけで崩れやすい所を確かめる。
 *   C-1 migration はちょうど 1 本。1 行目の見出しと 2 行目の「戻し方」がファイル名と一致し、戻し口が実在して、その 1 行目が対の
 *       migration を指す。番号は直前に main にあった最大より大きい
 *   C-2 関数の外の文は lock_timeout・COMMENT ON FUNCTION・REVOKE・GRANT だけ (追加だけ。表・ポリシー・行に触れない)
 *   C-3 関数の見出し: 名前と引数はアプリの定数と同じ。RETURNS text・LANGUAGE sql・STRICT・SECURITY INVOKER (DEFINER でない)・
 *       search_path を空に固定
 *   C-4 関数の本文は 1 文。recipe_collections への UPDATE はちょうど 1 つで、array_append と「まだ入っていないとき」の条件を
 *       同じ文に持つ。返す値はアプリの結果の定数と同じ 3 つで、already_present / not_found の判定は本人の行 (auth.uid()) に絞る
 *   C-5 EXECUTE は authenticated だけ (PUBLIC・anon・service_role から外す)
 *   C-6 戻し口の文は lock_timeout と DROP FUNCTION IF EXISTS の 2 文だけで、GRANT を書かない
 *   C-7 ほかの migration は、この関数の名前を作らない・消さない
 *   C-8 アプリのコードは recipe_collections の recipe_ids を update で書かない (読んでから書く形を戻さない)。
 *       executor は関数を定数の名前と引数の名前で 1 回だけ呼ぶ
 *   C-9 型の生成物 (src/types と packages/shared の database.types.ts) の Functions に、関数が同じ引数と戻り値の型で出ている
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  RECIPE_COLLECTION_APPEND_OUTCOME,
  RECIPE_COLLECTIONS_APPEND_RECIPE_RPC,
  RECIPE_COLLECTIONS_APPEND_RECIPE_RPC_ARGS,
} from '@/lib/recipes/collection-append';
import {
  APPEND_RECIPE_RPC_DROP_STATEMENT,
  APPEND_RECIPE_RPC_GRANT_STATEMENT,
  APPEND_RECIPE_RPC_PARAMS,
  APPEND_RECIPE_RPC_QUALIFIED,
  APPEND_RECIPE_RPC_REVOKE_STATEMENT,
  PRECEDING_MIGRATION_VERSION,
  RECIPE_COLLECTIONS_APPEND_RECIPE_RPC_MIGRATION_NAME,
} from './helpers/recipe-collections-append-recipe-rpc';
import {
  MIGRATION_LOCK_TIMEOUT_STATEMENT,
  RECIPE_COLLECTIONS_TABLE,
  sqlStatementsOf,
  stripSqlComments,
} from './helpers/recipe-collections-user-name-unique';

const ROOT = path.resolve(__dirname, '..');
const MIGRATIONS_DIR = path.join(ROOT, 'supabase', 'migrations');
const ROLLBACKS_DIR = path.join(ROOT, 'supabase', 'rollbacks');
const EXECUTOR = path.join(ROOT, 'src', 'lib', 'ai', 'consultation-action-executor.ts');
const TYPE_FILES = ['src/types/database.types.ts', 'packages/shared/src/database.types.ts'] as const;
/** 版の番号 = YYYYMMDDHHMMSS の 14 桁 (tests/migration-file-version-integrity.test.ts と同じ形) */
const VERSION_LENGTH = 14;
/** recipe_collections を書くアプリのコードを探すディレクトリ (運営の画面・Edge Function・モバイルを含む) */
const WRITER_DIRS = ['src', 'lib', 'apps', 'packages', 'supabase/functions', 'components'] as const;
/** 走査の対象 (型の生成物とテストと node_modules は除く) */
const SOURCE_FILE = /\.(?:ts|tsx)$/;
const SKIPPED_DIR = /(?:^|\/)(?:node_modules|\.next|dist|__tests__|tests)(?:\/|$)/;
const TEST_FILE = /\.(?:test|spec)\.tsx?$/;
const GENERATED_TYPES = /database\.types\.ts$/;
/** CREATE FUNCTION の文 (見出し・本文・終わりの ;) を切り出す */
const FUNCTION_STATEMENT = /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+([\s\S]*?)\bAS\s+\$\$([\s\S]*?)\$\$\s*;/i;
/** 関数の文を、外の文の並びの中で置き換える目印 */
const FUNCTION_PLACEHOLDER = 'CREATE FUNCTION <本文>;';

const read = (file: string): string => fs.readFileSync(file, 'utf-8');
const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** SQL の '...' の文字列を空にする (COMMENT の文の中の語を、文の検査で拾わないため) */
const blankSqlStrings = (sql: string): string => sql.replace(/'(?:[^']|'')*'/g, "''");
const collapse = (text: string): string => text.replace(/\s+/g, ' ').trim();

const migrationFiles = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
const ownMigrations = migrationFiles.filter((f) => f.endsWith(`_${RECIPE_COLLECTIONS_APPEND_RECIPE_RPC_MIGRATION_NAME}.sql`));
const MIGRATION_FILE = ownMigrations[0] ?? '';
const MIGRATION_STEM = MIGRATION_FILE.replace(/\.sql$/, '');
const ROLLBACK_FILE = `${MIGRATION_STEM}.down.sql`;
const migrationSql = MIGRATION_FILE ? read(path.join(MIGRATIONS_DIR, MIGRATION_FILE)) : '';
const rollbackPath = path.join(ROLLBACKS_DIR, ROLLBACK_FILE);
const rollbackSql = fs.existsSync(rollbackPath) ? read(rollbackPath) : '';
const migrationBody = stripSqlComments(migrationSql);
const functionMatch = migrationBody.match(FUNCTION_STATEMENT);
const functionHeader = collapse(functionMatch?.[1] ?? '');
const functionBody = functionMatch?.[2] ?? '';

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

describe('#2183 Z3 append_recipe_to_collection の migration と戻し口', () => {
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

  it('C-2: 関数の外の文は lock_timeout・COMMENT ON FUNCTION・REVOKE・GRANT だけ (表・ポリシー・行に触れない)', () => {
    expect(functionMatch, 'CREATE OR REPLACE FUNCTION の文が見つからない').not.toBeNull();
    const outside = migrationBody.replace(FUNCTION_STATEMENT, FUNCTION_PLACEHOLDER);
    // COMMENT の説明文だけを空にして比べる (説明文の語は文の検査の対象にしない。説明文に ; は無い)
    const statements = sqlStatementsOf(outside).map((s) => (/^COMMENT\b/i.test(s) ? blankSqlStrings(s) : s));
    expect(statements).toEqual([
      MIGRATION_LOCK_TIMEOUT_STATEMENT,
      FUNCTION_PLACEHOLDER,
      `COMMENT ON FUNCTION ${APPEND_RECIPE_RPC_QUALIFIED} IS '';`,
      APPEND_RECIPE_RPC_REVOKE_STATEMENT,
      APPEND_RECIPE_RPC_GRANT_STATEMENT,
    ]);
    for (const forbidden of [/\bALTER\s+TABLE\b/i, /\bCREATE\s+POLICY\b/i, /\bINSERT\b/i, /\bDELETE\b/i, /\bDROP\b/i, /\bTRUNCATE\b/i, /\bUPDATE\b/i]) {
      expect(blankSqlStrings(outside), String(forbidden)).not.toMatch(forbidden);
    }
  });

  it('C-3: 関数の見出しはアプリの定数の名前と引数で、RETURNS text・LANGUAGE sql・STRICT・SECURITY INVOKER・search_path は空', () => {
    expect(functionHeader.startsWith(`public.${RECIPE_COLLECTIONS_APPEND_RECIPE_RPC}(${APPEND_RECIPE_RPC_PARAMS}) `)).toBe(true);
    for (const clause of [/\bRETURNS text\b/i, /\bLANGUAGE sql\b/i, /\bSTRICT\b/i, /\bSECURITY INVOKER\b/i, /\bSET search_path = ''(?=\s|$)/i]) {
      expect(functionHeader, String(clause)).toMatch(clause);
    }
    expect(functionHeader).not.toMatch(/\bSECURITY DEFINER\b/i);
    expect(functionHeader).not.toMatch(/\bRETURNS\s+(?:SETOF|TABLE)\b/i);
  });

  it('C-4: 本文は 1 文で、recipe_collections への条件つき UPDATE は 1 つ。返す値はアプリの結果の定数と同じで、本人の行に絞る', () => {
    const body = collapse(functionBody);
    // 1 文: 終わりの ; のほかに ; が無い
    expect(body.endsWith(';')).toBe(true);
    expect(body.slice(0, -1)).not.toContain(';');
    const updates = body.match(/\bUPDATE\s+public\.(\w+)/gi) ?? [];
    expect(updates).toEqual([`UPDATE public.${RECIPE_COLLECTIONS_TABLE}`]);
    const [collectionArg, recipeArg] = RECIPE_COLLECTIONS_APPEND_RECIPE_RPC_ARGS;
    const emptyArray = String.raw`coalesce\(rc\.recipe_ids, '\{\}'::uuid\[\]\)`;
    expect(body).toMatch(new RegExp(String.raw`SET recipe_ids = array_append\(${emptyArray}, ${escapeRegExp(recipeArg)}\)`));
    expect(body).toMatch(new RegExp(String.raw`WHERE rc\.id = ${escapeRegExp(collectionArg)} AND NOT \(${escapeRegExp(recipeArg)} = ANY \(${emptyArray}\)\)`));
    const literals = [...body.matchAll(/THEN '(\w+)'|ELSE '(\w+)'/g)].map((m) => m[1] ?? m[2]);
    expect(literals.sort()).toEqual(Object.values(RECIPE_COLLECTION_APPEND_OUTCOME).sort());
    expect(body).toMatch(new RegExp(String.raw`WHERE own\.id = ${escapeRegExp(collectionArg)} AND own\.user_id = auth\.uid\(\)`));
  });

  it('C-5: EXECUTE は authenticated だけ (PUBLIC・anon・service_role から外す)', () => {
    const statements = sqlStatementsOf(migrationBody.replace(FUNCTION_STATEMENT, FUNCTION_PLACEHOLDER));
    expect(statements.filter((s) => /^REVOKE\b/i.test(s))).toEqual([APPEND_RECIPE_RPC_REVOKE_STATEMENT]);
    expect(statements.filter((s) => /^GRANT\b/i.test(s))).toEqual([APPEND_RECIPE_RPC_GRANT_STATEMENT]);
  });

  it('C-6: 戻し口の文は lock_timeout と DROP FUNCTION IF EXISTS の 2 文だけで、GRANT を書かない', () => {
    expect(sqlStatementsOf(rollbackSql)).toEqual([MIGRATION_LOCK_TIMEOUT_STATEMENT, APPEND_RECIPE_RPC_DROP_STATEMENT]);
    expect(stripSqlComments(rollbackSql)).not.toMatch(/\bGRANT\b/i);
  });

  it('C-7: ほかの migration は、この関数の名前を作らない・消さない', () => {
    const namePattern = new RegExp(String.raw`\b${escapeRegExp(RECIPE_COLLECTIONS_APPEND_RECIPE_RPC)}\b`);
    const others = migrationFiles
      .filter((f) => f !== MIGRATION_FILE)
      .filter((f) => namePattern.test(stripSqlComments(read(path.join(MIGRATIONS_DIR, f)))));
    expect(others).toEqual([]);
  });

  it('C-8: アプリのコードは recipe_ids を update で書かず、executor は関数を定数の名前と引数の名前で 1 回だけ呼ぶ', () => {
    const files = WRITER_DIRS.flatMap(listSourceFiles);
    // 走査が壊れて素通りしない番兵: executor は必ず走査の対象に入る
    expect(files).toContain(path.relative(ROOT, EXECUTOR));
    const tableFrom = String.raw`from\(\s*['"]${escapeRegExp(RECIPE_COLLECTIONS_TABLE)}['"]\s*\)`;
    const updatePattern = new RegExp(String.raw`${tableFrom}\s*\.update\(`);
    const recipeIdsWrite = /\.update\(\s*\{[^}]*\brecipe_ids\s*:/;
    expect(files.filter((f) => updatePattern.test(read(path.join(ROOT, f))))).toEqual([]);
    expect(files.filter((f) => recipeIdsWrite.test(read(path.join(ROOT, f))))).toEqual([]);
    const executor = read(EXECUTOR);
    // 読み直し (recipe_ids を select する問い合わせ) もしない
    expect(executor).not.toMatch(new RegExp(String.raw`${tableFrom}\s*\.select\(\s*['"]recipe_ids['"]\s*\)`));
    const [collectionArg, recipeArg] = RECIPE_COLLECTIONS_APPEND_RECIPE_RPC_ARGS;
    const rpcCall = new RegExp(
      String.raw`\.rpc\(RECIPE_COLLECTIONS_APPEND_RECIPE_RPC,\s*\{\s*${collectionArg}:\s*collection\.id,\s*${recipeArg}:\s*recipeId,?\s*\}\)`,
      'g',
    );
    expect(executor.match(rpcCall)).toHaveLength(1);
    expect(executor).toMatch(/from '@\/lib\/recipes\/collection-append';/);
  });

  it('C-9: 型の生成物の Functions に、同じ引数と戻り値の型で出ている (2 つのファイルとも)', () => {
    const [collectionArg, recipeArg] = RECIPE_COLLECTIONS_APPEND_RECIPE_RPC_ARGS;
    const entry = new RegExp(
      String.raw`\n      ${RECIPE_COLLECTIONS_APPEND_RECIPE_RPC}: \{\n        Args: \{ ${collectionArg}: string; ${recipeArg}: string \}\n        Returns: string\n      \}\n`,
    );
    for (const file of TYPE_FILES) {
      expect(read(path.join(ROOT, file)), file).toMatch(entry);
    }
  });
});
