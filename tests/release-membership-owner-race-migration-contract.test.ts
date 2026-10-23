/**
 * 退会の findBlocker のあとにオーナーになった人の所属を release_user_membership が外し、organizations.owner_id が所属の無い人を指す
 * 組織が残りうる欠陥の修正 (supabase/migrations/20261022160000_release_membership_owner_race.sql) を、ファイルどうしの突き合わせで確かめる
 * (DB には接続しない)。後の migration が同じ関数を古い本文で作り直してロックと判定を落とさないよう、各関数の「最新の定義」で見る。
 *
 *   1. release_user_membership: 所属をロックを取らずに読む → 組織の行 (FOR NO KEY UPDATE) → 本人の user_profiles (FOR NO KEY UPDATE) →
 *      所属が変わっていれば CONFLICT_RETRY / 何もしない → 本人が組織の行の owner_id なら IS_ORG_OWNER → 所属を外す の順。
 *      所属を外す書き込み (UPDATE・席数・監査) は前の定義と逐語で同じ。組織の行は 1 回だけ取り、取り直しのループは無い
 *   2. operator_force_owner_transfer: この migration の定義は、前の定義 (20261022140000) の、旧オーナーの行への UPDATE に
 *      AND organization_id = p_organization_id を足しただけ (権限・MFA・ロック・判定・エラーとその順番・監査・戻り値は同じ)。
 *      最新の定義 (20261023120000 が戻り値を jsonb にした。#1917) でも、在籍の条件つきの UPDATE が残っていること
 *   3. この migration は権限 (GRANT / REVOKE) を変えない
 *   4. 戻し口が実在し、2 つの関数を前の定義に逐語で戻す
 * 実際の挙動 (退会の所属の解放と譲渡の同時の実行) は tests/integration/security/org-transfer-toctou-release-membership.test.ts (実 DB) が確かめる。
 * 組織の行を最初に取る規則そのものは tests/org-transfer-toctou-migration-contract.test.ts も見る。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const MIGRATIONS_DIR = path.join(ROOT, 'supabase', 'migrations');
const MIGRATION = '20261022160000_release_membership_owner_race';
const ROLLBACK_PATH = path.join(ROOT, 'supabase', 'rollbacks', `${MIGRATION}.down.sql`);

/** 戻し先の定義: ファイルと、その中の関数の行 (1 始まり・両端を含む) */
const RESTORED_SOURCES = [
  { name: 'release_user_membership', file: '20251126124224_create_meal_planner_tables.sql', from: 2803, to: 2832 },
  { name: 'operator_force_owner_transfer', file: '20261022140000_org_transfer_toctou.sql', from: 191, to: 236 },
] as const;

/** ファイルの from〜to 行 (1 始まり・両端を含む) を改行でつないで返す */
function linesOf(file: string, from: number, to: number): string {
  return fs
    .readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8')
    .split('\n')
    .slice(from - 1, to)
    .join('\n');
}

