/**
 * #1584 の 2: migration *_accept_copies_profile_name.sql (と、そのロールバック) のソース走査 contract テスト (DB は使わない)
 *
 * 本物の DB での振る舞い (写る・'Guest' / 空白だけ / プロフィールの行なしは写さない・子供の呼び名を上書きしない) は
 * tests/integration/security/family-accept-display-name.test.ts が確かめる。
 * ここでは、番号の付け直しや後の migration の上書き、判定の文字の集合のずれで崩れやすい所を、ファイルの文面だけで確かめる。
 *   1. accept_family_invite / accept_child_promotion を最後に定義する migration が本 migration で、1 つ前は #1310 の migration
 *   2. 本 migration の定義は、1 つ前の定義に「名前を読む SELECT」と display_name の列を足しただけ (ほかは変えていない)
 *   3. 前後の空白として除く文字の集合が、JavaScript の String.prototype.trim (= normalizeProfileName) が除く文字の集合と同じ。
 *      仮置きの文字列が PROFILE_NAME_PLACEHOLDER と同じ
 *   4. ロールバックは、1 つ前の定義にそのまま戻す
 *   5. 冒頭のコメント・「戻し方」の参照が実際のファイル名と一致する。本 migration の番号を書いたファイルが、実在する version だけを指す
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PROFILE_NAME_PLACEHOLDER } from '@homegohan/shared';

const ROOT = path.resolve(__dirname, '..');
const MIGRATIONS_DIR = 'supabase/migrations';
const ROLLBACKS_DIR = 'supabase/rollbacks';
const STEM_SUFFIX = '_accept_copies_profile_name';
/** 本 migration の 1 つ前に 2 関数を作り直した migration の名前の末尾 (#1310。家族の行を先にロックする形)。ロールバックの戻す先 */
const PREVIOUS_STEM_SUFFIX = '_family_lock_order';

/** migration のファイル名 (version 14 桁 + `_` + 名前 + `.sql`) */
const MIGRATION_FILE = /^(\d{14})_.+\.sql$/;
/** 文面に書かれた migration の version らしい 14 桁の数 (2000 年代の日時) */
const VERSION_TOKEN = /\b20\d{12}\b/g;

/** 本 migration の番号を書いているコード・テスト・文書 */
const REFERENCING_FILES = [
  'src/lib/membership/family-member-names.ts',
  'tests/integration/security/family-accept-display-name.test.ts',
  'docs/operations/family-member-display-name-backfill.md',
];

/** BMP (U+0000〜U+FFFF) の最後の符号位置。trim が除く文字はすべて BMP にある */
const LAST_BMP_CODE_POINT = 0xffff;

const FUNCTIONS = ['accept_family_invite', 'accept_child_promotion'] as const;
type FunctionName = (typeof FUNCTIONS)[number];

const definitionPattern = (fn: FunctionName): RegExp =>
  new RegExp(`CREATE\\s+OR\\s+REPLACE\\s+FUNCTION\\s+public\\.${fn}\\s*\\([\\s\\S]*?\\$\\$[\\s\\S]*?END\\s+\\$\\$;`, 'i');
const definesPattern = (fn: FunctionName): RegExp =>
  new RegExp(`CREATE\\s+OR\\s+REPLACE\\s+FUNCTION\\s+(?:"?public"?\\.)?"?${fn}"?\\s*\\(`, 'i');

const migrationFiles = fs
  .readdirSync(path.join(ROOT, MIGRATIONS_DIR))
  .filter((name) => MIGRATION_FILE.test(name))
  .sort();

const versionOf = (name: string): string => {
  const match = MIGRATION_FILE.exec(name);
  if (!match) throw new Error(`migration のファイル名ではない: ${name}`);
  return match[1];
};

const versions = new Set(migrationFiles.map(versionOf));
const ours = migrationFiles.filter((name) => name.endsWith(`${STEM_SUFFIX}.sql`));
const previous = migrationFiles.filter((name) => name.endsWith(`${PREVIOUS_STEM_SUFFIX}.sql`));

