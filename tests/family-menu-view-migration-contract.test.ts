/**
 * #1584 の 1: migration *_family_menu_view_functions.sql (と、その戻し口) のソース走査の契約テスト (DB を使わない)。
 * 設計書 docs/design/family/10-family-menu-view.md §11・§19.6 (C-1〜C-3・C-5〜C-8。C-4 は型が掛かる
 * src/__tests__/lib/membership/family-menu-rpc-types.test.ts)。
 *
 * 本物の DB での振る舞い (見える・見えない・鍵・max_rows を超える件数) は tests/integration/rls/family-menu-visibility.test.ts。
 * ここでは、番号の付け直しや後の migration の上書き、TS の定数・Zod の鍵とのずれで崩れやすい所を、ファイルの文面だけで確かめる。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FAMILY_MENU_RANGE_MAX_DAYS } from '@/lib/membership/family-menu';
import { FamilyMenuMealSchema, FamilyMenuRpcRowSchema } from '@/schemas/membership/family-menu';

const ROOT = path.resolve(__dirname, '..');
const MIGRATIONS_DIR = 'supabase/migrations';
const ROLLBACKS_DIR = 'supabase/rollbacks';
const STEM_SUFFIX = '_family_menu_view_functions';

const VISIBLE_MEMBERS = 'family_menu_visible_members';
const PLANNED_MEALS = 'family_menu_planned_meals';
const FUNCTIONS = [VISIBLE_MEMBERS, PLANNED_MEALS] as const;
type FunctionName = (typeof FUNCTIONS)[number];

/** REVOKE / GRANT / DROP で関数を指すときの引数の型の並び */
const SIGNATURES: Record<FunctionName, string> = {
  [VISIBLE_MEMBERS]: 'public.family_menu_visible_members()',
  [PLANNED_MEALS]: 'public.family_menu_planned_meals(date, date)',
};

/** 関数の結果の要素 (1 食) が持つ鍵のうち、応答の 1 食 (FamilyMenuMealSchema) に無いもの (応答ではメンバーと日でまとめる) */
const GROUPING_KEYS = ['member_id', 'user_id', 'day_date'] as const;
/** 要素の鍵の数 (設計書 §11.1・§13) */
const RPC_ELEMENT_KEY_COUNT = 12;
/** 返してはいけない planned_meals の列 */
const FORBIDDEN_KEYS = ['memo', 'generation_metadata', 'mode', 'dishes', 'image_url'] as const;
/** 2 つの関数が読んではいけない語 (代表者の譲渡と凍結で見える相手が変わらない。設計書 §11.1・C-8) */
const UNREAD_WORDS = ['role', 'representative_id', 'frozen_at'] as const;

/** migration のファイル名 (version 14 桁 + `_` + 名前 + `.sql`) */
const MIGRATION_FILE = /^(\d{14})_.+\.sql$/;

const read = (relative: string): string => fs.readFileSync(path.join(ROOT, relative), 'utf8');

const migrationFiles = fs
  .readdirSync(path.join(ROOT, MIGRATIONS_DIR))
  .filter((name) => MIGRATION_FILE.test(name))
  .sort();
const ours = migrationFiles.filter((name) => name.endsWith(`${STEM_SUFFIX}.sql`));
const ourName = ours[0] ?? '';
const ourStem = ourName.replace(/\.sql$/, '');

/** SQL のコメント (-- から行末) を取り除く (このファイルの文字列リテラルに -- は無い) */
function stripSqlComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, '');
}

