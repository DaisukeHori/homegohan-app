/**
 * #1917: family_groups への利用者 (anon / authenticated) からの直接の DELETE を外した migration
 * (supabase/migrations/20261022200000_family_groups_no_direct_delete.sql) を、ファイルの読み取りで確かめる (DB には接続しない)。
 * 直接の DELETE は保護者の同意の記録 (parental_consents) を外部キーの CASCADE で消し、解散の RPC (通知・監査) も通らなかった。
 *
 *   1. migration を version 順にすべて流したときの family_groups のポリシーは SELECT の family_groups_select_member と
 *      UPDATE の family_groups_update_adult だけで、anon / authenticated の DELETE・TRUNCATE の権限は無い。
 *      authenticated の SELECT・UPDATE は残る (後の migration が DELETE のポリシーや権限を足し直したら、ここで赤くなる)
 *   2. 本冊の migration が、DELETE のポリシーを外し、DELETE・TRUNCATE の権限を anon / authenticated から外す (ほかには触れない)
 *   3. 同じ型の機械検査: family_groups の行を DELETE する関数の最新の定義は、どれも SECURITY DEFINER か、利用者が実行できない関数
 *   4. 戻し口が実在し、ポリシーはベースラインの行と逐語で同じに作り直し、流すと本冊の直前の状態 (ポリシーと権限) に戻る
 *   5. アプリのコード (Web・モバイル・Edge Function・共有のライブラリ) は family_groups を直接 DELETE しない (家族をやめるのは解散の RPC)
 * 実際の挙動は tests/integration/rls/family-groups-no-direct-delete.test.ts (実 DB) が確かめる。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { rel, ROOT, stripComments } from './helpers/ai-reach';

const MIGRATIONS_DIR = path.join(ROOT, 'supabase', 'migrations');
const MIGRATION = '20261022200000_family_groups_no_direct_delete';
const MIGRATION_FILE = `${MIGRATION}.sql`;
const ROLLBACK_PATH = path.join(ROOT, 'supabase', 'rollbacks', `${MIGRATION}.down.sql`);
/** 本番のベースライン (DELETE のポリシーと権限を最初に作ったファイル) */
const BASELINE_FILE = '20251126124224_create_meal_planner_tables.sql';

const TABLE = 'family_groups';
/** 利用者のロール (このロールの DELETE を閉じる) */
const USER_ROLES = ['anon', 'authenticated'] as const;
/** 閉じる権限 (TRUNCATE は RLS が効かない書き込みなので一緒に閉じる) */
const CLOSED_PRIVILEGES = ['DELETE', 'TRUNCATE'] as const;
/** 外す DELETE のポリシー */
const DELETE_POLICY = 'family_groups_delete_representative';
/** 残すポリシー (画面が読み、家族の名前などを書き換える。特権列は guard_family_groups_privileged が守る) */
const KEPT_POLICIES: ReadonlyArray<readonly [string, string]> = [
  ['family_groups_select_member', 'SELECT'],
  ['family_groups_update_adult', 'UPDATE'],
];
/** authenticated に残す権限 (画面の読み取りと UPDATE のポリシーが使う) */
const KEPT_AUTHENTICATED_PRIVILEGES = ['SELECT', 'UPDATE'] as const;
/** GRANT ALL / REVOKE ALL が表す表の権限 (PostgreSQL 17 の表の権限の全部) */
const ALL_TABLE_PRIVILEGES = ['INSERT', 'SELECT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'] as const;

/**
 * family_groups の行を DELETE するが SECURITY INVOKER のままでよい関数 (利用者 (anon / authenticated) が実行できない)。キーは関数名。理由を書く
 */
const INVOKER_DELETERS_NOT_EXECUTABLE_BY_USERS: Readonly<Record<string, string>> = {
  purge_dissolved_family_groups:
    'EXECUTE は service_role だけ (20261018010000_purge_dissolved_family_groups.sql)。pg_cron (所有者 postgres) が毎日呼ぶ。解散から 90 日を過ぎ、同意の記録を持たない家族だけを消す',
};

