/**
 * #1634 migration *_paste_meal_reject_missing_source.sql (と、そのロールバック) のソース走査 contract テスト (DB は使わない)
 *
 * 本物の DB での振る舞い (存在しない元の行は NOT_MEAL_OWNER で断られ、監査の行も家族の側の行もできない) は
 * tests/integration/rls/paste-meal-errors.test.ts が確かめる。
 * ここでは、番号の付け直し (main の取り込みで最大より上へ移したもの) や、後の migration の上書きで崩れやすい所を、ファイルの文面だけで確かめる。
 *   1. paste_meal_to_family を定義する migration のうち、番号の最も大きいもの (= 流した後に残る定義) が本 migration で、
 *      1 つ前は #1627 の migration (*_paste_meal_reject_sandbox.sql)
 *   2. 本 migration の定義は、1 つ前の定義の持ち主の確認を「NOT FOUND OR ... IS DISTINCT FROM ...」に変えただけ (ほかは変えていない)
 *   3. 元の行の読み込み (SELECT INTO v_source) の直後に持ち主の確認があり、確認の順は 持ち主 → 隠した食事 → お試し。
 *      どれも行を書く (UPDATE / INSERT) 前にある
 *   4. ロールバックは、1 つ前の定義にそのまま戻す。権限は本番の権限 (supabase/baseline/prod_function_acl.sql) と同じ
 *   5. 冒頭のコメント・「戻し方」の参照が実際のファイル名と一致する。本 migration の番号を書いたテストが、実在する version だけを指す
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const MIGRATIONS_DIR = 'supabase/migrations';
const ROLLBACKS_DIR = 'supabase/rollbacks';
const STEM_SUFFIX = '_paste_meal_reject_missing_source';
/** 本 migration の 1 つ前に paste_meal_to_family を作り直した migration の名前の末尾 (#1627。MEAL_SANDBOX の確認を足したもの)。ロールバックの戻す先 */
const PREVIOUS_STEM_SUFFIX = '_paste_meal_reject_sandbox';

/** migration のファイル名 (version 14 桁 + `_` + 名前 + `.sql`) */
const MIGRATION_FILE = /^(\d{14})_.+\.sql$/;
/** 文面に書かれた migration の version らしい 14 桁の数 (2000 年代の日時) */
const VERSION_TOKEN = /\b20\d{12}\b/g;

/** 本 migration の番号を書いているコード・テスト */
const REFERENCING_FILES = ['tests/meals-paste-error-codes.test.ts', 'tests/integration/rls/paste-meal-errors.test.ts'];

/** 本番の権限 (supabase/baseline/prod_function_acl.sql と同じ: PUBLIC / anon から外し、authenticated と service_role に EXECUTE) */
const EXPECTED_GRANTS = [
  'REVOKE ALL ON FUNCTION public.paste_meal_to_family(uuid, uuid[]) FROM PUBLIC, anon, authenticated, service_role;',
  'GRANT EXECUTE ON FUNCTION public.paste_meal_to_family(uuid, uuid[]) TO authenticated;',
  'GRANT EXECUTE ON FUNCTION public.paste_meal_to_family(uuid, uuid[]) TO service_role;',
];

/** 1 つ前の定義の持ち主の確認 (元の行が無いと v_source.user_id が NULL になり、すり抜ける形) */
const OLD_OWNER_CHECK = 'IF v_source.user_id <> auth.uid() THEN';
/** 本 migration の持ち主の確認 (元の行が無いときも、持ち主の列が NULL のときも断る) */
const NEW_OWNER_CHECK = 'IF NOT FOUND OR v_source.user_id IS DISTINCT FROM auth.uid() THEN';
/** 元の行の読み込みの直後に持ち主の確認があり、NOT_MEAL_OWNER で断る */
const LOAD_THEN_OWNER_CHECK =
  /SELECT \* INTO v_source FROM meals WHERE id = p_source_meal_id; IF NOT FOUND OR v_source\.user_id IS DISTINCT FROM auth\.uid\(\) THEN RAISE EXCEPTION 'NOT_MEAL_OWNER' USING ERRCODE = 'P0001'; END IF;/;

