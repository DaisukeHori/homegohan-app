// @vitest-environment node
/**
 * #2283 判断待ち 8 の Y2: AI 相談の提案の記録 (ai_action_logs) を、利用者 (authenticated) には読むだけにし、未認証 (anon) には何も
 * 許さない migration (supabase/migrations/20261107120000_ai_action_logs_select_only.sql) を、ファイルの読み取りで確かめる (DB には接続しない)。
 *
 *   M-1 migration はちょうど 1 本。頭の行と「戻し方」の参照が対になり、戻し口が実在して対の migration を指す
 *   M-2 migration を version 順にすべて流したあと、ai_action_logs のポリシーは SELECT だけの 1 本 (TO authenticated)。
 *       USING の式はベースラインの "Users can manage actions in own sessions" の USING と同じ (自分の相談の行。範囲を変えていない)。
 *       authenticated は SELECT・REFERENCES・TRIGGER・MAINTAIN だけを持ち (INSERT・UPDATE・DELETE・TRUNCATE が無い)、
 *       anon は何も持たない。service_role の権限はベースラインのまま
 *   M-3 本冊は行に書かない・service_role の権限に触れない・lock_timeout がある
 *   M-4 戻し口を本冊のあとに流すと、本冊の直前の状態 (ポリシーの名前と種類・権限) に戻る。作り直すポリシーの式 (USING と WITH CHECK)
 *       はベースラインと同じ。TRUNCATE は付け直さない (20261022190000 が外してある)
 *   M-5 修正前 (本冊の直前) の状態には利用者の書き込みが残っていた (この検査が本冊の無い形で赤になることの番兵)
 * 実際の挙動は tests/integration/rls/ai-action-logs-select-only-2283.test.ts (実 DB) と
 * tests/integration/security/ai-action-execute-route-select-only-2283.test.ts (実行の API) が確かめる。
 * アプリの書き込みが service_role のクライアントからだけであることは tests/ai-action-logs-service-role-writes-2283.test.ts (Y1) が見張る。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const MIGRATIONS_DIR = path.join(ROOT, 'supabase', 'migrations');
const ROLLBACKS_DIR = path.join(ROOT, 'supabase', 'rollbacks');
const BASELINE_FILE = '20251126124224_create_meal_planner_tables.sql';

const TABLE = 'ai_action_logs';
/** 本冊の名前 (version を除く) */
const MIGRATION_NAME = 'ai_action_logs_select_only';
/** 本冊が消すポリシー (ベースラインの FOR ALL) */
const OWNER_ALL_POLICY = 'Users can manage actions in own sessions';
/** 本冊が作るポリシー (SELECT だけ) */
const OWNER_SELECT_POLICY = 'Users can view actions in own sessions';

/** 表の権限の全部 (GRANT ALL / REVOKE ALL が指すもの。PostgreSQL 17) */
const ALL_TABLE_PRIVILEGES = ['INSERT', 'SELECT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'] as const;
/** 利用者に許さない書き込みの権限 */
const USER_WRITE_PRIVILEGES = ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'] as const;
/** 本冊のあとに authenticated が持つ権限 (SELECT と、本冊が触れない REFERENCES・TRIGGER・MAINTAIN) */
const AUTHENTICATED_AFTER = ['MAINTAIN', 'REFERENCES', 'SELECT', 'TRIGGER'] as const;
/** 20261022190000_db_privilege_hardening.sql が全部の表の anon / authenticated から TRUNCATE を外す文 (format で表ごとに出す) */
const DYNAMIC_TRUNCATE_REVOKE = "format('REVOKE TRUNCATE ON TABLE %s FROM anon, authenticated'";
const USER_ROLES = ['anon', 'authenticated'] as const;

const stripLineComments = (sql: string): string => sql.replace(/--.*$/gm, '');
const readMigration = (file: string): string => fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8');

const migrationFileNames = fs
  .readdirSync(MIGRATIONS_DIR)
  .filter((name) => name.endsWith('.sql'))
  .sort();
