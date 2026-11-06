// @vitest-environment node
/**
 * #2283 完成度が「入っていない」と数える列の既定値 (src/lib/profile-completeness.ts の USER_PROFILE_COLUMN_DEFAULTS) が、
 * migration の user_profiles の DEFAULT と食い違わないことを検査する。
 *
 * 完成度は、列の既定値 (行を作ると DB が入れる値) と同じ値を入っていないと数える。migration で既定値を変える・足すと、
 * 定数を直さない限り既定値で埋まった欄を「入力済み」と数え直してしまう。そこで次を機械で確かめる。
 *   - 定数の各値が、CREATE TABLE user_profiles の DEFAULT と同じ
 *   - 完成度に数えるほかの列の DEFAULT は、無い (NULL) か空の配列だけ (どちらも入っていないと数える)
 *   - 後の migration が、完成度に数える列の DEFAULT を変えていない (ALTER COLUMN ... SET / DROP DEFAULT・ADD COLUMN ... DEFAULT)
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { PROFILE_COMPLETENESS_COLUMNS, USER_PROFILE_COLUMN_DEFAULTS } from '@/lib/profile-completeness';

const MIGRATIONS_DIR = path.resolve(__dirname, '..', 'supabase', 'migrations');
/** user_profiles を作った migration */
const CREATE_TABLE_MIGRATION = '20251126124224_create_meal_planner_tables.sql';
const CREATE_TABLE_HEADER = 'CREATE TABLE IF NOT EXISTS "public"."user_profiles" (';
/** 空の配列の既定値 (入っていないと数える) */
const EMPTY_ARRAY_DEFAULT = /^'\{\}'::"?[a-z]+"?\[\]$/;

/** CREATE TABLE user_profiles の列 → DEFAULT の式 (DEFAULT が無い列は null) */
function createTableDefaults(): Map<string, string | null> {
  const sql = readFileSync(path.join(MIGRATIONS_DIR, CREATE_TABLE_MIGRATION), 'utf8');
  const start = sql.indexOf(CREATE_TABLE_HEADER);
  expect(start).toBeGreaterThanOrEqual(0);
  const body = sql.slice(start + CREATE_TABLE_HEADER.length, sql.indexOf('\n);', start));
  const defaults = new Map<string, string | null>();
  for (const line of body.split('\n')) {
    const column = /^\s*"([a-z_]+)"\s/.exec(line);
    if (!column) continue;
    const expression = /\sDEFAULT\s(.+?)(?:\s+NOT NULL)?,?\s*$/.exec(line);
    defaults.set(column[1], expression ? expression[1] : null);
  }
  return defaults;
}

/** SQL の既定値の式を、定数と比べられる値にする ('normal'::"text" → 'normal'・30 → 30・'{...}'::"jsonb" → オブジェクト) */
function sqlDefaultValue(expression: string): unknown {
  const literal = /^'(.*)'::"?([a-z]+)"?$/.exec(expression);
  if (literal) return literal[2] === 'jsonb' ? JSON.parse(literal[1]) : literal[1];
  const numeric = Number(expression);
  return Number.isFinite(numeric) ? numeric : expression;
}

describe('完成度が入っていないと数える列の既定値は migration の DEFAULT と同じ (#2283)', () => {
  const defaults = createTableDefaults();

  it('USER_PROFILE_COLUMN_DEFAULTS の各値が CREATE TABLE user_profiles の DEFAULT と同じ', () => {
    for (const [column, expected] of Object.entries(USER_PROFILE_COLUMN_DEFAULTS)) {
      const expression = defaults.get(column);
      expect(expression, column).toBeTruthy();
      expect(sqlDefaultValue(expression ?? ''), column).toEqual(expected);
    }
  });

  it('完成度に数えるほかの列の DEFAULT は、無いか空の配列だけ', () => {
    const listed = new Set<string>(Object.keys(USER_PROFILE_COLUMN_DEFAULTS));
    for (const column of PROFILE_COMPLETENESS_COLUMNS) {
      expect(defaults.has(column), `${column} が CREATE TABLE user_profiles に無い`).toBe(true);
      if (listed.has(column)) continue;
      const expression = defaults.get(column) ?? null;
      if (expression !== null) expect(expression, column).toMatch(EMPTY_ARRAY_DEFAULT);
    }
  });

  it('後の migration は、完成度に数える列の DEFAULT を変えていない', () => {
    const later = readdirSync(MIGRATIONS_DIR).filter(
      (name) => name.endsWith('.sql') && !name.endsWith('.down.sql') && name > CREATE_TABLE_MIGRATION,
    );
    expect(later.length).toBeGreaterThan(0);
    const offenders: string[] = [];
    for (const name of later) {
      const sql = readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8');
      for (const column of PROFILE_COMPLETENESS_COLUMNS) {
        const alterDefault = new RegExp(`ALTER\\s+COLUMN\\s+"?${column}"?\\s+(SET|DROP)\\s+DEFAULT`, 'i');
        const addWithDefault = new RegExp(`ADD\\s+COLUMN\\s+(IF\\s+NOT\\s+EXISTS\\s+)?"?${column}"?\\s[^,;]*\\bDEFAULT\\b`, 'i');
        if ((alterDefault.test(sql) || addWithDefault.test(sql)) && /user_profiles/.test(sql)) offenders.push(`${name}: ${column}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
