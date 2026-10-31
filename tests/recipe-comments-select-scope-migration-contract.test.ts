// @vitest-environment node
/**
 * cross/25 (#2166 X1): recipe_comments の SELECT のポリシーを「そのレシピを読める人」と「書いた本人」に絞る migration
 * (*_recipe_comments_select_scope.sql) と戻し口の contract テスト (DB には接続しない)。
 * 設計: docs/design/cross/25-recipe-comments-select-scope.md §7.1〜§7.4
 *
 * 本物の DB での振る舞い (他人に 0 行・本人と作者に見える・公開は今どおり・戻し口) は
 * tests/integration/rls/recipe-comments-select-scope.test.ts が確かめる。ここでは文面だけで崩れやすい所を確かめる。
 *   C-1 migration はちょうど 1 本。1 行目の見出しと 2 行目の「戻し方」がファイル名と一致し、戻し口が実在して、その 1 行目が対の migration を指す
 *       (tests/migration-file-version-integrity.test.ts の決まり)。番号は本番のベースラインより大きい
 *   C-2 migration の文 (コメントを除く) は、lock_timeout・旧ポリシーの DROP IF EXISTS・新ポリシーの DROP IF EXISTS・CREATE POLICY の 4 文だけ。
 *       GRANT / REVOKE / ALTER TABLE / CREATE FUNCTION / INSERT / UPDATE / DELETE を書かない
 *   C-3 migration を番号順に流した後の recipe_comments のポリシーは、新しい SELECT 1 本と、変えない INSERT / UPDATE / DELETE の 3 本。
 *       本冊の直前は旧 SELECT 1 本と同じ 3 本 (番兵: 読み取りが旧ポリシーを拾っている)
 *   C-4 CREATE POLICY の文は正典の 1 行と逐語で同じ (FOR SELECT・TO authenticated・USING の式。WITH CHECK 無し)
 *   C-5 戻し口の文は、lock_timeout・新ポリシーの DROP・旧ポリシーの DROP・旧ポリシーの CREATE の 4 文だけで、CREATE はベースラインの
 *       定義 (引用符を外した形) と逐語で同じ。GRANT を書かない
 *   C-6 判定の土台: recipes の SELECT のポリシーに最後に効く文は 20261009000500 の ALTER POLICY で、USING の式が正典と同じ
 *       (recipes 側を変える migration が入ったら、ここが赤になり、コメントの見え方の再検討を求める)
 *   C-7 RLS の上の読み手の閉包: アプリのコードで recipe_comments に触れるファイルは決まった 4 本だけ (運営の画面・Edge・モバイルに無い)
 *   C-8 src/lib/account-export-tables.ts の recipe_comments は self('user_id') のままで、「誰でも閲覧可」の古い注が無い
 *   C-9 設計書 cross/25 の migration のファイル名の番号は、すべて置き場か、すべて実在する番号 (混ざっていない)
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { collectMigrationNameMentions, findMigrationNumberProblems } from './helpers/design-doc-migration-number';
import {
  BASELINE_MIGRATION,
  MIGRATION_LOCK_TIMEOUT_STATEMENT,
  RECIPE_COMMENTS_LEGACY_SELECT_POLICY,
  RECIPE_COMMENTS_LEGACY_SELECT_POLICY_STATEMENT,
  RECIPE_COMMENTS_OTHER_POLICIES,
  RECIPE_COMMENTS_SELECT_POLICY,
  RECIPE_COMMENTS_SELECT_POLICY_STATEMENT,
  RECIPE_COMMENTS_SELECT_SCOPE_MIGRATION_NAME,
  RECIPE_COMMENTS_TABLE,
  RECIPES_PUBLIC_SELECT_MIGRATION,
  RECIPES_PUBLIC_SELECT_POLICY,
  RECIPES_PUBLIC_SELECT_USING,
  escapeRegExp,
  foldSql,
  unquoteIdentifiers,
} from './helpers/recipe-comments-select-scope';

const ROOT = path.resolve(__dirname, '..');
const MIGRATIONS_DIR = path.join(ROOT, 'supabase', 'migrations');
const ROLLBACKS_DIR = path.join(ROOT, 'supabase', 'rollbacks');
const DESIGN_DOC = path.join(ROOT, 'docs', 'design', 'cross', '25-recipe-comments-select-scope.md');
const EXPORT_TABLES = path.join(ROOT, 'src', 'lib', 'account-export-tables.ts');
/** 版の番号 = YYYYMMDDHHMMSS の 14 桁 (tests/migration-file-version-integrity.test.ts と同じ形) */
const VERSION_LENGTH = 14;
/** RLS の上で recipe_comments に触れるアプリのコード (リポジトリの根からの相対。設計書 §3.2 E-1〜E-5) */
const EXPECTED_READERS = [
  'src/app/api/recipes/[id]/comments/route.ts',
  'src/app/api/recipes/[id]/route.ts',
  'src/lib/account-export-tables.ts',
  'src/lib/api/list-order.ts',
] as const;
/** 読み手を探すディレクトリ (運営の画面・Edge Function・モバイルを含む) */
const READER_DIRS = ['src', 'lib', 'apps', 'packages', 'supabase/functions', 'components'] as const;
/** 読み手の走査の対象 (型の生成物とテストは除く) */
const READER_FILE = /\.(?:ts|tsx)$/;
const GENERATED_TYPES = /database\.types\.ts$/;
const TEST_FILE = /(?:^|\/)(?:__tests__|tests)\/|\.(?:test|spec)\.tsx?$/;
/** 書き出しの表の行 (設計書 §7.6。注の古い文が無いこと) */
const EXPORT_SPEC_LINE = "{ table: 'recipe_comments', scope: self('user_id') }";
const STALE_EXPORT_NOTE = '誰でも閲覧可';

