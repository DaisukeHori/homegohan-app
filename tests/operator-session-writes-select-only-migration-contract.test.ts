/**
 * #1917 の続き: 運営 (と組織の管理者のポリシーの運営の枝) が自分のセッションの JWT で PostgREST から直接書けた 17 本のポリシーを閉じ、
 * 運営の API を service_role の書き込みに移し、利用者の INSERT が運営の判定の列を指定できないようにした
 * (migration 20261025100000_operator_session_writes_select_only.sql) ことを、migration の文面とアプリのコードで固定する (DB は使わない)。
 * 実 DB での確認は tests/integration/rls/operator-session-writes-select-only.test.ts。
 *
 * 確かめること:
 *   - migration を全部流した後の、16 の表のポリシー (名前・種類) と、anon / authenticated / service_role の表の権限
 *   - 本冊の直前の状態 (番兵: 読み取りが、消す・変えるポリシーと外す権限を拾えている)
 *   - 本冊だけを流したときの差分 (消す・作る・変えるポリシーと、外す権限だけが変わる)
 *   - 作る SELECT のポリシーの USING は、消すポリシーの 20261017130000 の式と逐語で同じ (運営の MFA の判定つき)
 *   - 変えるポリシー (組織の 3 本・チケットのメッセージ・利用者の INSERT の 3 本) の式
 *   - 戻し口を流すと、本冊の直前の状態 (ポリシーの名前・種類・TO・USING・WITH CHECK と権限) に戻る
 *   - 同じ型 (運営のロールで判定する書き込みのポリシー) の一覧から、台帳の「別の案件」だった 17 本だけが減る
 *   - アプリのコードがこれらの表に書く場所と、その client (運営の API は requireRole の後の getSupabaseAdmin())
 *   - DB の関数でこれらの表に書くものは、最新の定義がどれも SECURITY DEFINER
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { listFiles, rel, ROOT, stripComments } from './helpers/ai-reach';
import { operatorWritePolicyRow, operatorWritePolicyRowsAfterMigrations } from './helpers/operator-write-policy-ledger';

const MIGRATIONS_DIR = path.join(ROOT, 'supabase', 'migrations');
const MIGRATION = '20261025100000_operator_session_writes_select_only';
const MIGRATION_FILE = `${MIGRATION}.sql`;
const ROLLBACK_PATH = path.join(ROOT, 'supabase', 'rollbacks', `${MIGRATION}.down.sql`);
/** 本番のベースライン (#1116 で統合した最初の migration) */
const BASELINE_FILE = '20251126124224_create_meal_planner_tables.sql';
/** 運営のポリシーに TO authenticated と MFA の判定を足した migration */
const MFA_GATE_FILE = '20261017130000_operator_mfa_db_gate.sql';
/** organization_invites の DELETE のポリシーを作り直した migration */
const ORG_RPC_ONLY_FILE = '20261022180000_org_tables_rpc_only_writes.sql';
/** anon / authenticated の TRUNCATE を全部の表から外した migration */
const TRUNCATE_HARDENING_FILE = '20261022190000_db_privilege_hardening.sql';

const WRITE_PRIVILEGES = ['INSERT', 'UPDATE', 'DELETE'] as const;
type WritePrivilege = (typeof WRITE_PRIVILEGES)[number];
const USER_ROLES = ['anon', 'authenticated'] as const;
type UserRole = (typeof USER_ROLES)[number];
/** GRANT ALL / REVOKE ALL が表す表の権限 (PostgreSQL 17 の表の権限の全部) */
const ALL_TABLE_PRIVILEGES = ['INSERT', 'SELECT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'] as const;
/** 20261022190000 の動的な REVOKE (public の全部の表から anon / authenticated の TRUNCATE を外す) */
const DYNAMIC_TRUNCATE_REVOKE = "format('REVOKE TRUNCATE ON TABLE %s FROM anon, authenticated'";

type UserWrites = Readonly<Record<UserRole, readonly WritePrivilege[]>>;
const NO_USER_WRITES: UserWrites = { anon: [], authenticated: [] };
/** ベースラインの GRANT ALL のまま (anon も authenticated も INSERT / UPDATE / DELETE を持つ) */
const BASELINE_USER_WRITES: UserWrites = { anon: WRITE_PRIVILEGES, authenticated: WRITE_PRIVILEGES };

/** 本冊が消す運営の書き込みのポリシー */
interface RemovedPolicy {
  name: string;
  command: 'ALL' | 'INSERT' | 'UPDATE' | 'DELETE';
  /** 本冊の直前の形を作った文 (ファイルと 1 始まりの行番号) */
  source: { file: string; line: number };
}

/** 本冊が作る運営の SELECT のポリシー (USING は消すポリシー from の式と逐語で同じ) */
interface AddedPolicy {
  name: string;
  from: string;
}

/** 本冊が ALTER POLICY で変えるポリシー (変えた後の文) */
interface AlteredPolicy {
  name: string;
  statement: string;
}

interface TableSpec {
  table: string;
  removed: readonly RemovedPolicy[];
  added: readonly AddedPolicy[];
  altered: readonly AlteredPolicy[];
  /** 本冊の後に残るポリシー (名前 → 種類) */
  finalPolicies: ReadonlyArray<readonly [string, string]>;
  /** 本冊の後も利用者のロールに残す書き込みの権限 */
  keptUserWrites: UserWrites;
  /** 本冊の直前に利用者のロールが持っている書き込みの権限 */
  userWritesBefore: UserWrites;
}

/** 組織の管理者 (所属組織の org_role が owner / admin) の枝 */
const orgAdminUsing = (table: string) =>
  `USING ((EXISTS ( SELECT 1 FROM user_profiles up WHERE ((up.id = auth.uid()) AND (up.organization_id = ${table}.organization_id) AND (up.org_role = ANY (ARRAY['owner'::org_role_enum, 'admin'::org_role_enum]))))))`;

const ORG_ADMIN_WRITES: UserWrites = { anon: [], authenticated: WRITE_PRIVILEGES };

