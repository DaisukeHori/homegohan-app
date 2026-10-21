/**
 * #1912 (billing/03 段 A の家族の門の取りこぼし): 招待の作成 create_family_invite の家族プランの門
 * (supabase/migrations/20261022130000_family_invite_plan_gate.sql) を、ファイルどうしの突き合わせで確かめる (DB には接続しない)。
 *
 * 後の migration が create_family_invite を CREATE OR REPLACE し直すとき (古い本文をそのまま写すとき) に門を落とさないよう、
 * 「最新の定義」(supabase/migrations を version 順に見て、最後に CREATE OR REPLACE したもの) で確かめる。
 *
 *   1. 最新の定義が、グループの plan_key と status を読み、active で plan_key = free なら FAMILY_PLAN_REQUIRED で止める
 *   2. 判定の式が、承諾の門のトリガー family_members_billing_plan_gate の最新の定義と同じ (「作れたのに承諾で断られる」を作らない)
 *   3. 位置: 認可 (NOT_FAMILY_ADULT) の後・人数上限 (MEMBER_LIMIT_EXCEEDED)・24 時間上限 (enforce_membership_daily_cap)・
 *      最初の書き込みより前。既存のエラーの順番 (NOT_FAMILY_ADULT → MEMBER_LIMIT_EXCEEDED → RATE_LIMITED) は変えない
 *   4. ロックを足さない (家族の行のロック順 (CLAUDE.md) を変えない)。引数・戻り値・SECURITY DEFINER・search_path は変えない
 *   5. 本冊の migration の定義は、20261008100000 の定義の逐語に、変数 2 つと判定のかたまりを足しただけ
 *   6. 戻し口が実在し、20261008100000 の定義に逐語で戻す
 * 実際の挙動は tests/integration/security/family-plan-gate.test.ts (実 DB) が確かめる。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const MIGRATIONS_DIR = path.join(ROOT, 'supabase', 'migrations');
const MIGRATION = '20261022130000_family_invite_plan_gate';
const MIGRATION_PATH = path.join(MIGRATIONS_DIR, `${MIGRATION}.sql`);
const ROLLBACK_PATH = path.join(ROOT, 'supabase', 'rollbacks', `${MIGRATION}.down.sql`);

/** 戻し先 (= 本冊が土台にした) 定義: ファイルと、その中の関数の行 (1 始まり・両端を含む) */
const BASE_SOURCE = { file: '20261008100000_membership_daily_send_cap.sql', from: 256, to: 308 } as const;

/** 本冊が土台の定義に足した変数の行 (DECLARE の末尾) */
const ADDED_DECLARE_LINES = ['  v_plan_key TEXT;', '  v_group_status TEXT;'] as const;
/** 本冊が足した判定のかたまりの最初の行 (コメント) と、かたまりの最後の行 */
const GATE_BLOCK_FIRST_LINE = '  -- billing/03 §6.6 (#1912): 家族プランの無いグループ (plan_key = free の active なグループ) には招待を作らない。';
const GATE_BLOCK_LAST_LINE = '  END IF;';

