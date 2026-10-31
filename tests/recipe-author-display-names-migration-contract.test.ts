// @vitest-environment node
/**
 * cross/21 (#1917 の続き): migration *_recipe_author_display_names.sql (と、その戻し口) と、それを呼ぶ TS・許可一覧・型の突き合わせ (DB は使わない)
 *
 * 本物の DB での振る舞い (他人の表示名が返る・返らない人・anon が呼べる・user_profiles の RLS が変わっていない) は
 * tests/integration/security/recipe-author-display-names.test.ts が確かめる。ここでは、ファイルの文面だけで崩れやすい所を確かめる。
 *   C-1 migration はちょうど 1 本。1 行目の見出しと「戻し方」の参照がファイル名と一致し、戻し口が実在して、その 1 行目の見出しが対の migration のファイル名を指す
 *       (tests/migration-file-version-integrity.test.ts の決まり。戻し口の見出しに .down.sql を書かない)
 *   C-2 列 show_recipe_author_name は boolean NOT NULL DEFAULT true。特権列ガードの関数を作り直していない
 *   C-3 関数は SECURITY DEFINER・STABLE・search_path が空・RETURNS TABLE (author_id uuid, display_name text)
 *   C-4 年齢の境の定数が @homegohan/shared の ADULT_AGE_YEARS と同じ。age_years_jst と normalize_profile_name を呼び、どちらも作り直していない
 *   C-5 凍結中の判定が isAccountFrozen と同じ形 (frozen_at IS NULL OR (unban_at IS NOT NULL AND unban_at <= now()))
 *   C-6 権限: 完全形で PUBLIC / anon / authenticated / service_role から REVOKE し、anon と authenticated にだけ GRANT EXECUTE。TRUNCATE / ALL を付けない
 *   C-7 戻し口は関数 → 索引 → 列 の順に消し、GRANT を書かない
 *   C-8 viewer-lookups.ts の RECIPE_AUTHOR_DISPLAY_NAMES_RPC が関数の名前と同じで、user_profiles を直接 select していない (段 B の PR で足す)
 *   C-9 anon の許可一覧に関数の完全形がある。2 つの database.types.ts に関数と列が入っている
 *   C-10 同意の条件 (K-同意) がある。「作者名の表示を書く前の版」の一覧 c_privacy_versions_without_author_name は、旧版の控え
 *        (docs/legal/archive/<版>/privacy.md) といまの版 (LEGAL_DOCUMENTS.privacy_policy.version の src/lib/legal/privacy-text.ts) のうち、
 *        作者名の表示の文を持たない版をすべて含み、持つ版を含まない (文面が効く前でも後でも緑。版を上げる PR・控えを足す PR がずれを作ると赤)
 *
 * 段 A の PR はこのファイルを C-8 の it を除いて置き、段 B の PR (viewer-lookups.ts を差し替える PR) が C-8 の it を足す
 * (段 A の時点の viewer-lookups.ts は fix 枝の形で、まだ user_profiles を読み、RPC の定数を持たないため)。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ADULT_AGE_YEARS, LEGAL_DOCUMENTS } from '@homegohan/shared';

const ROOT = path.resolve(__dirname, '..');
const MIGRATIONS_DIR = 'supabase/migrations';
const ROLLBACKS_DIR = 'supabase/rollbacks';
const STEM_SUFFIX = '_recipe_author_display_names';
const FUNCTION_NAME = 'recipe_author_display_names';
const FUNCTION_SIGNATURE = `public.${FUNCTION_NAME}(uuid[])`;
const COLUMN_NAME = 'show_recipe_author_name';
const INDEX_NAME = 'idx_recipe_comments_user_id';
const ALLOWLIST_TEST = 'tests/integration/security/anon-definer-execute.test.ts';
const TYPE_FILES = ['src/types/database.types.ts', 'packages/shared/src/database.types.ts'] as const;
/** 旧版の控えの置き場 (cross/20 §9.1。版ごとのディレクトリの中に privacy.md) */
const LEGAL_ARCHIVE_DIR = 'docs/legal/archive';
const ARCHIVED_PRIVACY_FILE = 'privacy.md';
/** いまの版のプライバシーポリシーの本文 */
const PRIVACY_TEXT_SOURCE = 'src/lib/legal/privacy-text.ts';
/** 作者名の表示を書いた文 (cross/21 §7.12 の第9条の 1 文目) の一部。これを持つ版が「作者名の表示を書いた版」 */
const AUTHOR_NAME_PRIVACY_FRAGMENT = 'ニックネームが作者名として表示され';
/** 同意の版の形。accept_legal_documents (20261017030000) が受け付ける形と同じ (英数字・. _ - の 1〜20 文字 = 列の varchar(20)) */
const LEGAL_VERSION_FORMAT = /^[0-9A-Za-z._-]{1,20}$/;
/** 特権列ガード・年齢・名前の関数は、この migration が作り直してはいけない (ほかの契約テストの前提) */
const MUST_NOT_REDEFINE = [
  'guard_user_profiles_privileged',
  'guard_user_profiles_privileged_on_insert',
  'age_years_jst',
  'normalize_profile_name',
] as const;

