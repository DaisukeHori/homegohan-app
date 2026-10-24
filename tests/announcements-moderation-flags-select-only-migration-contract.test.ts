/**
 * #1917 の続き: 運営 (admin / super_admin) の announcements (お知らせ) と moderation_flags (食事の通報) の FOR ALL のポリシーを
 * SELECT だけにし、recipe_flags (レシピの通報) の運営の FOR UPDATE のポリシーと personal_subscriptions (個人の契約) の運営の
 * FOR INSERT / FOR UPDATE のポリシーを消し、anon / authenticated の書き込みの権限を外した
 * migration (supabase/migrations/20261024110000_announcements_moderation_flags_select_only.sql) を、ファイルの読み取りで確かめる
 * (DB には接続しない)。運営は PostgREST の直接の書き込みで、運営の API と監査ログ (admin_audit_logs) を通らずにお知らせ・通報・契約を書けた。
 *
 *   1. migration を version 順にすべて流したときの 4 つの表のポリシーに、書き込みを許すものが無い。残る SELECT 以外のポリシーは
 *      recipe_flags の利用者の通報 ("Anyone can create recipe flags"。INSERT) と、personal_subscriptions の DELETE の禁止
 *      (personal_subscriptions_no_delete。USING (false)) だけ。anon と authenticated は UPDATE / DELETE / TRUNCATE の権限を持たず、
 *      INSERT は recipe_flags の authenticated だけが持ち、SELECT は持つ。service_role の権限は変わらない
 *   2. 本冊の migration が作る運営の SELECT のポリシーは、20261017130000_operator_mfa_db_gate.sql が付けた式 (TO authenticated・
 *      運営の MFA の判定) と USING の式が逐語で同じ (ロールの集合・MFA の判定を変えていない)
 *   3. 戻し口が実在し、流すと本冊の直前の状態 (ポリシーの名前と種類・権限) に戻る。作り直すポリシーの式は 20261017130000 の文と逐語で同じ
 *      (TRUNCATE は 20261022190000 が外してあるので付け直さない)
 *   4. アプリのコード (Web・モバイル・Edge Function・共有のライブラリ) で 4 つの表に書くのは、決まったファイルだけで、どれも
 *      requireRole の後の service_role の client で書く。DB の関数で 4 つの表に書くのは、決まった SECURITY DEFINER の関数だけ
 *   5. 本冊の migration のコメントが挙げる行番号が、ファイルの事実と合う
 *   6. 同じ型の全域の探索: 運営のロールで判定する書き込みのポリシーの全部 (migration の文面から作る) が、台帳
 *      (tests/helpers/operator-write-policy-sweep.ts) と過不足なく一致し、本冊の頭のコメントが台帳の表をすべて分類どおりに名指しする
 * 実際の挙動は tests/integration/rls/announcements-moderation-flags-select-only.test.ts (実 DB) が確かめる。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { listFiles, rel, ROOT, stripComments } from './helpers/ai-reach';
import {
  isOperatorRoleExpression,
  OPERATOR_WRITE_POLICIES_AFTER_MIGRATION,
  OPERATOR_WRITE_POLICY_SWEEP,
  type OperatorWritePolicySweepCategory,
  type OperatorWritePolicySweepEntry,
} from './helpers/operator-write-policy-sweep';

const MIGRATIONS_DIR = path.join(ROOT, 'supabase', 'migrations');
const MIGRATION = '20261024110000_announcements_moderation_flags_select_only';
const MIGRATION_FILE = `${MIGRATION}.sql`;
const ROLLBACK_PATH = path.join(ROOT, 'supabase', 'rollbacks', `${MIGRATION}.down.sql`);
/** 本番のベースライン (ポリシーと権限を最初に作ったファイル) */
const BASELINE_FILE = '20251126124224_create_meal_planner_tables.sql';
/** 運営のポリシーに TO authenticated と MFA の判定を足した migration */
const MFA_GATE_FILE = '20261017130000_operator_mfa_db_gate.sql';
/** personal_subscriptions の運営の INSERT / UPDATE のポリシーを作り、anon の書き込みの権限を外した migration */
const BILLING_CORE_FILE = '20261016210000_billing_core.sql';
/** anon / authenticated の TRUNCATE を public の全部の表から外した migration (本冊より前) */
const TRUNCATE_HARDENING_FILE = '20261022190000_db_privilege_hardening.sql';
/** 退会の外部キーを ON DELETE SET NULL にした migration */
const FK_ON_DELETE_FILE = '20261010000100_auth_users_fk_on_delete.sql';

/** 書き込みの権限 (本冊が anon / authenticated から外す。表ごとに残すものは TableSpec.keptUserWrites) */
const WRITE_PRIVILEGES = ['INSERT', 'UPDATE', 'DELETE'] as const;
type WritePrivilege = (typeof WRITE_PRIVILEGES)[number];
/** 利用者のロール (PostgREST の JWT のロール) */
const USER_ROLES = ['anon', 'authenticated'] as const;
type UserRole = (typeof USER_ROLES)[number];
/** 本冊の後に残すポリシーで、書き込みを許すもの (利用者の通報。運営の API を迂回する書き込みではない) */
const USER_REPORT_INSERT_POLICY = 'Anyone can create recipe flags';
/** 本冊の後に残す、常に偽の DELETE のポリシー (何も消させない。ベースライン :10743) */
const SUBSCRIPTION_NO_DELETE_POLICY = 'personal_subscriptions_no_delete';
/** 本冊の後に残る SELECT 以外のポリシー (名前 → 種類)。ほかは SELECT だけ */
const KEPT_NON_SELECT_POLICIES: Readonly<Record<string, string>> = {
  [USER_REPORT_INSERT_POLICY]: 'INSERT',
  [SUBSCRIPTION_NO_DELETE_POLICY]: 'DELETE',
};
/** GRANT ALL / REVOKE ALL が表す表の権限 (PostgreSQL 17 の表の権限の全部) */
const ALL_TABLE_PRIVILEGES = ['INSERT', 'SELECT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'] as const;
/** 20261022190000 の動的な REVOKE (public の全部の表から anon / authenticated の TRUNCATE を外す) */
const DYNAMIC_TRUNCATE_REVOKE = "format('REVOKE TRUNCATE ON TABLE %s FROM anon, authenticated'";