const migrations = fs
  .readdirSync(MIGRATIONS_DIR)
  .filter((file) => file.endsWith('.sql'))
  .sort()
  .map((file) => ({ file, sql: fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8') }));

interface FunctionDefinition {
  file: string;
  /** CREATE OR REPLACE FUNCTION ... AS $$ の手前まで (属性: SECURITY DEFINER・SET search_path など) */
  header: string;
  body: string;
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
    found.push({ file, header: rest.slice(0, opener.index), body: rest.slice(bodyStart, bodyEnd) });
  }
  return found;
}

function latestOf(name: string): FunctionDefinition {
  const all = migrations.flatMap(({ file, sql }) => definitionsIn(file, sql, name));
  expect(all.length, `${name} の定義が migration に見つからない`).toBeGreaterThan(0);
  return all[all.length - 1];
}

/** この migration より前の最後の定義 */
function previousOf(name: string): FunctionDefinition {
  const earlier = migrations.filter(({ file }) => file < `${MIGRATION}.sql`).flatMap(({ file, sql }) => definitionsIn(file, sql, name));
  expect(earlier.length, `${name} の前の定義が見つからない`).toBeGreaterThan(0);
  return earlier[earlier.length - 1];
}

/** 本文の中で pattern が最初に現れる位置。無ければテストを落とす */
function indexOf(body: string, pattern: RegExp, label: string): number {
  const at = body.search(pattern);
  expect(at, `${label} が本文に無い`).toBeGreaterThanOrEqual(0);
  return at;
}

describe('release_user_membership の最新の定義', () => {
  const { file, header, body: rawBody } = latestOf('release_user_membership');
  const body = stripLineComments(rawBody);

  it('最新の定義はこの migration で、SECURITY DEFINER・search_path = public・RETURNS void のまま (前の定義と見出しが同じ)', () => {
    expect(file).toBe(`${MIGRATION}.sql`);
    expect(header, file).toMatch(/RETURNS\s+"void"/i);
    expect(header, file).toMatch(/SECURITY\s+DEFINER/i);
    expect(header, file).toMatch(/SET\s+"search_path"\s+TO\s+'public'/i);
    expect(squash(header)).toBe(squash(previousOf('release_user_membership').header));
  });

  it('所属の読み出し (ロックなし) → 組織の行 → 本人の行 → 所属の変化の判定 → IS_ORG_OWNER → 所属を外す書き込み の順', () => {
    const unlockedReadAt = indexOf(
      body,
      /SELECT\s+organization_id\s+INTO\s+v_org_id\s+FROM\s+user_profiles\s+WHERE\s+id\s*=\s*p_user_id\s*;/i,
      '所属の読み出し (ロックなし)',
    );
    const orgLockAt = indexOf(
      body,
      /SELECT\s+owner_id\s+INTO\s+v_org_owner_id\s+FROM\s+organizations\s+WHERE\s+id\s*=\s*v_org_id\s+FOR\s+NO\s+KEY\s+UPDATE\s*;/i,
      '組織の行のロック',
    );
    const profileLockAt = indexOf(
      body,
      /SELECT\s+organization_id\s+INTO\s+v_locked_org_id\s+FROM\s+user_profiles\s+WHERE\s+id\s*=\s*p_user_id\s+FOR\s+NO\s+KEY\s+UPDATE\s*;/i,
      '本人の行のロック',
    );
    const changedAt = indexOf(body, /IF\s+v_locked_org_id\s+IS\s+DISTINCT\s+FROM\s+v_org_id\s+THEN/i, '所属の変化の判定');
    const retryAt = indexOf(
      body,
      /IF\s+v_locked_org_id\s+IS\s+NOT\s+NULL\s+THEN\s+RAISE\s+EXCEPTION\s+'CONFLICT_RETRY'\s+USING\s+ERRCODE\s*=\s*'P0001'\s*;\s*END\s+IF\s*;\s*RETURN\s*;\s*END\s+IF\s*;/i,
      '別の組織なら CONFLICT_RETRY・所属が無ければ何もしない',
    );
    const ownerAt = indexOf(
      body,
      /IF\s+v_org_owner_id\s*=\s*p_user_id\s+THEN\s+RAISE\s+EXCEPTION\s+'IS_ORG_OWNER'\s+USING\s+ERRCODE\s*=\s*'P0001'\s*;/i,
      'オーナーの判定',
    );
    const writeAt = indexOf(body, /UPDATE\s+user_profiles\s+SET\s+organization_id\s*=\s*NULL/i, '所属を外す書き込み');
    const order = [unlockedReadAt, orgLockAt, profileLockAt, changedAt, retryAt, ownerAt, writeAt];
    expect(order, file).toEqual([...order].sort((a, b) => a - b));
  });

  it('組織の行は FOR NO KEY UPDATE で 1 回だけ取る (FOR UPDATE / FOR SHARE で取らない)。本人の行も FOR NO KEY UPDATE で 1 回だけ。取り直しのループは無い', () => {
    expect(body.match(/FROM\s+organizations\b[^;]*\bFOR\s+(?:NO\s+KEY\s+)?UPDATE/gi) ?? [], file).toHaveLength(1);
    expect(body, file).not.toMatch(/FROM\s+organizations\b[^;]*\bFOR\s+UPDATE/i);
    expect(body, file).not.toMatch(/\bFOR\s+(?:KEY\s+)?SHARE\b/i);
    expect(body.match(/FROM\s+user_profiles\b[^;]*\bFOR\s+(?:NO\s+KEY\s+)?UPDATE/gi) ?? [], file).toHaveLength(1);
    expect(body, file).not.toMatch(/FROM\s+user_profiles\b[^;]*\bFOR\s+UPDATE/i);
    expect(body, file).not.toMatch(/\bLOOP\b/i);
    // user_profiles の行を取る (書く) のは本人 (p_user_id) だけ
    const targets = body
      .split(';')
      .filter((statement) => /FROM\s+user_profiles\b[^;]*\bFOR\s+NO\s+KEY\s+UPDATE|\bUPDATE\s+user_profiles\b/i.test(statement))
      .map((statement) => /\bWHERE\s+id\s*=\s*([\w.()]+)/i.exec(statement)?.[1] ?? '(WHERE id = … が無い)');
    expect(new Set(targets), targets.join(', ')).toEqual(new Set(['p_user_id']));
  });

  it('所属を外す書き込み (UPDATE・席数を 1 減らす・監査の member_left) は前の定義と逐語で同じ', () => {
    const previous = squash(stripLineComments(previousOf('release_user_membership').body));
    const writeBlock = /UPDATE user_profiles SET organization_id = NULL[\s\S]*?END IF;/;
    const previousWrite = writeBlock.exec(previous)?.[0];
    expect(previousWrite, '前の定義に書き込みの塊が無い').toBeTruthy();
    expect(previousWrite).toContain("jsonb_build_object('reason', 'account_delete')");
    expect(squash(body)).toContain(previousWrite);
  });
});

describe('operator_force_owner_transfer: この migration の定義と最新の定義', () => {
  const ownDefinitions = definitionsIn(
    `${MIGRATION}.sql`,
    fs.readFileSync(path.join(MIGRATIONS_DIR, `${MIGRATION}.sql`), 'utf-8'),
    'operator_force_owner_transfer',
  );
  const latest = latestOf('operator_force_owner_transfer');
  const previous = previousOf('operator_force_owner_transfer');
  const oldOwnerWrite = "UPDATE user_profiles SET org_role = 'admin' WHERE id = v_old_owner_id;";
  const guardedOldOwnerWrite = "UPDATE user_profiles SET org_role = 'admin' WHERE id = v_old_owner_id AND organization_id = p_organization_id;";

  it('この migration の定義は 1 つで、前の定義 (20261022140000) と見出しが同じ。最新の定義はこの migration かそれより後 (20261023120000 が戻り値を jsonb にした。#1917)', () => {
    expect(ownDefinitions).toHaveLength(1);
    expect(previous.file).toBe('20261022140000_org_transfer_toctou.sql');
    expect(squash(ownDefinitions[0].header)).toBe(squash(previous.header));
    expect(latest.file >= `${MIGRATION}.sql`, latest.file).toBe(true);
  });

  it('コメントを除くと、この migration の定義は前の定義の旧オーナーの行への UPDATE に AND organization_id = p_organization_id を足しただけ', () => {
    const previousBody = squash(stripLineComments(previous.body));
    expect(previousBody).toContain(oldOwnerWrite);
    expect(squash(stripLineComments(ownDefinitions[0].body))).toBe(previousBody.replace(oldOwnerWrite, guardedOldOwnerWrite));
  });

  it('最新の定義でも、旧オーナーの org_role を書く文は、在籍の条件つきの 1 つだけ (条件の無い UPDATE は残っていない)', () => {
    const flat = squash(stripLineComments(latest.body));
    expect(flat.split(guardedOldOwnerWrite)).toHaveLength(2);
    expect(flat).not.toContain(oldOwnerWrite);
  });
});

describe('権限と見出し', () => {
  const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, `${MIGRATION}.sql`), 'utf-8');

  it('この migration は権限 (GRANT / REVOKE / ALTER FUNCTION) を変えない (CREATE OR REPLACE で既存の EXECUTE 権限が残る)', () => {
    const code = stripLineComments(sql);
    expect(code).not.toMatch(/\bGRANT\b/i);
    expect(code).not.toMatch(/\bREVOKE\b/i);
    expect(code).not.toMatch(/\bALTER\s+FUNCTION\b/i);
  });

  it('migration の 1 行目と戻し口の参照が自分を指す', () => {
    expect(sql.split('\n', 1)[0]).toBe(`-- migration: ${MIGRATION}.sql`);
    expect(sql).toContain(`supabase/rollbacks/${MIGRATION}.down.sql`);
  });

  it('この migration の version (先頭の 14 桁) は、ほかの migration と重ならない (main を取り込んだあとの番号の付け直しの見張り)', () => {
    const version = MIGRATION.slice(0, MIGRATION.indexOf('_'));
    expect(version).toMatch(/^\d{14}$/);
    expect(migrations.filter(({ file }) => file.startsWith(`${version}_`)).map(({ file }) => file)).toEqual([`${MIGRATION}.sql`]);
  });
});

