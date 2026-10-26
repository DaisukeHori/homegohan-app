/**
 * 運営の家族の強制解散 (operator_force_dissolve_family) が、無い家族・解散済みの家族でも成功して監査を残す欠陥の修正
 * (supabase/migrations/20261026100000_operator_force_dissolve_family_missing.sql) を、ファイルどうしの突き合わせで確かめる (DB には接続しない)。
 *
 * 後の migration が operator_force_dissolve_family を CREATE OR REPLACE し直すとき (古い本文をそのまま写すとき) に、判定を
 * 落とさないよう、「最新の定義」(supabase/migrations を version 順に見て、最後に CREATE OR REPLACE したもの) で確かめる。
 *
 *   1. 最新の定義は、家族の行を FOR NO KEY UPDATE で行全体を読み、その下で 行が無ければ FAMILY_NOT_FOUND・status が dissolved なら
 *      FAMILY_ALREADY_DISSOLVED を RAISE する。2 つの判定は、後始末 (family_dissolve_apply) と membership_audit の INSERT より前
 *   2. エラーの順番は NOT_OPERATOR → OPERATOR_MFA_REQUIRED → FAMILY_NOT_FOUND → FAMILY_ALREADY_DISSOLVED。属性 (SECURITY DEFINER・
 *      search_path) は変えない。家族の行のロックは家族のほかの行・user_profiles への書き込みより先 (CLAUDE.md の家族のロック順)
 *   3. 本文は、読み出しを行全体にして 2 つの判定を足したことのほかは 20261019120000_self_dissolve.sql の定義 (:287-320) と同じ
 *      (コメントと空白を除いて比べる)
 *   4. migration は関数の本文の置き換えだけ (権限の付け外し・DROP・データを書き換える文が無い)
 *   5. 戻し口が実在し、20261019120000 の定義に逐語で戻す
 * 実際の挙動は tests/integration/security/self-dissolve.test.ts の D-17 と tests/integration/security/family-lock-order-race.test.ts の
 * B2・C5 (実 DB)、route の 404 / 409 は tests/operator-membership-rpc-errors-1917.test.ts が確かめる。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const MIGRATIONS_DIR = path.join(ROOT, 'supabase', 'migrations');
const MIGRATION = '20261026100000_operator_force_dissolve_family_missing';
const MIGRATION_PATH = path.join(MIGRATIONS_DIR, `${MIGRATION}.sql`);
const ROLLBACK_PATH = path.join(ROOT, 'supabase', 'rollbacks', `${MIGRATION}.down.sql`);
const FUNCTION_NAME = 'operator_force_dissolve_family';

/** 戻し先の定義: 20261019120000_self_dissolve.sql の operator_force_dissolve_family の行 (1 始まり・両端を含む) */
const PREVIOUS_SOURCE = { file: '20261019120000_self_dissolve.sql', from: 287, to: 320 } as const;

/** 修正で足した部分 (読み出しを行全体に・2 つの判定・代表者の控え) と、それが置き換えた修正前の読み出し (どちらもコメントを除き空白をまとめた形) */
const FIXED_READ_AND_GUARDS =
  "SELECT * INTO v_fam FROM family_groups WHERE id = p_family_id FOR NO KEY UPDATE; IF NOT FOUND THEN RAISE EXCEPTION 'FAMILY_NOT_FOUND' USING ERRCODE = 'P0001'; END IF; IF v_fam.status = 'dissolved' THEN RAISE EXCEPTION 'FAMILY_ALREADY_DISSOLVED' USING ERRCODE = 'P0001'; END IF; v_prev_rep := v_fam.representative_id;";
const PREVIOUS_READ = 'SELECT representative_id INTO v_prev_rep FROM family_groups WHERE id = p_family_id FOR NO KEY UPDATE;';

/** エラーの順番 (最新の定義の本文で、この順に現れる) */
const RAISE_ORDER = ['NOT_OPERATOR', 'OPERATOR_MFA_REQUIRED', 'FAMILY_NOT_FOUND', 'FAMILY_ALREADY_DISSOLVED'] as const;

interface FunctionDefinition {
  file: string;
  /** CREATE OR REPLACE FUNCTION から本文の開き ($$) まで (属性: SECURITY DEFINER・SET search_path など) */
  header: string;
  body: string;
  /** CREATE OR REPLACE から本文の閉じ ($$) と、それに続く ; までの全体 */
  whole: string;
}

/** SQL の行コメント (-- ...) を取り除く (コメントの中の語に反応しないため) */
const stripLineComments = (sql: string): string => sql.replace(/--.*$/gm, '');

/** 空白をまとめる (字下げ・改行の違いを無視して比べるため) */
const squash = (sql: string): string => sql.replace(/\s+/g, ' ').trim();

