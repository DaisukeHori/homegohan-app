/**
 * #1917 の続き: organizations へのオーナーの直接の DELETE を外した migration
 * (supabase/migrations/20261023100000_organizations_no_owner_direct_delete.sql) を、ファイルの読み取りで確かめる (DB には接続しない)。
 * 直接の DELETE は部署・招待・チャレンジ・席数などの子の記録を外部キーの CASCADE で消し、解散の RPC (知らせ・監査) も通らなかった。
 * 家族の同じ欠陥は 20261022200000_family_groups_no_direct_delete.sql で塞いだ (tests/family-groups-no-direct-delete-migration-contract.test.ts)。
 *
 *   1. migration を version 順にすべて流したときの organizations のポリシーは SELECT の organizations_select_member・
 *      UPDATE の organizations_update_admin・DELETE の organizations_delete_super_admin (運営) だけ。anon は DELETE・TRUNCATE を
 *      持たず、authenticated は DELETE を持つ (運営のポリシーのため) が TRUNCATE は持たない
 *   2. 本冊の migration が、オーナーの DELETE のポリシーを外し、anon の DELETE の権限を外す (ほかには触れない)
 *   3. 同じ型の機械検査: organizations の行を DELETE する関数の最新の定義は、どれも SECURITY DEFINER か、利用者が実行できない関数。
 *      解散の RPC と後始末の関数は organizations を DELETE しない
 *   4. 戻し口が実在し、ポリシーはベースラインの行と逐語で同じに作り直し、流すと本冊の直前の状態 (ポリシーと権限) に戻る
 *      (TRUNCATE は 20261022190000 が外してあるので付け直さない)
 *   5. アプリのコード (Web・モバイル・Edge Function・共有のライブラリ) は organizations を直接 DELETE しない (組織をやめるのは解散の RPC)
 *   6. 本冊の migration のコメントが挙げる行番号・列・外部キーが、スキーマの事実と合う
 * 実際の挙動は tests/integration/rls/organizations-no-owner-direct-delete.test.ts (実 DB) が確かめる。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { rel, ROOT, stripComments } from './helpers/ai-reach';

const MIGRATIONS_DIR = path.join(ROOT, 'supabase', 'migrations');
const MIGRATION = '20261023100000_organizations_no_owner_direct_delete';
const MIGRATION_FILE = `${MIGRATION}.sql`;
const ROLLBACK_PATH = path.join(ROOT, 'supabase', 'rollbacks', `${MIGRATION}.down.sql`);
/** 本番のベースライン (DELETE のポリシーと権限を最初に作ったファイル) */
const BASELINE_FILE = '20251126124224_create_meal_planner_tables.sql';
/** anon / authenticated の TRUNCATE を public の全部の表から外した migration (本冊より前) */
const TRUNCATE_HARDENING_FILE = '20261022190000_db_privilege_hardening.sql';

const TABLE = 'organizations';
/** DELETE の権限を外すロール (どの DELETE のポリシーも当たらない) */
const CLOSED_ROLE = 'anon';
/** DELETE の権限を残すロール (運営の削除のポリシー organizations_delete_super_admin は TO authenticated) */
const KEPT_DELETE_ROLE = 'authenticated';
/** 外す DELETE のポリシー */
const DELETE_POLICY = 'organizations_delete_owner';
/** 残すポリシー */
const KEPT_POLICIES: ReadonlyArray<readonly [string, string]> = [
  ['organizations_delete_super_admin', 'DELETE'],
  ['organizations_select_member', 'SELECT'],
  ['organizations_update_admin', 'UPDATE'],
];
/** authenticated に残す権限 (画面の読み取り・UPDATE のポリシー・運営の DELETE のポリシーが使う) */
const KEPT_AUTHENTICATED_PRIVILEGES = ['SELECT', 'UPDATE', 'DELETE'] as const;
/** GRANT ALL / REVOKE ALL が表す表の権限 (PostgreSQL 17 の表の権限の全部) */
const ALL_TABLE_PRIVILEGES = ['INSERT', 'SELECT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'] as const;
/** 20261022190000 の動的な REVOKE (public の全部の表から anon / authenticated の TRUNCATE を外す) */
const DYNAMIC_TRUNCATE_REVOKE = "format('REVOKE TRUNCATE ON TABLE %s FROM anon, authenticated'";
const DYNAMIC_TRUNCATE_REVOKED_ROLES = ['anon', 'authenticated'] as const;