/** `--` から行末までのコメントを除く (文字列の中に `--` を書いていないファイルにだけ使う) */
function stripLineComments(sql: string): string {
  return sql
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n');
}

const read = (relative: string): string => fs.readFileSync(path.join(ROOT, relative), 'utf8');

/** 関数の定義 (CREATE OR REPLACE ... END $$;) を空白を詰めて取り出す */
function definitionOf(code: string, fn: FunctionName): string {
  const match = definitionPattern(fn).exec(code);
  if (!match) throw new Error(`${fn} の定義が無い`);
  return match[0].replace(/\s+/g, ' ').trim();
}

const ourDefinition = (fn: FunctionName): string =>
  definitionOf(stripLineComments(read(`${MIGRATIONS_DIR}/${ours[0]}`)), fn);
const previousDefinition = (fn: FunctionName): string =>
  definitionOf(stripLineComments(read(`${MIGRATIONS_DIR}/${previous[0]}`)), fn);

/** 前後の空白として除く文字の集合 (E'\uXXXX...' の形)。名前を読む SELECT と、昇格の display_name の判定の両方で使う */
const WS_LITERAL = /btrim\((?:nickname|display_name), E'((?:\\u[0-9A-F]{4})+)'\)/g;

/** E'\uXXXX\uXXXX...' の中身を符号位置の一覧にする */
function decodeEscapes(body: string): number[] {
  return [...body.matchAll(/\\u([0-9A-F]{4})/g)].map((m) => Number.parseInt(m[1], 16));
}

/** 名前を読む SELECT と 'Guest' の判定 (accept_family_invite と accept_child_promotion で同じ文面) */
const LOOKUP =
  /SELECT NULLIF\(btrim\(nickname, E'(?:\\u[0-9A-F]{4})+'\), ''\) INTO v_profile_name FROM user_profiles WHERE id = auth\.uid\(\); IF v_profile_name = '([^']*)' THEN v_profile_name := NULL; END IF; /;

