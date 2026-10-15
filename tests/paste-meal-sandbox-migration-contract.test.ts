/**
 * #1627 migration *_paste_meal_reject_sandbox.sql (と、そのロールバック) のソース走査 contract テスト (DB は使わない)
 *
 * 本物の DB での振る舞い (お試しの記録を貼ると断られ、家族の側に行ができない) は
 * tests/integration/rls/paste-meal-sandbox.test.ts が確かめる。
 * ここでは、番号の付け直し (main の取り込みで最大より上へ移したもの) や、後の migration の上書きで崩れやすい所を、ファイルの文面だけで確かめる。
 *   1. paste_meal_to_family を定義する migration のうち、番号の最も大きいもの (= 流した後に残る定義) が本 migration で、
 *      お試しの記録 (MEAL_SANDBOX) と、運営が隠した食事 (MEAL_HIDDEN。#1101) の両方を断っている。
 *      断る確認は、持ち主の確認 (NOT_MEAL_OWNER) のあと・行を書く (UPDATE / INSERT) 前にある
 *   2. 本 migration の定義は、1 つ前の定義 (#1101 の migration) に MEAL_SANDBOX の確認を足しただけ (ほかは変えていない)
 *   3. ロールバックは、1 つ前の定義にそのまま戻す。権限は本番の権限 (supabase/baseline/prod_function_acl.sql) と同じ
 *   4. 冒頭のコメント・「戻し方」の参照が実際のファイル名と一致する。本 migration の番号を書いたテストが、実在する version だけを指す
 *   5. DB が投げる語 (MEAL_SANDBOX) と、API の対応表 (MembershipErrorCode) が同じ文字列
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MembershipErrorCode } from '@/lib/errors/membership-errors';

const ROOT = path.resolve(__dirname, '..');
const MIGRATIONS_DIR = 'supabase/migrations';
const ROLLBACKS_DIR = 'supabase/rollbacks';
const STEM_SUFFIX = '_paste_meal_reject_sandbox';
/** 本 migration の 1 つ前に paste_meal_to_family を作り直した migration (#1101。MEAL_HIDDEN の確認を足したもの)。ロールバックの戻す先 */
const PREVIOUS_DEFINER = '20261009000500_hide_moderated_content.sql';

/** migration のファイル名 (version 14 桁 + `_` + 名前 + `.sql`) */
const MIGRATION_FILE = /^(\d{14})_.+\.sql$/;
/** 文面に書かれた migration の version らしい 14 桁の数 (2000 年代の日時) */
const VERSION_TOKEN = /\b20\d{12}\b/g;

/** 本 migration の番号を書いているコード・テスト */
const REFERENCING_FILES = ['tests/meals-paste-sandbox.test.ts', 'tests/integration/rls/paste-meal-sandbox.test.ts'];

/** 本番の権限 (supabase/baseline/prod_function_acl.sql と同じ: PUBLIC / anon から外し、authenticated と service_role に EXECUTE) */
const EXPECTED_GRANTS = [
  'REVOKE ALL ON FUNCTION public.paste_meal_to_family(uuid, uuid[]) FROM PUBLIC, anon, authenticated, service_role;',
  'GRANT EXECUTE ON FUNCTION public.paste_meal_to_family(uuid, uuid[]) TO authenticated;',
  'GRANT EXECUTE ON FUNCTION public.paste_meal_to_family(uuid, uuid[]) TO service_role;',
];

/** 本 migration が 1 つ前の定義に足した確認 (この部分を除くと、1 つ前の定義と同じになる) */
const SANDBOX_CHECK = /IF\s+v_source\.is_sandbox\s+THEN\s+RAISE\s+EXCEPTION\s+'MEAL_SANDBOX'\s+USING\s+ERRCODE\s*=\s*'P0001';\s+END\s+IF;/i;

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

const rejectSandbox = migrationFiles.filter((name) => name.endsWith(`${STEM_SUFFIX}.sql`));

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