const migrationFiles = migrationFileNames.filter((name) => name.endsWith(`_${MIGRATION_NAME}.sql`));
const migrationFile = migrationFiles[0] ?? '';
const migrations = migrationFileNames.map((file) => ({ file, sql: stripLineComments(readMigration(file)) }));
const migrationIndex = migrations.findIndex(({ file }) => file === migrationFile);
const migrationSql = migrationIndex >= 0 ? migrations[migrationIndex].sql : '';
const rollbackFile = migrationFile.replace(/\.sql$/, '.down.sql');
const rollbackPath = path.join(ROLLBACKS_DIR, rollbackFile);
const rollbackSql = migrationFile && fs.existsSync(rollbackPath) ? stripLineComments(fs.readFileSync(rollbackPath, 'utf-8')) : '';

const TABLE_REF = String.raw`(?:"?public"?\.)?"?${TABLE}"?(?=[\s;])`;
const POLICY_NAME = String.raw`(?:"([^"]+)"|([A-Za-z_][\w]*))`;

interface TableState {
  /** ポリシーの名前 → 種類 (ALL / SELECT / INSERT / UPDATE / DELETE) */
  policies: Map<string, string>;
  /** ロール → 表の権限 */
  grants: Map<string, Set<string>>;
}

/** SQL の中の、ai_action_logs のポリシーと権限の文を、書かれた順に state へ流す */
function applySql(state: TableState, sql: string): void {
  const events: Array<{ at: number; apply: () => void }> = [];
  const createPolicy = new RegExp(
    String.raw`CREATE\s+POLICY\s+${POLICY_NAME}\s+ON\s+${TABLE_REF}\s*(?:AS\s+\w+\s+)?(?:FOR\s+(ALL|SELECT|INSERT|UPDATE|DELETE))?`,
    'gi',
  );
  for (const m of sql.matchAll(createPolicy)) {
    const name = m[1] ?? m[2];
    const command = (m[3] ?? 'ALL').toUpperCase();
    events.push({ at: m.index ?? 0, apply: () => state.policies.set(name, command) });
  }
  const dropPolicy = new RegExp(String.raw`DROP\s+POLICY\s+(?:IF\s+EXISTS\s+)?${POLICY_NAME}\s+ON\s+${TABLE_REF}`, 'gi');
  for (const m of sql.matchAll(dropPolicy)) {
    const name = m[1] ?? m[2];
    events.push({ at: m.index ?? 0, apply: () => state.policies.delete(name) });
  }
  const grantOrRevoke = new RegExp(String.raw`\b(GRANT|REVOKE)\s+([A-Z ,]+?)\s+ON\s+(?:TABLE\s+)?${TABLE_REF}\s+(TO|FROM)\s+([^;]+);`, 'gi');
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
}

function stateAfter(sqls: readonly string[]): TableState {
  const state: TableState = { policies: new Map(), grants: new Map() };
  for (const sql of sqls) applySql(state, sql);
  return state;
}

const sortedPolicies = (state: TableState) => [...state.policies.entries()].sort(([a], [b]) => a.localeCompare(b));
const sortedGrants = (state: TableState, role: string) => [...(state.grants.get(role) ?? new Set<string>())].sort();

const allSqls = migrations.map(({ sql }) => sql);
const beforeSqls = migrationIndex >= 0 ? allSqls.slice(0, migrationIndex) : allSqls;

