/**
 * #2120 W1: supabase/migrations/20261031100000_create_organization_owner_joined_at.sql (と、その戻し口) の文面の契約テスト
 * (DB は使わない)。
 *
 * 運営の組織の作成の関数 admin_create_organization が、オーナーの所属と一緒に加入日 (joined_org_at) と在籍の印
 * (is_active_in_org) を書くこと (招待の承諾と同じ値) を、番号の付け直しや後の migration の上書きで崩れないように、
 * ファイルの文面だけで確かめる。実 DB での値と、メンバーの一覧の API の応答は tests/integration/security/org-create-atomic.test.ts の OC-11。
 *   1. 関数の最新の定義はこの migration で、版は前の最大より大きい
 *   2. オーナーの所属の UPDATE は organization_id・org_role = 'owner'・joined_org_at = CURRENT_DATE・is_active_in_org = TRUE の 4 列
 *   3. 前の定義 (20261030150000) との違いは、その UPDATE だけ (見出し・ほかの本文・権限は同じ)
 *   4. 加入日と在籍の印の値は、招待の承諾 (accept_org_invite の最新の定義) が書く値 (CURRENT_DATE・TRUE) と同じ
 *   5. 関数の外で表・行を変えない (既存の行の埋め戻しをしない)
 *   6. 戻し口は前の定義を CREATE OR REPLACE で書き戻す (関数を消さない。運営の作成 API が失敗しないように)
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const MIGRATIONS_DIR = path.join(ROOT, 'supabase', 'migrations');
const MIGRATION = '20261031100000_create_organization_owner_joined_at';
/** この関数の前の定義 (オーナーの所属は organization_id と org_role の 2 列だけを書く。#2107 Y4) */
const PREVIOUS_MIGRATION = '20261030150000_create_organization_atomic';
const ROLLBACK_PATH = path.join(ROOT, 'supabase', 'rollbacks', `${MIGRATION}.down.sql`);
/** この migration を足したときの origin/main の最大の版 (これより大きくなければ本番へ当たらない) */
const PREVIOUS_MAX_VERSION = '20261030160000';
const FN = 'admin_create_organization';
const SIGNATURE = `public.${FN}(text, text, uuid)`;
const INVITE_ACCEPT_FN = 'accept_org_invite';

/** 前の定義のオーナーの所属の UPDATE (空白をまとめた形) */
const PREVIOUS_MEMBERSHIP_UPDATE = "UPDATE user_profiles SET organization_id = v_org.id, org_role = 'owner' WHERE id = p_owner_id;";
/** この migration のオーナーの所属の UPDATE (空白をまとめた形) */
const MEMBERSHIP_UPDATE =
  "UPDATE user_profiles SET organization_id = v_org.id, org_role = 'owner', joined_org_at = CURRENT_DATE, is_active_in_org = TRUE WHERE id = p_owner_id;";

const read = (file: string): string => fs.readFileSync(file, 'utf-8');
/** SQL の行コメント (-- ...) を取り除く (コメントの中の語に反応しないため) */
const stripLineComments = (sql: string): string => sql.replace(/--.*$/gm, '');
/** 空白をまとめる (字下げ・改行の違いを無視して比べるため) */
const squash = (text: string): string => text.replace(/\s+/g, ' ').trim();
const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const migrations = fs
  .readdirSync(MIGRATIONS_DIR)
  .filter((file) => file.endsWith('.sql'))
  .sort()
  .map((file) => ({ file, sql: read(path.join(MIGRATIONS_DIR, file)) }));

const definesFunction = (fn: string) => (text: string): boolean =>
  new RegExp(String.raw`CREATE\s+OR\s+REPLACE\s+FUNCTION\s+(?:"?public"?\.)?"?${fn}"?\s*\(`, 'i').test(text);

const sql = read(path.join(MIGRATIONS_DIR, `${MIGRATION}.sql`));
const previousSql = read(path.join(MIGRATIONS_DIR, `${PREVIOUS_MIGRATION}.sql`));

/** 関数の定義 (CREATE OR REPLACE FUNCTION ... AS $$ ... $$) の見出しと本文と、定義の外の文 */
function definitionOf(source: string, fn: string): { header: string; body: string; outside: string } {
  const start = source.search(new RegExp(String.raw`CREATE OR REPLACE FUNCTION (?:"?public"?\.)?"?${fn}"?\s*\(`));
  expect(start, `${fn} の定義が無い`).toBeGreaterThanOrEqual(0);
  const rest = source.slice(start);
  const opener = /\bAS\s+(\$[A-Za-z_]*\$)/.exec(rest);
  expect(opener, `${fn} の本文の始まりが無い`).not.toBeNull();
  const bodyStart = opener!.index + opener![0].length;
  const bodyEnd = rest.indexOf(opener![1], bodyStart);
  expect(bodyEnd, `${fn} の本文の終わりが無い`).toBeGreaterThan(bodyStart);
  return {
    header: rest.slice(0, opener!.index),
    body: rest.slice(bodyStart, bodyEnd),
    outside: source.slice(0, start) + rest.slice(bodyEnd + opener![1].length),
  };
}