/** SQL の行コメント (-- ...) を取り除く */
const stripSqlComments = (sql: string): string => sql.replace(/--.*$/gm, '');
/** TS の行コメント (行頭か空白のあとの //) とブロックコメントを取り除く (文字列の中の // は壊れうるが、語の検出には足りる) */
const stripTsComments = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
/** SQL を文 (; で終わる) に分け、空白を畳む */
const statementsOf = (sql: string): string[] =>
  stripSqlComments(sql)
    .split(';')
    .map((s) => foldSql(s))
    .filter((s) => s.length > 0)
    .map((s) => `${s};`);
const read = (file: string): string => fs.readFileSync(file, 'utf-8');

const migrationFiles = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
const ownMigrations = migrationFiles.filter((f) => f.endsWith(`_${RECIPE_COMMENTS_SELECT_SCOPE_MIGRATION_NAME}.sql`));
const MIGRATION_FILE = ownMigrations[0] ?? '';
const MIGRATION_STEM = MIGRATION_FILE.replace(/\.sql$/, '');
const ROLLBACK_FILE = `${MIGRATION_STEM}.down.sql`;
const migrationSql = MIGRATION_FILE ? read(path.join(MIGRATIONS_DIR, MIGRATION_FILE)) : '';
const rollbackPath = path.join(ROLLBACKS_DIR, ROLLBACK_FILE);
const rollbackSql = fs.existsSync(rollbackPath) ? read(rollbackPath) : '';
const migrations = migrationFiles.map((file) => ({ file, sql: stripSqlComments(read(path.join(MIGRATIONS_DIR, file))) }));
const migrationIndex = migrations.findIndex(({ file }) => file === MIGRATION_FILE);

const tableRef = (table: string) => String.raw`(?:"?public"?\.)?"?${table}"?(?=[\s;])`;
const POLICY_NAME = String.raw`(?:"([^"]+)"|([A-Za-z_][\w]*))`;

/** 表 table のポリシー (名前 → 種類) を、migration を書かれた順に流して求める (CREATE / DROP / ALTER ... RENAME) */
function policiesAfter(table: string, files: ReadonlyArray<{ sql: string }>): Map<string, string> {
  const state = new Map<string, string>();
  const ref = tableRef(table);
  const createPolicy = new RegExp(String.raw`CREATE\s+POLICY\s+${POLICY_NAME}\s+ON\s+${ref}\s*(?:AS\s+\w+\s+)?(?:FOR\s+(ALL|SELECT|INSERT|UPDATE|DELETE))?`, 'gi');
  const dropPolicy = new RegExp(String.raw`DROP\s+POLICY\s+(?:IF\s+EXISTS\s+)?${POLICY_NAME}\s+ON\s+${ref}`, 'gi');
  const renamePolicy = new RegExp(String.raw`ALTER\s+POLICY\s+${POLICY_NAME}\s+ON\s+${ref}\s+RENAME\s+TO\s+${POLICY_NAME}`, 'gi');
  for (const { sql } of files) {
    const events: Array<{ at: number; apply: () => void }> = [];
    for (const m of sql.matchAll(createPolicy)) {
      const name = m[1] ?? m[2];
      const command = (m[3] ?? 'ALL').toUpperCase();
      events.push({ at: m.index ?? 0, apply: () => state.set(name, command) });
    }
    for (const m of sql.matchAll(dropPolicy)) {
      const name = m[1] ?? m[2];
      events.push({ at: m.index ?? 0, apply: () => state.delete(name) });
    }
    for (const m of sql.matchAll(renamePolicy)) {
      const from = m[1] ?? m[2];
      const to = m[3] ?? m[4];
      events.push({
        at: m.index ?? 0,
        apply: () => {
          const command = state.get(from);
          if (command !== undefined) {
            state.delete(from);
            state.set(to, command);
          }
        },
      });
    }
    for (const event of events.sort((a, b) => a.at - b.at)) event.apply();
  }
  return state;
}