const TABLES: readonly TableSpec[] = [
  {
    table: 'admin_user_notes',
    removed: [{ name: 'Admins can manage user notes', command: 'ALL', source: { file: MFA_GATE_FILE, line: 377 } }],
    added: [{ name: 'Admins can view user notes', from: 'Admins can manage user notes' }],
    altered: [],
    finalPolicies: [['Admins can view user notes', 'SELECT']],
    keptUserWrites: NO_USER_WRITES,
    userWritesBefore: BASELINE_USER_WRITES,
  },
  {
    table: 'coupons',
    removed: [{ name: 'coupons_mutate_sales_or_above', command: 'ALL', source: { file: MFA_GATE_FILE, line: 381 } }],
    added: [],
    altered: [],
    finalPolicies: [['coupons_select_sales_or_above', 'SELECT']],
    keptUserWrites: NO_USER_WRITES,
    userWritesBefore: BASELINE_USER_WRITES,
  },
  {
    table: 'departments',
    removed: [],
    added: [],
    altered: [
      {
        name: 'Org admins can manage departments',
        statement: `ALTER POLICY "Org admins can manage departments" ON public.departments TO authenticated ${orgAdminUsing('departments')};`,
      },
    ],
    finalPolicies: [
      ['Org admins can manage departments', 'ALL'],
      ['Org members can view departments', 'SELECT'],
    ],
    keptUserWrites: ORG_ADMIN_WRITES,
    userWritesBefore: BASELINE_USER_WRITES,
  },
  {
    table: 'experiment_assignments',
    removed: [{ name: 'experiment_assignments_delete_super_admin', command: 'DELETE', source: { file: MFA_GATE_FILE, line: 390 } }],
    added: [],
    altered: [],
    finalPolicies: [['experiment_assignments_select_super_admin', 'SELECT']],
    keptUserWrites: NO_USER_WRITES,
    userWritesBefore: BASELINE_USER_WRITES,
  },
  {
    table: 'experiments',
    removed: [{ name: 'experiments_select_super_admin', command: 'ALL', source: { file: MFA_GATE_FILE, line: 392 } }],
    // 名前どおりの SELECT として作り直す (同じ名前)
    added: [{ name: 'experiments_select_super_admin', from: 'experiments_select_super_admin' }],
    altered: [],
    finalPolicies: [['experiments_select_super_admin', 'SELECT']],
    keptUserWrites: NO_USER_WRITES,
    userWritesBefore: BASELINE_USER_WRITES,
  },
  {
    table: 'feature_flags',
    removed: [{ name: 'feature_flags_super_admin_all', command: 'ALL', source: { file: MFA_GATE_FILE, line: 393 } }],
    added: [{ name: 'feature_flags_select_super_admin', from: 'feature_flags_super_admin_all' }],
    altered: [],
    finalPolicies: [['feature_flags_select_super_admin', 'SELECT']],
    keptUserWrites: NO_USER_WRITES,
    userWritesBefore: BASELINE_USER_WRITES,
  },
  {
    table: 'feature_packages',
    removed: [{ name: 'feature_packages_mutate_super_admin', command: 'ALL', source: { file: MFA_GATE_FILE, line: 394 } }],
    added: [{ name: 'feature_packages_select_super_admin', from: 'feature_packages_mutate_super_admin' }],
    altered: [],
    finalPolicies: [
      ['feature_packages_select_authenticated', 'SELECT'],
      ['feature_packages_select_super_admin', 'SELECT'],
    ],
    keptUserWrites: NO_USER_WRITES,
    userWritesBefore: BASELINE_USER_WRITES,
  },
  {
    table: 'inquiries',
    removed: [{ name: 'Admins can update inquiries', command: 'UPDATE', source: { file: MFA_GATE_FILE, line: 398 } }],
    added: [],
    altered: [
      {
        name: 'Anyone can create inquiries',
        statement:
          "ALTER POLICY \"Anyone can create inquiries\" ON public.inquiries WITH CHECK (((status = 'pending'::text) AND (admin_notes IS NULL) AND (resolved_at IS NULL) AND ((user_id IS NULL) OR (user_id = auth.uid()))));",
      },
    ],
    finalPolicies: [
      ['Admins can view all inquiries', 'SELECT'],
      ['Anyone can create inquiries', 'INSERT'],
      ['Users can view own inquiries', 'SELECT'],
    ],
    // 問い合わせの送信 (POST /api/contact。未ログインは anon) のために INSERT を両方に残す
    keptUserWrites: { anon: ['INSERT'], authenticated: ['INSERT'] },
    userWritesBefore: BASELINE_USER_WRITES,
  },
  {
    table: 'organization_challenges',
    removed: [],
    added: [],
    altered: [
      {
        name: 'Org admins can manage challenges',
        statement: `ALTER POLICY "Org admins can manage challenges" ON public.organization_challenges TO authenticated ${orgAdminUsing('organization_challenges')};`,
      },
    ],
    finalPolicies: [
      ['Org admins can manage challenges', 'ALL'],
      ['Org challenges can be deleted only as draft or cancelled', 'DELETE'],
      ['Org members can view challenges', 'SELECT'],
    ],
    keptUserWrites: ORG_ADMIN_WRITES,
    userWritesBefore: BASELINE_USER_WRITES,
  },
  {
    table: 'organization_invites',
    removed: [],
    added: [],
    altered: [
      {
        name: 'Org admins can delete invites',
        statement: `ALTER POLICY "Org admins can delete invites" ON public.organization_invites TO authenticated ${orgAdminUsing('organization_invites')};`,
      },
    ],
    finalPolicies: [
      ['Org admins can delete invites', 'DELETE'],
      ['Org admins can view invites', 'SELECT'],
      ['org_invites_select_admin', 'SELECT'],
    ],
    // INSERT / UPDATE と anon の DELETE は 20261022180000 が外してある。本冊は権限に触れない
    keptUserWrites: { anon: [], authenticated: ['DELETE'] },
    userWritesBefore: { anon: [], authenticated: ['DELETE'] },
  },
  {
    table: 'recipe_flags',
    removed: [],
    added: [],
    altered: [
      {
        name: 'Anyone can create recipe flags',
        statement:
          "ALTER POLICY \"Anyone can create recipe flags\" ON public.recipe_flags WITH CHECK (((reporter_id = auth.uid()) AND (status = 'pending'::text) AND (reviewed_by IS NULL) AND (reviewed_at IS NULL)));",
      },
    ],
    finalPolicies: [
      ['Anyone can create recipe flags', 'INSERT'],
      ['Users and admins can view recipe flags', 'SELECT'],
    ],
    // UPDATE / DELETE と anon の INSERT は 20261024140000 が外してある。本冊は権限に触れない
    keptUserWrites: { anon: [], authenticated: ['INSERT'] },
    userWritesBefore: { anon: [], authenticated: ['INSERT'] },
  },
  {
    table: 'sales_lead_activities',
    removed: [{ name: 'sales_activities_access', command: 'ALL', source: { file: MFA_GATE_FILE, line: 417 } }],
    added: [{ name: 'sales_activities_select', from: 'sales_activities_access' }],
    altered: [],
    finalPolicies: [['sales_activities_select', 'SELECT']],
    keptUserWrites: NO_USER_WRITES,
    userWritesBefore: BASELINE_USER_WRITES,
  },
  {
    table: 'sales_leads',
    removed: [{ name: 'sales_leads_access', command: 'ALL', source: { file: MFA_GATE_FILE, line: 418 } }],
    added: [{ name: 'sales_leads_select', from: 'sales_leads_access' }],
    altered: [],
    finalPolicies: [['sales_leads_select', 'SELECT']],
    keptUserWrites: NO_USER_WRITES,
    userWritesBefore: BASELINE_USER_WRITES,
  },
  {
    table: 'subscription_plans',
    removed: [{ name: 'subscription_plans_mutate_super_admin', command: 'ALL', source: { file: MFA_GATE_FILE, line: 420 } }],
    added: [],
    altered: [],
    finalPolicies: [
      ['subscription_plans_select_operator', 'SELECT'],
      ['subscription_plans_select_public', 'SELECT'],
    ],
    keptUserWrites: NO_USER_WRITES,
    userWritesBefore: BASELINE_USER_WRITES,
  },
  {
    table: 'support_ticket_messages',
    removed: [],
    added: [],
    altered: [
      {
        name: 'ticket_messages_insert',
        statement:
          'ALTER POLICY ticket_messages_insert ON public.support_ticket_messages TO authenticated WITH CHECK (((sender_id = auth.uid()) AND (NOT is_internal) AND (EXISTS ( SELECT 1 FROM support_tickets t WHERE ((t.id = support_ticket_messages.ticket_id) AND (t.user_id = auth.uid()))))));',
      },
    ],
    finalPolicies: [
      ['ticket_messages_insert', 'INSERT'],
      ['ticket_messages_select', 'SELECT'],
    ],
    keptUserWrites: { anon: [], authenticated: ['INSERT'] },
    userWritesBefore: BASELINE_USER_WRITES,
  },
  {
    table: 'support_tickets',
    removed: [
      { name: 'tickets_insert_staff', command: 'INSERT', source: { file: MFA_GATE_FILE, line: 423 } },
      { name: 'tickets_update_support', command: 'UPDATE', source: { file: MFA_GATE_FILE, line: 425 } },
    ],
    added: [],
    altered: [
      {
        name: 'tickets_insert_user',
        statement:
          "ALTER POLICY tickets_insert_user ON public.support_tickets TO authenticated WITH CHECK (((user_id = auth.uid()) AND ((status)::text = 'open'::text) AND (assignee_id IS NULL) AND (first_response_at IS NULL) AND (resolved_at IS NULL) AND (closed_at IS NULL)));",
      },
    ],
    finalPolicies: [
      ['tickets_insert_user', 'INSERT'],
      ['tickets_select', 'SELECT'],
    ],
    keptUserWrites: { anon: [], authenticated: ['INSERT'] },
    userWritesBefore: BASELINE_USER_WRITES,
  },
  {
    table: 'system_settings',
    removed: [{ name: 'Super admins can update system settings', command: 'ALL', source: { file: MFA_GATE_FILE, line: 428 } }],
    added: [],
    altered: [],
    finalPolicies: [['Admins can view system settings', 'SELECT']],
    keptUserWrites: NO_USER_WRITES,
    userWritesBefore: BASELINE_USER_WRITES,
  },
];