const current = definitionOf(sql, FN);
const previous = definitionOf(previousSql, FN);
const body = squash(stripLineComments(current.body));
const previousBody = squash(stripLineComments(previous.body));

describe(`${FN} の最新の定義 (#2120 W1)`, () => {
  it('関数の最新の定義はこの migration。版は前の最大より大きい', () => {
    const definers = migrations.filter(({ sql: text }) => definesFunction(FN)(text)).map(({ file }) => file);
    expect(definers.at(-1)).toBe(`${MIGRATION}.sql`);
    expect(MIGRATION.slice(0, PREVIOUS_MAX_VERSION.length) > PREVIOUS_MAX_VERSION).toBe(true);
    expect(sql.split('\n', 1)[0]).toBe(`-- migration: ${MIGRATION}.sql`);
    expect(sql).toContain(`supabase/rollbacks/${MIGRATION}.down.sql`);
  });

  it("オーナーの所属の UPDATE は organization_id・org_role = 'owner'・joined_org_at = CURRENT_DATE・is_active_in_org = TRUE を書く (UPDATE は 1 つだけ)", () => {
    expect(body.match(/\bUPDATE user_profiles\b/g)).toHaveLength(1);
    expect(body).toContain(MEMBERSHIP_UPDATE);
  });

  it('前の定義との違いは、オーナーの所属の UPDATE だけ (見出し・ほかの本文・権限は同じ)', () => {
    expect(previousBody).toContain(PREVIOUS_MEMBERSHIP_UPDATE);
    expect(body).toBe(previousBody.replace(PREVIOUS_MEMBERSHIP_UPDATE, MEMBERSHIP_UPDATE));
    expect(squash(current.header)).toBe(squash(previous.header));
    const grantsOf = (source: string): string[] =>
      squash(stripLineComments(source))
        .split(';')
        .map((statement) => statement.trim())
        .filter((statement) => /^(?:REVOKE|GRANT)\b/.test(statement));
    expect(grantsOf(current.outside)).toEqual([
      `REVOKE ALL ON FUNCTION ${SIGNATURE} FROM PUBLIC, anon, authenticated, service_role`,
      `GRANT EXECUTE ON FUNCTION ${SIGNATURE} TO service_role`,
    ]);
    expect(grantsOf(current.outside)).toEqual(grantsOf(previous.outside));
  });

  it('加入日と在籍の印の値は、招待の承諾 (accept_org_invite の最新の定義) が書く値 (CURRENT_DATE・TRUE) と同じ', () => {
    const inviteDefiners = migrations.filter(({ sql: text }) => definesFunction(INVITE_ACCEPT_FN)(text));
    expect(inviteDefiners.length).toBeGreaterThan(0);
    const latestInvite = inviteDefiners.at(-1)!;
    const inviteBody = squash(stripLineComments(definitionOf(latestInvite.sql, INVITE_ACCEPT_FN).body));
    // 招待の承諾は、所属の列を INSERT の VALUES (… invited_role, CURRENT_DATE, TRUE) で入れ、行があれば EXCLUDED の値で上書きする
    expect(inviteBody, latestInvite.file).toMatch(
      /\(\s?id, nickname, age_group, gender, organization_id, org_role, joined_org_at, is_active_in_org\s?\) VALUES \(.*v_invite\.invited_role, CURRENT_DATE, TRUE\)/,
    );
    expect(inviteBody, latestInvite.file).toContain('joined_org_at = EXCLUDED.joined_org_at');
    expect(inviteBody, latestInvite.file).toContain('is_active_in_org = EXCLUDED.is_active_in_org');
  });

  it('関数の外で表・行を変えない (既存の加入日が空の行を埋め戻さない)', () => {
    // 定義の外 = 関数の見出し・本文より前と後。文字列 (関数のコメントの文) の中の語には反応しない
    const outside = squash(stripLineComments(current.outside)).replace(/'(?:[^']|'')*'/g, "''");
    const statements = outside
      .split(';')
      .map((statement) => statement.trim())
      .filter((statement) => statement !== '');
    const kinds = statements.map((statement) => statement.split(' ', 1)[0]);
    expect(kinds).toEqual(['SET', 'COMMENT', 'REVOKE', 'GRANT']);
    expect(outside).not.toMatch(/\b(?:UPDATE|DELETE|INSERT|ALTER|DROP|TRUNCATE)\b/);
  });
});

describe('戻し口', () => {
  const rollback = read(ROLLBACK_PATH);

  it('1 行目が自分の migration を指し、前の定義 (20261030150000) の文をそのまま書き戻す (関数を消さない)', () => {
    expect(rollback.split('\n', 1)[0]).toBe(`-- rollback: ${MIGRATION}.sql`);
    expect(squash(stripLineComments(rollback))).toBe(squash(stripLineComments(previousSql)));
    expect(rollback).not.toMatch(new RegExp(String.raw`DROP\s+FUNCTION[^;]*${escapeRegExp(FN)}`, 'i'));
    const rolledBack = definitionOf(rollback, FN);
    expect(squash(stripLineComments(rolledBack.body))).toContain(PREVIOUS_MEMBERSHIP_UPDATE);
    expect(squash(stripLineComments(rolledBack.body))).not.toContain('joined_org_at');
  });
});
