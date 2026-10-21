/**
 * Q-4 (docs/design/family/11-self-dissolve.md): 解散した組織の招待を承諾できる欠陥の修正
 * (supabase/migrations/20261022100000_org_invite_dissolved.sql) を、ファイルどうしの突き合わせで確かめる (DB には接続しない)。
 *
 * 後の migration が accept_org_invite / operator_force_dissolve_org を CREATE OR REPLACE し直すとき (古い本文をそのまま写すとき) に、
 * 組織の行のロックと status の判定を落とさないよう、各関数の「最新の定義」(supabase/migrations を version 順に見て、
 * 最後に CREATE OR REPLACE したもの) で確かめる。
 *
 *   1. accept_org_invite: 招待の行のロックのあと、在籍の判定・最初の書き込み・席数のロックより前に、招待の組織の行を
 *      FOR NO KEY UPDATE で取り、status が 'active' でなければ ORG_ALREADY_DISSOLVED
 *   2. operator_force_dissolve_org: 後始末 (org_dissolve_apply) より前に、オーナーの user_profiles → 組織の行 の順で
 *      FOR NO KEY UPDATE を取る (dissolve_org_by_owner と同じ向き)
 *   3. 解散の後始末 (org_dissolve_apply) は招待の行を触らない (触るなら、承諾 (招待の行 → 組織の行) と逆向きになるので、
 *      ロックの順番から決め直すこと)
 *   4. 戻し口が実在し、2 つの RPC を前の定義に逐語で戻す
 * 実際の挙動 (解散した組織の招待の承諾・同時実行) は tests/integration/security/org-invite-dissolved.test.ts (実 DB) が確かめる。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const MIGRATIONS_DIR = path.join(ROOT, 'supabase', 'migrations');
const MIGRATION = '20261022100000_org_invite_dissolved';
const ROLLBACK_PATH = path.join(ROOT, 'supabase', 'rollbacks', `${MIGRATION}.down.sql`);

/** 戻し先の定義: ファイルと、その中の関数の行 (1 始まり・両端を含む) */
const RESTORED_SOURCES = [
  { name: 'accept_org_invite', file: '20261017160000_org_invite_same_org_member.sql', from: 158, to: 260 },
  { name: 'operator_force_dissolve_org', file: '20261019120000_self_dissolve.sql', from: 232, to: 285 },
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

describe('Q-4 accept_org_invite の最新の定義', () => {
  const { file, header, body: rawBody } = latestOf('accept_org_invite');
  const body = stripLineComments(rawBody);

  it('SECURITY DEFINER・search_path = public・RETURNS user_profiles のまま', () => {
    expect(header, file).toMatch(/RETURNS\s+user_profiles/i);
    expect(header, file).toMatch(/SECURITY\s+DEFINER/i);
    expect(header, file).toMatch(/SET\s+search_path\s*(?:=|TO)\s*'?public'?/i);
  });

  it('招待の組織の行を FOR NO KEY UPDATE で取り、active でなければ ORG_ALREADY_DISSOLVED (行が無ければ ORG_NOT_FOUND)', () => {
    expect(body, file).toMatch(
      /SELECT\s+status\s+INTO\s+v_org_status\s+FROM\s+organizations\s+WHERE\s+id\s*=\s*v_invite\.organization_id\s+FOR\s+NO\s+KEY\s+UPDATE\s*;\s*IF\s+NOT\s+FOUND\s+THEN\s+RAISE\s+EXCEPTION\s+'ORG_NOT_FOUND'[^;]*;\s*END\s+IF\s*;\s*IF\s+v_org_status\s*<>\s*'active'\s+THEN\s+RAISE\s+EXCEPTION\s+'ORG_ALREADY_DISSOLVED'/i,
    );
  });

  it('組織の行のロックは、招待の行のロックのあと、在籍の判定・最初の書き込み・席数のロックより前 (ロックの向き: 招待 → 組織 → user_profiles → org_license_pools)', () => {
    const inviteLockAt = indexOf(body, /FROM\s+organization_invites\s+WHERE\s+token\s*=\s*p_token\s+FOR\s+UPDATE/i, '招待の行のロック');
    const orgLockAt = indexOf(body, /FROM\s+organizations\s+WHERE\s+id\s*=\s*v_invite\.organization_id\s+FOR\s+NO\s+KEY\s+UPDATE/i, '組織の行のロック');
    const alreadyAt = indexOf(body, /IF\s+v_user_profile\.organization_id\s+IS\s+NOT\s+NULL/i, '在籍の判定');
    const upsertAt = indexOf(body, /INSERT\s+INTO\s+user_profiles/i, 'user_profiles への書き込み');
    const acceptedAt = indexOf(body, /UPDATE\s+organization_invites\s+SET\s+status\s*=\s*'accepted'/i, '招待の消化');
    const poolLockAt = indexOf(body, /FROM\s+org_license_pools\s+WHERE\s+organization_id\s*=\s*v_invite\.organization_id\s+FOR\s+UPDATE/i, '席数のロック');
    expect(orgLockAt, file).toBeGreaterThan(inviteLockAt);
    expect(orgLockAt, file).toBeLessThan(alreadyAt);
    expect(orgLockAt, file).toBeLessThan(upsertAt);
    expect(orgLockAt, file).toBeLessThan(acceptedAt);
    expect(orgLockAt, file).toBeLessThan(poolLockAt);
  });

  it('組織の行のロックは FOR NO KEY UPDATE の 1 回だけ (FOR UPDATE / FOR SHARE で組織の行を取らない。外部キーの確認と待ち合わないため)', () => {
    expect(body.match(/FROM\s+organizations\b[^;]*\bFOR\s+(?:NO\s+KEY\s+)?UPDATE/gi) ?? [], file).toHaveLength(1);
    expect(body, file).not.toMatch(/FROM\s+organizations\b[^;]*\bFOR\s+UPDATE/i);
    expect(body, file).not.toMatch(/FROM\s+organizations\b[^;]*\bFOR\s+(?:KEY\s+)?SHARE/i);
  });
});

describe('Q-4 operator_force_dissolve_org の最新の定義', () => {
  const { file, header, body: rawBody } = latestOf('operator_force_dissolve_org');
  const body = stripLineComments(rawBody);

  it('SECURITY DEFINER・search_path = public・RETURNS organizations・p_reason の既定値のまま', () => {
    expect(header, file).toMatch(/"p_reason"\s+"text"\s+DEFAULT\s+NULL::"text"/i);
    expect(header, file).toMatch(/RETURNS\s+"public"\."organizations"/i);
    expect(header, file).toMatch(/SECURITY\s+DEFINER/i);
    expect(header, file).toMatch(/SET\s+"search_path"\s+TO\s+'public'/i);
  });

  it('権限・MFA の判定のあと、後始末 (org_dissolve_apply) の前に、オーナーの user_profiles → 組織の行 の順で FOR NO KEY UPDATE を取る', () => {
    const roleAt = indexOf(body, /RAISE\s+EXCEPTION\s+'OPERATOR_PERMISSION_REQUIRED'/i, '権限の判定');
    const mfaAt = indexOf(body, /IF\s+NOT\s+public\.operator_mfa_satisfied\(\)\s+THEN\s+RAISE\s+EXCEPTION\s+'OPERATOR_MFA_REQUIRED'/i, 'MFA の判定');
    const ownerLockAt = indexOf(body, /PERFORM\s+1\s+FROM\s+user_profiles\s+WHERE\s+id\s*=\s*v_lock_owner\s+FOR\s+NO\s+KEY\s+UPDATE/i, 'オーナーの行のロック');
    const orgLockAt = indexOf(body, /SELECT\s+\*\s+INTO\s+v_org\s+FROM\s+organizations\s+WHERE\s+id\s*=\s*p_organization_id\s+FOR\s+NO\s+KEY\s+UPDATE/i, '組織の行のロック');
    const dissolvedAt = indexOf(body, /IF\s+v_org\.status\s*=\s*'dissolved'\s+THEN\s+RAISE\s+EXCEPTION\s+'ORG_ALREADY_DISSOLVED'/i, '解散済みの判定');
    const applyAt = indexOf(body, /public\.org_dissolve_apply\(\s*p_organization_id\s*\)/i, '後始末の呼び出し');
    expect(mfaAt, file).toBeGreaterThan(roleAt);
    expect(ownerLockAt, file).toBeGreaterThan(mfaAt);
    expect(orgLockAt, file).toBeGreaterThan(ownerLockAt);
    expect(dissolvedAt, file).toBeGreaterThan(orgLockAt);
    expect(applyAt, file).toBeGreaterThan(dissolvedAt);
  });

  it('オーナーの行を取ったあとにオーナーを読み直し、変わっていたら取り直す (ループ)', () => {
    expect(body, file).toMatch(
      /LOOP\s+PERFORM\s+1\s+FROM\s+user_profiles\s+WHERE\s+id\s*=\s*v_lock_owner\s+FOR\s+NO\s+KEY\s+UPDATE\s*;\s*SELECT\s+owner_id\s+INTO\s+v_current_owner\s+FROM\s+organizations\s+WHERE\s+id\s*=\s*p_organization_id\s*;\s*EXIT\s+WHEN\s+v_current_owner\s+IS\s+NOT\s+DISTINCT\s+FROM\s+v_lock_owner\s*;\s*v_lock_owner\s*:=\s*v_current_owner\s*;\s*END\s+LOOP\s*;/i,
    );
  });

  it('監査の action・metadata (reason / dissolved_at / previous_owner_id) は変えない', () => {
    expect(body, file).toMatch(/'operator_force_dissolve'/);
    expect(body, file).toMatch(/'reason',\s*p_reason,\s*'dissolved_at',\s*NOW\(\),\s*'previous_owner_id',\s*v_prev_owner/);
  });
});

describe('Q-4 解散の後始末 (org_dissolve_apply) は招待の行を触らない', () => {
  it('最新の org_dissolve_apply に organization_invites が出てこない (足すなら承諾とのロックの向きから決め直す)', () => {
    const { file, body } = latestOf('org_dissolve_apply');
    expect(stripLineComments(body), file).not.toMatch(/organization_invites/i);
  });
});

describe('Q-4 戻し口', () => {
  it('戻し口が実在し、1 行目が自分の migration を指す', () => {
    expect(fs.existsSync(ROLLBACK_PATH), ROLLBACK_PATH).toBe(true);
    const firstLine = fs.readFileSync(ROLLBACK_PATH, 'utf-8').split('\n', 1)[0];
    expect(firstLine).toBe(`-- rollback: ${MIGRATION}.sql`);
  });

  it.each(RESTORED_SOURCES)('$name を $file の :$from-$to に逐語で戻す', ({ file, from, to }) => {
    const rollback = fs.readFileSync(ROLLBACK_PATH, 'utf-8');
    const source = fs
      .readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8')
      .split('\n')
      .slice(from - 1, to)
      .join('\n');
    // 行の範囲が関数の定義の先頭と末尾を指していること (土台のファイルが書き換わって行がずれたら気づく)
    expect(source).toMatch(/^CREATE OR REPLACE FUNCTION /);
    expect(source).toMatch(/\$\$;$/);
    expect(rollback).toContain(source);
  });

  it('戻した 2 つの RPC は、組織の行のロック (Q-4 の修正) を含まない', () => {
    const sql = stripLineComments(fs.readFileSync(ROLLBACK_PATH, 'utf-8'));
    const accept = definitionsIn(ROLLBACK_PATH, sql, 'accept_org_invite');
    const operator = definitionsIn(ROLLBACK_PATH, sql, 'operator_force_dissolve_org');
    expect(accept).toHaveLength(1);
    expect(operator).toHaveLength(1);
    expect(accept[0].body).not.toMatch(/ORG_ALREADY_DISSOLVED/);
    expect(operator[0].body).not.toMatch(/v_lock_owner/);
  });
});
