/**
 * #1678: migration *_rpc_profile_name_placeholder.sql (と、そのロールバック) のソース走査 contract テスト (DB は使わない)
 *
 * 本物の DB での振る舞い (3 つの RPC が仮置きの 'Guest' を名前として返さない・写さない、normalize_profile_name と
 * normalizeProfileName が同じ答えを返す、anon / authenticated が直接呼べない) は
 * tests/integration/security/rpc-profile-name-placeholder.test.ts が確かめる。
 * ここでは、番号の付け直しや後の migration の上書き、判定の文字の集合のずれで崩れやすい所を、ファイルの文面だけで確かめる。
 *   1. get_invite_details / get_promotion_details を最後に定義する migration が本 migration で、1 つ前はベースライン (20251126124224)。
 *      create_family_group は、本 migration の定義を土台に #1173 の migration が 18 歳未満の IF を足して作り直し
 *      (差分の契約は tests/parental-consent-migration-contract.test.ts の T-MIG5)、さらに billing/03 の migration が家族プランの門を足して作り直す。
 *      本 migration は最後から 3 つ目、ベースラインは 4 つ目
 *   2. 本 migration の 3 つの RPC の定義は、1 つ前の定義の名前の式だけを normalize_profile_name に通したもの (ほかは変えていない)
 *   3. normalize_profile_name が前後の空白として除く文字の集合が、JavaScript の String.prototype.trim (= normalizeProfileName) が
 *      除く文字の集合と同じ。仮置きの文字列が PROFILE_NAME_PLACEHOLDER と同じ。IMMUTABLE・search_path が空・SECURITY DEFINER でない
 *   4. normalize_profile_name の実行権限は、引数の型まで含めて全ロールから外し、service_role にだけ付ける
 *   5. ロールバックは、3 つの RPC を 1 つ前の定義にそのまま戻してから normalize_profile_name を消す
 *   6. 冒頭のコメント・「戻し方」の参照が実際のファイル名と一致する。本 migration の番号を書いたファイルが、実在する version だけを指す
 *   7. 本 migration の version は、ほかの migration・ロールバックの version と重ならない (main に入った別の migration と同じ番号にしない)
 *   8. Edge Functions の写し (supabase/functions/_shared/profile-name.ts) が、migration の文面から組み立てた SQL の判定と同じ答えを返す
 *      (写しと正本の一致は tests/edge-profile-name-sync.test.ts。ここは SQL ⇄ 写し。実 DB での突き合わせは結合テスト)
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PROFILE_NAME_PLACEHOLDER } from '@homegohan/shared';
import { normalizeProfileName as edgeNormalizeProfileName } from '../supabase/functions/_shared/profile-name';

const ROOT = path.resolve(__dirname, '..');
const MIGRATIONS_DIR = 'supabase/migrations';
const ROLLBACKS_DIR = 'supabase/rollbacks';
const STEM_SUFFIX = '_rpc_profile_name_placeholder';
/** 3 つの RPC を本 migration の 1 つ前に定義した migration (本番のベースライン)。ロールバックの戻す先 */
const PREVIOUS_FILE = '20251126124224_create_meal_planner_tables.sql';

/** migration のファイル名 (version 14 桁 + `_` + 名前 + `.sql`) */
const MIGRATION_FILE = /^(\d{14})_.+\.sql$/;
/** ロールバックのファイル名のうち、version 14 桁で始まるもの (version + `_` + 名前 + `.down.sql`) */
const ROLLBACK_FILE = /^(\d{14})_.+\.down\.sql$/;
/** 文面に書かれた migration の version らしい 14 桁の数 (2000 年代の日時) */
const VERSION_TOKEN = /\b20\d{12}\b/g;

/** 本 migration の番号を書いているコード・テスト */
const REFERENCING_FILES = [
  'packages/shared/src/profile-name.ts',
  'src/lib/membership/family-member-names.ts',
  'tests/integration/security/rpc-profile-name-placeholder.test.ts',
];

/** BMP (U+0000〜U+FFFF) の最後の符号位置。trim が除く文字はすべて BMP にある */
const LAST_BMP_CODE_POINT = 0xffff;

const RPCS = ['get_invite_details', 'get_promotion_details', 'create_family_group'] as const;
type RpcName = (typeof RPCS)[number];
const NORMALIZER = 'normalize_profile_name';
type FunctionName = RpcName | typeof NORMALIZER;

/**
 * RPC ごとに、本 migration で名前の式をどう変えたか (空白を詰めた形。[変更後, 変更前, 出てくる回数])。
 * get_invite_details は組織と家族の 2 つの分岐で同じ式を使う
 */