/** SQL の行コメント (-- ...) を取り除く (コメントの中の語に反応しないため) */
const stripLineComments = (sql: string): string => sql.replace(/--.*$/gm, '');

const migrationFileNames = fs
  .readdirSync(MIGRATIONS_DIR)
  .filter((file) => file.endsWith('.sql'))
  .sort();
const readMigration = (file: string): string => fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8');
const migrations = migrationFileNames.map((file) => ({ file, sql: stripLineComments(readMigration(file)) }));

const TABLE_REF = String.raw`(?:"?public"?\.)?"?${TABLE}"?(?=[\s;])`;
const POLICY_NAME = String.raw`(?:"([^"]+)"|([A-Za-z_][\w]*))`;

interface TableState {
  /** ポリシーの名前 → コマンド (ALL / SELECT / INSERT / UPDATE / DELETE) */
  policies: Map<string, string>;
  /** ロール → 表の権限 */
  grants: Map<string, Set<string>>;
}

const emptyState = (): TableState => ({ policies: new Map(), grants: new Map() });

/** SQL の中の、表 family_groups のポリシーと権限の文を、書かれた順に state へ流す */
function applySql(state: TableState, sql: string): TableState {
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
  for (const event of events.sort((a, b) => a.at - b.at)) event.apply();
  return state;
}

function stateAfter(files: ReadonlyArray<{ sql: string }>, extra: readonly string[] = []): TableState {
  const state = emptyState();
  for (const { sql } of files) applySql(state, sql);
  for (const sql of extra) applySql(state, sql);
  return state;
}

const migrationIndex = migrations.findIndex(({ file }) => file === MIGRATION_FILE);
const migrationSql = migrationIndex >= 0 ? migrations[migrationIndex].sql : '';

const sortedPolicies = (state: TableState) => [...state.policies.entries()].sort(([a], [b]) => a.localeCompare(b));
const sortedGrants = (state: TableState, role: string) => [...(state.grants.get(role) ?? new Set<string>())].sort();
const sortedKeptPolicies = () => [...KEPT_POLICIES].map(([name, command]) => [name, command]).sort(([a], [b]) => a.localeCompare(b));

describe('#1917 migration を全部流した後の family_groups のポリシーと権限', () => {
  const finalState = stateAfter(migrations);

  it('ポリシーは SELECT の family_groups_select_member と UPDATE の family_groups_update_adult だけ (DELETE のポリシーが無い)', () => {
    expect(sortedPolicies(finalState)).toEqual(sortedKeptPolicies());
  });

  it('anon / authenticated は DELETE・TRUNCATE の権限を持たない。authenticated の SELECT・UPDATE は残る', () => {
    for (const role of USER_ROLES) {
      for (const privilege of CLOSED_PRIVILEGES) {
        expect(finalState.grants.get(role)?.has(privilege) ?? false, `${role} ${privilege}`).toBe(false);
      }
    }
    for (const privilege of KEPT_AUTHENTICATED_PRIVILEGES) {
      expect(finalState.grants.get('authenticated')?.has(privilege), `authenticated ${privilege}`).toBe(true);
    }
  });

  it('service_role は DELETE の権限を持ったまま (purge・運営の手作業・テストの後片付けが使う)', () => {
    expect(finalState.grants.get('service_role')?.has('DELETE')).toBe(true);
  });

  it('番兵: 読み取りが本番のベースラインの DELETE のポリシーと権限を拾っている (本冊の直前の状態)', () => {
    const before = stateAfter(migrations.slice(0, migrationIndex));
    expect(sortedPolicies(before)).toEqual(
      [...sortedKeptPolicies(), [DELETE_POLICY, 'DELETE']].sort(([a], [b]) => a.localeCompare(b)),
    );
    for (const role of USER_ROLES) {
      for (const privilege of CLOSED_PRIVILEGES) {
        expect(before.grants.get(role)?.has(privilege), `${role} ${privilege}`).toBe(true);
      }
    }
  });
});