const read = (relativePath: string): string => fs.readFileSync(path.join(ROOT, relativePath), 'utf-8');

function migrationFile(): string {
  const files = fs.readdirSync(path.join(ROOT, MIGRATIONS_DIR)).filter((f) => f.endsWith(`${STEM_SUFFIX}.sql`));
  expect(files, 'migration はちょうど 1 本').toHaveLength(1);
  return files[0];
}

/** SQL のコメント (-- から行末) を除き、空白を 1 つに詰める */
function normalizeSql(sql: string): string {
  return sql
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

describe('cross/21 recipe_author_display_names の migration (静的)', () => {
  const file = migrationFile();
  const stem = file.replace(/\.sql$/, '');
  const sql = read(`${MIGRATIONS_DIR}/${file}`);
  const flat = normalizeSql(sql);
  const rollbackFile = `${stem}.down.sql`;

  it('C-1: 見出し・戻し方の参照・戻し口のファイル名と見出しがそろう', () => {
    expect(sql.split('\n')[0]).toBe(`-- migration: ${file}`);
    expect(sql).toContain(`${ROLLBACKS_DIR}/${rollbackFile}`);
    const rollbackPath = path.join(ROOT, ROLLBACKS_DIR, rollbackFile);
    expect(fs.existsSync(rollbackPath), `${rollbackFile} が実在する`).toBe(true);
    // 戻し口の見出しは対の migration の名前 (<stem>.sql)。tests/migration-file-version-integrity.test.ts と同じ決まり
    expect(read(`${ROLLBACKS_DIR}/${rollbackFile}`).split('\n')[0]).toBe(`-- rollback: ${file}`);
  });

  it('C-2: 列は boolean NOT NULL DEFAULT true。特権列ガードを作り直さない', () => {
    expect(flat).toContain(
      `ALTER TABLE public.user_profiles ADD COLUMN IF NOT EXISTS ${COLUMN_NAME} boolean NOT NULL DEFAULT true;`,
    );
    for (const fn of MUST_NOT_REDEFINE) {
      expect(flat, `${fn} を作り直さない`).not.toMatch(new RegExp(`CREATE (OR REPLACE )?FUNCTION public\\.${fn}\\(`));
    }
  });

  it('C-3: 関数は SECURITY DEFINER・STABLE・search_path が空・(author_id uuid, display_name text) を返す', () => {
    expect(flat).toContain(`CREATE OR REPLACE FUNCTION ${FUNCTION_SIGNATURE.replace('(uuid[])', '(p_user_ids uuid[])')}`);
    expect(flat).toContain('RETURNS TABLE (author_id uuid, display_name text)');
    const head = flat.slice(flat.indexOf(`CREATE OR REPLACE FUNCTION public.${FUNCTION_NAME}`), flat.indexOf('AS $function$'));
    expect(head).toContain('SECURITY DEFINER');
    expect(head).toContain('STABLE');
    expect(head).toMatch(/SET search_path = ''/);
  });

  it('C-4: 年齢の境は ADULT_AGE_YEARS と同じ。age_years_jst と normalize_profile_name を呼ぶ', () => {
    expect(flat).toContain(`c_adult_age_years CONSTANT pg_catalog.int4 := ${ADULT_AGE_YEARS};`);
    expect(flat).toContain('public.age_years_jst(p.birth_date) >= c_adult_age_years');
    expect(flat).toContain('public.normalize_profile_name(p.nickname) IS NOT NULL');
    expect(flat).toContain('p.birth_date IS NOT NULL');
  });

  it('C-5: 凍結中の判定は isAccountFrozen と同じ形', () => {
    expect(flat).toContain('(p.frozen_at IS NULL OR (p.unban_at IS NOT NULL AND p.unban_at <= pg_catalog.now()))');
  });

  it('C-6: 権限は完全形で外してから anon と authenticated にだけ付ける。TRUNCATE / ALL を付けない', () => {
    expect(flat).toContain(`REVOKE ALL ON FUNCTION ${FUNCTION_SIGNATURE} FROM PUBLIC, anon, authenticated, service_role;`);
    expect(flat).toContain(`GRANT EXECUTE ON FUNCTION ${FUNCTION_SIGNATURE} TO anon, authenticated;`);
    expect(flat).not.toMatch(/GRANT (ALL|TRUNCATE)/);
    expect(flat).not.toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION ${FUNCTION_SIGNATURE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} TO [^;]*service_role`));
    expect(flat).toContain(`CREATE INDEX IF NOT EXISTS ${INDEX_NAME} ON public.recipe_comments (user_id);`);
  });

  it('C-7: 戻し口は関数 → 索引 → 列 の順に消し、GRANT を書かない', () => {
    const down = normalizeSql(read(`${ROLLBACKS_DIR}/${rollbackFile}`));
    const dropFn = down.indexOf(`DROP FUNCTION IF EXISTS ${FUNCTION_SIGNATURE};`);
    const dropIdx = down.indexOf(`DROP INDEX IF EXISTS public.${INDEX_NAME};`);
    const dropCol = down.indexOf(`ALTER TABLE public.user_profiles DROP COLUMN IF EXISTS ${COLUMN_NAME};`);
    expect(dropFn).toBeGreaterThanOrEqual(0);
    expect(dropIdx).toBeGreaterThan(dropFn);
    expect(dropCol).toBeGreaterThan(dropIdx);
    expect(down).not.toMatch(/\bGRANT\b/);
  });

  // C-8 は段 B の PR で足す (段 A の PR には置かない。§15)

  it('C-9: anon の許可一覧と 2 つの database.types.ts に関数がある。型に列がある', () => {
    expect(read(ALLOWLIST_TEST)).toContain(`'${FUNCTION_NAME}(uuid[])':`);
    for (const typeFile of TYPE_FILES) {
      const types = read(typeFile);
      expect(types, `${typeFile} に関数`).toMatch(new RegExp(`^\\s+${FUNCTION_NAME}: \\{`, 'm'));
      expect(types, `${typeFile} に列`).toMatch(new RegExp(`^\\s+${COLUMN_NAME}: boolean`, 'm'));
    }
  });

  it('C-10: 同意の条件がある。作者名の表示を書く前の版の一覧は、旧版の控えといまの版のうち作者名の表示の文を持たない版とそろう', () => {
    expect(flat).toContain(
      'p.privacy_version_accepted IS NOT NULL AND p.privacy_version_accepted::pg_catalog.text <> ALL (c_privacy_versions_without_author_name)',
    );
    const declared = /c_privacy_versions_without_author_name CONSTANT pg_catalog\.text\[\] := ARRAY\[([^\]]*)\]::pg_catalog\.text\[\];/.exec(flat);
    expect(declared, '一覧の定数がある').not.toBeNull();
    const listed = [...(declared?.[1] ?? '').matchAll(/'([^']*)'/g)].map((m) => m[1]);
    expect(listed.length, '一覧は空でない').toBeGreaterThan(0);
    for (const version of listed) expect(version, `${version} の形`).toMatch(LEGAL_VERSION_FORMAT);

    const archived = fs
      .readdirSync(path.join(ROOT, LEGAL_ARCHIVE_DIR))
      .filter((dir) => fs.existsSync(path.join(ROOT, LEGAL_ARCHIVE_DIR, dir, ARCHIVED_PRIVACY_FILE)));
    expect(archived.length, '旧版の控えがある').toBeGreaterThan(0);
    const texts: Array<readonly [string, string]> = [
      ...archived.map((dir) => [dir, read(`${LEGAL_ARCHIVE_DIR}/${dir}/${ARCHIVED_PRIVACY_FILE}`)] as const),
      [LEGAL_DOCUMENTS.privacy_policy.version, read(PRIVACY_TEXT_SOURCE)] as const,
    ];
    for (const [version, text] of texts) {
      const hasAuthorName = text.includes(AUTHOR_NAME_PRIVACY_FRAGMENT);
      expect(listed.includes(version), `${version}: 作者名の表示の文を${hasAuthorName ? '持つので一覧に入れない' : '持たないので一覧に入れる'}`).toBe(!hasAuthorName);
    }
  });
});
