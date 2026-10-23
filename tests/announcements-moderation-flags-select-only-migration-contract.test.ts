/**
 * #1917 の続き: 運営 (admin / super_admin) の announcements (お知らせ) と moderation_flags (食事の通報) の FOR ALL のポリシーを
 * SELECT だけにし、recipe_flags (レシピの通報) の運営の FOR UPDATE のポリシーを消し、anon / authenticated の書き込みの権限を外した
 * migration (supabase/migrations/20261024110000_announcements_moderation_flags_select_only.sql) を、ファイルの読み取りで確かめる
 * (DB には接続しない)。運営は PostgREST の直接の書き込みで、運営の API と監査ログ (admin_audit_logs) を通らずにお知らせ・通報を書けた。
 *
 *   1. migration を version 順にすべて流したときの 3 つの表のポリシーに、UPDATE / DELETE / ALL のものが無い。INSERT のポリシーは
 *      recipe_flags の利用者の通報 ("Anyone can create recipe flags") だけ。anon と authenticated は UPDATE / DELETE / TRUNCATE の
 *      権限を持たず、INSERT は recipe_flags の authenticated だけが持ち、SELECT は持つ。service_role の権限は変わらない
 *   2. 本冊の migration が作る運営の SELECT のポリシーは、20261017130000_operator_mfa_db_gate.sql が付けた式 (TO authenticated・
 *      運営の MFA の判定) と USING の式が逐語で同じ (ロールの集合・MFA の判定を変えていない)
 *   3. 戻し口が実在し、流すと本冊の直前の状態 (ポリシーの名前と種類・権限) に戻る。作り直すポリシーの式は 20261017130000 の文と逐語で同じ
 *      (TRUNCATE は 20261022190000 が外してあるので付け直さない)
 *   4. アプリのコード (Web・モバイル・Edge Function・共有のライブラリ) で 3 つの表に書くのは、決まったファイルだけで、どれも
 *      requireRole の後の service_role の client で書く。DB の関数の本文は 3 つの表に書かない
 *   5. 本冊の migration のコメントが挙げる行番号が、ファイルの事実と合う
 * 実際の挙動は tests/integration/rls/announcements-moderation-flags-select-only.test.ts (実 DB) が確かめる。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { listFiles, rel, ROOT, stripComments } from './helpers/ai-reach';

const MIGRATIONS_DIR = path.join(ROOT, 'supabase', 'migrations');
const MIGRATION = '20261024110000_announcements_moderation_flags_select_only';
const MIGRATION_FILE = `${MIGRATION}.sql`;
const ROLLBACK_PATH = path.join(ROOT, 'supabase', 'rollbacks', `${MIGRATION}.down.sql`);
/** 本番のベースライン (ポリシーと権限を最初に作ったファイル) */
const BASELINE_FILE = '20251126124224_create_meal_planner_tables.sql';
/** 運営のポリシーに TO authenticated と MFA の判定を足した migration */
const MFA_GATE_FILE = '20261017130000_operator_mfa_db_gate.sql';
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
/** GRANT ALL / REVOKE ALL が表す表の権限 (PostgreSQL 17 の表の権限の全部) */
const ALL_TABLE_PRIVILEGES = ['INSERT', 'SELECT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'] as const;
/** 20261022190000 の動的な REVOKE (public の全部の表から anon / authenticated の TRUNCATE を外す) */
const DYNAMIC_TRUNCATE_REVOKE = "format('REVOKE TRUNCATE ON TABLE %s FROM anon, authenticated'";

interface TableSpec {
  table: string;
  /** 本冊が消す運営の書き込みのポリシー */
  removedPolicy: string;
  /** 消すポリシーの種類 (FOR の無い形 = ALL) */
  removedCommand: 'ALL' | 'UPDATE';
  /** 本冊が作る運営の SELECT のポリシー (作り直さない表は null。recipe_flags は運営の SELECT をもともと持つ) */
  addedPolicy: string | null;
  /** 本冊の後に残るポリシー (名前 → 種類) */
  finalPolicies: ReadonlyArray<readonly [string, string]>;
  /** 本冊の後も利用者のロールに残す書き込みの権限 (残さないロールは空) */
  keptUserWrites: Readonly<Record<UserRole, readonly WritePrivilege[]>>;
  /** 20261017130000 の ALTER POLICY の行番号 (1 始まり) */
  mfaGateLine: number;
}