const migrations = fs
  .readdirSync(MIGRATIONS_DIR)
  .filter((file) => file.endsWith('.sql'))
  .sort()
  .map((file) => ({ file, sql: fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8') }));

interface FunctionDefinition {
  file: string;
  /** CREATE OR REPLACE FUNCTION ... AS $$ の手前まで (引数・戻り値・SECURITY DEFINER・SET search_path など) */
  header: string;
  body: string;
  /** CREATE OR REPLACE FUNCTION から本文の閉じ ($$;) までの全文 */
  text: string;
}

/** SQL の行コメント (-- ...) を取り除く (コメントの中の語に反応しないため) */
const stripLineComments = (sql: string): string => sql.replace(/--.*$/gm, '');

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
    const closeEnd = rest.indexOf(';', bodyEnd) + 1;
    found.push({
      file,
      header: rest.slice(0, opener.index),
      body: rest.slice(bodyStart, bodyEnd),
      text: rest.slice(0, closeEnd),
    });
  }
  return found;
}

function latestOf(name: string): FunctionDefinition {
  const all = migrations.flatMap(({ file, sql }) => definitionsIn(file, sql, name));
  expect(all.length, `${name} の定義が migration に見つからない`).toBeGreaterThan(0);
  return all[all.length - 1];
}

/** 本文の中で pattern が最初に現れる位置。無ければテストを落とす */
function indexOf(body: string, pattern: RegExp, label: string): number {
  const at = body.search(pattern);
  expect(at, `${label} が本文に無い`).toBeGreaterThanOrEqual(0);
  return at;
}

/** 最初の書き込み文の位置 (tests/membership-daily-cap-contract.test.ts と同じ見方) */
function firstWriteIndex(body: string): number {
  const write = /\b(?:INSERT\s+INTO|DELETE\s+FROM)\b|(?<!FOR\s)\bUPDATE\s+[A-Za-z_."]+\s+SET\b/i.exec(body);
  return write ? write.index : Infinity;
}

/** 土台の定義 (20261008100000 の :256-308) の全文 */
function baseDefinitionText(): string {
  return fs
    .readFileSync(path.join(MIGRATIONS_DIR, BASE_SOURCE.file), 'utf-8')
    .split('\n')
    .slice(BASE_SOURCE.from - 1, BASE_SOURCE.to)
    .join('\n');
}

/** 承諾の門 (トリガー) と招待の作成の門が使う判定の式: グループが active で plan_key = free */
const FREE_ACTIVE_GROUP_TEST = /IF\s+(v_[a-z_]*status)\s*=\s*'active'\s+AND\s+(v_plan_key)\s*=\s*'free'\s+THEN\s+RAISE\s+EXCEPTION\s+'FAMILY_PLAN_REQUIRED'/i;

describe('#1912 create_family_invite の最新の定義: 家族プランの門', () => {
  const { file, header, body: rawBody } = latestOf('create_family_invite');
  const body = stripLineComments(rawBody);

  it('最新の定義は本冊の migration (後の migration が置き換えるなら、門を残して積むこと)', () => {
    expect(file).toBe(`${MIGRATION}.sql`);
  });

  it('引数・戻り値・SECURITY DEFINER・search_path = public は変えない', () => {
    expect(header, file).toMatch(/p_family_id\s+UUID\s*,\s*p_email\s+TEXT\s*,\s*p_custom_message\s+TEXT\s+DEFAULT\s+NULL\s*\)/i);
    expect(header, file).toMatch(/RETURNS\s+public\.family_invites/i);
    expect(header, file).toMatch(/SECURITY\s+DEFINER/i);
    expect(header, file).toMatch(/SET\s+search_path\s*=\s*public\b/i);
  });

  it('グループの plan_key と status を読み、active で plan_key = free なら FAMILY_PLAN_REQUIRED (P0001) で止める', () => {
    expect(body, file).toMatch(
      /SELECT\s+plan_key\s*,\s*status\s+INTO\s+v_plan_key\s*,\s*v_group_status\s+FROM\s+family_groups\s+WHERE\s+id\s*=\s*p_family_id\s*;/i,
    );
    expect(body, file).toMatch(
      /IF\s+v_group_status\s*=\s*'active'\s+AND\s+v_plan_key\s*=\s*'free'\s+THEN\s+RAISE\s+EXCEPTION\s+'FAMILY_PLAN_REQUIRED'\s+USING\s+ERRCODE\s*=\s*'P0001'/i,
    );
    expect(body.match(/'FAMILY_PLAN_REQUIRED'/g) ?? [], file).toHaveLength(1);
  });

  it('判定の式は、承諾の門のトリガー family_members_billing_plan_gate の最新の定義と同じ (active AND plan_key = free)', () => {
    const trigger = latestOf('family_members_billing_plan_gate');
    const triggerBody = stripLineComments(trigger.body);
    expect(triggerBody, trigger.file).toMatch(FREE_ACTIVE_GROUP_TEST);
    expect(triggerBody, trigger.file).toMatch(/SELECT\s+g\.plan_key\s*,\s*g\.status\s+INTO\s+v_plan_key\s*,\s*v_status\s+FROM\s+public\.family_groups/i);
    expect(body, file).toMatch(FREE_ACTIVE_GROUP_TEST);
  });

  it('位置: 認可 (NOT_FAMILY_ADULT) → 家族プランの門 → 人数上限 → 24 時間上限 → 最初の書き込み (既存のエラーの順番は変えない)', () => {
    const authAt = indexOf(body, /RAISE\s+EXCEPTION\s+'NOT_FAMILY_ADULT'/i, '認可');
    const planReadAt = indexOf(body, /SELECT\s+plan_key\s*,\s*status\s+INTO\s+v_plan_key/i, 'グループのプランの読み取り');
    const gateAt = indexOf(body, /RAISE\s+EXCEPTION\s+'FAMILY_PLAN_REQUIRED'/i, '家族プランの門');
    const limitAt = indexOf(body, /RAISE\s+EXCEPTION\s+'MEMBER_LIMIT_EXCEEDED'/i, '人数上限');
    const capAt = indexOf(body, /PERFORM\s+public\.enforce_membership_daily_cap\(\s*'family_invite'/i, '24 時間上限');
    expect(planReadAt, file).toBeGreaterThan(authAt);
    expect(gateAt, file).toBeGreaterThan(planReadAt);
    expect(limitAt, file).toBeGreaterThan(gateAt);
    expect(capAt, file).toBeGreaterThan(limitAt);
    expect(firstWriteIndex(body), file).toBeGreaterThan(capAt);
  });

  it('行のロックを取らない (家族の行のロック順を変えない。土台の定義もロックを取らない)', () => {
    expect(body, file).not.toMatch(/\bFOR\s+(?:NO\s+KEY\s+)?UPDATE\b/i);
    expect(body, file).not.toMatch(/\bFOR\s+(?:KEY\s+)?SHARE\b/i);
    expect(body, file).not.toMatch(/pg_advisory/i);
  });
});

describe('#1912 本冊の migration の定義は土台の逐語 + 門だけ', () => {
  it('migration の 1 行目が自分を指し、lock_timeout を置いてから関数を置き換える', () => {
    const sql = fs.readFileSync(MIGRATION_PATH, 'utf-8');
    expect(sql.split('\n', 1)[0]).toBe(`-- migration: ${MIGRATION}.sql`);
    const lockTimeoutAt = sql.search(/^SET LOCAL lock_timeout = '10s';$/m);
    const functionAt = sql.search(/^CREATE OR REPLACE FUNCTION public\.create_family_invite\(/m);
    expect(lockTimeoutAt).toBeGreaterThanOrEqual(0);
    expect(functionAt).toBeGreaterThan(lockTimeoutAt);
  });

  it(`足した変数 2 行と判定のかたまりを除くと、${BASE_SOURCE.file} の :${BASE_SOURCE.from}-${BASE_SOURCE.to} と逐語で一致する`, () => {
    const base = baseDefinitionText();
    // 行の範囲が関数の定義の先頭と末尾を指していること (土台のファイルが書き換わって行がずれたら気づく)
    expect(base).toMatch(/^CREATE OR REPLACE FUNCTION public\.create_family_invite\(/);
    expect(base).toMatch(/END \$\$;$/);

    const definitions = definitionsIn(MIGRATION_PATH, fs.readFileSync(MIGRATION_PATH, 'utf-8'), 'create_family_invite');
    expect(definitions).toHaveLength(1);
    const lines = definitions[0].text.split('\n');
    for (const added of ADDED_DECLARE_LINES) {
      expect(lines.filter((line) => line === added), added).toHaveLength(1);
    }
    const blockStart = lines.indexOf(GATE_BLOCK_FIRST_LINE);
    expect(blockStart, '判定のかたまりの最初の行').toBeGreaterThan(0);
    const blockEnd = lines.indexOf(GATE_BLOCK_LAST_LINE, blockStart);
    expect(blockEnd).toBeGreaterThan(blockStart);
    expect(lines.slice(blockStart, blockEnd + 1).join('\n')).toMatch(/'FAMILY_PLAN_REQUIRED'/);
    // かたまりの前の空行も足したもの
    expect(lines[blockStart - 1]).toBe('');
    const stripped = [...lines.slice(0, blockStart - 1), ...lines.slice(blockEnd + 1)].filter(
      (line) => !(ADDED_DECLARE_LINES as readonly string[]).includes(line),
    );
    expect(stripped.join('\n')).toBe(base);
  });
});

describe('#1912 戻し口', () => {
  it('戻し口が実在し、1 行目が自分の migration を指す', () => {
    expect(fs.existsSync(ROLLBACK_PATH), ROLLBACK_PATH).toBe(true);
    const firstLine = fs.readFileSync(ROLLBACK_PATH, 'utf-8').split('\n', 1)[0];
    expect(firstLine).toBe(`-- rollback: ${MIGRATION}.sql`);
  });

  it(`create_family_invite を ${BASE_SOURCE.file} の :${BASE_SOURCE.from}-${BASE_SOURCE.to} に逐語で戻し、門を含まない`, () => {
    const rollback = fs.readFileSync(ROLLBACK_PATH, 'utf-8');
    expect(rollback).toContain(baseDefinitionText());
    const definitions = definitionsIn(ROLLBACK_PATH, stripLineComments(rollback), 'create_family_invite');
    expect(definitions).toHaveLength(1);
    expect(definitions[0].body).not.toMatch(/FAMILY_PLAN_REQUIRED/);
  });
});