const NAME_EXPRESSION_CHANGES: Record<RpcName, readonly [after: string, before: string, count: number]> = {
  get_invite_details: [
    'SELECT COALESCE(public.normalize_profile_name(up.nickname), au.email) INTO v_invited_by_name',
    'SELECT COALESCE(up.nickname, au.email) INTO v_invited_by_name',
    2,
  ],
  get_promotion_details: [
    'SELECT COALESCE(public.normalize_profile_name(up.nickname), au.email) INTO v_requested_by_name',
    'SELECT COALESCE(up.nickname, au.email) INTO v_requested_by_name',
    1,
  ],
  create_family_group: [
    '(SELECT public.normalize_profile_name(nickname) FROM user_profiles WHERE id = auth.uid())',
    '(SELECT nickname FROM user_profiles WHERE id = auth.uid())',
    1,
  ],
};

const definitionPattern = (fn: FunctionName): RegExp =>
  new RegExp(
    `CREATE\\s+OR\\s+REPLACE\\s+FUNCTION\\s+"?public"?\\."?${fn}"?\\s*\\([\\s\\S]*?\\$\\$[\\s\\S]*?(?:END\\s+)?\\$\\$;`,
    'i',
  );
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

/** `--` から行末までのコメントを除く (関数の本文の文字列の中に `--` を書いていないファイルにだけ使う) */
function stripLineComments(sql: string): string {
  return sql
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n');
}

const read = (relative: string): string => fs.readFileSync(path.join(ROOT, relative), 'utf8');

/** 関数の定義 (CREATE OR REPLACE ... $$;) を空白を詰めて取り出す */
function definitionOf(code: string, fn: FunctionName): string {
  const match = definitionPattern(fn).exec(code);
  if (!match) throw new Error(`${fn} の定義が無い`);
  return match[0].replace(/\s+/g, ' ').trim();
}

const ourCode = (): string => stripLineComments(read(`${MIGRATIONS_DIR}/${ours[0]}`));
const previousCode = (): string => stripLineComments(read(`${MIGRATIONS_DIR}/${PREVIOUS_FILE}`));

/** normalize_profile_name の本文 (前後の空白の集合 E'\uXXXX...' と、仮置きの文字列) */
const NORMALIZER_BODY =
  /AS \$\$ SELECT NULLIF\(NULLIF\(btrim\(p_value, E'((?:\\u[0-9A-F]{4})+)'\), ''\), '([^']*)'\) \$\$;$/;

/** E'\uXXXX\uXXXX...' の中身を符号位置の一覧にする */
function decodeEscapes(body: string): number[] {
  return [...body.matchAll(/\\u([0-9A-F]{4})/g)].map((m) => Number.parseInt(m[1], 16));
}