const DEFINITION = /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.paste_meal_to_family\s*\([\s\S]*?\$\$[\s\S]*?END\s+\$\$;/i;

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

const rejectMissing = migrationFiles.filter((name) => name.endsWith(`${STEM_SUFFIX}.sql`));
const rejectSandbox = migrationFiles.filter((name) => name.endsWith(`${PREVIOUS_STEM_SUFFIX}.sql`));

/** `--` から行末までのコメントを除く */
function stripLineComments(sql: string): string {
  return sql
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n');
}

const read = (relative: string): string => fs.readFileSync(path.join(ROOT, relative), 'utf8');

/** 関数の定義 (CREATE OR REPLACE ... END $$;) を空白を詰めて取り出す */
function definitionOf(code: string): string {
  const match = DEFINITION.exec(code);
  if (!match) throw new Error('paste_meal_to_family の定義が無い');
  return match[0].replace(/\s+/g, ' ').trim();
}

const definers = migrationFiles.filter((name) =>
  /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.paste_meal_to_family\s*\(/i.test(stripLineComments(read(`${MIGRATIONS_DIR}/${name}`))),
);

const ourDefinition = (): string => definitionOf(stripLineComments(read(`${MIGRATIONS_DIR}/${rejectMissing[0]}`)));
const previousDefinition = (): string => definitionOf(stripLineComments(read(`${MIGRATIONS_DIR}/${rejectSandbox[0]}`)));

describe('#1634 paste_meal_to_family が存在しない元の行を断る migration', () => {
  it('本 migration と 1 つ前の migration はちょうど 1 本ずつあり、migration の version は重複しない', () => {
    expect(rejectMissing).toHaveLength(1);
    expect(rejectSandbox).toHaveLength(1);
    expect(versions.size).toBe(migrationFiles.length);
  });

  it('paste_meal_to_family を最後に定義する migration が本 migration で、1 つ前は #1627 の migration', () => {
    expect(definers.length).toBeGreaterThanOrEqual(2);
    expect(definers[definers.length - 1]).toBe(rejectMissing[0]);
    expect(definers[definers.length - 2]).toBe(rejectSandbox[0]);
    expect(versionOf(rejectMissing[0]) > versionOf(rejectSandbox[0])).toBe(true);
  });

  it('本 migration の定義は、1 つ前の定義の持ち主の確認を NOT FOUND も断る形に変えただけ', () => {
    const ours = ourDefinition();
    const previous = previousDefinition();
    expect(previous).toContain(OLD_OWNER_CHECK);
    expect(ours).not.toContain(OLD_OWNER_CHECK);
    expect(ours.split(NEW_OWNER_CHECK)).toHaveLength(2);
    expect(ours.replace(NEW_OWNER_CHECK, OLD_OWNER_CHECK)).toBe(previous);
  });

  it('元の行の読み込みの直後に持ち主の確認があり、持ち主 → 隠した食事 → お試しの順で、どれも行を書く前', () => {
    const definition = ourDefinition();
    expect(definition).toMatch(LOAD_THEN_OWNER_CHECK);
    expect(definition).toMatch(/SECURITY DEFINER SET search_path TO 'public'/);
    expect(definition).toMatch(/RETURNS uuid/);

    const at = (needle: string): number => {
      const index = definition.indexOf(needle);
      expect(index, needle).toBeGreaterThanOrEqual(0);
      return index;
    };
    const owner = at("'NOT_MEAL_OWNER'");
    const hidden = at("'MEAL_HIDDEN'");
    const sandbox = at("'MEAL_SANDBOX'");
    const firstWrite = Math.min(at('UPDATE meals SET paste_group_id'), at('INSERT INTO meals'), at('INSERT INTO membership_audit'));
    expect(owner).toBeLessThan(hidden);
    expect(hidden).toBeLessThan(sandbox);
    // 断ったときは何も書かない (元の行の paste_group_id も、家族の側の行も、監査の行も)
    expect(sandbox).toBeLessThan(firstWrite);
  });

  it('本 migration とロールバックの権限は、本番の権限と同じ', () => {
    const stem = rejectMissing[0].replace(/\.sql$/, '');
    const migrationCode = stripLineComments(read(`${MIGRATIONS_DIR}/${rejectMissing[0]}`));
    const rollbackCode = stripLineComments(read(`${ROLLBACKS_DIR}/${stem}.down.sql`));
    for (const statement of EXPECTED_GRANTS) {
      expect(migrationCode, statement).toContain(statement);
      expect(rollbackCode, statement).toContain(statement);
    }
    expect(migrationCode).toContain('ALTER FUNCTION public.paste_meal_to_family(uuid, uuid[]) OWNER TO postgres;');
    expect(rollbackCode).toContain('ALTER FUNCTION public.paste_meal_to_family(uuid, uuid[]) OWNER TO postgres;');
  });

  it('ロールバックは、1 つ前の定義 (#1627 の migration。MEAL_HIDDEN と MEAL_SANDBOX を断る形) にそのまま戻す', () => {
    const stem = rejectMissing[0].replace(/\.sql$/, '');
    const rollback = definitionOf(stripLineComments(read(`${ROLLBACKS_DIR}/${stem}.down.sql`)));
    expect(rollback).toBe(previousDefinition());
    expect(rollback).toContain("'MEAL_HIDDEN'");
    expect(rollback).toContain("'MEAL_SANDBOX'");
    expect(rollback).not.toContain(NEW_OWNER_CHECK);
  });

  it('冒頭のコメントと「戻し方」・ロールバックの参照が実際のファイル名と一致する', () => {
    const name = rejectMissing[0];
    const stem = name.replace(/\.sql$/, '');
    const rollback = `${ROLLBACKS_DIR}/${stem}.down.sql`;
    expect(fs.existsSync(path.join(ROOT, rollback))).toBe(true);

    const migrationText = read(`${MIGRATIONS_DIR}/${name}`);
    expect(migrationText.split('\n')[0]).toBe(`-- migration: ${name}`);
    expect(migrationText).toContain(`-- 戻し方: ${rollback}`);
    expect(migrationText).toContain(rejectSandbox[0]);

    const rollbackText = read(rollback);
    expect(rollbackText.split('\n')[0]).toBe(`-- rollback: ${name}`);
    expect(rollbackText).toContain(rejectSandbox[0]);
  });

  it('本 migration の番号を書いたテストは、実在する migration の version だけを指す', () => {
    const own = versionOf(rejectMissing[0]);
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