/** 空白をまとめて 1 つにする */
function squash(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

/** 関数の定義 (CREATE OR REPLACE FUNCTION public.<name>( から本体の終わりの $$; まで)。無ければ null */
function functionDefinition(sql: string, name: FunctionName): string | null {
  const start = sql.search(new RegExp(`CREATE\\s+OR\\s+REPLACE\\s+FUNCTION\\s+public\\.${name}\\s*\\(`, 'i'));
  if (start < 0) return null;
  const bodyStart = sql.indexOf('$$', start);
  if (bodyStart < 0) return null;
  const bodyEnd = sql.indexOf('$$', bodyStart + 2);
  if (bodyEnd < 0) return null;
  return sql.slice(start, bodyEnd + 2);
}

/** 関数の本体 ($$ と $$ の間) */
function functionBody(definition: string): string {
  const open = definition.indexOf('$$');
  const close = definition.lastIndexOf('$$');
  return definition.slice(open + 2, close);
}

const ourSql = stripSqlComments(read(`${MIGRATIONS_DIR}/${ourName}`));
const definitionOf = (fn: FunctionName): string => {
  const def = functionDefinition(ourSql, fn);
  if (!def) throw new Error(`${fn} の定義が ${ourName} に無い`);
  return def;
};

/** 括弧の外にあるカンマで分割する */
function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of text) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) {
      parts.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

/** r の SELECT の各式 (family_menu_planned_meals の to_jsonb(r) の r) */
function rSelectItems(): string[] {
  const body = squash(functionBody(definitionOf(PLANNED_MEALS)));
  const aggregate = body.indexOf('jsonb_agg(to_jsonb(r)');
  if (aggregate < 0) throw new Error('jsonb_agg(to_jsonb(r) が無い');
  const selectStart = body.indexOf('SELECT ', body.indexOf('FROM (', aggregate));
  const selectEnd = body.indexOf(`FROM public.${VISIBLE_MEMBERS}() AS m`, selectStart);
  if (selectStart < 0 || selectEnd < 0) throw new Error('r の SELECT が見つからない');
  return splitTopLevel(body.slice(selectStart + 'SELECT '.length, selectEnd));
}

/** 式の列の名前: 末尾の AS <名前> (括弧の外)、無ければ <別名>.<列> の列 */
function columnNameOf(item: string): string {
  const alias = /\)?\s+AS\s+([a-z_][a-z0-9_]*)$/i.exec(item);
  if (alias) return alias[1];
  const column = /^[a-z_][a-z0-9_]*\.([a-z_][a-z0-9_]*)$/i.exec(item);
  if (column) return column[1];
  throw new Error(`r の列の名前を読めない: ${item}`);
}

