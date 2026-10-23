/**
 * 組織の譲渡の承諾と解散の同時の実行で CHECK user_profiles_org_consistency (23514) が API に届く欠陥の修正
 * (supabase/migrations/20261022140000_org_transfer_toctou.sql) を、ファイルどうしの突き合わせで確かめる (DB には接続しない)。
 *
 * 後の migration が下の関数を CREATE OR REPLACE し直すとき (古い本文をそのまま写すとき) に、ロックと判定し直しを
 * 落とさないよう、各関数の「最新の定義」(supabase/migrations を version 順に見て、最後に CREATE OR REPLACE したもの) で確かめる。
 *
 *   0. ロックの順の規則 (CLAUDE.md の組織のロック順): 組織の行を取る関数は、組織の行を、ほかのどの user_profiles の行よりも先に取る。
 *      組織の行を取らない関数 (脱退・除名) は user_profiles の行を 1 つだけ取る。取り直しのループ (LOOP) は無い
 *      (release_user_membership は 20261022160000_release_membership_owner_race.sql で組織の行を最初に取る側に移った。
 *      その中身は tests/release-membership-owner-race-migration-contract.test.ts が見る)
 *   1. accept_org_owner_transfer: 提案の行 → 組織の行 → 承諾者の user_profiles → 旧オーナーの user_profiles を FOR NO KEY UPDATE で取り、
 *      ORG_ALREADY_DISSOLVED → TRANSFER_ACCEPTOR_NOT_IN_ORG → TRANSFER_NOT_PENDING → NOT_ORG_OWNER の順に判定し、
 *      最初の所属の書き込み (旧オーナーの org_role) はすべての判定のあと
 *   2. operator_force_owner_transfer: 権限・MFA のあと、組織の行 → 新オーナーの user_profiles を取り、そのあとで TARGET_NOT_IN_ORG を
 *      判定してから書く
 *   3. leave_org / remove_org_member: 判定に使う行 (本人 / 対象) を FOR NO KEY UPDATE で読む
 *   4. dissolve_org_by_owner: 組織の行を最初に取ってから判定する (呼び出した本人の行を先に取らない)。コメントを除くと、
 *      20261019120000 の定義から本人の行のロックの 1 文を除いたものと同じ
 *   5. operator_force_dissolve_org: 権限・MFA のあと、組織の行を最初に取る (オーナーの行・取り直しのループは無い)。コメントを除くと、
 *      20261019120000 の定義の組織の読み出しに FOR NO KEY UPDATE を足したものと同じ
 *   6. 戻し口が実在し、6 つの関数を前の定義に逐語で戻す
 * 実際の挙動 (解散・脱退・除名と承諾の同時の実行) は tests/integration/security/org-transfer-toctou.test.ts (実 DB) が確かめる。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const MIGRATIONS_DIR = path.join(ROOT, 'supabase', 'migrations');
const MIGRATION = '20261022140000_org_transfer_toctou';
const ROLLBACK_PATH = path.join(ROOT, 'supabase', 'rollbacks', `${MIGRATION}.down.sql`);

/** 戻し先の定義: ファイルと、その中の関数の行 (1 始まり・両端を含む) */
const RESTORED_SOURCES = [
  { name: 'accept_org_owner_transfer', file: '20261017030000_parental_consent_and_birth_date.sql', from: 1024, to: 1087 },
  { name: 'operator_force_owner_transfer', file: '20261017130000_operator_mfa_db_gate.sql', from: 238, to: 278 },
  { name: 'leave_org', file: '20251126124224_create_meal_planner_tables.sql', from: 2084, to: 2120 },
  { name: 'remove_org_member', file: '20251126124224_create_meal_planner_tables.sql', from: 2878, to: 2921 },
  { name: 'dissolve_org_by_owner', file: '20261019120000_self_dissolve.sql', from: 175, to: 223 },
  { name: 'operator_force_dissolve_org', file: '20261022100000_org_invite_dissolved.sql', from: 178, to: 252 },
] as const;

/** dissolve_org_by_owner の戻し先の説明 (COMMENT ON FUNCTION) の行 (20261019120000_self_dissolve.sql の中。1 始まり・両端を含む) */
const DISSOLVE_COMMENT_SOURCE = { file: '20261019120000_self_dissolve.sql', from: 226, to: 227 } as const;