/** 本冊の後に残る SELECT 以外のポリシー (組織の管理者・利用者の枝。名前 → 種類) */
const KEPT_NON_SELECT_POLICIES: Readonly<Record<string, string>> = Object.fromEntries(
  TABLES.flatMap((spec) => spec.finalPolicies.filter(([, command]) => command !== 'SELECT')),
);
const REMOVED_POLICIES = TABLES.flatMap((spec) => spec.removed.map((policy) => ({ table: spec.table, ...policy })));
const ADDED_POLICIES = TABLES.flatMap((spec) => spec.added.map((policy) => ({ table: spec.table, ...policy })));
const ALTERED_POLICIES = TABLES.flatMap((spec) => spec.altered.map((policy) => ({ table: spec.table, ...policy })));

const keeps = (spec: TableSpec, role: UserRole, privilege: string): boolean => (spec.keptUserWrites[role] as readonly string[]).includes(privilege);
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
const migrationsBefore = migrations.slice(0, Math.max(migrationIndex, 0));

const tableRef = (table: string) => String.raw`(?:"?public"?\.)?"?${table}"?(?=[\s;])`;
const POLICY_NAME = String.raw`(?:"([^"]+)"|([A-Za-z_][\w]*))`;

/** ポリシー 1 本 (種類と、比べる形に揃えた TO・USING・WITH CHECK) */
interface PolicyState {
  command: string;
  /** TO のロール (二重引用符を外し小文字・カンマ区切り)。TO の無いポリシーは public */
  roles: string;
  using: string | null;
  check: string | null;
}

interface TableState {
  policies: Map<string, PolicyState>;
  grants: Map<string, Set<string>>;
}

const emptyState = (): TableState => ({ policies: new Map(), grants: new Map() });

/** 文の中の keyword の直後の、対応の取れた ( ... ) を返す (無ければ null) */
function balancedAfter(text: string, keyword: RegExp): string | null {
  const m = keyword.exec(text);
  if (!m) return null;
  let i = m.index + m[0].length;
  while (text[i] === ' ' || text[i] === '\n' || text[i] === '\t') i += 1;
  if (text[i] !== '(') return null;
  let depth = 0;
  for (let j = i; j < text.length; j += 1) {
    if (text[j] === '(') depth += 1;
    else if (text[j] === ')') {
      depth -= 1;
      if (depth === 0) return text.slice(i, j + 1);
    }
  }
  return null;
}