describe('#1584 の 1 家族の献立を読む関数 2 本の migration', () => {
  it('C-1: *_family_menu_view_functions.sql が関数 2 本を CREATE OR REPLACE し、後の migration が上書きしていない', () => {
    expect(ours).toHaveLength(1);
    for (const fn of FUNCTIONS) {
      expect(functionDefinition(ourSql, fn), fn).not.toBeNull();
      const definers = migrationFiles.filter(
        (name) => functionDefinition(stripSqlComments(read(`${MIGRATIONS_DIR}/${name}`)), fn) !== null,
      );
      // 本 migration が最初で最後の定義 (後の migration が上書きしたら、そちらへこの検査を移す)
      expect(definers, fn).toEqual([ourName]);
    }
  });

  it("C-2: 2 本とも SECURITY DEFINER・STABLE・search_path = '' で、REVOKE (PUBLIC, anon, authenticated, service_role) と GRANT (authenticated, service_role) を引数の型つきで持つ", () => {
    const sql = squash(ourSql);
    for (const fn of FUNCTIONS) {
      const head = squash(definitionOf(fn)).split('$$')[0];
      expect(head, fn).toMatch(/\bSTABLE\b/);
      expect(head, fn).toMatch(/\bSECURITY DEFINER\b/);
      expect(head, fn).toContain("SET search_path = ''");
      expect(sql, fn).toContain(`REVOKE ALL ON FUNCTION ${SIGNATURES[fn]} FROM PUBLIC, anon, authenticated, service_role;`);
      expect(sql, fn).toContain(`GRANT EXECUTE ON FUNCTION ${SIGNATURES[fn]} TO authenticated, service_role;`);
      // anon に GRANT していない
      expect(sql, fn).not.toMatch(new RegExp(`GRANT [^;]*${fn}[^;]* TO [^;]*\\banon\\b`));
    }
  });

  it('C-3: 関数の範囲の上限 (… + 1 > 31) が FAMILY_MENU_RANGE_MAX_DAYS と同じ値', () => {
    const body = squash(functionBody(definitionOf(PLANNED_MEALS)));
    const match = /\(p_end_date - p_start_date\) \+ 1 > (\d+)/.exec(body);
    expect(match).not.toBeNull();
    expect(Number(match?.[1])).toBe(FAMILY_MENU_RANGE_MAX_DAYS);
    expect(body).toContain("RAISE EXCEPTION 'FAMILY_MENU_RANGE_INVALID'");
    expect(body).toContain('p_end_date < p_start_date');
  });

  it('C-5: 1 行目の見出し・戻し方の参照・戻し口のファイル名と見出しが一致し、戻し口は DROP FUNCTION IF EXISTS を 2 本持つ', () => {
    const raw = read(`${MIGRATIONS_DIR}/${ourName}`);
    expect(raw.split('\n', 1)[0]).toBe(`-- migration: ${ourName}`);
    const rollbackPath = `${ROLLBACKS_DIR}/${ourStem}.down.sql`;
    expect(raw).toContain(`戻し方: ${rollbackPath}`);
    expect(fs.existsSync(path.join(ROOT, rollbackPath))).toBe(true);
    const rollback = read(rollbackPath);
    expect(rollback.split('\n', 1)[0]).toBe(`-- rollback: ${ourName}`);
    const drops = squash(stripSqlComments(rollback)).match(/DROP FUNCTION IF EXISTS [^;]+;/g) ?? [];
    expect(drops.sort()).toEqual(FUNCTIONS.map((fn) => `DROP FUNCTION IF EXISTS ${SIGNATURES[fn]};`).sort());
    // 本 migration の番号を書いたコメント (確かめるテストの案内) が、実在するファイルを指す
    for (const referenced of ['tests/family-menu-view-migration-contract.test.ts', 'tests/integration/rls/family-menu-visibility.test.ts']) {
      expect(raw).toContain(referenced);
      expect(fs.existsSync(path.join(ROOT, referenced)), referenced).toBe(true);
    }
  });

  it('C-6: family_menu_planned_meals は RETURNS jsonb (RETURNS TABLE / SETOF でない) で、配列の要素の鍵 (to_jsonb(r) の r の列) が FamilyMenuRpcRowSchema の鍵とも FamilyMenuMealSchema の鍵 + member_id / user_id / day_date とも一致する (12 個。memo / generation_metadata / mode / dishes / image_url を返していない)', () => {
    const head = squash(definitionOf(PLANNED_MEALS)).split('$$')[0];
    expect(head).toMatch(/\)\s*RETURNS jsonb LANGUAGE plpgsql/i);
    expect(head).not.toMatch(/RETURNS\s+(TABLE|SETOF)/i);
    // 結果は 1 つの jsonb の配列 (行の集合でない) で、献立が無ければ空の配列
    const body = squash(functionBody(definitionOf(PLANNED_MEALS)));
    expect(body).toContain('RETURN COALESCE((');
    expect(body).toContain("), '[]'::jsonb);");

    const columns = rSelectItems().map(columnNameOf);
    expect(columns).toHaveLength(RPC_ELEMENT_KEY_COUNT);
    expect(new Set(columns).size).toBe(columns.length);
    expect([...columns].sort()).toEqual(Object.keys(FamilyMenuRpcRowSchema.shape).sort());
    expect([...columns].sort()).toEqual([...Object.keys(FamilyMenuMealSchema.shape), ...GROUPING_KEYS].sort());
    for (const forbidden of FORBIDDEN_KEYS) expect(columns, forbidden).not.toContain(forbidden);
  });

  it("C-7: dish_names は dishes から ->> 'name' で名前だけを取り出す (r の列に dishes そのものを入れない)", () => {
    const items = rSelectItems();
    const dishNames = items.filter((item) => columnNameOf(item) === 'dish_names');
    expect(dishNames).toHaveLength(1);
    expect(dishNames[0]).toMatch(/^ARRAY\(/);
    expect(dishNames[0]).toContain("SELECT e.elem ->> 'name'");
    expect(dishNames[0]).toContain('pm.dishes');
    // dishes そのものも、dishes から取り出した名前以外の値も r の列にしない
    for (const item of items.filter((i) => columnNameOf(i) !== 'dish_names')) {
      expect(item, item).not.toContain('dishes');
    }
  });

  it('C-8: 2 つの関数の本文は role・representative_id・frozen_at を読まない (代表者の譲渡と凍結で見える相手が変わらない)', () => {
    for (const fn of FUNCTIONS) {
      const body = functionBody(definitionOf(fn));
      for (const word of UNREAD_WORDS) {
        expect(new RegExp(`\\b${word}\\b`, 'i').test(body), `${fn} が ${word} を読む`).toBe(false);
      }
    }
  });
});