/** 本冊が消す運営の書き込みのポリシー */
interface RemovedPolicy {
  name: string;
  /** ポリシーの種類 (FOR の無い形 = ALL) */
  command: 'ALL' | 'INSERT' | 'UPDATE';
  /** 20261017130000 の ALTER POLICY の行番号 (1 始まり) */
  mfaGateLine: number;
}

interface TableSpec {
  table: string;
  /** 本冊が消す運営の書き込みのポリシー */
  removedPolicies: readonly RemovedPolicy[];
  /** 本冊が作る運営の SELECT のポリシー (作り直さない表は null。recipe_flags・personal_subscriptions は運営の SELECT をもともと持つ) */
  addedPolicy: string | null;
  /** 本冊の後に残るポリシー (名前 → 種類) */
  finalPolicies: ReadonlyArray<readonly [string, string]>;
  /** 本冊の後も利用者のロールに残す書き込みの権限 (残さないロールは空) */
  keptUserWrites: Readonly<Record<UserRole, readonly WritePrivilege[]>>;
  /** 本冊の直前に利用者のロールが持っている書き込みの権限 */
  userWritesBefore: Readonly<Record<UserRole, readonly WritePrivilege[]>>;
}

const NO_USER_WRITES: Readonly<Record<UserRole, readonly WritePrivilege[]>> = { anon: [], authenticated: [] };
/** ベースラインの GRANT のまま (anon も authenticated も INSERT / UPDATE / DELETE を持つ) */
const BASELINE_USER_WRITES: Readonly<Record<UserRole, readonly WritePrivilege[]>> = { anon: WRITE_PRIVILEGES, authenticated: WRITE_PRIVILEGES };

const TABLES: readonly TableSpec[] = [
  {
    table: 'announcements',
    removedPolicies: [{ name: 'Admins can manage announcements', command: 'ALL', mfaGateLine: 379 }],
    addedPolicy: 'Admins can view announcements',
    finalPolicies: [
      ['Admins can view announcements', 'SELECT'],
      ['Public announcements are viewable by everyone', 'SELECT'],
    ],
    keptUserWrites: NO_USER_WRITES,
    userWritesBefore: BASELINE_USER_WRITES,
  },
  {
    table: 'moderation_flags',
    removedPolicies: [{ name: 'moderation_flags_admin_all', command: 'ALL', mfaGateLine: 402 }],
    addedPolicy: 'moderation_flags_admin_select',
    finalPolicies: [['moderation_flags_admin_select', 'SELECT']],
    keptUserWrites: NO_USER_WRITES,
    userWritesBefore: BASELINE_USER_WRITES,
  },
  {
    table: 'recipe_flags',
    removedPolicies: [{ name: 'Admins can update recipe flags', command: 'UPDATE', mfaGateLine: 413 }],
    addedPolicy: null,
    finalPolicies: [
      [USER_REPORT_INSERT_POLICY, 'INSERT'],
      ['Users and admins can view recipe flags', 'SELECT'],
    ],
    keptUserWrites: { anon: [], authenticated: ['INSERT'] },
    userWritesBefore: BASELINE_USER_WRITES,
  },
  {
    table: 'personal_subscriptions',
    removedPolicies: [
      { name: 'personal_subscriptions_insert_admin', command: 'INSERT', mfaGateLine: 409 },
      { name: 'personal_subscriptions_update_admin', command: 'UPDATE', mfaGateLine: 411 },
    ],
    addedPolicy: null,
    finalPolicies: [
      [SUBSCRIPTION_NO_DELETE_POLICY, 'DELETE'],
      ['personal_subscriptions_select', 'SELECT'],
    ],
    keptUserWrites: NO_USER_WRITES,
    // anon の INSERT / UPDATE / DELETE は 20261016210000:63 が外してある
    userWritesBefore: { anon: [], authenticated: WRITE_PRIVILEGES },
  },
];
/** 本冊が運営の SELECT のポリシーを作り直す表 */
const TABLES_WITH_ADDED_POLICY = TABLES.filter((spec): spec is TableSpec & { addedPolicy: string } => spec.addedPolicy !== null);
/** 本冊が消すポリシーの全部 (表つき) */
const REMOVED_POLICIES = TABLES.flatMap((spec) => spec.removedPolicies.map((policy) => ({ table: spec.table, ...policy })));
/** 本冊の後に、ロール role が表 spec で持つべき書き込みの権限か */
const keeps = (spec: TableSpec, role: UserRole, privilege: string): boolean =>
  (spec.keptUserWrites[role] as readonly string[]).includes(privilege);
const heldBefore = (spec: TableSpec, role: UserRole, privilege: string): boolean =>
  (spec.userWritesBefore[role] as readonly string[]).includes(privilege);

/** SQL の行コメント (-- ...) を取り除く (コメントの中の語に反応しないため) */
const stripLineComments = (sql: string): string => sql.replace(/--.*$/gm, '');

const migrationFileNames = fs
  .readdirSync(MIGRATIONS_DIR)
  .filter((file) => file.endsWith('.sql'))
  .sort();
const readMigration = (file: string): string => fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8');
const migrations = migrationFileNames.map((file) => ({ file, sql: stripLineComments(readMigration(file)) }));
const migrationIndex = migrations.findIndex(({ file }) => file === MIGRATION_FILE);
const migrationRaw = migrationIndex >= 0 ? readMigration(MIGRATION_FILE) : '';
const migrationSql = stripLineComments(migrationRaw);
const rollbackSql = fs.existsSync(ROLLBACK_PATH) ? stripLineComments(fs.readFileSync(ROLLBACK_PATH, 'utf-8')) : '';

const tableRef = (table: string) => String.raw`(?:"?public"?\.)?"?${table}"?(?=[\s;])`;
const POLICY_NAME = String.raw`(?:"([^"]+)"|([A-Za-z_][\w]*))`;

interface TableState {
  /** ポリシーの名前 → 種類 (ALL / SELECT / INSERT / UPDATE / DELETE) */
  policies: Map<string, string>;
  /** ロール → 表の権限 */
  grants: Map<string, Set<string>>;
}

const emptyState = (): TableState => ({ policies: new Map(), grants: new Map() });