describe('#1584 承諾のときにプロフィールの名前を写す migration', () => {
  it('本 migration と 1 つ前の migration はちょうど 1 本ずつあり、migration の version は重複しない', () => {
    expect(ours).toHaveLength(1);
    expect(previous).toHaveLength(1);
    expect(versions.size).toBe(migrationFiles.length);
  });

  it.each(FUNCTIONS)('%s を最後に定義する migration が本 migration で、1 つ前は #1310 の migration', (fn) => {
    const definers = migrationFiles.filter((name) =>
      definesPattern(fn).test(stripLineComments(read(`${MIGRATIONS_DIR}/${name}`))),
    );
    expect(definers.length).toBeGreaterThanOrEqual(2);
    expect(definers[definers.length - 1]).toBe(ours[0]);
    expect(definers[definers.length - 2]).toBe(previous[0]);
  });

  it('accept_family_invite は、1 つ前の定義に名前を読む SELECT と INSERT の display_name の列を足しただけ', () => {
    const now = ourDefinition('accept_family_invite');
    const before = previousDefinition('accept_family_invite');
    expect(now).toMatch(LOOKUP);
    const restored = now
      .replace(' v_profile_name TEXT;', '')
      .replace(LOOKUP, '')
      .replace('share_menu, display_name )', 'share_menu )')
      .replace('p_share_menu, v_profile_name )', 'p_share_menu )');
    expect(restored).toBe(before);
    // 名前を読むのは、メンバーの行を作る直前 (承諾の確認が全部済んでから)
    expect(now.indexOf("'MEMBER_LIMIT_EXCEEDED'")).toBeLessThan(now.search(LOOKUP));
    expect(now.search(LOOKUP)).toBeLessThan(now.indexOf('INSERT INTO family_members'));
  });

  it('accept_child_promotion は、1 つ前の定義に名前を読む SELECT と、空のときだけ写す display_name の列を足しただけ', () => {
    const now = ourDefinition('accept_child_promotion');
    const before = previousDefinition('accept_child_promotion');
    expect(now).toMatch(LOOKUP);
    const fill =
      /, display_name = CASE WHEN NULLIF\(btrim\(display_name, E'(?:\\u[0-9A-F]{4})+'\), ''\) IS NULL AND v_profile_name IS NOT NULL THEN v_profile_name ELSE display_name END WHERE id = v_member\.id/;
    expect(now).toMatch(fill);
    const restored = now
      .replace(' v_profile_name TEXT;', '')
      .replace(LOOKUP, '')
      .replace(fill, ' WHERE id = v_member.id');
    expect(restored).toBe(before);
  });

  it.each(FUNCTIONS)('%s: SECURITY DEFINER・search_path・戻り値は 1 つ前の定義と同じ', (fn) => {
    const now = ourDefinition(fn);
    expect(now).toContain('RETURNS family_members LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$');
    expect(previousDefinition(fn)).toContain(
      'RETURNS family_members LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$',
    );
  });

  it('前後の空白として除く文字の集合は、JavaScript の trim (normalizeProfileName) が除く文字の集合と同じ', () => {
    const jsTrimmed: number[] = [];
    for (let cp = 0; cp <= LAST_BMP_CODE_POINT; cp += 1) {
      if (String.fromCharCode(cp).trim() === '') jsTrimmed.push(cp);
    }
    const literals = [...stripLineComments(read(`${MIGRATIONS_DIR}/${ours[0]}`)).matchAll(WS_LITERAL)].map((m) =>
      decodeEscapes(m[1]),
    );
    // 名前を読む SELECT × 2 関数 + 昇格の display_name の判定
    const EXPECTED_LITERAL_COUNT = 3;
    expect(literals).toHaveLength(EXPECTED_LITERAL_COUNT);
    for (const codePoints of literals) {
      expect([...codePoints].sort((a, b) => a - b)).toEqual(jsTrimmed);
    }
  });

  it('仮置きとみなす文字列は PROFILE_NAME_PLACEHOLDER と同じ', () => {
    for (const fn of FUNCTIONS) {
      const match = LOOKUP.exec(ourDefinition(fn));
      expect(match?.[1], fn).toBe(PROFILE_NAME_PLACEHOLDER);
    }
  });

  it.each(FUNCTIONS)('ロールバックは %s を 1 つ前の定義 (#1310) にそのまま戻す', (fn) => {
    const stem = ours[0].replace(/\.sql$/, '');
    const rollback = definitionOf(stripLineComments(read(`${ROLLBACKS_DIR}/${stem}.down.sql`)), fn);
    expect(rollback).toBe(previousDefinition(fn));
    expect(rollback).not.toContain('v_profile_name');
  });

  it('冒頭のコメントと「戻し方」・ロールバックの参照が実際のファイル名と一致する', () => {
    const name = ours[0];
    const stem = name.replace(/\.sql$/, '');
    const rollback = `${ROLLBACKS_DIR}/${stem}.down.sql`;
    expect(fs.existsSync(path.join(ROOT, rollback))).toBe(true);

    const migrationText = read(`${MIGRATIONS_DIR}/${name}`);
    expect(migrationText.split('\n')[0]).toBe(`-- migration: ${name}`);
    expect(migrationText).toContain(`-- 戻し方: ${rollback}`);
    expect(migrationText).toContain(previous[0]);
    expect(fs.existsSync(path.join(ROOT, 'docs/operations/family-member-display-name-backfill.md'))).toBe(true);

    const rollbackText = read(rollback);
    expect(rollbackText.split('\n')[0]).toBe(`-- rollback: ${name}`);
    expect(rollbackText).toContain(previous[0]);
  });

  it('本 migration の番号を書いたファイルは、実在する migration の version だけを指す', () => {
    const own = versionOf(ours[0]);
    const dangling: string[] = [];
    for (const file of REFERENCING_FILES) {
      const text = read(file);
      expect(text, file).toContain(own);
      for (const token of text.match(VERSION_TOKEN) ?? []) {
        if (!versions.has(token)) dangling.push(`${file}: ${token}`);
      }
    }
    expect(dangling).toEqual([]);
  });
});