/** start の位置の ( から、対応する ) までの文字列 (両端の括弧を含む)。対応が無ければ '' */
function balancedParens(text: string, start: number): string {
  if (text[start] !== '(') return '';
  let depth = 0;
  for (let i = start; i < text.length; i += 1) {
    if (text[i] === '(') depth += 1;
    else if (text[i] === ')') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return '';
}

/** 式を比べられる形にする (二重引用符を外し、空白をそろえる) */
const normalizeExpression = (expression: string): string => expression.replace(/"/g, '').replace(/\s+/g, ' ').trim();

/** sql の中で、ai_action_logs の name のポリシーを作る文の、keyword (USING / WITH CHECK) の式。無ければ '' */
function policyExpression(sql: string, name: string, keyword: 'USING' | 'WITH CHECK'): string {
  const head = new RegExp(String.raw`CREATE\s+POLICY\s+"${name}"\s+ON\s+${TABLE_REF}`, 'i').exec(sql);
  if (!head) return '';
  const statement = sql.slice(head.index, sql.indexOf(';', head.index) + 1);
  const at = new RegExp(String.raw`\b${keyword.replace(' ', String.raw`\s+`)}\s*\(`, 'i').exec(statement);
  if (!at) return '';
  return normalizeExpression(balancedParens(statement, at.index + at[0].length - 1));
}

const baselineSql = readMigration(BASELINE_FILE);
const baselineUsing = policyExpression(baselineSql, OWNER_ALL_POLICY, 'USING');
const baselineWithCheck = policyExpression(baselineSql, OWNER_ALL_POLICY, 'WITH CHECK');

describe('M-1 migration と戻し口の対 (#2283 Y2)', () => {
  it('migration はちょうど 1 本。頭の行と「戻し方」が対になり、戻し口が実在して対の migration を指す', () => {
    expect(migrationFiles).toHaveLength(1);
    const lines = readMigration(migrationFile).split('\n');
    expect(lines[0]).toBe(`-- migration: ${migrationFile}`);
    expect(lines[1]).toBe(`-- 戻し方: supabase/rollbacks/${rollbackFile}`);
    expect(fs.existsSync(rollbackPath)).toBe(true);
    expect(fs.readFileSync(rollbackPath, 'utf-8').split('\n')[0]).toBe(`-- rollback: ${migrationFile}`);
  });

  it('本冊の version は supabase/migrations の中で本冊だけ (ほかの migration と重ならない)', () => {
    const version = migrationFile.split('_')[0];
    expect(migrationFileNames.filter((name) => name.startsWith(`${version}_`))).toEqual([migrationFile]);
  });
});

describe('M-2 migration を全部流したあとの ai_action_logs のポリシーと権限 (#2283 Y2)', () => {
  const finalState = stateAfter(allSqls);

  it('ベースラインの式を読み取れている (番兵: 自分の相談の行 = ai_consultation_sessions.user_id = auth.uid())', () => {
    expect(baselineUsing).toContain('ai_consultation_sessions.user_id = auth.uid()');
    expect(baselineUsing).toContain('ai_consultation_sessions.id = ai_action_logs.session_id');
    expect(baselineWithCheck).toBe(baselineUsing);
  });

  it('ポリシーは SELECT だけの 1 本で、ほかに書き込みを許すポリシーが無い', () => {
    expect(sortedPolicies(finalState)).toEqual([[OWNER_SELECT_POLICY, 'SELECT']]);
  });

  it('SELECT のポリシーは TO authenticated で、USING はベースラインと同じ (読める範囲を広げも狭めもしない)。WITH CHECK は無い', () => {
    expect(migrationSql).toMatch(
      new RegExp(String.raw`CREATE\s+POLICY\s+"${OWNER_SELECT_POLICY}"\s+ON\s+${TABLE_REF}\s+FOR\s+SELECT\s+TO\s+authenticated\s+USING\s*\(`, 'i'),
    );
    expect(policyExpression(migrationSql, OWNER_SELECT_POLICY, 'USING')).toBe(baselineUsing);
    expect(policyExpression(migrationSql, OWNER_SELECT_POLICY, 'WITH CHECK')).toBe('');
  });

  it('authenticated は SELECT・REFERENCES・TRIGGER・MAINTAIN だけを持つ (INSERT・UPDATE・DELETE・TRUNCATE が無い)', () => {
    expect(sortedGrants(finalState, 'authenticated')).toEqual([...AUTHENTICATED_AFTER]);
    for (const privilege of USER_WRITE_PRIVILEGES) expect(finalState.grants.get('authenticated')?.has(privilege), privilege).toBe(false);
  });

  it('anon は何も持たない (SELECT も無い)', () => {
    expect(sortedGrants(finalState, 'anon')).toEqual([]);
  });

  it('service_role の権限は、本冊の直前と同じ (本冊は service_role に触れない)', () => {
    expect(sortedGrants(finalState, 'service_role')).toEqual(sortedGrants(stateAfter(beforeSqls), 'service_role'));
    expect(sortedGrants(finalState, 'service_role')).toEqual(expect.arrayContaining(['DELETE', 'INSERT', 'SELECT', 'UPDATE']));
  });
});

describe('M-3 本冊の形 (#2283 Y2)', () => {
  it('lock_timeout があり、消す側と作る側の両方の名前を DROP POLICY IF EXISTS してから作る (冪等)', () => {
    expect(migrationSql).toMatch(/SET LOCAL lock_timeout = '10s';/);
    for (const name of [OWNER_ALL_POLICY, OWNER_SELECT_POLICY]) {
      expect(migrationSql).toMatch(new RegExp(String.raw`DROP\s+POLICY\s+IF\s+EXISTS\s+"${name}"\s+ON\s+${TABLE_REF}`, 'i'));
    }
  });

  it('行に書かない・GRANT しない・service_role に触れない・authenticated の SELECT を外さない', () => {
    expect(migrationSql).not.toMatch(/\bINSERT\s+INTO\b|\bUPDATE\s+(?:public\.)?\w+\s+SET\b|\bDELETE\s+FROM\b|\bTRUNCATE\s+(?:TABLE\s+)?(?!ON\b)[\w".]+\s*;/i);
    expect(migrationSql).not.toMatch(/\bGRANT\b/i);
    expect(migrationSql).not.toMatch(/service_role/i);
    const authenticatedRevokes = [...migrationSql.matchAll(/\bREVOKE\s+([A-Z ,]+?)\s+ON\s+[^;]*\bFROM\s+([^;]*\bauthenticated\b[^;]*);/gi)].map((m) =>
      m[1].toUpperCase(),
    );
    expect(authenticatedRevokes.length).toBeGreaterThan(0);
    for (const listed of authenticatedRevokes) {
      expect(listed).not.toMatch(/\bSELECT\b|\bALL\b/);
    }
  });
});

describe('M-4 戻し口 (#2283 Y2)', () => {
  const before = stateAfter(beforeSqls);
  const afterRollback = stateAfter([...allSqls, rollbackSql]);

  it('本冊の直前の状態を読み取れている (番兵: FOR ALL の 1 本・anon と authenticated は TRUNCATE 以外の全部)', () => {
    expect(sortedPolicies(before)).toEqual([[OWNER_ALL_POLICY, 'ALL']]);
    const allButTruncate = ALL_TABLE_PRIVILEGES.filter((p) => p !== 'TRUNCATE').sort();
    for (const role of USER_ROLES) expect(sortedGrants(before, role), role).toEqual(allButTruncate);
  });

  it('戻し口を流すと、ポリシーの名前と種類・3 つのロールの権限が本冊の直前と同じになる', () => {
    expect(rollbackSql).not.toBe('');
    expect(sortedPolicies(afterRollback)).toEqual(sortedPolicies(before));
    for (const role of [...USER_ROLES, 'service_role']) {
      expect(sortedGrants(afterRollback, role), role).toEqual(sortedGrants(before, role));
    }
  });

  it('作り直すポリシーは TO authenticated で、USING と WITH CHECK がベースラインと同じ', () => {
    expect(rollbackSql).toMatch(new RegExp(String.raw`CREATE\s+POLICY\s+"${OWNER_ALL_POLICY}"\s+ON\s+${TABLE_REF}\s+TO\s+authenticated\s+USING\s*\(`, 'i'));
    expect(policyExpression(rollbackSql, OWNER_ALL_POLICY, 'USING')).toBe(baselineUsing);
    expect(policyExpression(rollbackSql, OWNER_ALL_POLICY, 'WITH CHECK')).toBe(baselineWithCheck);
  });

  it('TRUNCATE と ALL を付け直さない・service_role に触れない・行に書かない・lock_timeout がある', () => {
    for (const m of rollbackSql.matchAll(/\bGRANT\s+([A-Z ,]+?)\s+ON\b/gi)) {
      expect(m[1].toUpperCase()).not.toMatch(/\bTRUNCATE\b|\bALL\b/);
    }
    expect(rollbackSql).not.toMatch(/service_role/i);
    expect(rollbackSql).not.toMatch(/\bINSERT\s+INTO\b|\bUPDATE\s+(?:public\.)?\w+\s+SET\b|\bDELETE\s+FROM\b/i);
    expect(rollbackSql).toMatch(/SET LOCAL lock_timeout = '10s';/);
  });
});

describe('M-5 修正前の番兵 (#2283 Y2)', () => {
  it('本冊の直前は、authenticated と anon が INSERT・UPDATE・DELETE を持ち、FOR ALL のポリシーがあった (本冊が無ければ M-2 が赤になる)', () => {
    const before = stateAfter(beforeSqls);
    for (const role of USER_ROLES) {
      for (const privilege of ['INSERT', 'UPDATE', 'DELETE']) expect(before.grants.get(role)?.has(privilege), `${role} ${privilege}`).toBe(true);
    }
    expect(before.policies.get(OWNER_ALL_POLICY)).toBe('ALL');
  });
});