/** operator_force_dissolve_org の、組織の行のロックを足す前の定義 (20261019120000_self_dissolve.sql の中。1 始まり・両端を含む) */
const OPERATOR_DISSOLVE_UNLOCKED_SOURCE = { file: '20261019120000_self_dissolve.sql', from: 232, to: 285 } as const;

/** 組織の行を取る関数 (組織の行を、ほかのどの user_profiles の行よりも先に取る) */
const ORG_ROW_FIRST_FUNCTIONS = [
  'accept_org_owner_transfer',
  'operator_force_owner_transfer',
  'dissolve_org_by_owner',
  'operator_force_dissolve_org',
  'accept_org_invite',
  // 20261022160000_release_membership_owner_race.sql: 組織の行 → 本人の user_profiles (退会の findBlocker のあとにオーナーになった人の所属を外さない)
  'release_user_membership',
] as const;

/** 組織の行を取らずに所属を外す関数 (user_profiles の行を 1 つだけ取る) */
const SINGLE_PROFILE_ROW_FUNCTIONS = ['leave_org', 'remove_org_member'] as const;

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

/** 本文の中で pattern が最初に現れる位置。無ければテストを落とす */
function indexOf(body: string, pattern: RegExp, label: string): number {
  const at = body.search(pattern);
  expect(at, `${label} が本文に無い`).toBeGreaterThanOrEqual(0);
  return at;
}

/** 組織の行を取る文 (SELECT … FROM organizations … FOR [NO KEY] UPDATE / UPDATE organizations)。表の名前の public. はあってもなくてもよい */
const ORG_ROW_LOCK = /FROM\s+(?:public\.)?organizations\b[^;]*\bFOR\s+(?:NO\s+KEY\s+)?UPDATE|\bUPDATE\s+(?:public\.)?organizations\b/i;

/** user_profiles の行を取る文 (SELECT / PERFORM … FOR [NO KEY] UPDATE・UPDATE・INSERT (ON CONFLICT DO UPDATE は既存の行を取る)) */
const PROFILE_ROW_LOCK = /FROM\s+(?:public\.)?user_profiles\b[^;]*\bFOR\s+(?:NO\s+KEY\s+)?UPDATE|\bUPDATE\s+(?:public\.)?user_profiles\b|\bINSERT\s+INTO\s+(?:public\.)?user_profiles\b/i;

/** 上に加えて、解散の後始末の呼び出し (org_dissolve_apply が全員の user_profiles の行を UPDATE で取る) */
const PROFILE_ROW_LOCK_OR_DISSOLVE_APPLY = new RegExp(`${PROFILE_ROW_LOCK.source}|\\bpublic\\.org_dissolve_apply\\s*\\(`, 'i');

/** 取り直しのループ (オーナーを読んでから行を取るまでにオーナーが変わったときの取り直し) の名残 */
const OWNER_RETAKE_LOOP = /\bLOOP\b|\bv_lock_owner\b|\bv_current_owner\b/i;

describe('ロックの順の規則 (組織の行を最初に取る。CLAUDE.md の組織のロック順)', () => {
  it.each(ORG_ROW_FIRST_FUNCTIONS)('%s の最新の定義は、組織の行を、ほかのどの user_profiles の行よりも先に取る (取り直しのループは無い)', (name) => {
    const { file, body: rawBody } = latestOf(name);
    const body = stripLineComments(rawBody);
    const orgLockAt = indexOf(body, ORG_ROW_LOCK, '組織の行のロック');
    const profileLockAt = indexOf(body, PROFILE_ROW_LOCK_OR_DISSOLVE_APPLY, 'user_profiles の行のロック・書き込み (解散は後始末の呼び出し)');
    expect(orgLockAt, `${name} (${file})`).toBeLessThan(profileLockAt);
    expect(body, `${name} (${file})`).not.toMatch(OWNER_RETAKE_LOOP);
  });

  it.each(SINGLE_PROFILE_ROW_FUNCTIONS)('%s の最新の定義は、組織の行を取らず、user_profiles の行を 1 つだけ (同じ id で) 取る', (name) => {
    const { file, body: rawBody } = latestOf(name);
    const body = stripLineComments(rawBody);
    expect(body, `${name} (${file})`).not.toMatch(ORG_ROW_LOCK);
    const targets = body
      .split(';')
      .filter((statement) => PROFILE_ROW_LOCK.test(statement))
      .map((statement) => /\bWHERE\s+id\s*=\s*([\w.()]+)/i.exec(statement)?.[1] ?? '(WHERE id = … が無い)');
    expect(targets.length, `${name} (${file})`).toBeGreaterThan(0);
    expect(new Set(targets).size, `${name} (${file}): ${targets.join(', ')}`).toBe(1);
  });
});

