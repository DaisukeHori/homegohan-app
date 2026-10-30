/**
 * #2107 Y4: supabase/migrations/20261030150000_create_organization_atomic.sql (と、その戻し口) の文面の契約テスト (DB は使わない)。
 *
 * 運営の組織の作成を 1 つのトランザクションで書く関数 admin_create_organization の、番号の付け直しや後の migration の上書きで
 * 崩れやすい所を、ファイルの文面だけで確かめる。実 DB での振る舞い (同じオーナーの同時の作成は 1 つだけ通る・権限) は
 * tests/integration/security/org-create-atomic.test.ts。
 *   1. 最新の定義はこの migration で、SECURITY DEFINER・search_path = public・RETURNS jsonb
 *   2. 本文の順は CLAUDE.md の組織のロック順 ((2) 組織の行 → (3) user_profiles → (4) org_license_pools) に合う:
 *      organizations の INSERT → プロフィールの行が無ければ作る → オーナーの行を FOR NO KEY UPDATE で読む → 所属していれば
 *      OWNER_ALREADY_IN_ORG → 所属を書く → 席の行 → 戻り値。所属の確認は、その行のロックより後で、どの書き込み (所属・席の行) よりも前
 *   3. 行のロックは FOR NO KEY UPDATE だけ (FOR UPDATE は外部キーの確認 (FOR KEY SHARE) と待ち合う。CLAUDE.md)
 *   4. 実行権限は service_role だけ (PUBLIC・anon・authenticated から外す)
 *   5. 戻し口は同じ関数 (引数の型まで) を消すだけ
 *   6. 運営の作成 API は、この関数を呼ぶだけで、organizations・org_license_pools・user_profiles に直接触らない
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const MIGRATIONS_DIR = path.join(ROOT, 'supabase', 'migrations');
const MIGRATION = '20261030150000_create_organization_atomic';
const ROLLBACK_PATH = path.join(ROOT, 'supabase', 'rollbacks', `${MIGRATION}.down.sql`);
/** この migration を足したときの origin/main の最大の版 (これより大きくなければ本番へ当たらない) */
const PREVIOUS_MAX_VERSION = '20261030120000';
const FN = 'admin_create_organization';
const SIGNATURE = `public.${FN}(text, text, uuid)`;
const ROUTE = 'src/app/api/admin/organizations/route.ts';

const read = (file: string): string => fs.readFileSync(file, 'utf-8');
/** SQL の行コメント (-- ...) を取り除く (コメントの中の語に反応しないため) */
const stripLineComments = (sql: string): string => sql.replace(/--.*$/gm, '');
/** 空白をまとめる (字下げ・改行の違いを無視して比べるため) */
const squash = (text: string): string => text.replace(/\s+/g, ' ').trim();

const migrations = fs
  .readdirSync(MIGRATIONS_DIR)
  .filter((file) => file.endsWith('.sql'))
  .sort()
  .map((file) => ({ file, sql: read(path.join(MIGRATIONS_DIR, file)) }));

const sql = read(path.join(MIGRATIONS_DIR, `${MIGRATION}.sql`));
const code = squash(stripLineComments(sql));

/** 関数の定義 (CREATE OR REPLACE FUNCTION ... AS $$ ... $$) の見出しと本文 */
function definitionOf(source: string): { header: string; body: string } {
  const start = source.search(new RegExp(String.raw`CREATE OR REPLACE FUNCTION public\.${FN}\s*\(`));
  expect(start, `${FN} の定義が無い`).toBeGreaterThanOrEqual(0);
  const rest = source.slice(start);
  const opener = /\bAS\s+(\$[A-Za-z_]*\$)/.exec(rest);
  expect(opener, `${FN} の本文の始まりが無い`).not.toBeNull();
  const bodyStart = opener!.index + opener![0].length;
  const bodyEnd = rest.indexOf(opener![1], bodyStart);
  return { header: rest.slice(0, opener!.index), body: rest.slice(bodyStart, bodyEnd) };
}

const { header, body: rawBody } = definitionOf(sql);
const body = squash(stripLineComments(rawBody));

/** 本文の中で pattern が最初に現れる位置。無ければテストを落とす */
function indexOf(pattern: RegExp, label: string): number {
  const at = body.search(pattern);
  expect(at, `${label} が本文に無い`).toBeGreaterThanOrEqual(0);
  return at;
}