const sortedEntries = (m: ReadonlyMap<string, string>) => [...m.entries()].sort(([a], [b]) => a.localeCompare(b));
const expectedFinal = sortedEntries(new Map<string, string>([...RECIPE_COMMENTS_OTHER_POLICIES, [RECIPE_COMMENTS_SELECT_POLICY, 'SELECT']]));
const expectedBefore = sortedEntries(new Map<string, string>([...RECIPE_COMMENTS_OTHER_POLICIES, [RECIPE_COMMENTS_LEGACY_SELECT_POLICY, 'SELECT']]));

/** ディレクトリ以下の TS ファイルを再帰で (リポジトリの根からの相対。区切りは /) */
function listTsFiles(dir: string): string[] {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.next' || entry.name === 'dist') continue;
      out.push(...listTsFiles(rel));
    } else if (READER_FILE.test(entry.name)) {
      out.push(rel);
    }
  }
  return out;
}

describe('C-1: migration と戻し口の対', () => {
  it('migration はちょうど 1 本で、番号は本番のベースラインより大きい', () => {
    expect(ownMigrations).toHaveLength(1);
    expect(MIGRATION_FILE.slice(0, VERSION_LENGTH) > BASELINE_MIGRATION.slice(0, VERSION_LENGTH)).toBe(true);
  });

  it('1 行目の見出しと 2 行目の「戻し方」がファイル名を指し、戻し口が実在して 1 行目が対の migration を指す', () => {
    const [first, second] = migrationSql.split('\n');
    expect(first).toBe(`-- migration: ${MIGRATION_FILE}`);
    expect(second).toBe(`-- 戻し方: supabase/rollbacks/${ROLLBACK_FILE}`);
    expect(fs.existsSync(rollbackPath), `${ROLLBACK_FILE} が無い`).toBe(true);
    expect(rollbackSql.split('\n')[0]).toBe(`-- rollback: ${MIGRATION_FILE}`);
  });
});

describe('C-2 / C-4: migration の文', () => {
  it('C-2: lock_timeout・旧ポリシーの DROP IF EXISTS・新ポリシーの DROP IF EXISTS・CREATE POLICY の 4 文だけ', () => {
    expect(statementsOf(migrationSql)).toEqual([
      MIGRATION_LOCK_TIMEOUT_STATEMENT,
      `DROP POLICY IF EXISTS "${RECIPE_COMMENTS_LEGACY_SELECT_POLICY}" ON public.${RECIPE_COMMENTS_TABLE};`,
      `DROP POLICY IF EXISTS ${RECIPE_COMMENTS_SELECT_POLICY} ON public.${RECIPE_COMMENTS_TABLE};`,
      foldSql(RECIPE_COMMENTS_SELECT_POLICY_STATEMENT),
    ]);
    expect(stripSqlComments(migrationSql)).not.toMatch(/\b(GRANT|REVOKE|ALTER\s+TABLE|CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION|INSERT\s+INTO|UPDATE\s+public|DELETE\s+FROM)\b/i);
  });

  it('C-4: CREATE POLICY の文は正典の 1 行と逐語で同じ (FOR SELECT・TO authenticated・USING の式・WITH CHECK 無し)', () => {
    const lines = stripSqlComments(migrationSql).split('\n').filter((l) => l.startsWith(`CREATE POLICY ${RECIPE_COMMENTS_SELECT_POLICY} ON public.${RECIPE_COMMENTS_TABLE} `));
    expect(lines).toEqual([RECIPE_COMMENTS_SELECT_POLICY_STATEMENT]);
    expect(lines[0]).toContain(' FOR SELECT TO authenticated USING ');
    expect(lines[0]).not.toMatch(/WITH\s+CHECK/i);
  });
});

describe('C-3: migration を番号順に流した後の recipe_comments のポリシー', () => {
  it('新しい SELECT 1 本と、変えない INSERT / UPDATE / DELETE の 3 本', () => {
    expect(sortedEntries(policiesAfter(RECIPE_COMMENTS_TABLE, migrations))).toEqual(expectedFinal);
  });

  it('番兵: 本冊の直前は旧 SELECT 1 本と同じ 3 本 (読み取りが旧ポリシーを拾っている)', () => {
    expect(migrationIndex, `${MIGRATION_FILE} が supabase/migrations に無い`).toBeGreaterThan(0);
    expect(sortedEntries(policiesAfter(RECIPE_COMMENTS_TABLE, migrations.slice(0, migrationIndex)))).toEqual(expectedBefore);
  });
});