describe('accept_org_owner_transfer の最新の定義', () => {
  const { file, header, body: rawBody } = latestOf('accept_org_owner_transfer');
  const body = stripLineComments(rawBody);

  it('最新の定義はこの migration で、SECURITY DEFINER・search_path = public・RETURNS organizations のまま', () => {
    expect(file).toBe(`${MIGRATION}.sql`);
    expect(header, file).toMatch(/RETURNS\s+"public"\."organizations"/i);
    expect(header, file).toMatch(/SECURITY\s+DEFINER/i);
    expect(header, file).toMatch(/SET\s+"search_path"\s+TO\s+'public'/i);
  });

  it('BEGIN の直後は 18 歳未満の判定のまま (#1173)', () => {
    expect(body.replace(/\s+/g, ' ')).toContain(
      "BEGIN IF public.caller_is_minor_jst() THEN RAISE EXCEPTION 'MINOR_ACCOUNT_NOT_ALLOWED' USING ERRCODE = 'P0001'; END IF;",
    );
  });

  it('ロックの向き: 提案の行 → 組織の行 → 承諾者の user_profiles → 旧オーナーの user_profiles。どれも判定と書き込みより前', () => {
    const proposalLockAt = indexOf(
      body,
      /FROM\s+ownership_transfer_proposals\s+WHERE\s+id\s*=\s*p_proposal_id\s+AND\s+status\s*=\s*'pending'\s+AND\s+to_user_id\s*=\s*auth\.uid\(\)\s+FOR\s+NO\s+KEY\s+UPDATE/i,
      '提案の行のロック',
    );
    const expiredAt = indexOf(body, /RAISE\s+EXCEPTION\s+'TRANSFER_PROPOSAL_EXPIRED'/i, '期限の判定');
    const orgLockAt = indexOf(
      body,
      /SELECT\s+\*\s+INTO\s+v_org\s+FROM\s+organizations\s+WHERE\s+id\s*=\s*v_org_id\s+FOR\s+NO\s+KEY\s+UPDATE/i,
      '組織の行のロック',
    );
    const dissolvedAt = indexOf(
      body,
      /IF\s+FOUND\s+AND\s+v_org\.status\s*<>\s*'active'\s+THEN\s+RAISE\s+EXCEPTION\s+'ORG_ALREADY_DISSOLVED'/i,
      '解散済みの判定',
    );
    const acceptorLockAt = indexOf(
      body,
      /SELECT\s+organization_id\s+INTO\s+v_acceptor_org_id\s+FROM\s+user_profiles\s+WHERE\s+id\s*=\s*auth\.uid\(\)\s+FOR\s+NO\s+KEY\s+UPDATE/i,
      '承諾者の行のロック',
    );
    const acceptorCheckAt = indexOf(
      body,
      /IF\s+v_acceptor_org_id\s+IS\s+NULL\s+OR\s+v_acceptor_org_id\s*<>\s*v_org_id\s+THEN\s+RAISE\s+EXCEPTION\s+'TRANSFER_ACCEPTOR_NOT_IN_ORG'/i,
      '承諾者の在籍の判定',
    );
    const pendingAt = indexOf(body, /RAISE\s+EXCEPTION\s+'TRANSFER_NOT_PENDING'/i, 'pending の判定');
    const ownerCheckAt = indexOf(
      body,
      /IF\s+v_org\.owner_id\s+IS\s+DISTINCT\s+FROM\s+v_old_owner_id\s+THEN\s+RAISE\s+EXCEPTION\s+'NOT_ORG_OWNER'/i,
      '提案者がオーナーかの判定 (ロックした組織の行の owner_id)',
    );
    const oldOwnerLockAt = indexOf(
      body,
      /SELECT\s+organization_id\s+INTO\s+v_old_owner_org_id\s+FROM\s+user_profiles\s+WHERE\s+id\s*=\s*v_old_owner_id\s+FOR\s+NO\s+KEY\s+UPDATE/i,
      '旧オーナーの行のロック',
    );
    const oldOwnerMemberAt = indexOf(
      body,
      /IF\s+v_old_owner_org_id\s+IS\s+NULL\s+OR\s+v_old_owner_org_id\s*<>\s*v_org_id\s+THEN\s+RAISE\s+EXCEPTION\s+'NOT_ORG_OWNER'/i,
      '旧オーナーの在籍の判定',
    );
    const firstMembershipWriteAt = indexOf(
      body,
      /UPDATE\s+user_profiles\s+SET\s+org_role\s*=\s*'admin'\s+WHERE\s+id\s*=\s*v_old_owner_id/i,
      '旧オーナーの org_role の書き込み',
    );
    const order = [
      proposalLockAt,
      expiredAt,
      orgLockAt,
      dissolvedAt,
      acceptorLockAt,
      acceptorCheckAt,
      pendingAt,
      ownerCheckAt,
      oldOwnerLockAt,
      oldOwnerMemberAt,
      firstMembershipWriteAt,
    ];
    expect(order, file).toEqual([...order].sort((a, b) => a - b));
  });

  it('組織の行のロックは FOR NO KEY UPDATE の 1 回だけ (FOR UPDATE / FOR SHARE で組織の行を取らない。外部キーの確認と待ち合わないため)', () => {
    expect(body.match(/FROM\s+organizations\b[^;]*\bFOR\s+(?:NO\s+KEY\s+)?UPDATE/gi) ?? [], file).toHaveLength(1);
    expect(body, file).not.toMatch(/FROM\s+organizations\b[^;]*\bFOR\s+UPDATE/i);
    expect(body, file).not.toMatch(/FROM\s+organizations\b[^;]*\bFOR\s+(?:KEY\s+)?SHARE/i);
  });

  it('書き込み (役割の入れ替え・owner_id・監査の action と metadata) は従来のまま', () => {
    const flat = body.replace(/\s+/g, ' ');
    expect(flat).toContain("UPDATE user_profiles SET org_role = 'admin' WHERE id = v_old_owner_id;");
    expect(flat).toContain("UPDATE user_profiles SET org_role = 'owner' WHERE id = auth.uid();");
    expect(flat).toContain('UPDATE organizations SET owner_id = auth.uid() WHERE id = v_org_id;');
    expect(flat).toContain(
      "VALUES ('organization', v_org_id, 'owner_transferred', auth.uid(), v_old_owner_id, jsonb_build_object('proposal_id', p_proposal_id));",
    );
  });
});