function countOf(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

describe('#1678 SQL の RPC が仮置きの名前を返さない migration', () => {
  it('本 migration はちょうど 1 本あり、1 つ前の migration が実在し、migration の version は重複しない', () => {
    expect(ours).toHaveLength(1);
    expect(migrationFiles).toContain(PREVIOUS_FILE);
    expect(versions.size).toBe(migrationFiles.length);
  });

  it.each(['get_invite_details', 'get_promotion_details'] as const)('%s を最後に定義する migration が本 migration で、1 つ前はベースライン', (fn) => {
    const definers = migrationFiles.filter((name) =>
      definesPattern(fn).test(stripLineComments(read(`${MIGRATIONS_DIR}/${name}`))),
    );
    expect(definers.length).toBeGreaterThanOrEqual(2);
    expect(definers[definers.length - 1]).toBe(ours[0]);
    expect(definers[definers.length - 2]).toBe(PREVIOUS_FILE);
  });

  it('create_family_group を最後に定義するのは billing/03 の _billing_paid_plans_iap (家族プランの門)、1 つ前が #1173 の _parental_consent_and_birth_date、2 つ前が本 migration、3 つ前がベースライン', () => {
    const definers = migrationFiles.filter((name) =>
      definesPattern('create_family_group').test(stripLineComments(read(`${MIGRATIONS_DIR}/${name}`))),
    );
    expect(definers.length).toBeGreaterThanOrEqual(4);
    expect(definers[definers.length - 1]).toMatch(/_billing_paid_plans_iap\.sql$/);
    expect(definers[definers.length - 2]).toMatch(/_parental_consent_and_birth_date\.sql$/);
    expect(definers[definers.length - 3]).toBe(ours[0]);
    expect(definers[definers.length - 4]).toBe(PREVIOUS_FILE);
  });

  it('normalize_profile_name を定義する migration は本 migration だけ', () => {
    const definers = migrationFiles.filter((name) =>
      definesPattern(NORMALIZER).test(stripLineComments(read(`${MIGRATIONS_DIR}/${name}`))),
    );
    expect(definers).toEqual(ours);
  });

  it.each(RPCS)('%s は、1 つ前の定義の名前の式だけを normalize_profile_name に通したもの', (fn) => {
    const now = definitionOf(ourCode(), fn);
    const before = definitionOf(previousCode(), fn);
    const [after, original, count] = NAME_EXPRESSION_CHANGES[fn];
    expect(countOf(now, after)).toBe(count);
    expect(countOf(before, original)).toBe(count);
    // 名前の式を戻すと、1 つ前の定義と一字一句同じ (SECURITY DEFINER・search_path・ロック・エラー・監査は変えていない)
    expect(now.split(after).join(original)).toBe(before);
    // 名前の式を通さずに nickname を読む所が残っていない
    expect(now.replace(/normalize_profile_name\((?:up\.)?nickname\)/g, '')).not.toMatch(/nickname/);
  });

  it('normalize_profile_name: 前後の空白として除く文字の集合は、JavaScript の trim (normalizeProfileName) が除く文字の集合と同じ', () => {
    const jsTrimmed: number[] = [];
    for (let cp = 0; cp <= LAST_BMP_CODE_POINT; cp += 1) {
      if (String.fromCharCode(cp).trim() === '') jsTrimmed.push(cp);
    }
    const match = NORMALIZER_BODY.exec(definitionOf(ourCode(), NORMALIZER));
    expect(match).not.toBeNull();
    expect([...decodeEscapes(match![1])].sort((a, b) => a - b)).toEqual(jsTrimmed);
  });

  it('normalize_profile_name: 仮置きとみなす文字列は PROFILE_NAME_PLACEHOLDER と同じ', () => {
    const match = NORMALIZER_BODY.exec(definitionOf(ourCode(), NORMALIZER));
    expect(match?.[2]).toBe(PROFILE_NAME_PLACEHOLDER);
  });

  it('normalize_profile_name: text を受けて text を返す・IMMUTABLE・search_path が空・SECURITY DEFINER でない', () => {
    const def = definitionOf(ourCode(), NORMALIZER);
    expect(def).toContain(
      "CREATE OR REPLACE FUNCTION public.normalize_profile_name(p_value TEXT) RETURNS TEXT LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = '' AS $$",
    );
    expect(def).not.toMatch(/SECURITY\s+DEFINER/i);
  });

  it('normalize_profile_name の実行権限は、全ロールから外して service_role にだけ付ける (引数の型まで書く)', () => {
    const code = ourCode();
    const grants = code.match(/^\s*(?:REVOKE|GRANT)\b.*normalize_profile_name.*$/gim)?.map((line) => line.trim());
    expect(grants).toEqual([
      'REVOKE ALL ON FUNCTION public.normalize_profile_name(TEXT) FROM PUBLIC, anon, authenticated, service_role;',
      'GRANT EXECUTE ON FUNCTION public.normalize_profile_name(TEXT) TO service_role;',
    ]);
    // 権限は関数を作った後に変える
    expect(code.indexOf('CREATE OR REPLACE FUNCTION public.normalize_profile_name')).toBeLessThan(
      code.indexOf('REVOKE ALL ON FUNCTION public.normalize_profile_name'),
    );
    // 3 つの RPC の実行権限は変えない (CREATE OR REPLACE は権限を残す)
    for (const fn of RPCS) {
      expect(code).not.toMatch(new RegExp(`(?:REVOKE|GRANT)[^;]*${fn}`, 'i'));
    }
  });

  it('3 つの RPC が normalize_profile_name を呼ぶ所より前に、normalize_profile_name を作る', () => {
    const code = ourCode();
    const created = code.indexOf('CREATE OR REPLACE FUNCTION public.normalize_profile_name');
    for (const fn of RPCS) {
      expect(created).toBeLessThan(code.search(definesPattern(fn)));
    }
  });

  it.each(RPCS)('ロールバックは %s を 1 つ前の定義にそのまま戻す', (fn) => {
    const stem = ours[0].replace(/\.sql$/, '');
    const rollback = definitionOf(stripLineComments(read(`${ROLLBACKS_DIR}/${stem}.down.sql`)), fn);
    expect(rollback).toBe(definitionOf(previousCode(), fn));
    expect(rollback).not.toContain(NORMALIZER);
  });

  it('ロールバックは、3 つの RPC を戻してから normalize_profile_name を消す', () => {
    const stem = ours[0].replace(/\.sql$/, '');
    const code = stripLineComments(read(`${ROLLBACKS_DIR}/${stem}.down.sql`));
    const drop = code.indexOf('DROP FUNCTION IF EXISTS public.normalize_profile_name(TEXT);');
    expect(drop).toBeGreaterThan(-1);
    for (const fn of RPCS) {
      expect(code.search(definesPattern(fn))).toBeGreaterThan(-1);
      expect(code.search(definesPattern(fn))).toBeLessThan(drop);
    }
  });

  it('冒頭のコメントと「戻し方」・ロールバックの参照が実際のファイル名と一致する', () => {
    const name = ours[0];
    const stem = name.replace(/\.sql$/, '');
    const rollback = `${ROLLBACKS_DIR}/${stem}.down.sql`;
    expect(fs.existsSync(path.join(ROOT, rollback))).toBe(true);

    const migrationText = read(`${MIGRATIONS_DIR}/${name}`);
    expect(migrationText.split('\n')[0]).toBe(`-- migration: ${name}`);
    expect(migrationText).toContain(`-- 戻し方: ${rollback}`);
    expect(migrationText).toContain(PREVIOUS_FILE);

    const rollbackText = read(rollback);
    expect(rollbackText.split('\n')[0]).toBe(`-- rollback: ${name}`);
    expect(rollbackText).toContain(PREVIOUS_FILE);
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

  it('本 migration の version は、ほかの migration・ロールバックの version と重ならない', () => {
    const own = versionOf(ours[0]);
    expect(migrationFiles.filter((name) => versionOf(name) === own)).toEqual(ours);
    const rollbacksWithOwnVersion = fs
      .readdirSync(path.join(ROOT, ROLLBACKS_DIR))
      .filter((name) => ROLLBACK_FILE.exec(name)?.[1] === own);
    expect(rollbacksWithOwnVersion).toEqual([ours[0].replace(/\.sql$/, '.down.sql')]);
  });

  it('Edge Functions の写し (_shared/profile-name.ts) は、migration の文面から組み立てた SQL の判定と同じ答えを返す', () => {
    const match = NORMALIZER_BODY.exec(definitionOf(ourCode(), NORMALIZER));
    expect(match).not.toBeNull();
    const sqlTrimmed = new Set(decodeEscapes(match![1]));
    const sqlPlaceholder = match![2];
    // btrim(p_value, 集合) → 空なら NULL → 仮置きなら NULL を、migration の文面のとおりに組み立てる
    const sqlNormalize = (value: string | null): string | null => {
      if (value === null) return null;
      const chars = [...value];
      let start = 0;
      let end = chars.length;
      while (start < end && sqlTrimmed.has(chars[start].codePointAt(0)!)) start += 1;
      while (end > start && sqlTrimmed.has(chars[end - 1].codePointAt(0)!)) end -= 1;
      const trimmed = chars.slice(start, end).join('');
      return trimmed === '' || trimmed === sqlPlaceholder ? null : trimmed;
    };
    const cases: Array<string | null> = [null, '', 'Guest', ' Guest ', 'guest', 'Guests', '山田 太郎', ' 山田 太郎 '];
    for (let cp = 0; cp <= LAST_BMP_CODE_POINT; cp += 1) {
      // 1 文字ずつ、仮置きの前後と名前の前後に付ける (除く文字 / 除かない文字の境目を全部当てる)
      const ch = String.fromCharCode(cp);
      cases.push(`${ch}Guest${ch}`, `${ch}花子${ch}`);
    }
    const mismatches = cases.filter((value) => sqlNormalize(value) !== edgeNormalizeProfileName(value));
    expect(mismatches.map((value) => JSON.stringify(value)).slice(0, 5)).toEqual([]);
  });

  it('migration の冒頭と結合テストが挙げるテストのファイルが実在する', () => {
    const migrationText = read(`${MIGRATIONS_DIR}/${ours[0]}`);
    for (const file of [
      'tests/integration/security/rpc-profile-name-placeholder.test.ts',
      'tests/rpc-profile-name-placeholder-migration-contract.test.ts',
    ]) {
      expect(migrationText).toContain(file);
      expect(fs.existsSync(path.join(ROOT, file)), file).toBe(true);
    }
  });
});