describe('戻し口', () => {
  it('戻し口が実在し、1 行目が自分の migration を指す', () => {
    expect(fs.existsSync(ROLLBACK_PATH), ROLLBACK_PATH).toBe(true);
    const firstLine = fs.readFileSync(ROLLBACK_PATH, 'utf-8').split('\n', 1)[0];
    expect(firstLine).toBe(`-- rollback: ${MIGRATION}.sql`);
  });

  it('この migration が作り直す関数と、戻し口が戻す関数は同じ 2 つ', () => {
    const sql = stripLineComments(fs.readFileSync(path.join(MIGRATIONS_DIR, `${MIGRATION}.sql`), 'utf-8'));
    const rollback = stripLineComments(fs.readFileSync(ROLLBACK_PATH, 'utf-8'));
    const namesOf = (text: string) =>
      [...text.matchAll(/CREATE OR REPLACE FUNCTION\s+(?:"?public"?\.)?"?(\w+)"?\s*\(/g)].map((m) => m[1]).sort();
    const expected = RESTORED_SOURCES.map(({ name }) => name).sort();
    expect(namesOf(sql)).toEqual(expected);
    expect(namesOf(rollback)).toEqual(expected);
  });

  it.each(RESTORED_SOURCES)('$name を $file の :$from-$to に逐語で戻す (この migration より前の最後の定義)', ({ name, file, from, to }) => {
    const rollback = fs.readFileSync(ROLLBACK_PATH, 'utf-8');
    const source = linesOf(file, from, to);
    // 行の範囲が関数の定義の先頭と末尾を指していること (土台のファイルが書き換わって行がずれたら気づく)
    expect(source).toMatch(new RegExp(`^CREATE OR REPLACE FUNCTION "public"\\."${name}"\\(`));
    expect(source).toMatch(/END \$\$;$/);
    expect(rollback).toContain(source);
    expect(previousOf(name).file).toBe(file);
  });

  it('戻した release_user_membership は組織の行を取らず、IS_ORG_OWNER を返さない。戻した operator_force_owner_transfer は在籍の条件を持たない', () => {
    const sql = stripLineComments(fs.readFileSync(ROLLBACK_PATH, 'utf-8'));
    const restored = (name: string): string => {
      const defs = definitionsIn(ROLLBACK_PATH, sql, name);
      expect(defs, name).toHaveLength(1);
      return defs[0].body;
    };
    expect(restored('release_user_membership')).not.toMatch(/FROM\s+organizations\b/i);
    expect(restored('release_user_membership')).not.toMatch(/IS_ORG_OWNER/);
    expect(squash(restored('operator_force_owner_transfer'))).toContain("UPDATE user_profiles SET org_role = 'admin' WHERE id = v_old_owner_id;");
  });
});