/**
 * organizations の行を DELETE するが SECURITY INVOKER のままでよい関数 (利用者 (anon / authenticated) が実行できない)。キーは関数名。
 * いまは無い (解散は UPDATE で dissolved にするだけで、解散した組織を物理削除するジョブも無い)
 */
const INVOKER_DELETERS_NOT_EXECUTABLE_BY_USERS: Readonly<Record<string, string>> = {};

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

/** SQL の中の、表 organizations のポリシーと権限の文を、書かれた順に state へ流す */
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
  // 20261022190000 は public の全部の表から、動的な SQL (format + EXECUTE) で anon / authenticated の TRUNCATE を外す
  const dynamicAt = sql.indexOf(DYNAMIC_TRUNCATE_REVOKE);
  if (dynamicAt >= 0) {
    events.push({
      at: dynamicAt,
      apply: () => {
        for (const role of DYNAMIC_TRUNCATE_REVOKED_ROLES) state.grants.get(role)?.delete('TRUNCATE');
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
const has = (state: TableState, role: string, privilege: string) => state.grants.get(role)?.has(privilege) ?? false;

describe('#1917 の続き: migration を全部流した後の organizations のポリシーと権限', () => {
  const finalState = stateAfter(migrations);

  it('ポリシーは SELECT・UPDATE と運営の DELETE (organizations_delete_super_admin) だけ (オーナーの DELETE のポリシーが無い)', () => {
    expect(sortedPolicies(finalState)).toEqual(sortedKeptPolicies());
  });

  it('anon は DELETE・TRUNCATE の権限を持たない。authenticated は SELECT・UPDATE・DELETE を持ち、TRUNCATE は持たない', () => {
    expect(has(finalState, CLOSED_ROLE, 'DELETE')).toBe(false);
    expect(has(finalState, CLOSED_ROLE, 'TRUNCATE')).toBe(false);
    for (const privilege of KEPT_AUTHENTICATED_PRIVILEGES) {
      expect(has(finalState, KEPT_DELETE_ROLE, privilege), `authenticated ${privilege}`).toBe(true);
    }
    expect(has(finalState, KEPT_DELETE_ROLE, 'TRUNCATE')).toBe(false);
  });

  it('service_role は DELETE の権限を持ったまま (テストと e2e の後片付けが使う)', () => {
    expect(has(finalState, 'service_role', 'DELETE')).toBe(true);
  });

  it('番兵: 読み取りが本番のベースラインのオーナーの DELETE のポリシーと anon の DELETE、20261022190000 の TRUNCATE の取り外しを拾っている', () => {
    const before = stateAfter(migrations.slice(0, migrationIndex));
    expect(sortedPolicies(before)).toEqual(
      [...sortedKeptPolicies(), [DELETE_POLICY, 'DELETE']].sort(([a], [b]) => a.localeCompare(b)),
    );
    expect(has(before, CLOSED_ROLE, 'DELETE')).toBe(true);
    expect(has(before, KEPT_DELETE_ROLE, 'DELETE')).toBe(true);
    // 20261022190000 の直前までは anon / authenticated が TRUNCATE を持っていた (動的な REVOKE の読み取りが働いている)
    const hardeningIndex = migrations.findIndex(({ file }) => file === TRUNCATE_HARDENING_FILE);
    expect(hardeningIndex).toBeGreaterThan(0);
    expect(hardeningIndex).toBeLessThan(migrationIndex);
    const beforeHardening = stateAfter(migrations.slice(0, hardeningIndex));
    for (const role of DYNAMIC_TRUNCATE_REVOKED_ROLES) {
      expect(has(beforeHardening, role, 'TRUNCATE'), `${role} TRUNCATE (20261022190000 の前)`).toBe(true);
      expect(has(before, role, 'TRUNCATE'), `${role} TRUNCATE (本冊の直前)`).toBe(false);
    }
  });
});

describe('#1917 の続き: 本冊の migration', () => {
  it('実在し、オーナーの DELETE のポリシーを外し、anon の DELETE の権限だけを外す', () => {
    expect(migrationIndex, `${MIGRATION_FILE} が supabase/migrations に無い`).toBeGreaterThanOrEqual(0);
    const before = stateAfter(migrations.slice(0, migrationIndex));
    const own = applySql(stateAfter(migrations.slice(0, migrationIndex)), migrationSql);
    expect(sortedPolicies(own)).toEqual(sortedKeptPolicies());
    expect(has(own, CLOSED_ROLE, 'DELETE')).toBe(false);
    // anon の DELETE のほかは変えない
    expect(sortedGrants(own, CLOSED_ROLE)).toEqual(sortedGrants(before, CLOSED_ROLE).filter((p) => p !== 'DELETE'));
    for (const role of [KEPT_DELETE_ROLE, 'service_role']) {
      expect(sortedGrants(own, role), role).toEqual(sortedGrants(before, role));
    }
  });

  it('残すポリシー・authenticated と service_role の権限・TRUNCATE には触れない', () => {
    for (const [name] of KEPT_POLICIES) expect(migrationSql).not.toMatch(new RegExp(name));
    expect(migrationSql).not.toMatch(/service_role/);
    expect(migrationSql).not.toMatch(/\bauthenticated\b/);
    expect(migrationSql).not.toMatch(/\bTRUNCATE\b/i);
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

/** SQL が organizations の行を DELETE するか (DELETE FROM [public.]organizations。organization_invites などには当たらない) */
const deletesOrganizations = (sql: string): boolean =>
  /\bDELETE\s+FROM\s+(?:ONLY\s+)?(?:"?public"?\.)?"?organizations"?(?![\w"])/i.test(stripLineComments(sql));

describe('#1917 の続き: 同じ型の機械検査: organizations の行を DELETE する関数', () => {
  const latest = new Map<string, FunctionDefinition>();
  for (const file of migrationFileNames) {
    for (const def of definitionsIn(file, readMigration(file))) latest.set(def.name, def);
  }
  const deleters = [...latest.values()].filter((def) => deletesOrganizations(def.body));

  it('番兵: 検出の式は、migration の中の DELETE FROM public.organizations を拾い、子の表には当たらない', () => {
    // 20261017100000 の一度きりの DO ブロック (関数ではない) が organizations を消す
    expect(deletesOrganizations(readMigration('20261017100000_organizations_owner_id_not_null.sql'))).toBe(true);
    expect(deletesOrganizations('DELETE FROM public.organization_invites WHERE true')).toBe(false);
    expect(deletesOrganizations('DELETE FROM public.organizations_x WHERE true')).toBe(false);
    expect(deletesOrganizations('-- DELETE FROM public.organizations')).toBe(false);
  });

  it('最新の定義は、どれも SECURITY DEFINER か、利用者が実行できない関数 (許可一覧)', () => {
    const offenders = deleters
      .filter((d) => !/SECURITY\s+DEFINER/i.test(d.header) && !(d.name in INVOKER_DELETERS_NOT_EXECUTABLE_BY_USERS))
      .map((d) => `${d.name} (${d.file})`);
    expect(offenders, 'SECURITY INVOKER の関数から消すと、オーナーの直接の DELETE と同じく解散の仕組みを迂回する').toEqual([]);
  });

  it('解散の RPC 2 本と後始末の関数は organizations の行を DELETE しない (UPDATE で dissolved にするだけ)', () => {
    for (const name of ['dissolve_org_by_owner', 'operator_force_dissolve_org', 'org_dissolve_apply']) {
      const def = latest.get(name);
      expect(def, `${name} の定義が migration に見つからない`).toBeDefined();
      expect(deletesOrganizations(def!.body), name).toBe(false);
    }
  });
});

describe('#1917 の続き: 戻し口', () => {
  const rollbackRaw = fs.existsSync(ROLLBACK_PATH) ? fs.readFileSync(ROLLBACK_PATH, 'utf-8') : '';

  it('実在し、1 行目が戻す migration の名前', () => {
    expect(fs.existsSync(ROLLBACK_PATH), ROLLBACK_PATH).toBe(true);
    expect(rollbackRaw.split('\n', 1)[0]).toBe(`-- rollback: ${MIGRATION_FILE}`);
  });

  it('オーナーの DELETE のポリシーを、ベースラインの行と逐語で同じに作り直す', () => {
    const baselineLines = readMigration(BASELINE_FILE).split('\n');
    const created = baselineLines.filter((line) => line.startsWith(`CREATE POLICY "${DELETE_POLICY}" ON "public"."${TABLE}"`));
    expect(created, `${BASELINE_FILE} の ${DELETE_POLICY}`).toHaveLength(1);
    expect(new Set(rollbackRaw.split('\n')).has(created[0])).toBe(true);
  });

  it('流すと、本冊の直前のポリシーと権限に戻る (TRUNCATE は付け直さない)', () => {
    const before = stateAfter(migrations.slice(0, migrationIndex));
    const restored = stateAfter(migrations.slice(0, migrationIndex + 1), [stripLineComments(rollbackRaw)]);
    expect(sortedPolicies(restored)).toEqual(sortedPolicies(before));
    for (const role of [CLOSED_ROLE, KEPT_DELETE_ROLE, 'service_role']) {
      expect(sortedGrants(restored, role), role).toEqual(sortedGrants(before, role));
    }
    expect(stripLineComments(rollbackRaw)).not.toMatch(/\bTRUNCATE\b/i);
  });
});

describe('#1917 の続き: アプリのコードは organizations を直接 DELETE しない', () => {
  /** アプリのコードが organizations の行を消す箇所 (いまは無い)。組織をやめるのは解散の RPC (dissolve_org_by_owner) */
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

  it(".from('organizations') の delete と、REST の /rest/v1/organizations が無い", () => {
    const deletes = mentioning.filter((file) => {
      const text = textOf(file);
      return new RegExp(String.raw`${fromTable}\s*\.delete\(`).test(text) || text.includes(`rest/v1/${TABLE}`);
    });
    expect(deletes).toEqual([...ALLOWED_DELETERS]);
  });

  it('番兵: 走査はアプリのコードの読み取り (組織の設定の SELECT) を拾っている', () => {
    const reads = mentioning.filter((file) => new RegExp(String.raw`${fromTable}\s*\.select\(`).test(textOf(file)));
    expect(reads).toContain('src/app/api/org/settings/route.ts');
  });
});

describe('#1917 の続き: 本冊の migration のコメントが挙げる行番号・列・外部キーは、スキーマの事実と合う', () => {
  const rawMigration = migrationIndex >= 0 ? readMigration(MIGRATION_FILE) : '';
  /** 本冊の migration のコメント (-- の行) だけ */
  const commentText = rawMigration
    .split('\n')
    .filter((line) => line.trimStart().startsWith('--'))
    .join('\n');
  const baselineLines = readMigration(BASELINE_FILE).split('\n');
  /** ベースラインの 1 始まりの行番号の行 */
  const baselineLine = (lineNo: number): string => baselineLines[lineNo - 1] ?? '';
  const tableRef = (table: string) => String.raw`(?:ONLY\s+)?(?:"?public"?\.)?"?${table}"?`;

  /** migration を version 順に流した後の、表を指す外部キー (参照する表.列 → ON DELETE の動作) */
  const foreignKeysTo = (schema: string, target: string, from?: string): Map<string, string> => {
    const keys = new Map<string, { table: string; column: string; action: string }>();
    const add = new RegExp(
      String.raw`ALTER\s+TABLE\s+${tableRef(from ?? String.raw`[a-z_][a-z0-9_]*`)}\s+ADD\s+CONSTRAINT\s+"?([A-Za-z0-9_]+)"?\s+FOREIGN\s+KEY\s*\(\s*"?([a-z_][a-z0-9_]*)"?\s*\)\s+REFERENCES\s+"?${schema}"?\."?${target}"?\s*\(\s*"?id"?\s*\)(?:\s+ON\s+DELETE\s+(CASCADE|RESTRICT|SET\s+NULL|SET\s+DEFAULT|NO\s+ACTION))?`,
      'gi',
    );
    const tableOf = /ALTER\s+TABLE\s+(?:ONLY\s+)?(?:"?public"?\.)?"?([a-z_][a-z0-9_]*)"?/i;
    const drop = /ALTER\s+TABLE\s+(?:ONLY\s+)?(?:"?public"?\.)?"?[a-z_][a-z0-9_]*"?\s+DROP\s+CONSTRAINT\s+(?:IF\s+EXISTS\s+)?"?([A-Za-z0-9_]+)"?/gi;
    for (const { sql } of migrations) {
      const events = [
        ...[...sql.matchAll(add)].map((m) => ({
          at: m.index ?? 0,
          apply: () =>
            keys.set(m[1], {
              table: tableOf.exec(m[0])?.[1] ?? '',
              column: m[2],
              action: (m[3] ?? 'NO ACTION').toUpperCase().replace(/\s+/g, ' '),
            }),
        })),
        ...[...sql.matchAll(drop)].map((m) => ({ at: m.index ?? 0, apply: () => keys.delete(m[1]) })),
      ];
      for (const event of events.sort((a, b) => a.at - b.at)) event.apply();
    }
    return new Map([...keys.values()].map(({ table, column, action }) => [`${table}.${column}`, action]));
  };

  /** ベースラインの CREATE TABLE と、後の migration の ADD COLUMN / DROP COLUMN を流した後の organizations の列 */
  const organizationColumns = (): Set<string> => {
    const columns = new Set<string>();
    const create = new RegExp(String.raw`CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?${tableRef(TABLE)}\s*\(([\s\S]*?)\n\);`, 'i').exec(
      readMigration(BASELINE_FILE),
    );
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

  it('コメントが挙げる CASCADE の表は、organizations を ON DELETE CASCADE で指す表と同じ。SET NULL は user_profiles.organization_id だけ', () => {
    const toOrganizations = foreignKeysTo('public', TABLE);
    const cascadeTables = [...toOrganizations.entries()]
      .filter(([, action]) => action === 'CASCADE')
      .map(([key]) => key.split('.')[0])
      .sort();
    // 番兵: 外部キーの読み取りが働いている
    expect(cascadeTables).toContain('departments');
    const named = [...commentText.matchAll(/([a-z_][a-z0-9_]*) \(:\d+\)/g)].map((m) => m[1]);
    for (const table of cascadeTables) expect(named, `${table} がコメントに無い`).toContain(table);
    const setNull = [...toOrganizations.entries()].filter(([, action]) => action === 'SET NULL').map(([key]) => key);
    expect(setNull).toEqual(['user_profiles.organization_id']);
    expect([...toOrganizations.values()].filter((action) => action !== 'CASCADE' && action !== 'SET NULL')).toEqual([]);
  });

  it('コメントの「表 (:行)」「表.列 (:行)」は、ベースラインのその行がその表の外部キーの ON DELETE を足す行を指す', () => {
    const refs = [...commentText.matchAll(/([a-z_][a-z0-9_]*)(?:\.([a-z_][a-z0-9_]*))? \(:(\d+)\)/g)];
    expect(refs.length, '番兵: 行番号つきの参照を拾っている').toBeGreaterThanOrEqual(8);
    for (const [, table, column, lineNo] of refs) {
      const line = baselineLine(Number(lineNo));
      const constraintPrefix = column ? `"${table}_${column}_fkey"` : `"${table}_`;
      expect(line, `${table}${column ? `.${column}` : ''} (:${lineNo})`).toContain(`ADD CONSTRAINT ${constraintPrefix}`);
      expect(line, `${table} (:${lineNo})`).toMatch(/ON DELETE (CASCADE|SET NULL)/);
    }
  });

  it('コメントが挙げるベースラインの行 (:10686 のポリシー・:13770-13771 の権限・:9183 の外部キー) は、書いてあるとおり', () => {
    expect(commentText).toContain(':10686 organizations_delete_owner');
    expect(baselineLine(10686)).toContain(`CREATE POLICY "${DELETE_POLICY}" ON "public"."${TABLE}" FOR DELETE`);
    expect(commentText).toContain(':13770-13771');
    expect(baselineLine(13770)).toMatch(/^GRANT [A-Z, ]*\bDELETE\b[A-Z, ]* ON TABLE public\."organizations" TO "anon";$/);
    expect(baselineLine(13771)).toMatch(/^GRANT [A-Z, ]*\bDELETE\b[A-Z, ]* ON TABLE public\."organizations" TO "authenticated";$/);
    expect(commentText).toContain('(ベースライン :9183)');
    expect(baselineLine(9183)).toContain('ADD CONSTRAINT "organizations_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "auth"."users"("id") ON DELETE RESTRICT');
  });

  it('コメントが名指しする organizations の列 (organizations.<列>) は、どれも organizations に実在する', () => {
    const columns = organizationColumns();
    expect(columns.has('owner_id')).toBe(true);
    expect(columns.has('dissolved_at')).toBe(true);
    const named = [...commentText.matchAll(/\borganizations\.([a-z_][a-z0-9_]*)/g)].map((m) => m[1]);
    expect(named.length, 'コメントが organizations の列を 1 つも名指ししていない (番兵)').toBeGreaterThan(0);
    expect(named.filter((column) => !columns.has(column))).toEqual([]);
  });

  it('退会で組織の行は消えない: organizations から auth.users への外部キーは owner_id の ON DELETE RESTRICT だけ', () => {
    expect([...foreignKeysTo('auth', 'users', TABLE).entries()]).toEqual([['organizations.owner_id', 'RESTRICT']]);
    const stated = [...commentText.matchAll(/organizations\.owner_id の ON DELETE (CASCADE|RESTRICT|SET NULL)/g)].map((m) => m[1]);
    expect(stated).toEqual(['RESTRICT']);
  });

  it('コメントが挙げる関数・表・API の経路は実在する', () => {
    const allSql = migrations.map(({ sql }) => sql).join('\n');
    for (const fn of ['dissolve_org_by_owner', 'operator_force_dissolve_org', 'org_dissolve_apply', 'operator_mfa_satisfied']) {
      expect(commentText).toContain(fn);
      expect(allSql, fn).toMatch(new RegExp(String.raw`CREATE\s+OR\s+REPLACE\s+FUNCTION\s+(?:"?public"?\.)?"?${fn}"?\s*\(`, 'i'));
    }
    for (const table of ['organization_challenge_aggregates', 'organization_challenge_ranking_exclusions']) {
      expect(commentText).toContain(table);
      expect(allSql, table).toMatch(new RegExp(String.raw`CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?public\.${table}\b`, 'i'));
    }
    for (const route of ['src/app/api/org/dissolve/route.ts', 'src/app/api/admin/organizations/route.ts', 'src/app/api/admin/organizations/[id]/route.ts']) {
      expect(fs.existsSync(path.join(ROOT, route)), route).toBe(true);
    }
    for (const file of ['tests/e2e/helpers/membership.ts', 'tests/e2e/fixtures/fresh-org.ts', 'tests/e2e/fixtures/fresh-user.ts']) {
      expect(commentText).toContain(file);
      expect(fs.existsSync(path.join(ROOT, file)), file).toBe(true);
    }
    // 運営の削除のポリシーの対象のロールは authenticated (20261017130000 の ALTER POLICY)
    expect(allSql).toMatch(/ALTER\s+POLICY\s+organizations_delete_super_admin\s+ON\s+public\.organizations\s+TO\s+authenticated\b/i);
  });
});
