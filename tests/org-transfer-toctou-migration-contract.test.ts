/**
 * 組織の譲渡の承諾と解散の同時の実行で CHECK user_profiles_org_consistency (23514) が API に届く欠陥の修正
 * (supabase/migrations/20261022110000_org_transfer_toctou.sql) を、ファイルどうしの突き合わせで確かめる (DB には接続しない)。
 *
 * 後の migration が下の 4 つの関数を CREATE OR REPLACE し直すとき (古い本文をそのまま写すとき) に、ロックと判定し直しを
 * 落とさないよう、各関数の「最新の定義」(supabase/migrations を version 順に見て、最後に CREATE OR REPLACE したもの) で確かめる。
 *
 *   1. accept_org_owner_transfer: 提案の行 → 現オーナーの user_profiles (取り直しのループ) → 組織の行 → 承諾者の user_profiles を
 *      FOR NO KEY UPDATE で取り、そのあとで ORG_ALREADY_DISSOLVED → TRANSFER_ACCEPTOR_NOT_IN_ORG → TRANSFER_NOT_PENDING →
 *      NOT_ORG_OWNER の順に判定し、最初の所属の書き込み (旧オーナーの org_role) はすべての判定のあと
 *   2. operator_force_owner_transfer: 権限・MFA のあと、現オーナーの user_profiles (ループ) → 組織の行 → 新オーナーの user_profiles を
 *      取り、そのあとで TARGET_NOT_IN_ORG を判定してから書く
 *   3. leave_org / remove_org_member: 判定に使う行 (本人 / 対象) を FOR NO KEY UPDATE で読む
 *   4. 戻し口が実在し、4 つの関数を前の定義に逐語で戻す
 * 実際の挙動 (解散・脱退・除名と承諾の同時の実行) は tests/integration/security/org-transfer-toctou.test.ts (実 DB) が確かめる。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const MIGRATIONS_DIR = path.join(ROOT, 'supabase', 'migrations');
const MIGRATION = '20261022110000_org_transfer_toctou';
const ROLLBACK_PATH = path.join(ROOT, 'supabase', 'rollbacks', `${MIGRATION}.down.sql`);

/** 戻し先の定義: ファイルと、その中の関数の行 (1 始まり・両端を含む) */
const RESTORED_SOURCES = [
  { name: 'accept_org_owner_transfer', file: '20261017030000_parental_consent_and_birth_date.sql', from: 1024, to: 1087 },
  { name: 'operator_force_owner_transfer', file: '20261017130000_operator_mfa_db_gate.sql', from: 238, to: 278 },
  { name: 'leave_org', file: '20251126124224_create_meal_planner_tables.sql', from: 2084, to: 2120 },
  { name: 'remove_org_member', file: '20251126124224_create_meal_planner_tables.sql', from: 2878, to: 2921 },
] as const;

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