describe('#1917 本冊の migration', () => {
  it('実在し、DELETE のポリシーを外し、DELETE・TRUNCATE の権限を anon / authenticated から外す', () => {
    expect(migrationIndex, `${MIGRATION_FILE} が supabase/migrations に無い`).toBeGreaterThanOrEqual(0);
    const before = stateAfter(migrations.slice(0, migrationIndex));
    const own = applySql(stateAfter(migrations.slice(0, migrationIndex)), migrationSql);
    expect(sortedPolicies(own)).toEqual(sortedKeptPolicies());
    for (const role of USER_ROLES) {
      for (const privilege of CLOSED_PRIVILEGES) {
        expect(own.grants.get(role)?.has(privilege) ?? false, `${role} ${privilege}`).toBe(false);
      }
      // 閉じる権限のほか (INSERT・SELECT・UPDATE・REFERENCES・TRIGGER・MAINTAIN) は変えない
      const untouched = (state: TableState) => sortedGrants(state, role).filter((p) => !(CLOSED_PRIVILEGES as readonly string[]).includes(p));
      expect(untouched(own), role).toEqual(untouched(before));
    }
    expect(sortedGrants(own, 'service_role')).toEqual(sortedGrants(before, 'service_role'));
  });

  it('残すポリシーと service_role の権限には触れない', () => {
    for (const [name] of KEPT_POLICIES) expect(migrationSql).not.toMatch(new RegExp(name));
    expect(migrationSql).not.toMatch(/service_role/);
    expect(migrationSql).not.toMatch(/\bGRANT\b/i);
  });
});

/** 関数の定義 (CREATE OR REPLACE FUNCTION ... AS $tag$ 本文 $tag$) */
interface FunctionDefinition {
  name: string;
  file: string;
  /** CREATE OR REPLACE FUNCTION から本文の開きのドル引用の手前まで (SECURITY DEFINER などの属性) */
  header: string;
  body: string;
}