/** 関数 name の定義 (CREATE OR REPLACE FUNCTION) を、与えた SQL の出現順にすべて返す */
function definitionsIn(file: string, sql: string, name: string): FunctionDefinition[] {
  const found: FunctionDefinition[] = [];
  const pattern = new RegExp(`CREATE OR REPLACE FUNCTION\\s+(?:"?public"?\\.)?"?${name}"?\\s*\\(`, 'g');
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(sql))) {
    const rest = sql.slice(match.index);
    const opener = /\bAS\s+(\$[A-Za-z_]*\$)/.exec(rest);
    if (!opener) continue;
    const bodyStart = opener.index + opener[0].length;
    const bodyEnd = rest.indexOf(opener[1], bodyStart);
    if (bodyEnd < 0) continue;
    found.push({
      file,
      header: rest.slice(0, opener.index),
      body: rest.slice(bodyStart, bodyEnd),
      whole: rest.slice(0, bodyEnd + opener[1].length) + (rest[bodyEnd + opener[1].length] === ';' ? ';' : ''),
    });
  }
  return found;
}

const migrations = fs
  .readdirSync(MIGRATIONS_DIR)
  .filter((file) => file.endsWith('.sql'))
  .sort()
  .map((file) => ({ file, sql: fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8') }));

function latestDefinition(): FunctionDefinition {
  const all = migrations.flatMap(({ file, sql }) => definitionsIn(file, sql, FUNCTION_NAME));
  expect(all.length, `${FUNCTION_NAME} の定義が migration に見つからない`).toBeGreaterThan(0);
  return all[all.length - 1];
}

/** ファイルの from〜to 行 (1 始まり・両端を含む) を改行でつないで返す */
function linesOf(file: string, from: number, to: number): string {
  return fs
    .readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8')
    .split('\n')
    .slice(from - 1, to)
    .join('\n');
}

/** 本文の中で pattern が最初に現れる位置。無ければテストを落とす */
function indexOf(body: string, pattern: RegExp, label: string): number {
  const at = body.search(pattern);
  expect(at, `${label} が本文に無い`).toBeGreaterThanOrEqual(0);
  return at;
}

const FAMILY_ROW_LOCK = /\bFROM\s+(?:public\.)?family_groups\s+WHERE\s+id\s*=\s*p_family_id\s+FOR\s+NO\s+KEY\s+UPDATE\b/i;
const NOT_FOUND_RAISE = /IF\s+NOT\s+FOUND\s+THEN\s+RAISE\s+EXCEPTION\s+'FAMILY_NOT_FOUND'/i;
const DISSOLVED_RAISE = /IF\s+v_fam\.status\s*=\s*'dissolved'\s+THEN\s+RAISE\s+EXCEPTION\s+'FAMILY_ALREADY_DISSOLVED'/i;
const DISSOLVE_APPLY = /\bpublic\.family_dissolve_apply\s*\(/i;
const AUDIT_INSERT = /\bINSERT\s+INTO\s+(?:public\.)?membership_audit\b/i;
/** 家族の子の行・user_profiles への書き込み (家族の行のロックより後にだけ現れてよい) */
const CHILD_ROW_WRITE = /\bUPDATE\s+(?:public\.)?(?:family_members|user_profiles|family_groups)\b|\bFROM\s+(?:public\.)?(?:family_members|user_profiles)\b[^;]*\bFOR\s+(?:NO\s+KEY\s+)?UPDATE\b/i;

describe(`${MIGRATION}: ${FUNCTION_NAME} の最新の定義`, () => {
  it('migration のファイルが実在し、最新の定義はこの migration 以降にある (古い本文で上書きされていない)', () => {
    expect(fs.existsSync(MIGRATION_PATH)).toBe(true);
    expect(latestDefinition().file >= `${MIGRATION}.sql`).toBe(true);
  });

  it('家族の行を FOR NO KEY UPDATE で読んだ下で、行が無ければ FAMILY_NOT_FOUND・dissolved なら FAMILY_ALREADY_DISSOLVED。どちらも後始末と監査の INSERT より前', () => {
    const body = stripLineComments(latestDefinition().body);
    const lockAt = indexOf(body, FAMILY_ROW_LOCK, '家族の行のロック');
    const notFoundAt = indexOf(body, NOT_FOUND_RAISE, 'FAMILY_NOT_FOUND の判定');
    const dissolvedAt = indexOf(body, DISSOLVED_RAISE, 'FAMILY_ALREADY_DISSOLVED の判定');
    const applyAt = indexOf(body, DISSOLVE_APPLY, '後始末の呼び出し');
    const auditAt = indexOf(body, AUDIT_INSERT, 'membership_audit の INSERT');
    expect(lockAt).toBeLessThan(notFoundAt);
    expect(notFoundAt).toBeLessThan(dissolvedAt);
    expect(dissolvedAt).toBeLessThan(applyAt);
    expect(dissolvedAt).toBeLessThan(auditAt);
    // 判定に使う status は、ロックした行全体 (v_fam) から読む (ロックの外で読み直さない)
    expect(squash(body)).toContain('SELECT * INTO v_fam FROM family_groups WHERE id = p_family_id FOR NO KEY UPDATE;');
  });

  it('エラーの順番は NOT_OPERATOR → OPERATOR_MFA_REQUIRED → FAMILY_NOT_FOUND → FAMILY_ALREADY_DISSOLVED で、ほかの業務のコードは RAISE しない', () => {
    const body = stripLineComments(latestDefinition().body);
    const raised = [...body.matchAll(/RAISE\s+EXCEPTION\s+'([A-Z][A-Z0-9_]*)'/g)].map((m) => m[1]);
    expect(raised).toEqual([...RAISE_ORDER]);
    for (const code of raised) expect(body).toMatch(new RegExp(`RAISE\\s+EXCEPTION\\s+'${code}'\\s+USING\\s+ERRCODE\\s*=\\s*'P0001'`));
  });

  it('家族の行のロックは、家族のほかの行・user_profiles への書き込みより先 (CLAUDE.md の家族のロック順)', () => {
    const body = stripLineComments(latestDefinition().body);
    const lockAt = indexOf(body, FAMILY_ROW_LOCK, '家族の行のロック');
    const rest = body.slice(0, lockAt);
    expect(rest.search(CHILD_ROW_WRITE)).toBe(-1);
  });

  it('属性は SECURITY DEFINER・SET search_path = public のまま (名前・引数・戻り値の型も変えない)', () => {
    const header = squash(stripLineComments(latestDefinition().header));
    expect(header).toBe(
      'CREATE OR REPLACE FUNCTION public.operator_force_dissolve_family(p_family_id UUID, p_reason TEXT) RETURNS family_groups LANGUAGE plpgsql SECURITY DEFINER SET search_path = public',
    );
  });

  it('本文は、読み出しを行全体にして 2 つの判定を足したことのほかは 20261019120000 の定義と同じ (コメントと空白を除いて比べる)', () => {
    const latest = squash(stripLineComments(latestDefinition().whole));
    const previous = squash(stripLineComments(linesOf(PREVIOUS_SOURCE.file, PREVIOUS_SOURCE.from, PREVIOUS_SOURCE.to)));
    expect(previous).toContain(PREVIOUS_READ);
    expect(latest.split(FIXED_READ_AND_GUARDS)).toHaveLength(2);
    expect(latest.replace(FIXED_READ_AND_GUARDS, PREVIOUS_READ)).toBe(previous);
  });
});

describe(`${MIGRATION}: migration の形`, () => {
  const sql = fs.readFileSync(MIGRATION_PATH, 'utf-8');
  const outsideBodies = stripLineComments(sql).replace(/\$\$[\s\S]*?\$\$/g, '');

  it('関数の定義は operator_force_dissolve_family の 1 つだけ', () => {
    expect([...stripLineComments(sql).matchAll(/CREATE\s+OR\s+REPLACE\s+FUNCTION\s+(?:"?public"?\.)?"?(\w+)"?/gi)].map((m) => m[1])).toEqual([
      FUNCTION_NAME,
    ]);
  });

  it('権限の付け外し・DROP・データを書き換える文が無い (関数の本文の置き換えだけ。権限は CREATE OR REPLACE で残る)', () => {
    expect(outsideBodies).not.toMatch(/\b(?:GRANT|REVOKE|DROP|ALTER|UPDATE|INSERT|DELETE|TRUNCATE)\b/i);
  });

  it('1 行目の見出しと戻し方の案内が、このファイルと戻し口を指す', () => {
    const lines = sql.split('\n');
    expect(lines[0]).toBe(`-- migration: ${MIGRATION}.sql`);
    expect(lines[1]).toBe(`-- 戻し方: supabase/rollbacks/${MIGRATION}.down.sql`);
  });
});

describe(`${MIGRATION}: 戻し口`, () => {
  it('戻し口が実在し、operator_force_dissolve_family を 20261019120000 の定義 (:287-320) に逐語で戻す', () => {
    expect(fs.existsSync(ROLLBACK_PATH)).toBe(true);
    const rollback = fs.readFileSync(ROLLBACK_PATH, 'utf-8');
    expect(rollback.split('\n')[0]).toBe(`-- rollback: ${MIGRATION}.sql`);
    const definitions = definitionsIn(path.basename(ROLLBACK_PATH), rollback, FUNCTION_NAME);
    expect(definitions).toHaveLength(1);
    expect(definitions[0].whole).toBe(linesOf(PREVIOUS_SOURCE.file, PREVIOUS_SOURCE.from, PREVIOUS_SOURCE.to));
  });

  it('戻し口は関数の置き換えだけ (権限の付け外し・DROP・データを書き換える文が無い)', () => {
    const rollback = stripLineComments(fs.readFileSync(ROLLBACK_PATH, 'utf-8')).replace(/\$\$[\s\S]*?\$\$/g, '');
    expect(rollback).not.toMatch(/\b(?:GRANT|REVOKE|DROP|ALTER|UPDATE|INSERT|DELETE|TRUNCATE)\b/i);
  });
});