/** 現オーナーの行を取り、オーナーを読み直して、変わっていたら取り直すループ (operator_force_dissolve_org と同じ形) */
const ownerLockLoop = (orgVar: string): RegExp =>
  new RegExp(
    `LOOP\\s+PERFORM\\s+1\\s+FROM\\s+user_profiles\\s+WHERE\\s+id\\s*=\\s*v_lock_owner\\s+FOR\\s+NO\\s+KEY\\s+UPDATE\\s*;\\s*` +
      `SELECT\\s+owner_id\\s+INTO\\s+v_current_owner\\s+FROM\\s+organizations\\s+WHERE\\s+id\\s*=\\s*${orgVar}\\s*;\\s*` +
      `EXIT\\s+WHEN\\s+v_current_owner\\s+IS\\s+NOT\\s+DISTINCT\\s+FROM\\s+v_lock_owner\\s*;\\s*` +
      `v_lock_owner\\s*:=\\s*v_current_owner\\s*;\\s*END\\s+LOOP\\s*;`,
    'i',
  );

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

  it('現オーナーの行を取ったあとにオーナーを読み直し、変わっていたら取り直す (ループ)', () => {
    expect(body, file).toMatch(ownerLockLoop('v_org_id'));
  });

  it('ロックの向き: 提案の行 → 現オーナーの user_profiles → 組織の行 → 承諾者の user_profiles。どれも判定と書き込みより前', () => {
    const proposalLockAt = indexOf(
      body,
      /FROM\s+ownership_transfer_proposals\s+WHERE\s+id\s*=\s*p_proposal_id\s+AND\s+status\s*=\s*'pending'\s+AND\s+to_user_id\s*=\s*auth\.uid\(\)\s+FOR\s+NO\s+KEY\s+UPDATE/i,
      '提案の行のロック',
    );
    const expiredAt = indexOf(body, /RAISE\s+EXCEPTION\s+'TRANSFER_PROPOSAL_EXPIRED'/i, '期限の判定');
    const ownerLockAt = indexOf(body, /PERFORM\s+1\s+FROM\s+user_profiles\s+WHERE\s+id\s*=\s*v_lock_owner\s+FOR\s+NO\s+KEY\s+UPDATE/i, 'オーナーの行のロック');
    const orgLockAt = indexOf(
      body,
      /SELECT\s+\*\s+INTO\s+v_org\s+FROM\s+organizations\s+WHERE\s+id\s*=\s*v_org_id\s+FOR\s+NO\s+KEY\s+UPDATE/i,
      '組織の行のロック',
    );
    const acceptorLockAt = indexOf(
      body,
      /SELECT\s+organization_id\s+INTO\s+v_acceptor_org_id\s+FROM\s+user_profiles\s+WHERE\s+id\s*=\s*auth\.uid\(\)\s+FOR\s+NO\s+KEY\s+UPDATE/i,
      '承諾者の行のロック',
    );
    const dissolvedAt = indexOf(
      body,
      /IF\s+FOUND\s+AND\s+v_org\.status\s*<>\s*'active'\s+THEN\s+RAISE\s+EXCEPTION\s+'ORG_ALREADY_DISSOLVED'/i,
      '解散済みの判定',
    );
    const acceptorCheckAt = indexOf(
      body,
      /IF\s+v_acceptor_org_id\s+IS\s+NULL\s+OR\s+v_acceptor_org_id\s*<>\s*v_org_id\s+THEN\s+RAISE\s+EXCEPTION\s+'TRANSFER_ACCEPTOR_NOT_IN_ORG'/i,
      '承諾者の在籍の判定',
    );
    const pendingAt = indexOf(body, /RAISE\s+EXCEPTION\s+'TRANSFER_NOT_PENDING'/i, 'pending の判定');
    const ownerCheckAt = indexOf(
      body,
      /IF\s+v_lock_owner\s+IS\s+DISTINCT\s+FROM\s+v_old_owner_id\s+OR\s+v_org\.owner_id\s+IS\s+DISTINCT\s+FROM\s+v_old_owner_id\s+THEN\s+RAISE\s+EXCEPTION\s+'NOT_ORG_OWNER'/i,
      '提案者がオーナーかの判定',
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
      ownerLockAt,
      orgLockAt,
      dissolvedAt,
      acceptorLockAt,
      acceptorCheckAt,
      pendingAt,
      ownerCheckAt,
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

  it('最新の定義はこの migration で、SECURITY DEFINER・search_path = public・RETURNS organizations のまま', () => {
    expect(file).toBe(`${MIGRATION}.sql`);
    expect(header, file).toMatch(/RETURNS\s+"public"\."organizations"/i);
    expect(header, file).toMatch(/SECURITY\s+DEFINER/i);
    expect(header, file).toMatch(/SET\s+"search_path"\s+TO\s+'public'/i);
  });

  it('現オーナーの行を取ったあとにオーナーを読み直し、変わっていたら取り直す (ループ)', () => {
    expect(body, file).toMatch(ownerLockLoop('p_organization_id'));
  });

  it('権限・MFA の判定 → 現オーナーの user_profiles → 組織の行 → 新オーナーの user_profiles のロック → TARGET_NOT_IN_ORG → 最初の書き込み', () => {
    const roleAt = indexOf(body, /RAISE\s+EXCEPTION\s+'NOT_OPERATOR'/i, '権限の判定');
    const mfaAt = indexOf(body, /IF\s+NOT\s+public\.operator_mfa_satisfied\(\)\s+THEN\s+RAISE\s+EXCEPTION\s+'OPERATOR_MFA_REQUIRED'/i, 'MFA の判定');
    const ownerLockAt = indexOf(body, /PERFORM\s+1\s+FROM\s+user_profiles\s+WHERE\s+id\s*=\s*v_lock_owner\s+FOR\s+NO\s+KEY\s+UPDATE/i, 'オーナーの行のロック');
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
    const order = [roleAt, mfaAt, ownerLockAt, orgLockAt, targetLockAt, targetCheckAt, firstWriteAt];
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
    // 呼び出し元の行をロックすると、譲渡の承諾 (オーナーの行 → 承諾者の行) と逆向きになりうる
    expect(body).not.toMatch(/WHERE\s+id\s*=\s*auth\.uid\(\)[^;]*FOR\s+(?:NO\s+KEY\s+)?UPDATE/i);
  });
});

describe('戻し口', () => {
  it('戻し口が実在し、1 行目が自分の migration を指す', () => {
    expect(fs.existsSync(ROLLBACK_PATH), ROLLBACK_PATH).toBe(true);
    const firstLine = fs.readFileSync(ROLLBACK_PATH, 'utf-8').split('\n', 1)[0];
    expect(firstLine).toBe(`-- rollback: ${MIGRATION}.sql`);
  });

  it('migration の 1 行目と戻し口の参照が自分を指す', () => {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, `${MIGRATION}.sql`), 'utf-8');
    expect(sql.split('\n', 1)[0]).toBe(`-- migration: ${MIGRATION}.sql`);
    expect(sql).toContain(`supabase/rollbacks/${MIGRATION}.down.sql`);
  });

  it.each(RESTORED_SOURCES)('$name を $file の :$from-$to に逐語で戻す', ({ name, file, from, to }) => {
    const rollback = fs.readFileSync(ROLLBACK_PATH, 'utf-8');
    const source = fs
      .readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8')
      .split('\n')
      .slice(from - 1, to)
      .join('\n');
    // 行の範囲が関数の定義の先頭と末尾を指していること (土台のファイルが書き換わって行がずれたら気づく)
    expect(source).toMatch(new RegExp(`^CREATE OR REPLACE FUNCTION "public"\\."${name}"\\(`));
    expect(source).toMatch(/END \$\$;$/);
    expect(rollback).toContain(source);
    // 戻し先は、この migration より前の最後の定義
    const earlier = migrations
      .filter(({ file: f }) => f < `${MIGRATION}.sql`)
      .flatMap(({ file: f, sql }) => definitionsIn(f, sql, name));
    expect(earlier[earlier.length - 1]?.file).toBe(file);
  });

  it('戻した 4 つの関数は、この migration のロックを含まない', () => {
    const sql = stripLineComments(fs.readFileSync(ROLLBACK_PATH, 'utf-8'));
    for (const { name } of RESTORED_SOURCES) {
      const defs = definitionsIn(ROLLBACK_PATH, sql, name);
      expect(defs, name).toHaveLength(1);
      expect(defs[0].body, name).not.toMatch(/v_lock_owner/);
      expect(defs[0].body, name).not.toMatch(/FROM\s+user_profiles\s+WHERE\s+id\s*=\s*(?:auth\.uid\(\)|p_user_id)\s+FOR\s+NO\s+KEY\s+UPDATE/i);
    }
  });
});