const NO_USER_WRITES: Readonly<Record<UserRole, readonly WritePrivilege[]>> = { anon: [], authenticated: [] };

const TABLES: readonly TableSpec[] = [
  {
    table: 'announcements',
    removedPolicy: 'Admins can manage announcements',
    removedCommand: 'ALL',
    addedPolicy: 'Admins can view announcements',
    finalPolicies: [
      ['Admins can view announcements', 'SELECT'],
      ['Public announcements are viewable by everyone', 'SELECT'],
    ],
    keptUserWrites: NO_USER_WRITES,
    mfaGateLine: 379,
  },
  {
    table: 'moderation_flags',
    removedPolicy: 'moderation_flags_admin_all',
    removedCommand: 'ALL',
    addedPolicy: 'moderation_flags_admin_select',
    finalPolicies: [['moderation_flags_admin_select', 'SELECT']],
    keptUserWrites: NO_USER_WRITES,
    mfaGateLine: 402,
  },
  {
    table: 'recipe_flags',
    removedPolicy: 'Admins can update recipe flags',
    removedCommand: 'UPDATE',
    addedPolicy: null,
    finalPolicies: [
      [USER_REPORT_INSERT_POLICY, 'INSERT'],
      ['Users and admins can view recipe flags', 'SELECT'],
    ],
    keptUserWrites: { anon: [], authenticated: ['INSERT'] },
    mfaGateLine: 413,
  },
];
/** 本冊が運営の SELECT のポリシーを作り直す表 */
const TABLES_WITH_ADDED_POLICY = TABLES.filter((spec): spec is TableSpec & { addedPolicy: string } => spec.addedPolicy !== null);
/** 本冊の後に、ロール role が表 spec で持つべき書き込みの権限か */
const keeps = (spec: TableSpec, role: UserRole, privilege: string): boolean =>
  (spec.keptUserWrites[role] as readonly string[]).includes(privilege);

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
function mfaGateUsing(spec: TableSpec): string {
  const line = mfaGateLines[spec.mfaGateLine - 1] ?? '';
  const m = /\bUSING\s+(\(.*?\))(?:\s+WITH\s+CHECK\s+\(.*\))?;$/.exec(line);
  return m ? m[1] : '';
}

/** 文 (CREATE POLICY ... ;) の USING (...) の式 */
function usingOf(statement: string): string {
  const m = /\bUSING\s+(\(.*?\))(?:\s+WITH\s+CHECK\s+\(.*\))?;$/.exec(statement.trim());
  return m ? m[1] : '';
}

/** sql の中から、表 table の名前 name のポリシーを作る文 (1 行) を返す */
function createStatement(sql: string, table: string, name: string): string {
  const quoted = /^[a-z_][a-z0-9_]*$/.test(name) ? name : `"${name}"`;
  const lines = sql.split('\n').filter((l) => l.startsWith(`CREATE POLICY ${quoted} ON public.${table} `));
  return lines.length === 1 ? lines[0] : '';
}