function definitionsIn(file: string, sql: string): FunctionDefinition[] {
  const found: FunctionDefinition[] = [];
  const pattern = /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+(?:"?public"?\.)?"?([A-Za-z0-9_]+)"?\s*\(/gi;
  for (const match of sql.matchAll(pattern)) {
    const rest = sql.slice(match.index ?? 0);
    const opener = /\bAS\s+(\$[A-Za-z_]*\$)/i.exec(rest);
    if (!opener) continue;
    const bodyStart = opener.index + opener[0].length;
    const bodyEnd = rest.indexOf(opener[1], bodyStart);
    if (bodyEnd < 0) continue;
    found.push({ name: match[1], file, header: rest.slice(0, opener.index), body: rest.slice(bodyStart, bodyEnd) });
  }
  return found;
}

/** 本文が family_groups の行を DELETE するか (DELETE FROM [public.]family_groups。legacy_family_groups には当たらない) */
const deletesFamilyGroups = (body: string): boolean =>
  /\bDELETE\s+FROM\s+(?:ONLY\s+)?(?:"?public"?\.)?"?family_groups"?(?![\w"])/i.test(stripLineComments(body));

describe('#1917 同じ型の機械検査: family_groups の行を DELETE する関数', () => {
  const latest = new Map<string, FunctionDefinition>();
  for (const file of migrationFileNames) {
    for (const def of definitionsIn(file, readMigration(file))) latest.set(def.name, def);
  }
  const deleters = [...latest.values()].filter((def) => deletesFamilyGroups(def.body));

  it('最新の定義は、どれも SECURITY DEFINER か、利用者が実行できない関数 (許可一覧)', () => {
    // 見つけ方が空振りしていないこと (purge_dissolved_family_groups は必ず当たる)
    expect(deleters.map((d) => d.name)).toEqual(expect.arrayContaining(Object.keys(INVOKER_DELETERS_NOT_EXECUTABLE_BY_USERS)));
    const offenders = deleters
      .filter((d) => !/SECURITY\s+DEFINER/i.test(d.header) && !(d.name in INVOKER_DELETERS_NOT_EXECUTABLE_BY_USERS))
      .map((d) => `${d.name} (${d.file})`);
    expect(offenders, '利用者の DELETE の権限は外してある。SECURITY INVOKER の関数から消すと、利用者の呼び出しでは 42501 になる').toEqual([]);
  });

  it('許可一覧の関数は、利用者 (anon / authenticated / PUBLIC) から EXECUTE を外し、利用者へ GRANT していない', () => {
    for (const name of Object.keys(INVOKER_DELETERS_NOT_EXECUTABLE_BY_USERS)) {
      const onFunction = String.raw`\bON\s+(?:FUNCTION|ROUTINE)\s+(?:"?public"?\.)?"?${name}"?\s*\(`;
      const statementsOf = (file: string) => stripLineComments(readMigration(file)).replace(/\s+/g, ' ').split(';').map((s) => s.trim());
      const all = migrationFileNames.flatMap(statementsOf);
      const revokes = all.filter((s) => new RegExp(`^REVOKE\\b[\\s\\S]*${onFunction}`, 'i').test(s));
      expect(
        revokes.some((s) => ['PUBLIC', 'anon', 'authenticated'].every((role) => new RegExp(`\\bFROM\\b[\\s\\S]*\\b${role}\\b`, 'i').test(s))),
        `${name} の REVOKE`,
      ).toBe(true);
      const grants = all.filter((s) => new RegExp(`^GRANT\\b[\\s\\S]*${onFunction}`, 'i').test(s));
      expect(grants.length, `${name} の GRANT`).toBeGreaterThan(0);
      for (const grant of grants) {
        expect(grant, `${name}: 利用者に EXECUTE を付けていない`).not.toMatch(/\bTO\b[\s\S]*\b(?:anon|authenticated|PUBLIC)\b/i);
      }
    }
  });

  it('解散の RPC 2 本と後始末の関数は family_groups の行を DELETE しない (UPDATE で dissolved にするだけ)', () => {
    for (const name of ['dissolve_family_by_representative', 'operator_force_dissolve_family', 'family_dissolve_apply']) {
      const def = latest.get(name);
      expect(def, `${name} の定義が migration に見つからない`).toBeDefined();
      expect(deletesFamilyGroups(def!.body), name).toBe(false);
    }
  });
});

describe('#1917 戻し口', () => {
  const rollbackRaw = fs.existsSync(ROLLBACK_PATH) ? fs.readFileSync(ROLLBACK_PATH, 'utf-8') : '';

  it('実在し、1 行目が戻す migration の名前', () => {
    expect(fs.existsSync(ROLLBACK_PATH), ROLLBACK_PATH).toBe(true);
    expect(rollbackRaw.split('\n', 1)[0]).toBe(`-- rollback: ${MIGRATION_FILE}`);
  });

  it('DELETE のポリシーを、ベースラインの行と逐語で同じに作り直す', () => {
    const baselineLines = readMigration(BASELINE_FILE).split('\n');
    const created = baselineLines.filter((line) => line.startsWith(`CREATE POLICY "${DELETE_POLICY}" ON "public"."${TABLE}"`));
    expect(created, `${BASELINE_FILE} の ${DELETE_POLICY}`).toHaveLength(1);
    expect(new Set(rollbackRaw.split('\n')).has(created[0])).toBe(true);
  });

  it('流すと、本冊の直前のポリシーと権限に戻る', () => {
    const before = stateAfter(migrations.slice(0, migrationIndex));
    const restored = stateAfter(migrations.slice(0, migrationIndex + 1), [stripLineComments(rollbackRaw)]);
    expect(sortedPolicies(restored)).toEqual(sortedPolicies(before));
    for (const role of [...USER_ROLES, 'service_role']) {
      expect(sortedGrants(restored, role), role).toEqual(sortedGrants(before, role));
    }
  });
});

describe('#1917 アプリのコードは family_groups を直接 DELETE しない', () => {
  /** アプリのコードが family_groups の行を消す箇所 (いまは無い)。家族をやめるのは解散の RPC (dissolve_family_by_representative) */
  const ALLOWED_DELETERS: readonly string[] = [];
  const SOURCE_DIRS = ['src', 'lib', 'shared', 'packages', 'apps/mobile/app', 'apps/mobile/src', 'supabase/functions'];
  const SOURCE_FILE = /\.(ts|tsx|js|jsx|mjs)$/;
  const TEST_FILE = /\.(test|spec)\.(ts|tsx|js|jsx)$/;
  const SKIP_DIRS = new Set(['node_modules', '.next', '.expo', 'dist', 'build', '__tests__', '__mocks__']);
  const walk = (dir: string): string[] => {
    if (!fs.existsSync(dir)) return [];
    const out: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) out.push(...walk(path.join(dir, entry.name)));
      } else if (SOURCE_FILE.test(entry.name) && !TEST_FILE.test(entry.name)) {
        out.push(path.join(dir, entry.name));
      }
    }
    return out;
  };
  const files = SOURCE_DIRS.flatMap((dir) => walk(path.join(ROOT, dir))).map(rel).sort();
  const textOf = (file: string) => stripComments(fs.readFileSync(path.join(ROOT, file), 'utf-8'));
  const mentioning = files.filter((file) => textOf(file).includes(TABLE));
  const fromTable = String.raw`\.from\(\s*['"\`]${TABLE}['"\`]\s*\)`;

  it(".from('family_groups') の delete と、REST の /rest/v1/family_groups が無い", () => {
    const deletes = mentioning.filter((file) => {
      const text = textOf(file);
      return new RegExp(String.raw`${fromTable}\s*\.delete\(`).test(text) || text.includes(`rest/v1/${TABLE}`);
    });
    expect(deletes).toEqual([...ALLOWED_DELETERS]);
  });

  it('番兵: 走査はアプリのコードの読み取り (家族のダッシュボードの SELECT) を拾っている', () => {
    const reads = mentioning.filter((file) => new RegExp(String.raw`${fromTable}\s*\.select\(`).test(textOf(file)));
    expect(reads).toContain('src/app/(main)/family/dashboard/page.tsx');
  });
});