describe('C-5: 戻し口', () => {
  it('lock_timeout・新ポリシーの DROP・旧ポリシーの DROP・旧ポリシーの CREATE の 4 文だけで、GRANT を書かない', () => {
    expect(statementsOf(rollbackSql)).toEqual([
      MIGRATION_LOCK_TIMEOUT_STATEMENT,
      `DROP POLICY IF EXISTS ${RECIPE_COMMENTS_SELECT_POLICY} ON public.${RECIPE_COMMENTS_TABLE};`,
      `DROP POLICY IF EXISTS "${RECIPE_COMMENTS_LEGACY_SELECT_POLICY}" ON public.${RECIPE_COMMENTS_TABLE};`,
      foldSql(RECIPE_COMMENTS_LEGACY_SELECT_POLICY_STATEMENT),
    ]);
    expect(stripSqlComments(rollbackSql)).not.toMatch(/\bGRANT\b/i);
  });

  it('旧ポリシーの CREATE は本番のベースラインの定義と逐語で同じ (引用符を外した形で比べる)', () => {
    const baseline = stripSqlComments(read(path.join(MIGRATIONS_DIR, BASELINE_MIGRATION)))
      .split('\n')
      .filter((l) => new RegExp(String.raw`^CREATE POLICY "${escapeRegExp(RECIPE_COMMENTS_LEGACY_SELECT_POLICY)}" ON `).test(l));
    expect(baseline).toHaveLength(1);
    expect(unquoteIdentifiers(foldSql(baseline[0]))).toBe(unquoteIdentifiers(foldSql(RECIPE_COMMENTS_LEGACY_SELECT_POLICY_STATEMENT)));
    // 戻し口が流した後は、本冊の直前と同じポリシーの集合になる
    expect(sortedEntries(policiesAfter(RECIPE_COMMENTS_TABLE, [...migrations, { sql: stripSqlComments(rollbackSql) }]))).toEqual(expectedBefore);
  });
});

describe('C-6: 判定の土台 (recipes の SELECT のポリシー)', () => {
  it('recipes の SELECT のポリシーに最後に効く文は 20261009000500 の ALTER POLICY で、USING の式が正典と同じ', () => {
    const touches = migrations.flatMap(({ file, sql }) =>
      [...sql.matchAll(new RegExp(String.raw`\b(CREATE|ALTER|DROP)\s+POLICY\s+(?:IF\s+EXISTS\s+)?"${escapeRegExp(RECIPES_PUBLIC_SELECT_POLICY)}"\s+ON\s+${tableRef('recipes')}[^;]*;`, 'gi'))].map((m) => ({ file, statement: foldSql(m[0]) })),
    );
    expect(touches.length).toBeGreaterThanOrEqual(2);
    const last = touches[touches.length - 1];
    expect(last.file).toBe(RECIPES_PUBLIC_SELECT_MIGRATION);
    const using = /\bUSING\s+(\(.*\))\s*;$/.exec(last.statement)?.[1] ?? '';
    expect(foldSql(using)).toBe(RECIPES_PUBLIC_SELECT_USING);
  });
});

describe('C-7 / C-8: RLS の上の読み手の閉包と書き出しの注', () => {
  it('C-7: アプリのコードで recipe_comments に触れるのは決まった 4 本だけ (運営の画面・Edge・モバイルに無い)', () => {
    const readers = READER_DIRS.flatMap(listTsFiles)
      .filter((file) => !GENERATED_TYPES.test(file) && !TEST_FILE.test(file))
      .filter((file) => stripTsComments(read(path.join(ROOT, file))).includes(RECIPE_COMMENTS_TABLE))
      .sort();
    expect(readers).toEqual([...EXPECTED_READERS].sort());
  });

  it('C-8: 書き出しの recipe_comments は self(user_id) のままで、「誰でも閲覧可」の古い注が無い', () => {
    const text = read(EXPORT_TABLES);
    expect(text).toContain(EXPORT_SPEC_LINE);
    expect(text).not.toContain(STALE_EXPORT_NOTE);
  });
});

describe('C-9: 設計書 cross/25 の migration の番号', () => {
  it('すべて置き場か、すべて実在する番号 (混ざっていない)', () => {
    const mentions = collectMigrationNameMentions(read(DESIGN_DOC), RECIPE_COMMENTS_SELECT_SCOPE_MIGRATION_NAME);
    expect(mentions.length).toBeGreaterThan(0);
    expect(findMigrationNumberProblems(mentions, MIGRATION_FILE.slice(0, VERSION_LENGTH))).toEqual([]);
  });
});