describe('#1917 の続き: migration を全部流した後の、3 つの表のポリシーと権限', () => {
  it.each(TABLES)('$table: UPDATE / DELETE / ALL のポリシーが無い。INSERT のポリシーは利用者の通報だけ', ({ table, finalPolicies }) => {
    const finalState = stateAfter(table, migrations);
    expect(sortedPolicies(finalState)).toEqual(byName(finalPolicies));
    for (const [name, command] of finalState.policies) {
      if (name === USER_REPORT_INSERT_POLICY) expect(command, name).toBe('INSERT');
      else expect(command, name).toBe('SELECT');
    }
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

  it.each(TABLES)('$table: service_role は全部の権限を持ったまま (API・Edge Function・テストの後片付けが使う)', ({ table }) => {
    expect(sortedGrants(stateAfter(table, migrations), 'service_role')).toEqual([...ALL_TABLE_PRIVILEGES].sort());
  });

  it.each(TABLES)('番兵: $table の読み取りが、本冊の直前の運営の書き込みのポリシーと書き込みの権限を拾っている', ({ table, removedPolicy, removedCommand, finalPolicies, addedPolicy }) => {
    expect(migrationIndex, `${MIGRATION_FILE} が supabase/migrations に無い`).toBeGreaterThan(0);
    const before = stateAfter(table, migrations.slice(0, migrationIndex));
    const expectedBefore = finalPolicies.filter(([name]) => name !== addedPolicy).concat([[removedPolicy, removedCommand]]);
    expect(sortedPolicies(before)).toEqual(byName(expectedBefore));
    for (const role of USER_ROLES) {
      for (const privilege of WRITE_PRIVILEGES) expect(has(before, role, privilege), `${role} ${privilege} (本冊の直前)`).toBe(true);
      expect(has(before, role, 'TRUNCATE'), `${role} TRUNCATE (20261022190000 で外してある)`).toBe(false);
    }
    const hardeningIndex = migrations.findIndex(({ file }) => file === TRUNCATE_HARDENING_FILE);
    expect(hardeningIndex).toBeGreaterThan(0);
    expect(hardeningIndex).toBeLessThan(migrationIndex);
    const beforeHardening = stateAfter(table, migrations.slice(0, hardeningIndex));
    for (const role of USER_ROLES) expect(has(beforeHardening, role, 'TRUNCATE'), `${role} TRUNCATE (20261022190000 の前)`).toBe(true);
  });
});

describe('#1917 の続き: 本冊の migration', () => {
  it.each(TABLES)('$table: 本冊だけを流すと、運営の書き込みのポリシーが消え (SELECT を作り直す表は SELECT に替わり)、anon / authenticated の書き込みの権限だけが外れる', (spec) => {
    const { table, removedPolicy, addedPolicy } = spec;
    const before = stateAfter(table, migrations.slice(0, migrationIndex));
    const own = applySql(stateAfter(table, migrations.slice(0, migrationIndex)), table, migrationSql);
    expect(own.policies.has(removedPolicy)).toBe(false);
    if (addedPolicy !== null) expect(own.policies.get(addedPolicy)).toBe('SELECT');
    // 消す・作る以外のポリシーには触れない
    const untouched = (state: TableState) => sortedPolicies(state).filter(([name]) => name !== removedPolicy && name !== addedPolicy);
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
    const expected = mfaGateUsing(spec);
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

  it('recipe_flags: 運営の UPDATE のポリシーは作り直さない (CREATE POLICY は announcements と moderation_flags の 2 本だけ)', () => {
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

  it.each(TABLES)('$table: 作り直すポリシーは、本冊の直前と同じ種類 (FOR) で、20261017130000 の ALTER POLICY と同じ TO と式 (USING と WITH CHECK)', (spec) => {
    const statement = createStatement(rollbackSql, spec.table, spec.removedPolicy);
    expect(statement, `${spec.removedPolicy} を作る文が 1 行だけある`).not.toBe('');
    const gate = mfaGateLines[spec.mfaGateLine - 1] ?? '';
    const quoted = /^[a-z_][a-z0-9_]*$/.test(spec.removedPolicy) ? spec.removedPolicy : `"${spec.removedPolicy}"`;
    const gatePrefix = `ALTER POLICY ${quoted} ON public.${spec.table} `;
    expect(gate.startsWith(gatePrefix), `${MFA_GATE_FILE}:${spec.mfaGateLine}`).toBe(true);
    // ALTER POLICY は種類 (FOR) を持たないので、FOR ALL 以外のポリシーは CREATE POLICY の側に FOR を書く
    const forClause = spec.removedCommand === 'ALL' ? '' : `FOR ${spec.removedCommand} `;
    const createPrefix = `CREATE POLICY ${quoted} ON public.${spec.table} ${forClause}`;
    expect(statement.startsWith(createPrefix), createPrefix).toBe(true);
    expect(statement.slice(createPrefix.length)).toBe(gate.slice(gatePrefix.length));
  });
});

/** アプリのコードの置き場 (Web・モバイル・Edge Function・共有のライブラリ) */
const APP_DIRS = ['src', 'lib', 'apps/mobile/src', 'apps/mobile/app', 'packages/shared/src', 'supabase/functions'] as const;
const isSource = (name: string) => /\.(ts|tsx)$/.test(name) && !/\.d\.ts$/.test(name);
const isTestPath = (file: string) => /(__tests__|\.test\.|\.spec\.)/.test(file);

/**
 * 3 つの表に書く (insert / update / upsert / delete) 場所の一覧と理由。キーは「ファイル 表」。
 * ここに無い場所で書くと赤になる (本人のセッションの client で書く新しい経路は、本冊の後は 42501 で失敗する。
 * recipe_flags の利用者の通報の INSERT だけは本人のセッションで書けるが、いまアプリにその経路は無い)
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

/** 3 つの表に書く呼び出しを、ファイルごとに見つける (from('表') から 1 つの式の中で insert / update / upsert / delete を呼ぶ) */
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

describe('#1917 の続き: アプリのコードは 3 つの表に service_role でだけ書く', () => {
  const files = APP_DIRS.flatMap((dir) => {
    const abs = path.join(ROOT, dir);
    return fs.existsSync(abs) ? listFiles(abs, isSource) : [];
  }).filter((file) => !isTestPath(rel(file)));

  it('3 つの表に書く場所は WRITE_SITES の一覧と同じ (増えたら、本人のセッションで書いていないかを確かめて一覧に足す)', () => {
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

  it('DB の関数の本文は 3 つの表に INSERT / UPDATE / DELETE しない (本人の権限で動く関数が書けなくなることは無い)', () => {
    for (const { file, sql } of migrations) {
      for (const body of sql.matchAll(/\bAS\s+(\$[A-Za-z_]*\$)([\s\S]*?)\1/g)) {
        for (const { table } of TABLES) {
          const write = new RegExp(String.raw`\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(?:"?public"?\.)?"?${table}"?\b`, 'i');
          expect(write.test(body[2]), `${file} の関数の本文が ${table} に書く`).toBe(false);
        }
      }
    }
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
    [MFA_GATE_FILE, 379, 'ALTER POLICY "Admins can manage announcements" ON public.announcements TO authenticated USING'],
    [MFA_GATE_FILE, 402, 'ALTER POLICY moderation_flags_admin_all ON public.moderation_flags TO authenticated USING'],
    [MFA_GATE_FILE, 413, 'ALTER POLICY "Admins can update recipe flags" ON public.recipe_flags TO authenticated USING'],
    [FK_ON_DELETE_FILE, 238, 'ALTER TABLE public.announcements'],
    [FK_ON_DELETE_FILE, 292, 'ALTER TABLE public.moderation_flags'],
    [FK_ON_DELETE_FILE, 318, 'ALTER TABLE public.recipe_flags'],
    [FK_ON_DELETE_FILE, 323, 'ALTER TABLE public.recipe_flags'],
  ] as const)('%s:%i は「%s」で始まる', (file, line, prefix) => {
    expect(lineOf(file, line).startsWith(prefix)).toBe(true);
  });

  it('本冊のコメントが、上の行番号を挙げている', () => {
    for (const ref of [':9518', ':9675', ':10605', ':13460-13461', ':13726-13727', ':9536', ':9594', ':9713', ':13814-13815', '20261017130000_operator_mfa_db_gate.sql:379', '20261017130000:402', '20261017130000:413', '20261010000100_auth_users_fk_on_delete.sql:238', '(:292)', '(:318・:323)']) {
      expect(migrationRaw, ref).toContain(ref);
    }
  });
});