/** SQL の中の、表 table のポリシーと権限の文を、書かれた順に state へ流す */
function applySql(state: TableState, table: string, sql: string): TableState {
  const ref = tableRef(table);
  const events: Array<{ at: number; apply: () => void }> = [];
  const createPolicy = new RegExp(
    String.raw`CREATE\s+POLICY\s+${POLICY_NAME}\s+ON\s+${ref}\s*(?:AS\s+\w+\s+)?(?:FOR\s+(ALL|SELECT|INSERT|UPDATE|DELETE))?`,
    'gi',
  );
  for (const m of sql.matchAll(createPolicy)) {
    const name = m[1] ?? m[2];
    const command = (m[3] ?? 'ALL').toUpperCase();
    events.push({ at: m.index ?? 0, apply: () => state.policies.set(name, command) });
  }
  const dropPolicy = new RegExp(String.raw`DROP\s+POLICY\s+(?:IF\s+EXISTS\s+)?${POLICY_NAME}\s+ON\s+${ref}`, 'gi');
  for (const m of sql.matchAll(dropPolicy)) {
    const name = m[1] ?? m[2];
    events.push({ at: m.index ?? 0, apply: () => state.policies.delete(name) });
  }
  const grantOrRevoke = new RegExp(String.raw`\b(GRANT|REVOKE)\s+([A-Z ,]+?)\s+ON\s+(?:TABLE\s+)?${ref}\s+(TO|FROM)\s+([^;]+);`, 'gi');
  for (const m of sql.matchAll(grantOrRevoke)) {
    const isGrant = m[1].toUpperCase() === 'GRANT';
    const listed = m[2].split(',').map((p) => p.trim().toUpperCase());
    const privileges = listed.some((p) => p === 'ALL' || p === 'ALL PRIVILEGES') ? [...ALL_TABLE_PRIVILEGES] : listed;
    const roles = m[4].split(',').map((r) => r.trim().replace(/"/g, '').toLowerCase());
    events.push({
      at: m.index ?? 0,
      apply: () => {
        for (const role of roles) {
          const held = state.grants.get(role) ?? new Set<string>();
          for (const privilege of privileges) {
            if (isGrant) held.add(privilege);
            else held.delete(privilege);
          }
          state.grants.set(role, held);
        }
      },
    });
  }
  const dynamicAt = sql.indexOf(DYNAMIC_TRUNCATE_REVOKE);
  if (dynamicAt >= 0) {
    events.push({
      at: dynamicAt,
      apply: () => {
        for (const role of USER_ROLES) state.grants.get(role)?.delete('TRUNCATE');
      },
    });
  }
  for (const event of events.sort((a, b) => a.at - b.at)) event.apply();
  return state;
}

function stateAfter(table: string, files: ReadonlyArray<{ sql: string }>): TableState {
  const state = emptyState();
  for (const { sql } of files) applySql(state, table, sql);
  return state;
}

const sortedPolicies = (state: TableState) => [...state.policies.entries()].sort(([a], [b]) => a.localeCompare(b));
const sortedGrants = (state: TableState, role: string) => [...(state.grants.get(role) ?? new Set<string>())].sort();
const has = (state: TableState, role: string, privilege: string) => state.grants.get(role)?.has(privilege) ?? false;
const byName = (rows: ReadonlyArray<readonly [string, string]>) => [...rows].map(([n, c]) => [n, c]).sort(([a], [b]) => a.localeCompare(b));

const mfaGateLines = readMigration(MFA_GATE_FILE).split('\n');

/** 20261017130000 の ALTER POLICY の USING (...) の式 (WITH CHECK の前まで。末尾の ; を除く) */
function mfaGateUsing(line: number): string {
  const text = mfaGateLines[line - 1] ?? '';
  const m = /\bUSING\s+(\(.*?\))(?:\s+WITH\s+CHECK\s+\(.*\))?;$/.exec(text);
  return m ? m[1] : '';
}

/** 文 (CREATE POLICY ... ;) の USING (...) の式 */
function usingOf(statement: string): string {
  const m = /\bUSING\s+(\(.*?\))(?:\s+WITH\s+CHECK\s+\(.*\))?;$/.exec(statement.trim());
  return m ? m[1] : '';
}

const quotedPolicyName = (name: string): string => (/^[a-z_][a-z0-9_]*$/.test(name) ? name : `"${name}"`);

/** sql の中から、表 table の名前 name のポリシーを作る文 (1 行) を返す */
function createStatement(sql: string, table: string, name: string): string {
  const lines = sql.split('\n').filter((l) => l.startsWith(`CREATE POLICY ${quotedPolicyName(name)} ON public.${table} `));
  return lines.length === 1 ? lines[0] : '';
}

describe('#1917 の続き: migration を全部流した後の、4 つの表のポリシーと権限', () => {
  it.each(TABLES)('$table: 書き込みを許すポリシーが無い (SELECT 以外は利用者の通報の INSERT と、常に偽の DELETE の禁止だけ)', ({ table, finalPolicies }) => {
    const finalState = stateAfter(table, migrations);
    expect(sortedPolicies(finalState)).toEqual(byName(finalPolicies));
    for (const [name, command] of finalState.policies) expect(command, name).toBe(KEPT_NON_SELECT_POLICIES[name] ?? 'SELECT');
  });

  it.each(TABLES)('$table: anon と authenticated は UPDATE / DELETE / TRUNCATE の権限を持たず、INSERT は keptUserWrites のものだけ、SELECT は持つ', (spec) => {
    const finalState = stateAfter(spec.table, migrations);
    for (const role of USER_ROLES) {
      for (const privilege of WRITE_PRIVILEGES) expect(has(finalState, role, privilege), `${role} ${privilege}`).toBe(keeps(spec, role, privilege));
      expect(has(finalState, role, 'TRUNCATE'), `${role} TRUNCATE`).toBe(false);
      expect(has(finalState, role, 'SELECT'), `${role} SELECT`).toBe(true);
    }
  });

  it('recipe_flags: 残る利用者の INSERT のポリシーは TO authenticated で reporter_id = auth.uid() の行だけを許す (運営の枝を持たない)', () => {
    const create = migrations
      .flatMap(({ sql }) => sql.split('\n'))
      .filter((line) => line.startsWith(`CREATE POLICY "${USER_REPORT_INSERT_POLICY}" ON "public"."recipe_flags" `));
    expect(create).toEqual([
      'CREATE POLICY "Anyone can create recipe flags" ON "public"."recipe_flags" FOR INSERT TO "authenticated" WITH CHECK (("reporter_id" = "auth"."uid"()));',
    ]);
  });

  it('personal_subscriptions: 残る DELETE のポリシーは常に偽 (USING (false)) で、どの migration も作り直していない', () => {
    const statements = migrations
      .flatMap(({ file, sql }) => sql.split('\n').map((line) => ({ file, line })))
      .filter(({ line }) => new RegExp(String.raw`\bPOLICY\s+(?:IF\s+EXISTS\s+)?"?${SUBSCRIPTION_NO_DELETE_POLICY}"?\s`, 'i').test(line));
    expect(statements).toEqual([
      {
        file: BASELINE_FILE,
        line: 'CREATE POLICY "personal_subscriptions_no_delete" ON "public"."personal_subscriptions" FOR DELETE USING (false);',
      },
    ]);
  });

  it.each(TABLES)('$table: service_role は全部の権限を持ったまま (API・DB の関数を呼ぶサーバー・テストの後片付けが使う)', ({ table }) => {
    expect(sortedGrants(stateAfter(table, migrations), 'service_role')).toEqual([...ALL_TABLE_PRIVILEGES].sort());
  });

  it.each(TABLES)('番兵: $table の読み取りが、本冊の直前の運営の書き込みのポリシーと書き込みの権限を拾っている', (spec) => {
    const { table, removedPolicies, finalPolicies, addedPolicy } = spec;
    expect(migrationIndex, `${MIGRATION_FILE} が supabase/migrations に無い`).toBeGreaterThan(0);
    const before = stateAfter(table, migrations.slice(0, migrationIndex));
    const expectedBefore = finalPolicies
      .filter(([name]) => name !== addedPolicy)
      .concat(removedPolicies.map(({ name, command }) => [name, command] as const));
    expect(sortedPolicies(before)).toEqual(byName(expectedBefore));
    for (const role of USER_ROLES) {
      for (const privilege of WRITE_PRIVILEGES) {
        expect(has(before, role, privilege), `${role} ${privilege} (本冊の直前)`).toBe(heldBefore(spec, role, privilege));
      }
      expect(has(before, role, 'TRUNCATE'), `${role} TRUNCATE (20261022190000 で外してある)`).toBe(false);
    }
    // 本冊が外す権限が、本冊の直前に少なくとも 1 つある (外すものの無い表を数えていない)
    expect(USER_ROLES.some((role) => WRITE_PRIVILEGES.some((p) => heldBefore(spec, role, p) && !keeps(spec, role, p)))).toBe(true);
    const hardeningIndex = migrations.findIndex(({ file }) => file === TRUNCATE_HARDENING_FILE);
    expect(hardeningIndex).toBeGreaterThan(0);
    expect(hardeningIndex).toBeLessThan(migrationIndex);
    const beforeHardening = stateAfter(table, migrations.slice(0, hardeningIndex));
    for (const role of USER_ROLES) expect(has(beforeHardening, role, 'TRUNCATE'), `${role} TRUNCATE (20261022190000 の前)`).toBe(true);
  });
});

describe('#1917 の続き: 本冊の migration', () => {
  it.each(TABLES)('$table: 本冊だけを流すと、運営の書き込みのポリシーが消え (SELECT を作り直す表は SELECT に替わり)、anon / authenticated の書き込みの権限だけが外れる', (spec) => {
    const { table, removedPolicies, addedPolicy } = spec;
    const removedNames = new Set(removedPolicies.map(({ name }) => name));
    const before = stateAfter(table, migrations.slice(0, migrationIndex));
    const own = applySql(stateAfter(table, migrations.slice(0, migrationIndex)), table, migrationSql);
    for (const name of removedNames) expect(own.policies.has(name), name).toBe(false);
    if (addedPolicy !== null) expect(own.policies.get(addedPolicy)).toBe('SELECT');
    // 消す・作る以外のポリシーには触れない
    const untouched = (state: TableState) => sortedPolicies(state).filter(([name]) => !removedNames.has(name) && name !== addedPolicy);
    expect(untouched(own)).toEqual(untouched(before));
    for (const role of USER_ROLES) {
      const removed = (p: string) => (WRITE_PRIVILEGES as readonly string[]).includes(p) && !keeps(spec, role, p);
      expect(sortedGrants(own, role), role).toEqual(sortedGrants(before, role).filter((p) => !removed(p)));
    }
    expect(sortedGrants(own, 'service_role')).toEqual(sortedGrants(before, 'service_role'));
  });

  it.each(TABLES_WITH_ADDED_POLICY)('$table: 作る SELECT のポリシーは TO authenticated で、USING の式は 20261017130000 の式と逐語で同じ (運営の MFA の判定つき)', (spec) => {
    const statement = createStatement(migrationSql, spec.table, spec.addedPolicy);
    expect(statement, `${spec.addedPolicy} を作る文が 1 行だけある`).not.toBe('');
    expect(statement).toMatch(/\bFOR SELECT TO authenticated USING\b/);
    expect(statement).not.toMatch(/WITH CHECK/);
    const expected = mfaGateUsing(spec.removedPolicies[0].mfaGateLine);
    expect(expected).toContain('public.operator_mfa_satisfied()');
    expect(usingOf(statement)).toBe(expected);
  });

  it('service_role・TRUNCATE・SELECT の権限と、ほかの表には触れない', () => {
    expect(migrationSql).not.toMatch(/service_role/);
    expect(migrationSql).not.toMatch(/\bTRUNCATE\b/i);
    expect(migrationSql).not.toMatch(/\bGRANT\b/i);
    const touched = new Set(
      [...migrationSql.matchAll(/\bON\s+(?:TABLE\s+)?public\.("?)(\w+)\1/gi)].map((m) => m[2]),
    );
    expect([...touched].sort()).toEqual(TABLES.map((t) => t.table).sort());
  });

  it('作るポリシーは announcements と moderation_flags の SELECT の 2 本だけ (recipe_flags・personal_subscriptions の運営の書き込みのポリシーは作り直さない)', () => {
    const created = [...migrationSql.matchAll(/\bCREATE\s+POLICY\s+(?:"([^"]+)"|(\w+))\s+ON\s+public\.(\w+)/gi)].map((m) => `${m[3]} ${m[1] ?? m[2]}`);
    expect(created.sort()).toEqual(TABLES_WITH_ADDED_POLICY.map((t) => `${t.table} ${t.addedPolicy}`).sort());
  });
});

describe('#1917 の続き: 戻し口', () => {
  it('実在し、1 行目が自分の migration を指す', () => {
    expect(fs.existsSync(ROLLBACK_PATH), rel(ROLLBACK_PATH)).toBe(true);
    expect(fs.readFileSync(ROLLBACK_PATH, 'utf-8').split('\n')[0]).toBe(`-- rollback: ${MIGRATION_FILE}`);
  });

  it.each(TABLES)('$table: 本冊の後に流すと、本冊の直前の状態 (ポリシーの名前と種類・権限) に戻る', ({ table }) => {
    const before = stateAfter(table, migrations.slice(0, migrationIndex));
    const restored = applySql(applySql(stateAfter(table, migrations.slice(0, migrationIndex)), table, migrationSql), table, rollbackSql);
    expect(sortedPolicies(restored)).toEqual(sortedPolicies(before));
    for (const role of [...USER_ROLES, 'service_role']) expect(sortedGrants(restored, role), role).toEqual(sortedGrants(before, role));
  });

  it.each(REMOVED_POLICIES)('$table の $name: 作り直すポリシーは、本冊の直前と同じ種類 (FOR) で、20261017130000 の ALTER POLICY と同じ TO と式 (USING と WITH CHECK)', (removed) => {
    const statement = createStatement(rollbackSql, removed.table, removed.name);
    expect(statement, `${removed.name} を作る文が 1 行だけある`).not.toBe('');
    const gate = mfaGateLines[removed.mfaGateLine - 1] ?? '';
    const quoted = quotedPolicyName(removed.name);
    const gatePrefix = `ALTER POLICY ${quoted} ON public.${removed.table} `;
    expect(gate.startsWith(gatePrefix), `${MFA_GATE_FILE}:${removed.mfaGateLine}`).toBe(true);
    // ALTER POLICY は種類 (FOR) を持たないので、FOR ALL 以外のポリシーは CREATE POLICY の側に FOR を書く
    const forClause = removed.command === 'ALL' ? '' : `FOR ${removed.command} `;
    const createPrefix = `CREATE POLICY ${quoted} ON public.${removed.table} ${forClause}`;
    expect(statement.startsWith(createPrefix), createPrefix).toBe(true);
    expect(statement.slice(createPrefix.length)).toBe(gate.slice(gatePrefix.length));
  });
});

/** アプリのコードの置き場 (Web・モバイル・Edge Function・共有のライブラリ) */
const APP_DIRS = ['src', 'lib', 'apps/mobile/src', 'apps/mobile/app', 'packages/shared/src', 'supabase/functions'] as const;
const isSource = (name: string) => /\.(ts|tsx)$/.test(name) && !/\.d\.ts$/.test(name);
const isTestPath = (file: string) => /(__tests__|\.test\.|\.spec\.)/.test(file);

/**
 * 4 つの表に書く (insert / update / upsert / delete) 場所の一覧と理由。キーは「ファイル 表」。
 * ここに無い場所で書くと赤になる (本人のセッションの client で書く新しい経路は、本冊の後は 42501 で失敗する。
 * recipe_flags の利用者の通報の INSERT だけは本人のセッションで書けるが、いまアプリにその経路は無い。
 * personal_subscriptions はアプリから .from で書かず、サーバーが service_role で SECURITY DEFINER の関数を呼ぶ)
 */
const WRITE_SITES: Readonly<Record<string, string>> = {
  'src/app/api/announcements/route.ts announcements': 'POST: requireRole の後に getSupabaseAdmin() で INSERT (下の別の検査が receiver を見る)',
  'src/lib/admin/moderation-backend.ts moderation_flags': 'resolveModerationItem: 呼び出し側 (運営の route) が requireRole の後の service_role の client を渡す',
  'src/lib/admin/hidden-content-restore.ts moderation_flags': '戻す操作: 呼び出し側 (restore の route) が requireRole の後の service_role の client を渡す',
  'src/lib/admin/moderation-backend.ts recipe_flags': 'resolveModerationItem: moderation_flags と同じ関数 (呼び出し側が requireRole の後の service_role の client を渡す)',
  'src/lib/admin/hidden-content-restore.ts recipe_flags': '戻す操作: moderation_flags と同じ関数 (MODERATION_FLAG_TABLE_OF で表を選ぶ)',
};
/** 表の名前を引数・定数から選ぶ書き方 (hidden-content-restore.ts の MODERATION_FLAG_TABLE_OF・moderation-backend.ts の backingTable) */
const INDIRECT_FLAG_TABLE_RESOLVERS = ['MODERATION_FLAG_TABLE_OF', 'backingTable'] as const;
/** 間接の書き方が選びうる表 */
const INDIRECT_FLAG_TABLES = ['moderation_flags', 'recipe_flags'] as const;

/** 4 つの表に書く呼び出しを、ファイルごとに見つける (from('表') から 1 つの式の中で insert / update / upsert / delete を呼ぶ) */
function writeSitesIn(file: string): string[] {
  const code = stripComments(fs.readFileSync(file, 'utf-8'));
  const found = new Set<string>();
  for (const { table } of TABLES) {
    const pattern = new RegExp(String.raw`\.from\(\s*['"\`]${table}['"\`]\s*\)[^;]*?\.(insert|update|upsert|delete)\(`, 'g');
    if (pattern.test(code)) found.add(table);
  }
  // 表の名前を定数・関数から引く書き方 (.from(MODERATION_FLAG_TABLE_OF[type]) / .from(backingTable(type)) の後の書き込み) も拾う。
  // 選びうる表は、そのファイルに名前の文字列がある通報の表
  for (const resolver of INDIRECT_FLAG_TABLE_RESOLVERS) {
    const pattern = new RegExp(String.raw`\.from\(\s*${resolver}\b[^;]*?\.(insert|update|upsert|delete)\(`);
    if (!pattern.test(code)) continue;
    for (const table of INDIRECT_FLAG_TABLES) if (new RegExp(String.raw`['"]${table}['"]`).test(code)) found.add(table);
  }
  return [...found];
}

/**
 * 4 つの表に書く DB の関数 (「関数名 表」→ 役目)。どの定義も SECURITY DEFINER で、所有者 (postgres) の権限で書くので、
 * 本冊が anon / authenticated の書き込みの権限を外しても書ける。EXECUTE は service_role だけ (サーバーが呼ぶ)
 */
const DB_FUNCTION_WRITERS: Readonly<Record<string, string>> = {
  'apply_coupon personal_subscriptions': 'クーポンの適用 (20261007160700)',
  'billing_apply_stripe_subscription personal_subscriptions': 'Stripe の写像 (20261016210000)',
  'billing_apply_store_subscription personal_subscriptions': 'ストアの写像 (20261021100000)',
  'billing_grant_manual_subscription personal_subscriptions': '手動付与 (20261017230000)',
  'billing_revoke_manual_subscription personal_subscriptions': '手動付与の取り消し (20261017230000・20261021100000)',
  'billing_expire_manual_subscription_for_user personal_subscriptions': '手動付与の期限切れ (20261017230000・20261021100000)',
};

interface FunctionDefinition {
  file: string;
  name: string;
  /** CREATE から本体の前まで と、本体の後ろから ; まで (SECURITY DEFINER の有無を見る) */
  clauses: string;
  body: string;
}

/** migration の文面 (行コメントを除いたもの) から、関数・プロシージャの定義 (本体が $tag$ で囲まれたもの) を取り出す */
function functionDefinitions(file: string, sql: string): FunctionDefinition[] {
  const creates = [...sql.matchAll(/\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:FUNCTION|PROCEDURE)\s+(?:"?public"?\.)?"?(\w+)"?\s*\(/gi)];
  return creates.flatMap((create, i) => {
    const start = create.index ?? 0;
    const end = i + 1 < creates.length ? (creates[i + 1].index ?? sql.length) : sql.length;
    const segment = sql.slice(start, end);
    const as = /\bAS\s+(\$[A-Za-z_]*\$)/.exec(segment);
    if (!as) return [];
    const bodyStart = as.index + as[0].length;
    const bodyEnd = segment.indexOf(as[1], bodyStart);
    if (bodyEnd < 0) return [];
    const afterBody = segment.slice(bodyEnd + as[1].length);
    const semicolon = afterBody.indexOf(';');
    const trailer = semicolon >= 0 ? afterBody.slice(0, semicolon) : afterBody;
    return [{ file, name: create[1], clauses: `${segment.slice(0, as.index)} ${trailer}`, body: segment.slice(bodyStart, bodyEnd) }];
  });
}

describe('#1917 の続き: アプリのコードは 4 つの表に service_role でだけ書く', () => {
  const files = APP_DIRS.flatMap((dir) => {
    const abs = path.join(ROOT, dir);
    return fs.existsSync(abs) ? listFiles(abs, isSource) : [];
  }).filter((file) => !isTestPath(rel(file)));

  it('4 つの表に書く場所は WRITE_SITES の一覧と同じ (増えたら、本人のセッションで書いていないかを確かめて一覧に足す)', () => {
    expect(files.length).toBeGreaterThan(0);
    const actual = files.flatMap((file) => writeSitesIn(file).map((table) => `${rel(file)} ${table}`)).sort();
    expect(actual).toEqual(Object.keys(WRITE_SITES).sort());
  });

  it('お知らせの INSERT の receiver は getSupabaseAdmin() で、requireRole の後にある', () => {
    const code = stripComments(fs.readFileSync(path.join(ROOT, 'src/app/api/announcements/route.ts'), 'utf-8'));
    const post = code.slice(code.indexOf('export async function POST'));
    const insertAt = post.search(/await\s+getSupabaseAdmin\(\)\s*\.from\(\s*'announcements'\s*\)\s*\.insert\(/);
    expect(insertAt, 'POST の INSERT が getSupabaseAdmin() から始まる').toBeGreaterThan(0);
    expect(post.indexOf("requireRole(['admin', 'super_admin'])")).toBeGreaterThan(0);
    expect(post.indexOf("requireRole(['admin', 'super_admin'])")).toBeLessThan(insertAt);
    // 本人のセッションの client では announcements に書かない
    expect(post).not.toMatch(/supabase\s*\.from\(\s*'announcements'\s*\)/);
  });

  it('通報に書く関数の呼び出し (route) は、どれも service_role の client (supabaseAdmin) を渡す', () => {
    const callers = files.filter((file) => /src\/app\/api\//.test(rel(file)));
    const calls = callers.flatMap((file) => {
      const code = stripComments(fs.readFileSync(file, 'utf-8'));
      return [...code.matchAll(/\b(resolveModerationItem|restoreModeratedContent)\(\s*(\w+)/g)].map((m) => ({ file: rel(file), fn: m[1], arg: m[2] }));
    });
    expect(calls.map((c) => c.fn).sort()).toEqual(['resolveModerationItem', 'restoreModeratedContent']);
    for (const call of calls) expect(call.arg, `${call.file} ${call.fn}`).toBe('supabaseAdmin');
    for (const call of calls) {
      const code = stripComments(fs.readFileSync(path.join(ROOT, call.file), 'utf-8'));
      expect(code, call.file).toMatch(/const\s+supabaseAdmin\s*=\s*getSupabaseAdmin\(\)/);
    }
  });

  it('DB の関数で 4 つの表に INSERT / UPDATE / DELETE するのは DB_FUNCTION_WRITERS の関数だけで、どの定義も SECURITY DEFINER (本人の権限で動く関数が書けなくなることは無い)', () => {
    const definitions = migrations.flatMap(({ file, sql }) => functionDefinitions(file, sql));
    expect(definitions.length, '関数の定義を読めている').toBeGreaterThan(Object.keys(DB_FUNCTION_WRITERS).length);
    const writers = new Set<string>();
    for (const definition of definitions) {
      for (const { table } of TABLES) {
        const write = new RegExp(String.raw`\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(?:"?public"?\.)?"?${table}"?\b`, 'i');
        if (!write.test(definition.body)) continue;
        writers.add(`${definition.name} ${table}`);
        expect(definition.clauses, `${definition.file} の ${definition.name} が ${table} に書くのに SECURITY DEFINER でない`).toMatch(/\bSECURITY\s+DEFINER\b/i);
      }
    }
    expect([...writers].sort()).toEqual(Object.keys(DB_FUNCTION_WRITERS).sort());
  });
});

describe('#1917 の続き: 本冊のコメントが挙げる行番号', () => {
  const lineOf = (file: string, line: number) => (readMigration(file).split('\n')[line - 1] ?? '');

  it.each([
    [BASELINE_FILE, 9518, 'CREATE POLICY "Admins can manage announcements" ON "public"."announcements" USING'],
    [BASELINE_FILE, 9675, 'CREATE POLICY "Public announcements are viewable by everyone" ON "public"."announcements" FOR SELECT'],
    [BASELINE_FILE, 10605, 'CREATE POLICY "moderation_flags_admin_all" ON "public"."moderation_flags" USING'],
    [BASELINE_FILE, 13460, 'GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."announcements" TO "anon";'],
    [BASELINE_FILE, 13461, 'GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."announcements" TO "authenticated";'],
    [BASELINE_FILE, 13726, 'GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."moderation_flags" TO "anon";'],
    [BASELINE_FILE, 13727, 'GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."moderation_flags" TO "authenticated";'],
    [BASELINE_FILE, 9536, 'CREATE POLICY "Admins can update recipe flags" ON "public"."recipe_flags" FOR UPDATE USING'],
    [BASELINE_FILE, 9594, 'CREATE POLICY "Anyone can create recipe flags" ON "public"."recipe_flags" FOR INSERT TO "authenticated"'],
    [BASELINE_FILE, 9713, 'CREATE POLICY "Users and admins can view recipe flags" ON "public"."recipe_flags" FOR SELECT'],
    [BASELINE_FILE, 13814, 'GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."recipe_flags" TO "anon";'],
    [BASELINE_FILE, 13815, 'GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."recipe_flags" TO "authenticated";'],
    [BASELINE_FILE, 10743, 'CREATE POLICY "personal_subscriptions_no_delete" ON "public"."personal_subscriptions" FOR DELETE USING (false);'],
    [BASELINE_FILE, 10747, 'CREATE POLICY "personal_subscriptions_select" ON "public"."personal_subscriptions" FOR SELECT'],
    [BASELINE_FILE, 13790, 'GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."personal_subscriptions" TO "anon";'],
    [BASELINE_FILE, 13791, 'GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."personal_subscriptions" TO "authenticated";'],
    [BASELINE_FILE, 9223, '    ADD CONSTRAINT "personal_subscriptions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;'],
    [BILLING_CORE_FILE, 51, 'CREATE POLICY personal_subscriptions_insert_admin ON public.personal_subscriptions'],
    [BILLING_CORE_FILE, 55, 'CREATE POLICY personal_subscriptions_update_admin ON public.personal_subscriptions'],
    [BILLING_CORE_FILE, 63, 'REVOKE INSERT, UPDATE, DELETE ON public.personal_subscriptions FROM anon;'],
    [MFA_GATE_FILE, 375, 'ALTER POLICY audit_logs_insert_admins ON public.admin_audit_logs TO authenticated WITH CHECK'],
    [MFA_GATE_FILE, 379, 'ALTER POLICY "Admins can manage announcements" ON public.announcements TO authenticated USING'],
    [MFA_GATE_FILE, 402, 'ALTER POLICY moderation_flags_admin_all ON public.moderation_flags TO authenticated USING'],
    [MFA_GATE_FILE, 409, 'ALTER POLICY personal_subscriptions_insert_admin ON public.personal_subscriptions TO authenticated WITH CHECK'],
    [MFA_GATE_FILE, 411, 'ALTER POLICY personal_subscriptions_update_admin ON public.personal_subscriptions TO authenticated USING'],
    [MFA_GATE_FILE, 413, 'ALTER POLICY "Admins can update recipe flags" ON public.recipe_flags TO authenticated USING'],
    [FK_ON_DELETE_FILE, 238, 'ALTER TABLE public.announcements'],
    [FK_ON_DELETE_FILE, 292, 'ALTER TABLE public.moderation_flags'],
    [FK_ON_DELETE_FILE, 318, 'ALTER TABLE public.recipe_flags'],
    [FK_ON_DELETE_FILE, 323, 'ALTER TABLE public.recipe_flags'],
  ] as const)('%s:%i は「%s」で始まる', (file, line, prefix) => {
    expect(lineOf(file, line).startsWith(prefix)).toBe(true);
  });

  it('本冊のコメントが、上の行番号を挙げている', () => {
    for (const ref of [
      ':9518', ':9675', ':10605', ':13460-13461', ':13726-13727', ':9536', ':9594', ':9713', ':13814-13815',
      ':10743', ':10747', ':13790-13791', '(ベースライン :9223)',
      '20261016210000_billing_core.sql:51', ':55 "personal_subscriptions_update_admin"', '20261016210000:63',
      '20261017130000_operator_mfa_db_gate.sql:379', '20261017130000:402', '20261017130000:413', '20261017130000:409・:411', '20261017130000:375',
      '20261010000100_auth_users_fk_on_delete.sql:238', '(:292)', '(:318・:323)',
    ]) {
      expect(migrationRaw, ref).toContain(ref);
    }
  });
});

/** migration の文面から作る、public のポリシーの全部 (「表|ポリシー」→ 種類と式の文面) */
interface PolicyText {
  command: string;
  /** CREATE POLICY / ALTER POLICY の ON 表 の後ろの文面 (USING と WITH CHECK の式を含む) */
  text: string;
}

const QUALIFIED_TABLE = String.raw`(?:"?(\w+)"?\.)?"?([A-Za-z_]\w*)"?`;

/** migration を順に流したときの、public のポリシー (CREATE / DROP / ALTER POLICY と DROP TABLE を書かれた順に流す) */
function publicPoliciesAfter(files: ReadonlyArray<{ sql: string }>): Map<string, PolicyText> {
  const policies = new Map<string, PolicyText>();
  const keyOf = (schema: string | undefined, table: string, name: string) => `${(schema ?? 'public').toLowerCase()}.${table}|${name}`;
  for (const { sql } of files) {
    const events: Array<{ at: number; apply: () => void }> = [];
    for (const m of sql.matchAll(new RegExp(String.raw`CREATE\s+POLICY\s+${POLICY_NAME}\s+ON\s+${QUALIFIED_TABLE}([^;]*);`, 'gi'))) {
      const key = keyOf(m[3], m[4], m[1] ?? m[2]);
      const rest = m[5];
      const command = (/^\s*(?:AS\s+\w+\s+)?(?:FOR\s+(ALL|SELECT|INSERT|UPDATE|DELETE))?/i.exec(rest)?.[1] ?? 'ALL').toUpperCase();
      events.push({ at: m.index ?? 0, apply: () => policies.set(key, { command, text: rest }) });
    }
    for (const m of sql.matchAll(new RegExp(String.raw`DROP\s+POLICY\s+(?:IF\s+EXISTS\s+)?${POLICY_NAME}\s+ON\s+${QUALIFIED_TABLE}`, 'gi'))) {
      const key = keyOf(m[3], m[4], m[1] ?? m[2]);
      events.push({ at: m.index ?? 0, apply: () => policies.delete(key) });
    }
    for (const m of sql.matchAll(new RegExp(String.raw`ALTER\s+POLICY\s+${POLICY_NAME}\s+ON\s+${QUALIFIED_TABLE}([^;]*);`, 'gi'))) {
      const schema = m[3];
      const table = m[4];
      const key = keyOf(schema, table, m[1] ?? m[2]);
      const rest = m[5];
      events.push({
        at: m.index ?? 0,
        apply: () => {
          const current = policies.get(key);
          if (!current) return;
          const rename = /RENAME\s+TO\s+(?:"([^"]+)"|(\w+))/i.exec(rest);
          if (rename) {
            policies.delete(key);
            policies.set(keyOf(schema, table, rename[1] ?? rename[2]), current);
          } else if (/\b(USING|WITH\s+CHECK)\b/i.test(rest)) {
            policies.set(key, { ...current, text: rest });
          }
        },
      });
    }
    for (const m of sql.matchAll(new RegExp(String.raw`DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?${QUALIFIED_TABLE}`, 'gi'))) {
      const prefix = `${(m[1] ?? 'public').toLowerCase()}.${m[2]}|`;
      events.push({
        at: m.index ?? 0,
        apply: () => {
          for (const key of [...policies.keys()]) if (key.startsWith(prefix)) policies.delete(key);
        },
      });
    }
    for (const event of events.sort((a, b) => a.at - b.at)) event.apply();
  }
  return policies;
}

/** 運営のロールで判定する、書き込みを許す public のポリシー (「表|ポリシー 種類」の並び) */
function operatorWritePolicies(files: ReadonlyArray<{ sql: string }>): string[] {
  return [...publicPoliciesAfter(files).entries()]
    .filter(([key, { command, text }]) => key.startsWith('public.') && command !== 'SELECT' && isOperatorRoleExpression(text))
    .map(([key, { command }]) => `${key.slice('public.'.length)} ${command}`)
    .sort();
}

const ledgerRows = (entries: readonly OperatorWritePolicySweepEntry[]) => entries.map((e) => `${e.table}|${e.policy} ${e.command}`).sort();

/** 頭のコメントの「同じ型の全域の探索」の節と、分類ごとの見出しの番号 */
const SWEEP_SECTION_START = '-- 同じ型の全域の探索:';
const SWEEP_SECTION_END = '-- 既存データへの影響';
const SWEEP_HEADING_OF: Readonly<Record<OperatorWritePolicySweepCategory, string>> = {
  closedHere: '(1)',
  sessionClientApi: '(2)',
  noOperatorWriteApi: '(3)',
  auditSink: '(4)',
};
const CATEGORY_ORDER = Object.keys(SWEEP_HEADING_OF) as OperatorWritePolicySweepCategory[];

/** 節の中の、分類 category の見出しから次の見出しまで */
function sweepSubsection(section: string, category: OperatorWritePolicySweepCategory): string {
  const start = section.indexOf(`--   ${SWEEP_HEADING_OF[category]} `);
  if (start < 0) return '';
  const next = CATEGORY_ORDER.slice(CATEGORY_ORDER.indexOf(category) + 1)
    .map((c) => section.indexOf(`--   ${SWEEP_HEADING_OF[c]} `, start))
    .filter((at) => at > start);
  return section.slice(start, next.length > 0 ? Math.min(...next) : section.length);
}

/** 表の名前が、ほかの名前・パスの一部としてでなく出る */
const mentionsTable = (text: string, table: string) => new RegExp(String.raw`(?<![\w/])${table}(?![\w/])`).test(text);

describe('#1917 の続き: 同じ型の全域の探索 (運営のロールで判定する書き込みのポリシーの台帳)', () => {
  it('本冊の直前の、運営のロールで判定する書き込みのポリシーは、台帳 OPERATOR_WRITE_POLICY_SWEEP と過不足なく一致する (分類の無いものが無い)', () => {
    expect(migrationIndex).toBeGreaterThan(0);
    expect(operatorWritePolicies(migrations.slice(0, migrationIndex))).toEqual(ledgerRows(OPERATOR_WRITE_POLICY_SWEEP));
  });

  it('全部流した後は、台帳から本冊が消したもの (closedHere) を除いたものと一致する (後の migration がこの型のポリシーを足したら、台帳で分類する)', () => {
    expect(operatorWritePolicies(migrations)).toEqual(ledgerRows(OPERATOR_WRITE_POLICIES_AFTER_MIGRATION));
  });

  it('台帳の closedHere は、本冊が消すポリシー (REMOVED_POLICIES) と同じ', () => {
    const closed = OPERATOR_WRITE_POLICY_SWEEP.filter((e) => e.category === 'closedHere').map((e) => `${e.table}|${e.policy} ${e.command}`).sort();
    expect(closed).toEqual(REMOVED_POLICIES.map((p) => `${p.table}|${p.name} ${p.command}`).sort());
  });

  it('台帳の行は 1 本ずつで、理由を持つ', () => {
    const keys = OPERATOR_WRITE_POLICY_SWEEP.map((e) => `${e.table}|${e.policy}`);
    expect(new Set(keys).size).toBe(keys.length);
    for (const entry of OPERATOR_WRITE_POLICY_SWEEP) expect(entry.reason.trim(), `${entry.table}|${entry.policy}`).not.toBe('');
  });

  it('本冊の頭のコメントの「同じ型の全域の探索」は、総数と分類ごとの本数を書き、台帳の表をすべて分類どおりの見出しの下で名指しする', () => {
    const start = migrationRaw.indexOf(SWEEP_SECTION_START);
    const end = migrationRaw.indexOf(SWEEP_SECTION_END, start);
    expect(start, '節がある').toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const section = migrationRaw.slice(start, end);
    expect(section).toContain(`この型に当たるのは ${OPERATOR_WRITE_POLICY_SWEEP.length} 本`);
    for (const category of CATEGORY_ORDER) {
      const entries = OPERATOR_WRITE_POLICY_SWEEP.filter((e) => e.category === category);
      const subsection = sweepSubsection(section, category);
      expect(subsection, `${SWEEP_HEADING_OF[category]} の見出しがある`).not.toBe('');
      expect(subsection, `${SWEEP_HEADING_OF[category]} の本数`).toContain(`— ${entries.length} 本`);
      for (const { table } of entries) expect(mentionsTable(subsection, table), `${SWEEP_HEADING_OF[category]} が ${table} を名指しする`).toBe(true);
    }
  });
});