describe('admin_create_organization の定義', () => {
  it('この関数を定義する migration はこれだけ (後の migration が上書きしていない)。版は前の最大より大きい', () => {
    const definers = migrations
      .filter(({ sql: text }) => new RegExp(String.raw`CREATE\s+OR\s+REPLACE\s+FUNCTION\s+(?:"?public"?\.)?"?${FN}"?\s*\(`, 'i').test(text))
      .map(({ file }) => file);
    expect(definers).toEqual([`${MIGRATION}.sql`]);
    expect(MIGRATION.slice(0, PREVIOUS_MAX_VERSION.length) > PREVIOUS_MAX_VERSION).toBe(true);
    expect(sql.split('\n', 1)[0]).toBe(`-- migration: ${MIGRATION}.sql`);
    expect(sql).toContain(`supabase/rollbacks/${MIGRATION}.down.sql`);
  });

  it('SECURITY DEFINER・search_path = public・RETURNS jsonb・引数は (p_name text, p_plan text, p_owner_id uuid)', () => {
    const head = squash(header);
    expect(head).toContain(`CREATE OR REPLACE FUNCTION public.${FN}(p_name text, p_plan text, p_owner_id uuid)`);
    expect(head).toContain('RETURNS jsonb');
    expect(head).toContain('SECURITY DEFINER');
    expect(head).toContain('SET search_path = public');
  });

  it('組織の行 → オーナーの行 (無ければ作る → FOR NO KEY UPDATE で読む) → 所属の確認 → 所属を書く → 席の行 → 戻り値 の順', () => {
    const insertOrg = indexOf(/INSERT INTO organizations \(name, plan, owner_id\) VALUES \(p_name, p_plan, p_owner_id\) RETURNING \* INTO v_org;/, '組織の行の INSERT');
    const ensureProfile = indexOf(
      /INSERT INTO user_profiles \(id, nickname, age_group, gender\) VALUES \(p_owner_id, 'Guest', 'unspecified', 'unspecified'\) ON CONFLICT \(id\) DO NOTHING;/,
      'プロフィールの行が無いときの作成',
    );
    const lockProfile = indexOf(
      /SELECT organization_id INTO v_owner_org_id FROM user_profiles WHERE id = p_owner_id FOR NO KEY UPDATE;/,
      'オーナーの行のロック',
    );
    const check = indexOf(
      /IF v_owner_org_id IS NOT NULL THEN RAISE EXCEPTION 'OWNER_ALREADY_IN_ORG' USING ERRCODE = 'P0001'; END IF;/,
      '所属の確認',
    );
    const writeMembership = indexOf(
      /UPDATE user_profiles SET organization_id = v_org\.id, org_role = 'owner' WHERE id = p_owner_id;/,
      '所属の書き込み',
    );
    const insertPool = indexOf(
      /INSERT INTO org_license_pools \(organization_id, total_licenses, used_licenses\) VALUES \(v_org\.id, NULL, 0\);/,
      '席の行の INSERT',
    );
    const returned = indexOf(/RETURN jsonb_build_object\(/, '戻り値');
    expect([insertOrg, ensureProfile, lockProfile, check, writeMembership, insertPool, returned]).toEqual(
      [insertOrg, ensureProfile, lockProfile, check, writeMembership, insertPool, returned].slice().sort((a, b) => a - b),
    );
  });

  it('所属の確認は、オーナーの行を読むたった 1 回の SELECT (ロックの下) の値で行う。ロックの外で読んだ値は使わない', () => {
    expect(body.match(/\bFROM user_profiles\b/g)).toHaveLength(1);
    // 宣言・ロックの下の SELECT の INTO・確認の IF の 3 か所だけ
    expect(body.match(/\bv_owner_org_id\b/g)).toHaveLength(3);
  });

  it('行のロックは FOR NO KEY UPDATE だけ (FOR UPDATE・FOR SHARE を使わない)', () => {
    expect(body).not.toMatch(/\bFOR UPDATE\b/);
    expect(body).not.toMatch(/\bFOR (?:KEY )?SHARE\b/);
  });

  it('戻り値は作った組織の id・name・plan・owner_id・created_at・updated_at (route の応答の organization と同じ列)', () => {
    expect(body).toContain(
      "RETURN jsonb_build_object( 'id', v_org.id, 'name', v_org.name, 'plan', v_org.plan, 'owner_id', v_org.owner_id, 'created_at', v_org.created_at, 'updated_at', v_org.updated_at );",
    );
  });

  it('実行権限は service_role だけ (PUBLIC・anon・authenticated から外す)', () => {
    expect(code).toContain(`REVOKE ALL ON FUNCTION ${SIGNATURE} FROM PUBLIC, anon, authenticated, service_role;`);
    const grants = [...code.matchAll(new RegExp(String.raw`GRANT EXECUTE ON FUNCTION ${SIGNATURE.replace(/[().]/g, '\\$&')} TO ([^;]+);`, 'g'))].map(
      (m) => m[1],
    );
    expect(grants).toEqual(['service_role']);
  });
});

describe('戻し口', () => {
  it('1 行目が自分の migration を指し、同じ関数 (引数の型まで) を消すだけ', () => {
    const rollback = read(ROLLBACK_PATH);
    expect(rollback.split('\n', 1)[0]).toBe(`-- rollback: ${MIGRATION}.sql`);
    const statements = squash(stripLineComments(rollback))
      .split(';')
      .map((statement) => statement.trim())
      .filter((statement) => statement !== '');
    expect(statements).toEqual([`SET LOCAL lock_timeout = '10s'`, `DROP FUNCTION IF EXISTS ${SIGNATURE}`]);
  });
});

describe('運営の作成 API', () => {
  const route = read(path.join(ROOT, ROUTE));
  const post = route.slice(route.indexOf('export async function POST'), route.indexOf('// GET の道具'));

  it('POST はこの関数を 1 回呼ぶだけで、organizations・org_license_pools・user_profiles に直接触らない', () => {
    expect(post.match(/\.rpc\(/g)).toHaveLength(1);
    expect(post).toContain(`.rpc('${FN}', {`);
    expect(post).not.toMatch(/\.from\(/);
  });
});