describe('#1917 本冊の migration のコメントが挙げる家族の行の消え方は、スキーマの事実と合う', () => {
  const rawMigration = migrationIndex >= 0 ? readMigration(MIGRATION_FILE) : '';
  /** 本冊の migration のコメント (-- の行) だけ */
  const commentText = rawMigration
    .split('\n')
    .filter((line) => line.trimStart().startsWith('--'))
    .join('\n');
  const tableRef = (table: string) => String.raw`(?:ONLY\s+)?(?:"?public"?\.)?"?${table}"?`;

  /** ベースラインの CREATE TABLE と、後の migration の ADD COLUMN / DROP COLUMN を流した後の family_groups の列 */
  const familyGroupsColumns = (): Set<string> => {
    const columns = new Set<string>();
    const baseline = readMigration(BASELINE_FILE);
    const create = new RegExp(String.raw`CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?${tableRef(TABLE)}\s*\(([\s\S]*?)\n\);`, 'i').exec(baseline);
    for (const m of (create?.[1] ?? '').matchAll(/^\s*"?([a-z_][a-z0-9_]*)"?\s+"?[a-z]/gim)) {
      if (m[1].toUpperCase() !== 'CONSTRAINT') columns.add(m[1]);
    }
    const alter = new RegExp(
      String.raw`ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?${tableRef(TABLE)}\s+(ADD|DROP)\s+COLUMN\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?"?([a-z_][a-z0-9_]*)"?`,
      'gi',
    );
    for (const { sql } of migrations) {
      for (const m of sql.matchAll(alter)) {
        if (m[1].toUpperCase() === 'ADD') columns.add(m[2]);
        else columns.delete(m[2]);
      }
    }
    return columns;
  };

  /** 表から auth.users への外部キー (列 → ON DELETE の動作)。migration を version 順に流した後 */
  const authUsersForeignKeys = (table: string): Map<string, string> => {
    const keys = new Map<string, { column: string; action: string }>();
    const add = new RegExp(
      String.raw`ALTER\s+TABLE\s+${tableRef(table)}\s+ADD\s+CONSTRAINT\s+"?([A-Za-z0-9_]+)"?\s+FOREIGN\s+KEY\s*\(\s*"?([a-z_][a-z0-9_]*)"?\s*\)\s+REFERENCES\s+"?auth"?\."?users"?\s*\(\s*"?id"?\s*\)(?:\s+ON\s+DELETE\s+(CASCADE|RESTRICT|SET\s+NULL|SET\s+DEFAULT|NO\s+ACTION))?`,
      'gi',
    );
    const drop = new RegExp(String.raw`ALTER\s+TABLE\s+${tableRef(table)}\s+DROP\s+CONSTRAINT\s+(?:IF\s+EXISTS\s+)?"?([A-Za-z0-9_]+)"?`, 'gi');
    for (const { sql } of migrations) {
      const events = [
        ...[...sql.matchAll(add)].map((m) => ({ at: m.index ?? 0, apply: () => keys.set(m[1], { column: m[2], action: (m[3] ?? 'NO ACTION').toUpperCase().replace(/\s+/g, ' ') }) })),
        ...[...sql.matchAll(drop)].map((m) => ({ at: m.index ?? 0, apply: () => keys.delete(m[1]) })),
      ];
      for (const event of events.sort((a, b) => a.at - b.at)) event.apply();
    }
    return new Map([...keys.values()].map(({ column, action }) => [column, action]));
  };

  it('コメントが名指しする family_groups の列 (family_groups.<列>) は、どれも family_groups に実在する (owner_id は無い)', () => {
    const columns = familyGroupsColumns();
    // 番兵: 列の読み取りが働いている (代表者の列と、解散で足した列がある)
    expect(columns.has('representative_id')).toBe(true);
    expect(columns.has('dissolved_at')).toBe(true);
    expect(columns.has('owner_id')).toBe(false);
    const named = [...commentText.matchAll(/\bfamily_groups\.([a-z_][a-z0-9_]*)/g)].map((m) => m[1]);
    expect(named.length, 'コメントが family_groups の列を 1 つも名指ししていない (番兵)').toBeGreaterThan(0);
    expect(named.filter((column) => !columns.has(column))).toEqual([]);
  });

  it('退会で家族の行は消えない: family_groups から auth.users への外部キーは representative_id の ON DELETE RESTRICT だけで、コメントの記述と合う', () => {
    expect([...authUsersForeignKeys(TABLE).entries()]).toEqual([['representative_id', 'RESTRICT']]);
    const stated = [...commentText.matchAll(/representative_id の ON DELETE (CASCADE|RESTRICT|SET NULL)/g)].map((m) => m[1]);
    expect(stated).toEqual(['RESTRICT']);
    // コメントは、退会で家族の行が CASCADE で消える経路を挙げない
    expect(commentText).not.toMatch(/family_groups\.[a-z_]+ の ON DELETE CASCADE/);
  });

  it('番兵: 外部キーの読み取りは legacy_family_groups の owner_id の CASCADE (名前は family_groups_owner_id_fkey) を、family_groups と取り違えずに拾う', () => {
    expect(authUsersForeignKeys('legacy_family_groups').get('owner_id')).toBe('CASCADE');
  });
});