describe('#1627 paste_meal_to_family がお試しの記録を断る migration', () => {
  it('本 migration はちょうど 1 本あり、migration の version は重複しない', () => {
    expect(rejectSandbox).toHaveLength(1);
    expect(versions.size).toBe(migrationFiles.length);
  });

  it('paste_meal_to_family を最後に定義する migration が本 migration で、1 つ前は #1101 の migration', () => {
    expect(definers.length).toBeGreaterThanOrEqual(2);
    expect(definers[definers.length - 1]).toBe(rejectSandbox[0]);
    expect(definers[definers.length - 2]).toBe(PREVIOUS_DEFINER);
    expect(versionOf(rejectSandbox[0]) > versionOf(PREVIOUS_DEFINER)).toBe(true);
  });

  it('最後の定義は、持ち主の確認のあと・行を書く前に MEAL_HIDDEN と MEAL_SANDBOX の両方を断る (SECURITY DEFINER と search_path は保つ)', () => {
    const definition = definitionOf(stripLineComments(read(`${MIGRATIONS_DIR}/${rejectSandbox[0]}`)));
    expect(definition).toMatch(SANDBOX_CHECK);
    expect(definition).toMatch(/IF v_source\.hidden_at IS NOT NULL THEN RAISE EXCEPTION 'MEAL_HIDDEN'/);
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
    // 持ち主でない人には、隠れているか・お試しかを教えない
    expect(owner).toBeLessThan(hidden);
    expect(hidden).toBeLessThan(sandbox);
    // 断ったときは何も書かない (元の行の paste_group_id も、家族の側の行も、監査の行も)
    expect(sandbox).toBeLessThan(firstWrite);
  });

  it('本 migration の定義は、1 つ前の定義に MEAL_SANDBOX の確認を足しただけ', () => {
    const ours = definitionOf(stripLineComments(read(`${MIGRATIONS_DIR}/${rejectSandbox[0]}`)));
    const previous = definitionOf(stripLineComments(read(`${MIGRATIONS_DIR}/${PREVIOUS_DEFINER}`)));
    expect(previous).not.toMatch(SANDBOX_CHECK);
    expect(ours.replace(SANDBOX_CHECK, '').replace(/\s+/g, ' ')).toBe(previous);
  });

  it('本 migration とロールバックの権限は、本番の権限と同じ', () => {
    const stem = rejectSandbox[0].replace(/\.sql$/, '');
    const migrationCode = stripLineComments(read(`${MIGRATIONS_DIR}/${rejectSandbox[0]}`));
    const rollbackCode = stripLineComments(read(`${ROLLBACKS_DIR}/${stem}.down.sql`));
    for (const statement of EXPECTED_GRANTS) {
      expect(migrationCode, statement).toContain(statement);
      expect(rollbackCode, statement).toContain(statement);
    }
    const acl = read('supabase/baseline/prod_function_acl.sql');
    expect(acl).toMatch(/GRANT EXECUTE ON ROUTINE public\."paste_meal_to_family"\([^)]*\) TO "authenticated";/);
    expect(acl).toMatch(/GRANT EXECUTE ON ROUTINE public\."paste_meal_to_family"\([^)]*\) TO "service_role";/);
    expect(acl).not.toMatch(/GRANT EXECUTE ON ROUTINE public\."paste_meal_to_family"\([^)]*\) TO "anon";/);
  });

  it('ロールバックは、1 つ前の定義 (#1101 の migration。MEAL_HIDDEN だけを断る形) にそのまま戻す', () => {
    const stem = rejectSandbox[0].replace(/\.sql$/, '');
    const rollback = definitionOf(stripLineComments(read(`${ROLLBACKS_DIR}/${stem}.down.sql`)));
    const previous = definitionOf(stripLineComments(read(`${MIGRATIONS_DIR}/${PREVIOUS_DEFINER}`)));
    expect(rollback).toBe(previous);
    expect(rollback).toContain("'MEAL_HIDDEN'");
    expect(rollback).not.toContain('MEAL_SANDBOX');
  });

  it('冒頭のコメントと「戻し方」・ロールバックの参照が実際のファイル名と一致する', () => {
    const name = rejectSandbox[0];
    const stem = name.replace(/\.sql$/, '');
    const rollback = `${ROLLBACKS_DIR}/${stem}.down.sql`;
    expect(fs.existsSync(path.join(ROOT, rollback))).toBe(true);

    const migrationText = read(`${MIGRATIONS_DIR}/${name}`);
    expect(migrationText.split('\n')[0]).toBe(`-- migration: ${name}`);
    expect(migrationText).toContain(`-- 戻し方: ${rollback}`);

    expect(read(rollback).split('\n')[0]).toBe(`-- rollback: ${name}`);
  });

  it('本 migration の番号を書いたテストは、実在する migration の version だけを指す', () => {
    const own = versionOf(rejectSandbox[0]);
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

  it('DB が投げる語と API の対応表のコードが同じ文字列で、route が MEAL_SANDBOX を対応している', () => {
    expect(MembershipErrorCode.MEAL_SANDBOX).toBe('MEAL_SANDBOX');
    const route = read('src/app/api/meals/paste/route.ts');
    expect(route).toContain('MembershipErrorCode.MEAL_SANDBOX');
  });
});