describe('operator_force_owner_transfer の最新の定義', () => {
  const { file, header, body: rawBody } = latestOf('operator_force_owner_transfer');
  const body = stripLineComments(rawBody);

  it('最新の定義はこの migration かそれより後 (20261022160000 が旧オーナーの行の UPDATE に在籍の条件を足し、20261023120000 が戻り値を jsonb (更新した後の行 + ロックの下で読んだ旧オーナー。#1917) にした) で、SECURITY DEFINER・search_path = public', () => {
    expect(file >= `${MIGRATION}.sql`, file).toBe(true);
    expect(header, file).toMatch(/RETURNS\s+"jsonb"/i);
    expect(header, file).toMatch(/SECURITY\s+DEFINER/i);
    expect(header, file).toMatch(/SET\s+"search_path"\s+TO\s+'public'/i);
  });

  it('権限・MFA の判定 → 組織の行 → 新オーナーの user_profiles のロック → TARGET_NOT_IN_ORG → 最初の書き込み', () => {
    const roleAt = indexOf(body, /RAISE\s+EXCEPTION\s+'NOT_OPERATOR'/i, '権限の判定');
    const mfaAt = indexOf(body, /IF\s+NOT\s+public\.operator_mfa_satisfied\(\)\s+THEN\s+RAISE\s+EXCEPTION\s+'OPERATOR_MFA_REQUIRED'/i, 'MFA の判定');
    const orgLockAt = indexOf(
      body,
      /SELECT\s+owner_id\s+INTO\s+v_old_owner_id\s+FROM\s+organizations\s+WHERE\s+id\s*=\s*p_organization_id\s+FOR\s+NO\s+KEY\s+UPDATE/i,
      '組織の行のロック',
    );
    const targetLockAt = indexOf(
      body,
      /SELECT\s+organization_id\s+INTO\s+v_target_org_id\s+FROM\s+user_profiles\s+WHERE\s+id\s*=\s*p_new_owner_id\s+FOR\s+NO\s+KEY\s+UPDATE/i,
      '新オーナーの行のロック',
    );
    const targetCheckAt = indexOf(
      body,
      /IF\s+v_target_org_id\s+IS\s+NULL\s+OR\s+v_target_org_id\s*<>\s*p_organization_id\s+THEN\s+RAISE\s+EXCEPTION\s+'TARGET_NOT_IN_ORG'/i,
      '新オーナーの在籍の判定',
    );
    const firstWriteAt = indexOf(body, /UPDATE\s+user_profiles\s+SET\s+org_role\s*=\s*'admin'\s+WHERE\s+id\s*=\s*v_old_owner_id/i, '最初の書き込み');
    const order = [roleAt, mfaAt, orgLockAt, targetLockAt, targetCheckAt, firstWriteAt];
    expect(order, file).toEqual([...order].sort((a, b) => a - b));
    // ロックの外での在籍の判定 (従来の NOT EXISTS) は残っていない
    expect(body, file).not.toMatch(/NOT\s+EXISTS\s*\(\s*SELECT\s+1\s+FROM\s+user_profiles\s+WHERE\s+id\s*=\s*p_new_owner_id/i);
  });

  it('監査の action・metadata (operator_id / old_owner_id / reason) は変えない', () => {
    const flat = body.replace(/\s+/g, ' ');
    expect(flat).toContain("'operator_force_owner_transfer', NULL, p_new_owner_id,");
    expect(flat).toContain("'operator_id', auth.uid(), 'old_owner_id', v_old_owner_id, 'reason', p_reason");
  });
});

describe('leave_org / remove_org_member の最新の定義', () => {
  it('leave_org: 本人の行を FOR NO KEY UPDATE で読み、その値で NOT_IN_ORG / IS_ORG_OWNER を判定する', () => {
    const { file, body: rawBody } = latestOf('leave_org');
    const body = stripLineComments(rawBody);
    expect(file).toBe(`${MIGRATION}.sql`);
    const lockAt = indexOf(
      body,
      /SELECT\s+\*\s+INTO\s+v_user\s+FROM\s+user_profiles\s+WHERE\s+id\s*=\s*auth\.uid\(\)\s+FOR\s+NO\s+KEY\s+UPDATE\s*;/i,
      '本人の行のロック',
    );
    const ownerCheckAt = indexOf(body, /RAISE\s+EXCEPTION\s+'IS_ORG_OWNER'/i, 'オーナーの判定');
    const writeAt = indexOf(body, /UPDATE\s+user_profiles\s+SET\s+organization_id\s*=\s*NULL/i, '所属を外す書き込み');
    expect(lockAt).toBeLessThan(ownerCheckAt);
    expect(ownerCheckAt).toBeLessThan(writeAt);
  });

  it('remove_org_member: 対象の行を FOR NO KEY UPDATE で読み、その値で USER_NOT_IN_ORG / CANNOT_REMOVE_OWNER を判定する。呼び出し元の行はロックしない', () => {
    const { file, body: rawBody } = latestOf('remove_org_member');
    const body = stripLineComments(rawBody);
    expect(file).toBe(`${MIGRATION}.sql`);
    const lockAt = indexOf(
      body,
      /SELECT\s+\*\s+INTO\s+v_target\s+FROM\s+user_profiles\s+WHERE\s+id\s*=\s*p_user_id\s+FOR\s+NO\s+KEY\s+UPDATE\s*;/i,
      '対象の行のロック',
    );
    const ownerCheckAt = indexOf(body, /RAISE\s+EXCEPTION\s+'CANNOT_REMOVE_OWNER'/i, 'オーナーの判定');
    const writeAt = indexOf(body, /UPDATE\s+user_profiles\s+SET\s+organization_id\s*=\s*NULL/i, '所属を外す書き込み');
    expect(lockAt).toBeLessThan(ownerCheckAt);
    expect(ownerCheckAt).toBeLessThan(writeAt);
    // 呼び出し元の行もロックすると、組織の行の下で 2 行を取る譲渡の承諾 (承諾者の行 → 旧オーナーの行) と逆向きになりうる
    expect(body).not.toMatch(/WHERE\s+id\s*=\s*auth\.uid\(\)[^;]*FOR\s+(?:NO\s+KEY\s+)?UPDATE/i);
  });
});

describe('dissolve_org_by_owner の最新の定義', () => {
  const { file, header, body: rawBody } = latestOf('dissolve_org_by_owner');
  const body = stripLineComments(rawBody);
  /** 置き換える前の定義 (20261019120000_self_dissolve.sql の :175-223) */
  const base = linesOf('20261019120000_self_dissolve.sql', 175, 223);
  const [baseDefinition] = definitionsIn('20261019120000_self_dissolve.sql', base, 'dissolve_org_by_owner');

  it("最新の定義はこの migration で、SECURITY DEFINER・search_path = ''・RETURNS jsonb のまま", () => {
    expect(file).toBe(`${MIGRATION}.sql`);
    expect(header, file).toMatch(/RETURNS\s+jsonb/i);
    expect(header, file).toMatch(/SECURITY\s+DEFINER/i);
    expect(header, file).toMatch(/SET\s+search_path\s*=\s*''/i);
  });

  it('user_profiles の行を本文でロックしない (呼び出した本人の行も現オーナーの行も。全員の行は後始末 org_dissolve_apply の中で、組織の行のあと)', () => {
    expect(body, file).not.toMatch(/FROM\s+(?:public\.)?user_profiles\b[^;]*\bFOR\s+(?:NO\s+KEY\s+)?UPDATE/i);
    expect(body, file).not.toMatch(/\bPERFORM\b/i);
  });

  it('NOT_AUTHENTICATED → 組織の行 → ORG_NOT_FOUND → ORG_ALREADY_DISSOLVED → NOT_ORG_OWNER → 後始末 の順', () => {
    const authAt = indexOf(body, /RAISE\s+EXCEPTION\s+'NOT_AUTHENTICATED'/i, '認証の判定');
    const orgLockAt = indexOf(
      body,
      /SELECT\s+\*\s+INTO\s+v_org\s+FROM\s+public\.organizations\s+WHERE\s+id\s*=\s*p_organization_id\s+FOR\s+NO\s+KEY\s+UPDATE/i,
      '組織の行のロック',
    );
    const notFoundAt = indexOf(body, /RAISE\s+EXCEPTION\s+'ORG_NOT_FOUND'/i, 'ORG_NOT_FOUND');
    const dissolvedAt = indexOf(body, /RAISE\s+EXCEPTION\s+'ORG_ALREADY_DISSOLVED'/i, 'ORG_ALREADY_DISSOLVED');
    const ownerCheckAt = indexOf(
      body,
      /IF\s+v_org\.owner_id\s+IS\s+DISTINCT\s+FROM\s+auth\.uid\(\)\s+THEN\s+RAISE\s+EXCEPTION\s+'NOT_ORG_OWNER'/i,
      'オーナーかの判定',
    );
    const applyAt = indexOf(body, /v_org\s*:=\s*public\.org_dissolve_apply\(p_organization_id\)/i, '後始末');
    const order = [authAt, orgLockAt, notFoundAt, dissolvedAt, ownerCheckAt, applyAt];
    expect(order, file).toEqual([...order].sort((a, b) => a - b));
  });

  it('コメントを除くと、20261019120000 の定義 (見出し・宣言・判定・後始末・監査・戻り値) から本人の行のロックの 1 文を除いたものと同じ', () => {
    const baseLock = 'PERFORM 1 FROM public.user_profiles WHERE id = auth.uid() FOR NO KEY UPDATE;';
    const baseBody = squash(stripLineComments(baseDefinition.body));
    expect(baseBody).toContain(baseLock);
    expect(squash(body)).toBe(squash(baseBody.replace(baseLock, '')));
    expect(squash(header)).toBe(squash(baseDefinition.header));
  });

  it('関数の説明 (COMMENT) をロックの順 (組織の行を最初に取る) に合わせる', () => {
    const sql = migrations.find((m) => m.file === `${MIGRATION}.sql`)?.sql ?? '';
    const comments = [...sql.matchAll(/COMMENT ON FUNCTION public\.dissolve_org_by_owner\(uuid\) IS\s+'([^']*)';/g)].map((m) => m[1]);
    expect(comments).toHaveLength(1);
    expect(comments[0]).toContain('組織の行を最初にロックしてオーナーかを判定し (呼び出した本人の user_profiles の行は先に取らない)');
    expect(comments[0]).not.toContain('本人の user_profiles の行 → 組織の行');
  });
});

describe('operator_force_dissolve_org の最新の定義', () => {
  const { file, header, body: rawBody } = latestOf('operator_force_dissolve_org');
  const body = stripLineComments(rawBody);
  const unlocked = linesOf(OPERATOR_DISSOLVE_UNLOCKED_SOURCE.file, OPERATOR_DISSOLVE_UNLOCKED_SOURCE.from, OPERATOR_DISSOLVE_UNLOCKED_SOURCE.to);
  const [unlockedDefinition] = definitionsIn(OPERATOR_DISSOLVE_UNLOCKED_SOURCE.file, unlocked, 'operator_force_dissolve_org');

  it('最新の定義はこの migration で、SECURITY DEFINER・search_path = public・RETURNS organizations・p_reason の既定値のまま', () => {
    expect(file).toBe(`${MIGRATION}.sql`);
    expect(header, file).toMatch(/"p_reason"\s+"text"\s+DEFAULT\s+NULL::"text"/i);
    expect(header, file).toMatch(/RETURNS\s+"public"\."organizations"/i);
    expect(header, file).toMatch(/SECURITY\s+DEFINER/i);
    expect(header, file).toMatch(/SET\s+"search_path"\s+TO\s+'public'/i);
  });

  it('権限・MFA の判定 → 組織の行のロック → ORG_NOT_FOUND → ORG_ALREADY_DISSOLVED → 後始末 の順。user_profiles の行は本文でロックしない', () => {
    const roleAt = indexOf(body, /RAISE\s+EXCEPTION\s+'OPERATOR_PERMISSION_REQUIRED'/i, '権限の判定');
    const mfaAt = indexOf(body, /IF\s+NOT\s+public\.operator_mfa_satisfied\(\)\s+THEN\s+RAISE\s+EXCEPTION\s+'OPERATOR_MFA_REQUIRED'/i, 'MFA の判定');
    const orgLockAt = indexOf(body, /SELECT\s+\*\s+INTO\s+v_org\s+FROM\s+organizations\s+WHERE\s+id\s*=\s*p_organization_id\s+FOR\s+NO\s+KEY\s+UPDATE/i, '組織の行のロック');
    const notFoundAt = indexOf(body, /RAISE\s+EXCEPTION\s+'ORG_NOT_FOUND'/i, 'ORG_NOT_FOUND');
    const dissolvedAt = indexOf(body, /IF\s+v_org\.status\s*=\s*'dissolved'\s+THEN\s+RAISE\s+EXCEPTION\s+'ORG_ALREADY_DISSOLVED'/i, '解散済みの判定');
    const applyAt = indexOf(body, /public\.org_dissolve_apply\(\s*p_organization_id\s*\)/i, '後始末の呼び出し');
    const order = [roleAt, mfaAt, orgLockAt, notFoundAt, dissolvedAt, applyAt];
    expect(order, file).toEqual([...order].sort((a, b) => a - b));
    expect(body.match(/RAISE\s+EXCEPTION\s+'ORG_NOT_FOUND'/gi) ?? [], file).toHaveLength(1);
    expect(body, file).not.toMatch(/FROM\s+(?:public\.)?user_profiles\b[^;]*\bFOR\s+(?:NO\s+KEY\s+)?UPDATE/i);
  });

  it('コメントを除くと、20261019120000 の定義の組織の読み出しに FOR NO KEY UPDATE を足しただけ (権限・MFA・エラー・監査・戻り値は同じ)', () => {
    const unlockedRead = 'SELECT * INTO v_org FROM organizations WHERE id = p_organization_id;';
    const unlockedBody = squash(stripLineComments(unlockedDefinition.body));
    expect(unlockedBody).toContain(unlockedRead);
    expect(squash(body)).toBe(
      squash(unlockedBody.replace(unlockedRead, 'SELECT * INTO v_org FROM organizations WHERE id = p_organization_id FOR NO KEY UPDATE;')),
    );
    expect(squash(header)).toBe(squash(unlockedDefinition.header));
  });
});

describe('戻し口', () => {
  it('戻し口が実在し、1 行目が自分の migration を指す', () => {
    expect(fs.existsSync(ROLLBACK_PATH), ROLLBACK_PATH).toBe(true);
    const firstLine = fs.readFileSync(ROLLBACK_PATH, 'utf-8').split('\n', 1)[0];
    expect(firstLine).toBe(`-- rollback: ${MIGRATION}.sql`);
  });

  it('この migration の version (先頭の 14 桁) は、ほかの migration と重ならない (main を取り込んだあとの番号の付け直しの見張り)', () => {
    const version = MIGRATION.slice(0, MIGRATION.indexOf('_'));
    expect(version).toMatch(/^\d{14}$/);
    expect(migrations.filter(({ file }) => file.startsWith(`${version}_`)).map(({ file }) => file)).toEqual([`${MIGRATION}.sql`]);
  });

  it('migration の 1 行目と戻し口の参照が自分を指す', () => {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, `${MIGRATION}.sql`), 'utf-8');
    expect(sql.split('\n', 1)[0]).toBe(`-- migration: ${MIGRATION}.sql`);
    expect(sql).toContain(`supabase/rollbacks/${MIGRATION}.down.sql`);
  });

  it('この migration が作り直す関数と、戻し口が戻す関数は同じ 6 つ', () => {
    const sql = stripLineComments(fs.readFileSync(path.join(MIGRATIONS_DIR, `${MIGRATION}.sql`), 'utf-8'));
    const rollback = stripLineComments(fs.readFileSync(ROLLBACK_PATH, 'utf-8'));
    const namesOf = (text: string) =>
      [...text.matchAll(/CREATE OR REPLACE FUNCTION\s+(?:"?public"?\.)?"?(\w+)"?\s*\(/g)].map((m) => m[1]).sort();
    const expected = RESTORED_SOURCES.map(({ name }) => name).sort();
    expect(namesOf(sql)).toEqual(expected);
    expect(namesOf(rollback)).toEqual(expected);
  });

  it.each(RESTORED_SOURCES)('$name を $file の :$from-$to に逐語で戻す', ({ name, file, from, to }) => {
    const rollback = fs.readFileSync(ROLLBACK_PATH, 'utf-8');
    const source = linesOf(file, from, to);
    // 行の範囲が関数の定義の先頭と末尾を指していること (土台のファイルが書き換わって行がずれたら気づく)。
    // 名前は "public"."name"( (pg_dump の形) と public.name( (手で書いた形) のどちらか。末尾は END $$; か END; の次の行の $$;
    expect(source).toMatch(new RegExp(`^CREATE OR REPLACE FUNCTION (?:"public"\\."${name}"|public\\.${name})\\(`));
    expect(source).toMatch(/END(?: \$\$;|;\n\$\$;)$/);
    expect(rollback).toContain(source);
    // 戻し先は、この migration より前の最後の定義
    const earlier = migrations
      .filter(({ file: f }) => f < `${MIGRATION}.sql`)
      .flatMap(({ file: f, sql }) => definitionsIn(f, sql, name));
    expect(earlier[earlier.length - 1]?.file).toBe(file);
  });

  it('戻した 6 つの関数は、この migration のロックの順を含まない (前の定義のロックに戻る)', () => {
    const sql = stripLineComments(fs.readFileSync(ROLLBACK_PATH, 'utf-8'));
    const restoredBody = (name: string): string => {
      const defs = definitionsIn(ROLLBACK_PATH, sql, name);
      expect(defs, name).toHaveLength(1);
      return defs[0].body;
    };
    // 譲渡の 2 本は組織の行をロックしない (書き込みの UPDATE だけ)
    for (const name of ['accept_org_owner_transfer', 'operator_force_owner_transfer']) {
      expect(restoredBody(name), name).not.toMatch(/FROM\s+organizations\b[^;]*\bFOR\s+(?:NO\s+KEY\s+)?UPDATE/i);
    }
    // 脱退・除名は判定に使う行をロックしない
    for (const name of ['leave_org', 'remove_org_member']) {
      expect(restoredBody(name), name).not.toMatch(/FROM\s+user_profiles\s+WHERE\s+id\s*=\s*(?:auth\.uid\(\)|p_user_id)\s+FOR\s+NO\s+KEY\s+UPDATE/i);
    }
    // オーナーの解散は呼び出した本人の行のロックに、運営の強制解散はオーナーの行の取り直しのループに戻る
    expect(restoredBody('dissolve_org_by_owner').replace(/\s+/g, ' ')).toContain(
      'PERFORM 1 FROM public.user_profiles WHERE id = auth.uid() FOR NO KEY UPDATE;',
    );
    expect(restoredBody('operator_force_dissolve_org')).toMatch(OWNER_RETAKE_LOOP);
  });

  it('dissolve_org_by_owner の説明 (COMMENT) を 20261019120000 の文に逐語で戻す (関数の定義のあと)', () => {
    const rollback = fs.readFileSync(ROLLBACK_PATH, 'utf-8');
    const { file, from, to } = DISSOLVE_COMMENT_SOURCE;
    const source = linesOf(file, from, to);
    expect(source).toMatch(/^COMMENT ON FUNCTION public\.dissolve_org_by_owner\(uuid\) IS\n {2}'[^']*';$/);
    expect(rollback).toContain(source);
    expect(rollback.indexOf(source)).toBeGreaterThan(rollback.indexOf('CREATE OR REPLACE FUNCTION public.dissolve_org_by_owner('));
  });
});