/** 式の書き方を比べる形に揃える (ベースラインの dump は識別子を二重引用符で囲み、"public". を付ける) */
const normalizeExpression = (expression: string | null): string | null =>
  expression === null ? null : expression.replace(/"/g, '').replace(/\bpublic\.(?=user_profiles\b)/g, '').replace(/\s+/g, ' ');

/** CREATE / ALTER POLICY の ON 表 の後ろの文面から、TO・USING・WITH CHECK を読む */
function clausesOf(rest: string): { roles: string | null; using: string | null; check: string | null } {
  const to = /\bTO\s+(.+?)(?=\s+USING\b|\s+WITH\s+CHECK\b|\s*$)/i.exec(rest.trim());
  return {
    roles: to ? to[1].replace(/"/g, '').toLowerCase().split(',').map((r) => r.trim()).join(', ') : null,
    using: normalizeExpression(balancedAfter(rest, /\bUSING\b/i)),
    check: normalizeExpression(balancedAfter(rest, /\bWITH\s+CHECK\b/i)),
  };
}

/** SQL の中の、表 table のポリシーと権限の文を、書かれた順に state へ流す */
function applySql(state: TableState, table: string, sql: string): TableState {
  const ref = tableRef(table);
  const events: Array<{ at: number; apply: () => void }> = [];
  for (const m of sql.matchAll(new RegExp(String.raw`CREATE\s+POLICY\s+${POLICY_NAME}\s+ON\s+${ref}([^;]*);`, 'gi'))) {
    const name = m[1] ?? m[2];
    const rest = m[3];
    const command = (/^\s*(?:AS\s+\w+\s+)?(?:FOR\s+(ALL|SELECT|INSERT|UPDATE|DELETE))?/i.exec(rest)?.[1] ?? 'ALL').toUpperCase();
    const clauses = clausesOf(rest.replace(/^\s*(?:AS\s+\w+\s+)?(?:FOR\s+\w+\s+)?/i, ' '));
    events.push({
      at: m.index ?? 0,
      apply: () => state.policies.set(name, { command, roles: clauses.roles ?? 'public', using: clauses.using, check: clauses.check }),
    });
  }
  for (const m of sql.matchAll(new RegExp(String.raw`DROP\s+POLICY\s+(?:IF\s+EXISTS\s+)?${POLICY_NAME}\s+ON\s+${ref}`, 'gi'))) {
    const name = m[1] ?? m[2];
    events.push({ at: m.index ?? 0, apply: () => state.policies.delete(name) });
  }
  for (const m of sql.matchAll(new RegExp(String.raw`ALTER\s+POLICY\s+${POLICY_NAME}\s+ON\s+${ref}([^;]*);`, 'gi'))) {
    const name = m[1] ?? m[2];
    const clauses = clausesOf(m[3]);
    events.push({
      at: m.index ?? 0,
      apply: () => {
        const current = state.policies.get(name);
        if (!current) return;
        state.policies.set(name, {
          command: current.command,
          roles: clauses.roles ?? current.roles,
          using: clauses.using ?? current.using,
          check: clauses.check ?? current.check,
        });
      },
    });
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

const policyCommands = (state: TableState) =>
  [...state.policies.entries()].map(([name, policy]) => [name, policy.command] as const).sort(([a], [b]) => a.localeCompare(b));
const policyDetails = (state: TableState) => [...state.policies.entries()].sort(([a], [b]) => a.localeCompare(b));
const sortedGrants = (state: TableState, role: string) => [...(state.grants.get(role) ?? new Set<string>())].sort();
const has = (state: TableState, role: string, privilege: string) => state.grants.get(role)?.has(privilege) ?? false;
const byName = (rows: ReadonlyArray<readonly [string, string]>) => [...rows].sort(([a], [b]) => a.localeCompare(b));

const quotedPolicyName = (name: string): string => (/^[a-z_][a-z0-9_]*$/.test(name) ? name : `"${name}"`);
const lineOf = (file: string, line: number) => readMigration(file).split('\n')[line - 1] ?? '';

/** sql の中から、表 table の名前 name のポリシーを作る文 (1 行) を返す */
function createStatement(sql: string, table: string, name: string): string {
  const lines = sql.split('\n').filter((l) => l.startsWith(`CREATE POLICY ${quotedPolicyName(name)} ON public.${table} `));
  return lines.length === 1 ? lines[0] : '';
}

describe('#1917 の続き: migration を全部流した後の、16 の表のポリシーと権限', () => {
  it.each(TABLES)('$table: 残るポリシーは finalPolicies だけで、SELECT 以外は組織の管理者・利用者の枝のものだけ', ({ table, finalPolicies }) => {
    const finalState = stateAfter(table, migrations);
    expect(policyCommands(finalState)).toEqual(byName(finalPolicies));
    for (const [name, policy] of finalState.policies) expect(policy.command, name).toBe(KEPT_NON_SELECT_POLICIES[name] ?? 'SELECT');
  });

  it.each(TABLES)('$table: anon と authenticated の書き込みの権限は keptUserWrites のものだけで、TRUNCATE は持たず、SELECT は持つ', (spec) => {
    const finalState = stateAfter(spec.table, migrations);
    for (const role of USER_ROLES) {
      for (const privilege of WRITE_PRIVILEGES) expect(has(finalState, role, privilege), `${role} ${privilege}`).toBe(keeps(spec, role, privilege));
      expect(has(finalState, role, 'TRUNCATE'), `${role} TRUNCATE`).toBe(false);
      expect(has(finalState, role, 'SELECT'), `${role} SELECT`).toBe(true);
    }
  });

  it.each(TABLES)('$table: service_role は全部の権限を持ったまま (運営の API・DB の関数を呼ぶサーバー・テストの後片付けが使う)', ({ table }) => {
    expect(sortedGrants(stateAfter(table, migrations), 'service_role')).toEqual([...ALL_TABLE_PRIVILEGES].sort());
  });

  it.each(TABLES)('$table: 残る書き込みのポリシーは、どれも運営のロール (user_profiles.roles) と運営の MFA の判定を見ない', ({ table }) => {
    for (const [name, policy] of stateAfter(table, migrations).policies) {
      if (policy.command === 'SELECT') continue;
      const expression = `${policy.using ?? ''} ${policy.check ?? ''}`;
      expect(expression, name).not.toMatch(/\broles\b/);
      expect(expression, name).not.toMatch(/operator_mfa_satisfied/);
    }
  });

  it.each(TABLES)('番兵: $table の読み取りが、本冊の直前のポリシーと書き込みの権限を拾っている', (spec) => {
    expect(migrationIndex, `${MIGRATION_FILE} が supabase/migrations に無い`).toBeGreaterThan(0);
    const before = stateAfter(spec.table, migrationsBefore);
    const addedNames = new Set(spec.added.map(({ name }) => name));
    const removedNames = new Set(spec.removed.map(({ name }) => name));
    // 本冊の直前 = 残るポリシーから、本冊が作るもの・消すもの (同じ名前で作り直すものを含む) を除き、消すものを本冊の直前の種類で足したもの
    const expectedBefore = spec.finalPolicies
      .filter(([name]) => !addedNames.has(name) && !removedNames.has(name))
      .concat(spec.removed.map(({ name, command }) => [name, command] as const));
    expect(policyCommands(before)).toEqual(byName(expectedBefore));
    for (const role of USER_ROLES) {
      for (const privilege of WRITE_PRIVILEGES) {
        expect(has(before, role, privilege), `${role} ${privilege} (本冊の直前)`).toBe(heldBefore(spec, role, privilege));
      }
      expect(has(before, role, 'TRUNCATE'), `${role} TRUNCATE (20261022190000 で外してある)`).toBe(false);
    }
    const hardeningIndex = migrations.findIndex(({ file }) => file === TRUNCATE_HARDENING_FILE);
    expect(hardeningIndex).toBeGreaterThan(0);
    expect(hardeningIndex).toBeLessThan(migrationIndex);
  });

  it('番兵: 権限を外す表は、本冊の直前に外す権限を少なくとも 1 つ持っている (外すものの無い表を数えていない)', () => {
    const withRevokes = TABLES.filter((spec) =>
      USER_ROLES.some((role) => WRITE_PRIVILEGES.some((p) => heldBefore(spec, role, p) && !keeps(spec, role, p))),
    ).map((spec) => spec.table);
    expect(withRevokes.sort()).toEqual(
      [
        'admin_user_notes',
        'coupons',
        'departments',
        'experiment_assignments',
        'experiments',
        'feature_flags',
        'feature_packages',
        'inquiries',
        'organization_challenges',
        'sales_lead_activities',
        'sales_leads',
        'subscription_plans',
        'support_ticket_messages',
        'support_tickets',
        'system_settings',
      ].sort(),
    );
  });
});

describe('#1917 の続き: 本冊の migration', () => {
  it.each(TABLES)('$table: 本冊だけを流すと、消す・作る・変えるポリシーと、外す権限だけが変わる', (spec) => {
    const before = stateAfter(spec.table, migrationsBefore);
    const own = applySql(stateAfter(spec.table, migrationsBefore), spec.table, migrationSql);
    expect(policyCommands(own)).toEqual(byName(spec.finalPolicies));
    const changed = new Set([...spec.removed, ...spec.added, ...spec.altered].map(({ name }) => name));
    const untouched = (state: TableState) => policyDetails(state).filter(([name]) => !changed.has(name));
    expect(untouched(own)).toEqual(untouched(before));
    for (const role of USER_ROLES) {
      const removed = (p: string) => (WRITE_PRIVILEGES as readonly string[]).includes(p) && !keeps(spec, role, p);
      expect(sortedGrants(own, role), role).toEqual(sortedGrants(before, role).filter((p) => !removed(p)));
    }
    expect(sortedGrants(own, 'service_role')).toEqual(sortedGrants(before, 'service_role'));
  });

  it.each(ADDED_POLICIES)('$table の $name: 作る SELECT のポリシーは TO authenticated で、USING は消す $from の 20261017130000 の式と逐語で同じ', (added) => {
    const statement = createStatement(migrationSql, added.table, added.name);
    expect(statement, `${added.name} を作る文が 1 行だけある`).not.toBe('');
    expect(statement).toMatch(/\bFOR SELECT TO authenticated USING\b/);
    expect(statement).not.toMatch(/WITH CHECK/);
    const removed = REMOVED_POLICIES.find((p) => p.table === added.table && p.name === added.from);
    expect(removed, `${added.from} は消すポリシー`).toBeDefined();
    const source = lineOf(removed!.source.file, removed!.source.line);
    const expected = balancedAfter(source, /\bUSING\b/i);
    expect(expected).toContain('public.operator_mfa_satisfied()');
    expect(balancedAfter(statement, /\bUSING\b/i)).toBe(expected);
  });

  it.each(ALTERED_POLICIES)('$table の $name: 変える文は 1 行で、決めた式のとおり', (altered) => {
    const lines = migrationSql.split('\n').filter((l) => l.startsWith(`ALTER POLICY ${quotedPolicyName(altered.name)} ON public.${altered.table} `));
    expect(lines).toEqual([altered.statement]);
  });

  it('組織の 3 本は、本冊の直前の式から運営の枝 (roles の admin / super_admin と MFA の判定) だけを外した形', () => {
    for (const table of ['departments', 'organization_challenges', 'organization_invites']) {
      const altered = ALTERED_POLICIES.find((p) => p.table === table)!;
      const before = stateAfter(table, migrationsBefore).policies.get(altered.name)!;
      const after = stateAfter(table, migrations).policies.get(altered.name)!;
      const operatorBranch = " OR ((up.roles && ARRAY['admin'::text, 'super_admin'::text]) AND (SELECT public.operator_mfa_satisfied()))";
      expect(before.using, table).toContain(operatorBranch);
      // 外した後は、組織の管理者の枝の外側の括弧が 1 組減る
      expect(after.using, table).toBe(before.using!.replace(`((up.org_role = ANY (ARRAY['owner'::org_role_enum, 'admin'::org_role_enum]))${operatorBranch})`, "(up.org_role = ANY (ARRAY['owner'::org_role_enum, 'admin'::org_role_enum]))"));
      expect(after.command).toBe(before.command);
      expect(after.roles).toBe('authenticated');
    }
  });

  it('チケットのメッセージの INSERT は、本冊の直前の式から運営の枝だけを外した形 (本人・内部メモでない・本人のチケット)', () => {
    const before = stateAfter('support_ticket_messages', migrationsBefore).policies.get('ticket_messages_insert')!;
    const after = stateAfter('support_ticket_messages', migrations).policies.get('ticket_messages_insert')!;
    expect(before.check).toContain("ARRAY['support'::text, 'admin'::text, 'super_admin'::text] && user_profiles.roles");
    expect(after.check).toBe(
      '(((sender_id = auth.uid()) AND (NOT is_internal) AND (EXISTS ( SELECT 1 FROM support_tickets t WHERE ((t.id = support_ticket_messages.ticket_id) AND (t.user_id = auth.uid()))))))',
    );
    expect(after.roles).toBe('authenticated');
  });

  it.each([
    ['recipe_flags', 'Anyone can create recipe flags', ["(reporter_id = auth.uid())", "(status = 'pending'::text)", '(reviewed_by IS NULL)', '(reviewed_at IS NULL)'], 'authenticated'],
    [
      'inquiries',
      'Anyone can create inquiries',
      ["(status = 'pending'::text)", '(admin_notes IS NULL)', '(resolved_at IS NULL)', '((user_id IS NULL) OR (user_id = auth.uid()))'],
      'authenticated, anon',
    ],
    [
      'support_tickets',
      'tickets_insert_user',
      ['(user_id = auth.uid())', "((status)::text = 'open'::text)", '(assignee_id IS NULL)', '(first_response_at IS NULL)', '(resolved_at IS NULL)', '(closed_at IS NULL)'],
      'authenticated',
    ],
  ] as const)('%s の利用者の INSERT (%s) は、運営が判定・対応で書く列を指定させない (WITH CHECK の項と TO)', (table, name, terms, roles) => {
    const policy = stateAfter(table, migrations).policies.get(name)!;
    expect(policy.command).toBe('INSERT');
    expect(policy.roles).toBe(roles);
    expect(policy.using).toBeNull();
    expect(policy.check).toBe(`(${terms.join(' AND ')})`);
  });

  it('ALTER POLICY で TO を書き換えるのは、組織の 3 本・チケットのメッセージ (どれも元から TO authenticated) と tickets_insert_user (public → authenticated) だけ', () => {
    const withTo = [...migrationSql.matchAll(/\bALTER\s+POLICY\s+(?:"([^"]+)"|(\w+))\s+ON\s+public\.(\w+)\s+TO\s/gi)].map((m) => `${m[3]} ${m[1] ?? m[2]}`);
    expect(withTo.sort()).toEqual(
      [
        'departments Org admins can manage departments',
        'organization_challenges Org admins can manage challenges',
        'organization_invites Org admins can delete invites',
        'support_ticket_messages ticket_messages_insert',
        'support_tickets tickets_insert_user',
      ].sort(),
    );
  });

  it('service_role・TRUNCATE・SELECT の権限と、ほかの表には触れない。GRANT はしない', () => {
    expect(migrationSql).not.toMatch(/service_role/);
    expect(migrationSql).not.toMatch(/\bTRUNCATE\b/i);
    expect(migrationSql).not.toMatch(/\bGRANT\b/i);
    expect(migrationSql).not.toMatch(/\bREVOKE\s+[A-Z ,]*\bSELECT\b/i);
    const touched = new Set([...migrationSql.matchAll(/\bON\s+(?:TABLE\s+)?public\.("?)(\w+)\1/gi)].map((m) => m[2]));
    expect([...touched].sort()).toEqual(TABLES.map((t) => t.table).sort());
  });

  it('作るポリシーは ADDED_POLICIES の SELECT だけ', () => {
    const created = [...migrationSql.matchAll(/\bCREATE\s+POLICY\s+(?:"([^"]+)"|(\w+))\s+ON\s+public\.(\w+)/gi)].map((m) => `${m[3]} ${m[1] ?? m[2]}`);
    expect(created.sort()).toEqual(ADDED_POLICIES.map((p) => `${p.table} ${p.name}`).sort());
  });
});

describe('#1917 の続き: 戻し口', () => {
  it('実在し、1 行目が自分の migration を指す', () => {
    expect(fs.existsSync(ROLLBACK_PATH), rel(ROLLBACK_PATH)).toBe(true);
    expect(fs.readFileSync(ROLLBACK_PATH, 'utf-8').split('\n')[0]).toBe(`-- rollback: ${MIGRATION_FILE}`);
  });

  it.each(TABLES)('$table: 本冊の後に流すと、本冊の直前の状態 (ポリシーの名前・種類・TO・USING・WITH CHECK と権限) に戻る', ({ table }) => {
    const before = stateAfter(table, migrationsBefore);
    const restored = applySql(applySql(stateAfter(table, migrationsBefore), table, migrationSql), table, rollbackSql);
    expect(policyDetails(restored)).toEqual(policyDetails(before));
    for (const role of [...USER_ROLES, 'service_role']) expect(sortedGrants(restored, role), role).toEqual(sortedGrants(before, role));
  });

  it.each(REMOVED_POLICIES)('$table の $name: 作り直す文は 1 行で、本冊の直前と同じ種類 (FOR)', (removed) => {
    const statement = createStatement(rollbackSql, removed.table, removed.name);
    expect(statement, `${removed.name} を作る文が 1 行だけある`).not.toBe('');
    const forClause = removed.command === 'ALL' ? '' : `FOR ${removed.command} `;
    expect(statement.startsWith(`CREATE POLICY ${quotedPolicyName(removed.name)} ON public.${removed.table} ${forClause}TO authenticated `)).toBe(true);
  });
});

/** アプリのコードの置き場 (Web・モバイル・Edge Function・共有のライブラリ) */
const APP_DIRS = ['src', 'lib', 'apps/mobile/src', 'apps/mobile/app', 'packages/shared/src', 'supabase/functions'] as const;
const isSource = (name: string) => /\.(ts|tsx)$/.test(name) && !/\.d\.ts$/.test(name);
const isTestPath = (file: string) => /(__tests__|\.test\.|\.spec\.)/.test(file);
/** 書き込みの受け手が service_role の client であることの印 */
const SERVICE_ROLE_RECEIVER = 'getSupabaseAdmin()';

/**
 * 16 の表に書く (insert / update / upsert / delete) 場所と、その受け手 (.from の前の式)。キーは「ファイル 表 操作」。
 * ここに無い場所で書くと赤になる。本人のセッションの client (supabase) で書いてよいのは、本冊の後も本人の枝のポリシーが残るものだけ
 */
const WRITE_SITES: Readonly<Record<string, string>> = {
  'src/app/api/admin/inquiries/[id]/route.ts inquiries update': SERVICE_ROLE_RECEIVER,
  'src/app/api/admin/sales/leads/[id]/activities/route.ts sales_lead_activities insert': SERVICE_ROLE_RECEIVER,
  'src/app/api/admin/sales/leads/[id]/activities/route.ts sales_leads update': SERVICE_ROLE_RECEIVER,
  'src/app/api/admin/sales/leads/[id]/route.ts sales_lead_activities insert': SERVICE_ROLE_RECEIVER,
  'src/app/api/admin/sales/leads/[id]/route.ts sales_leads update': SERVICE_ROLE_RECEIVER,
  'src/app/api/admin/sales/leads/route.ts sales_leads insert': SERVICE_ROLE_RECEIVER,
  'src/app/api/admin/support/tickets/[id]/assign/route.ts support_tickets update': SERVICE_ROLE_RECEIVER,
  'src/app/api/admin/support/tickets/[id]/messages/route.ts support_ticket_messages insert': SERVICE_ROLE_RECEIVER,
  'src/app/api/admin/support/tickets/[id]/messages/route.ts support_tickets update': SERVICE_ROLE_RECEIVER,
  'src/app/api/admin/support/tickets/[id]/route.ts support_tickets update': SERVICE_ROLE_RECEIVER,
  'src/app/api/admin/support/tickets/route.ts support_ticket_messages insert': SERVICE_ROLE_RECEIVER,
  'src/app/api/admin/support/tickets/route.ts support_tickets insert': SERVICE_ROLE_RECEIVER,
  'src/app/api/admin/users/[id]/route.ts admin_user_notes insert': SERVICE_ROLE_RECEIVER,
  'src/app/api/super-admin/coupons/[id]/route.ts coupons delete': SERVICE_ROLE_RECEIVER,
  'src/app/api/super-admin/coupons/[id]/route.ts coupons update': SERVICE_ROLE_RECEIVER,
  'src/app/api/super-admin/coupons/route.ts coupons insert': SERVICE_ROLE_RECEIVER,
  'src/app/api/super-admin/experiments/[id]/route.ts experiment_assignments delete': SERVICE_ROLE_RECEIVER,
  'src/app/api/super-admin/experiments/[id]/route.ts experiments delete': SERVICE_ROLE_RECEIVER,
  'src/app/api/super-admin/experiments/[id]/route.ts experiments update': SERVICE_ROLE_RECEIVER,
  'src/app/api/super-admin/experiments/route.ts experiments insert': SERVICE_ROLE_RECEIVER,
  'src/app/api/super-admin/feature-packages/[id]/route.ts feature_packages delete': SERVICE_ROLE_RECEIVER,
  'src/app/api/super-admin/feature-packages/[id]/route.ts feature_packages update': SERVICE_ROLE_RECEIVER,
  'src/app/api/super-admin/feature-packages/route.ts feature_packages insert': SERVICE_ROLE_RECEIVER,
  'src/app/api/super-admin/flags/[key]/route.ts feature_flags delete': SERVICE_ROLE_RECEIVER,
  'src/app/api/super-admin/flags/[key]/route.ts feature_flags update': SERVICE_ROLE_RECEIVER,
  'src/app/api/super-admin/flags/route.ts feature_flags insert': SERVICE_ROLE_RECEIVER,
  'src/app/api/super-admin/flags/route.ts feature_packages update': SERVICE_ROLE_RECEIVER,
  'src/app/api/super-admin/plans/[id]/route.ts subscription_plans delete': SERVICE_ROLE_RECEIVER,
  'src/app/api/super-admin/plans/[id]/route.ts subscription_plans update': SERVICE_ROLE_RECEIVER,
  'src/app/api/super-admin/plans/route.ts subscription_plans insert': SERVICE_ROLE_RECEIVER,
  'src/app/api/super-admin/settings/route.ts system_settings upsert': SERVICE_ROLE_RECEIVER,
  'src/app/api/support/users/[id]/notes/route.ts admin_user_notes insert': SERVICE_ROLE_RECEIVER,
  // 本人のセッションで書いてよいもの (本冊の後も本人の枝のポリシーと権限が残る)
  'src/app/api/contact/route.ts inquiries insert': 'supabase', // "Anyone can create inquiries" (status = 'pending' などの条件つき)
  'src/app/api/org/challenges/route.ts organization_challenges insert': 'supabase', // 組織の管理者 (requireOrgAdmin)
  'src/app/api/org/challenges/route.ts organization_challenges update': 'supabase',
  'src/app/api/org/departments/route.ts departments delete': 'supabase',
  'src/app/api/org/departments/route.ts departments insert': 'supabase',
  'src/app/api/org/departments/route.ts departments update': 'supabase',
  'src/app/api/org/invites/route.ts organization_invites delete': 'supabase',
  // 引数の client で書く (呼び出し側の src/app/api/experiments/[key]/assignment/route.ts が getSupabaseAdmin() を渡す。下の検査)
  'src/lib/experiments/assignment.ts experiment_assignments insert': 'supabase',
};
const SESSION_WRITE_ROUTES = ['src/app/api/contact/route.ts', 'src/app/api/org/challenges/route.ts', 'src/app/api/org/departments/route.ts', 'src/app/api/org/invites/route.ts'];

/** 16 の表に書く呼び出しを、ファイルごとに見つける (受け手 .from('表') から 1 つの式の中で insert / update / upsert / delete を呼ぶ) */
function writeSitesIn(file: string): Array<{ key: string; receiver: string }> {
  const code = stripComments(fs.readFileSync(file, 'utf-8'));
  const found: Array<{ key: string; receiver: string }> = [];
  for (const { table } of TABLES) {
    const pattern = new RegExp(String.raw`([\w$.]+(?:\(\))?)\s*\.from\(\s*['"\`]${table}['"\`]\s*\)[^;]*?\.(insert|update|upsert|delete)\(`, 'g');
    for (const m of code.matchAll(pattern)) found.push({ key: `${rel(file)} ${table} ${m[2]}`, receiver: m[1] });
  }
  return found;
}

describe('#1917 の続き: アプリのコードは、運営の書き込みを service_role でだけ行う', () => {
  const files = APP_DIRS.flatMap((dir) => {
    const abs = path.join(ROOT, dir);
    return fs.existsSync(abs) ? listFiles(abs, isSource) : [];
  }).filter((file) => !isTestPath(rel(file)));
  const sites = files.flatMap(writeSitesIn);

  it('16 の表に書く場所は WRITE_SITES の一覧と同じ (増えたら、本人のセッションで書いていないかを確かめて一覧に足す)', () => {
    expect(files.length).toBeGreaterThan(0);
    expect([...new Set(sites.map((s) => s.key))].sort()).toEqual(Object.keys(WRITE_SITES).sort());
  });

  it('書き込みの受け手は WRITE_SITES のとおり (運営の API は getSupabaseAdmin()。本人のセッションは本人の枝が残る書き込みだけ)', () => {
    for (const site of sites) expect(site.receiver, site.key).toBe(WRITE_SITES[site.key]);
  });

  it('運営の API の service_role の書き込みは、どれも同じ関数の中で requireRole を通った後にある', () => {
    const operatorFiles = [...new Set(Object.entries(WRITE_SITES).filter(([, r]) => r === SERVICE_ROLE_RECEIVER).map(([key]) => key.split(' ')[0]))];
    for (const file of operatorFiles) {
      const code = stripComments(fs.readFileSync(path.join(ROOT, file), 'utf-8'));
      const handlers = code.split(/\n(?:export\s+)?async\s+function\s+/).slice(1);
      const writing = handlers.filter((h) => /getSupabaseAdmin\(\)\s*\.from\(\s*'\w+'\s*\)[^;]*?\.(insert|update|upsert|delete)\(/.test(h));
      expect(writing.length, file).toBeGreaterThan(0);
      for (const handler of writing) {
        const writeAt = handler.search(/getSupabaseAdmin\(\)\s*\.from\(\s*'\w+'\s*\)[^;]*?\.(insert|update|upsert|delete)\(/);
        const roleAt = handler.search(/\brequireRole\(/);
        expect(roleAt, `${file}: ${handler.slice(0, handler.indexOf('('))} が requireRole を呼ぶ`).toBeGreaterThanOrEqual(0);
        expect(roleAt, `${file}: ${handler.slice(0, handler.indexOf('('))} の requireRole が書き込みより前`).toBeLessThan(writeAt);
      }
    }
  });

  it('本人のセッションで書く route は、組織の管理者の判定 (requireOrgAdmin) か、問い合わせの送信 (/api/contact) だけ', () => {
    for (const file of SESSION_WRITE_ROUTES.filter((f) => f.startsWith('src/app/api/org/'))) {
      const code = stripComments(fs.readFileSync(path.join(ROOT, file), 'utf-8'));
      expect(code, file).toMatch(/\brequireOrgAdmin\(\)/);
      expect(code, file).not.toMatch(/getSupabaseAdmin\(\)\s*\.from\(\s*'(departments|organization_challenges|organization_invites)'/);
    }
  });

  it('実験の割り当て (getOrAssignVariant) の呼び出しは、getSupabaseAdmin() の client を渡す', () => {
    const callers = files.filter((file) => /src\/app\/api\//.test(rel(file)));
    const calls = callers.flatMap((file) => {
      const code = stripComments(fs.readFileSync(file, 'utf-8'));
      return [...code.matchAll(/\bgetOrAssignVariant\(\s*(\w+)/g)].map((m) => ({ file: rel(file), arg: m[1], code }));
    });
    expect(calls.map((c) => c.file)).toEqual(['src/app/api/experiments/[key]/assignment/route.ts']);
    for (const call of calls) {
      expect(call.arg).toBe('supabaseAdmin');
      expect(call.code).toMatch(/const\s+supabaseAdmin\s*=\s*getSupabaseAdmin\(\)/);
    }
  });
});

/** 関数・プロシージャの定義 */
interface FunctionDefinition {
  file: string;
  name: string;
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

/** 16 の表に書く DB の関数 (「関数名 表」→ 役目)。最新の定義はどれも SECURITY DEFINER で、所有者の権限で書くので本冊の影響を受けない */
const DB_FUNCTION_WRITERS: Readonly<Record<string, string>> = {
  'accept_org_invite organization_invites': '招待の承諾',
  'apply_coupon coupons': 'クーポンの適用 (20261007160700)',
  'apply_plan_price_change subscription_plans': 'プランの価格の変更 (20261024130000)',
  'create_org_invite organization_invites': '招待の作成 (20261022180000 で SECURITY DEFINER にした)',
  'prepare_account_deletion inquiries': '退会の準備 (20261016234000)',
  'prepare_account_deletion organization_invites': '退会の準備 (20261016234000)',
  'reject_org_invite organization_invites': '招待の拒否',
  'revoke_org_invite organization_invites': '招待の取り消し',
  'update_org_challenge_progress organization_challenges': 'チャレンジの進み (20261014100100)',
};

describe('#1917 の続き: DB の関数の書き込み', () => {
  it('16 の表に INSERT / UPDATE / DELETE する関数は DB_FUNCTION_WRITERS だけで、最新の定義はどれも SECURITY DEFINER', () => {
    const definitions = migrations.flatMap(({ file, sql }) => functionDefinitions(file, sql));
    expect(definitions.length, '関数の定義を読めている').toBeGreaterThan(Object.keys(DB_FUNCTION_WRITERS).length);
    const latest = new Map<string, FunctionDefinition>();
    for (const definition of definitions) latest.set(definition.name, definition);
    const writers = new Set<string>();
    for (const definition of latest.values()) {
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

describe('#1917 の続き: 同じ型 (運営のロールで判定する書き込みのポリシー) の中での本冊の差分', () => {
  /** 台帳の「別の案件」だった 17 本 (本冊の直前にこの型に当たり、本冊の後に当たらない) */
  const SESSION_CLIENT_API_ROWS = [
    ['admin_user_notes', 'Admins can manage user notes', 'ALL'],
    ['coupons', 'coupons_mutate_sales_or_above', 'ALL'],
    ['departments', 'Org admins can manage departments', 'ALL'],
    ['experiment_assignments', 'experiment_assignments_delete_super_admin', 'DELETE'],
    ['experiments', 'experiments_select_super_admin', 'ALL'],
    ['feature_flags', 'feature_flags_super_admin_all', 'ALL'],
    ['feature_packages', 'feature_packages_mutate_super_admin', 'ALL'],
    ['inquiries', 'Admins can update inquiries', 'UPDATE'],
    ['organization_challenges', 'Org admins can manage challenges', 'ALL'],
    ['organization_invites', 'Org admins can delete invites', 'DELETE'],
    ['sales_lead_activities', 'sales_activities_access', 'ALL'],
    ['sales_leads', 'sales_leads_access', 'ALL'],
    ['subscription_plans', 'subscription_plans_mutate_super_admin', 'ALL'],
    ['support_ticket_messages', 'ticket_messages_insert', 'INSERT'],
    ['support_tickets', 'tickets_insert_staff', 'INSERT'],
    ['support_tickets', 'tickets_update_support', 'UPDATE'],
    ['system_settings', 'Super admins can update system settings', 'ALL'],
  ] as const;
  const rows = SESSION_CLIENT_API_ROWS.map(([table, policy, command]) => operatorWritePolicyRow(table, policy, command)).sort();

  it('17 本は、本冊の直前にこの型に当たる (型の見つけ方が拾えている)', () => {
    expect(rows).toHaveLength(17);
    const before = operatorWritePolicyRowsAfterMigrations(migrationsBefore);
    for (const row of rows) expect(before, row).toContain(row);
  });

  it('本冊を流すと、この型の一覧から 17 本だけが減り、増えるものは無い (作る SELECT と、運営の枝を外したポリシーはこの型に当たらない)', () => {
    const before = operatorWritePolicyRowsAfterMigrations(migrationsBefore);
    const afterOwn = operatorWritePolicyRowsAfterMigrations(migrations.slice(0, migrationIndex + 1));
    expect(migrations[migrationIndex].file).toBe(MIGRATION_FILE);
    expect(afterOwn).toEqual(before.filter((row) => !rows.includes(row)));
  });
});

describe('#1917 の続き: 本冊のコメントが挙げる行番号', () => {
  it.each([
    [MFA_GATE_FILE, 377, 'ALTER POLICY "Admins can manage user notes" ON public.admin_user_notes '],
    [MFA_GATE_FILE, 381, 'ALTER POLICY coupons_mutate_sales_or_above ON public.coupons '],
    [MFA_GATE_FILE, 386, 'ALTER POLICY "Org admins can manage departments" ON public.departments '],
    [MFA_GATE_FILE, 390, 'ALTER POLICY experiment_assignments_delete_super_admin ON public.experiment_assignments '],
    [MFA_GATE_FILE, 392, 'ALTER POLICY experiments_select_super_admin ON public.experiments '],
    [MFA_GATE_FILE, 393, 'ALTER POLICY feature_flags_super_admin_all ON public.feature_flags '],
    [MFA_GATE_FILE, 394, 'ALTER POLICY feature_packages_mutate_super_admin ON public.feature_packages '],
    [MFA_GATE_FILE, 398, 'ALTER POLICY "Admins can update inquiries" ON public.inquiries '],
    [MFA_GATE_FILE, 405, 'ALTER POLICY "Org admins can manage challenges" ON public.organization_challenges '],
    [MFA_GATE_FILE, 417, 'ALTER POLICY sales_activities_access ON public.sales_lead_activities '],
    [MFA_GATE_FILE, 418, 'ALTER POLICY sales_leads_access ON public.sales_leads '],
    [MFA_GATE_FILE, 420, 'ALTER POLICY subscription_plans_mutate_super_admin ON public.subscription_plans '],
    [MFA_GATE_FILE, 421, 'ALTER POLICY ticket_messages_insert ON public.support_ticket_messages '],
    [MFA_GATE_FILE, 423, 'ALTER POLICY tickets_insert_staff ON public.support_tickets '],
    [MFA_GATE_FILE, 425, 'ALTER POLICY tickets_update_support ON public.support_tickets '],
    [MFA_GATE_FILE, 428, 'ALTER POLICY "Super admins can update system settings" ON public.system_settings '],
    [ORG_RPC_ONLY_FILE, 191, 'CREATE POLICY "Org admins can delete invites" ON public.organization_invites FOR DELETE '],
    [BASELINE_FILE, 9590, 'CREATE POLICY "Anyone can create inquiries" ON "public"."inquiries" FOR INSERT '],
    [BASELINE_FILE, 9594, 'CREATE POLICY "Anyone can create recipe flags" ON "public"."recipe_flags" FOR INSERT '],
    [BASELINE_FILE, 10979, 'CREATE POLICY "tickets_insert_user" ON "public"."support_tickets" FOR INSERT '],
  ] as const)('%s:%i は「%s」で始まる', (file, line, prefix) => {
    expect(lineOf(file, line).startsWith(prefix)).toBe(true);
  });

  it('本冊のコメントが、上の行番号を挙げている', () => {
    for (const ref of [
      '(20261017130000:377)', '(:381)', '(:386。', '(:390)', '(:392。', '(:393)', '(:394)', '(:398)', '(:405。', '(:417)', '(:418)',
      '(:420。', '(:421。', '(:423)', '(:425)', '(:428)', '20261022180000_org_tables_rpc_only_writes.sql:191', 'ベースライン :9590', ':9594', 'ベースライン :10979',
    ]) {
      expect(migrationRaw, ref).toContain(ref);
    }
  });
});

/** migration のファイル名の頭の version (14 桁) */
const VERSION_PATTERN = /^(\d{14})_/;
const versionOf = (file: string): string => VERSION_PATTERN.exec(file)?.[1] ?? '';
const MIGRATION_VERSION = versionOf(MIGRATION_FILE);
const MIGRATION_SLUG = MIGRATION.slice(MIGRATION_VERSION.length + 1);
/** 本冊のファイルの名前を書いた参照を探す場所 (アプリのコード・テスト・migration と戻し口・文書) */
const REFERENCE_DIRS = ['src', 'tests', 'supabase/migrations', 'supabase/rollbacks', 'docs'] as const;
const isReferenceText = (name: string) => /\.(ts|tsx|sql|md)$/.test(name);

describe('#1917 の続き: 本冊の version', () => {
  it('version は supabase/migrations の中で本冊だけで、本冊の直前の migration より後', () => {
    expect(MIGRATION_VERSION).toMatch(/^\d{14}$/);
    expect(migrationFileNames.filter((file) => versionOf(file) === MIGRATION_VERSION)).toEqual([MIGRATION_FILE]);
  });

  it('戻し口の version も supabase/rollbacks の中で本冊の戻し口だけ', () => {
    const rollbacks = fs.readdirSync(path.dirname(ROLLBACK_PATH)).filter((file) => versionOf(file) === MIGRATION_VERSION);
    expect(rollbacks).toEqual([path.basename(ROLLBACK_PATH)]);
  });

  it('migration の 1 行目と 2 行目は、自分のファイルと戻し口を指す', () => {
    const [first, second] = migrationRaw.split('\n');
    expect(first).toBe(`-- migration: ${MIGRATION_FILE}`);
    expect(second).toBe(`-- 戻し方: ${rel(ROLLBACK_PATH)}`);
  });

  it('リポジトリの中で本冊のファイルの名前を書いた参照は、どれも今の version を指す (付け直したときの書き残しが無い)', () => {
    const files = REFERENCE_DIRS.flatMap((dir) => {
      const abs = path.join(ROOT, dir);
      return fs.existsSync(abs) ? listFiles(abs, isReferenceText) : [];
    });
    const reference = new RegExp(String.raw`(\d{14})_${MIGRATION_SLUG}\b`, 'g');
    const found = files.flatMap((file) => [...fs.readFileSync(file, 'utf-8').matchAll(reference)].map((m) => ({ file: rel(file), version: m[1] })));
    expect(found.length, '参照を読めている').toBeGreaterThan(0);
    expect(found.filter(({ version }) => version !== MIGRATION_VERSION)).toEqual([]);
  });
});
