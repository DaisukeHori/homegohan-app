/**
 * #1912 (C36): family_invites への利用者 (anon / authenticated) からの直接の書き込みを外した migration
 * (supabase/migrations/20261022150000_family_invites_rpc_only_writes.sql) を、ファイルの読み取りで確かめる (DB には接続しない)。
 *
 *   1. migration を version 順にすべて流したときの family_invites のポリシーは SELECT の family_invites_select_adult だけで、
 *      anon / authenticated の書き込みの権限 (INSERT・UPDATE・DELETE・TRUNCATE) は無い。authenticated の SELECT は残る
 *      (後の migration が書き込みのポリシーや権限を足し直したら、ここで赤くなる)
 *   2. 本冊の migration が、2 つの書き込みのポリシーを外し、4 つの書き込みの権限を anon / authenticated から外す
 *   3. 戻し口が実在し、ポリシーはベースラインの行と逐語で同じに作り直し、流すと本冊の直前の状態 (ポリシーと権限) に戻る
 *   4. アプリのコード (Web・モバイル・Edge Function・共有のライブラリ) は family_invites に直接書かない (作成・取り消しは RPC)
 * 実際の挙動は tests/integration/rls/family-invites-rpc-only-writes.test.ts (実 DB) が確かめる。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { rel, ROOT, stripComments } from './helpers/ai-reach';

const MIGRATIONS_DIR = path.join(ROOT, 'supabase', 'migrations');
const MIGRATION = '20261022150000_family_invites_rpc_only_writes';
const MIGRATION_FILE = `${MIGRATION}.sql`;
const ROLLBACK_PATH = path.join(ROOT, 'supabase', 'rollbacks', `${MIGRATION}.down.sql`);
/** 本番のベースライン (書き込みのポリシーと権限を最初に作ったファイル) */
const BASELINE_FILE = '20251126124224_create_meal_planner_tables.sql';

const TABLE = 'family_invites';
/** 利用者のロール (このロールの書き込みを閉じる) */
const USER_ROLES = ['anon', 'authenticated'] as const;
/** 閉じる書き込みの権限 */
const WRITE_PRIVILEGES = ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'] as const;
/** 外す書き込みのポリシー */
const WRITE_POLICIES = ['family_invites_insert_adult', 'family_invites_update_adult'] as const;
/** 残す読み取りのポリシー (招待の一覧の画面が読む) */
const READ_POLICY = 'family_invites_select_adult';
/** GRANT ALL / REVOKE ALL が表す表の権限 (PostgreSQL 17 の表の権限の全部) */
const ALL_TABLE_PRIVILEGES = ['INSERT', 'SELECT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'] as const;

/** SQL の行コメント (-- ...) を取り除く (コメントの中の語に反応しないため) */
const stripLineComments = (sql: string): string => sql.replace(/--.*$/gm, '');

const migrations = fs
  .readdirSync(MIGRATIONS_DIR)
  .filter((file) => file.endsWith('.sql'))
  .sort()
  .map((file) => ({ file, sql: stripLineComments(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8')) }));

const TABLE_REF = String.raw`(?:"?public"?\.)?"?${TABLE}"?(?=[\s;])`;
const POLICY_NAME = String.raw`(?:"([^"]+)"|([A-Za-z_][\w]*))`;

interface TableState {
  /** ポリシーの名前 → コマンド (ALL / SELECT / INSERT / UPDATE / DELETE) */
  policies: Map<string, string>;
  /** ロール → 表の権限 */
  grants: Map<string, Set<string>>;
}

const emptyState = (): TableState => ({ policies: new Map(), grants: new Map() });

/** SQL の中の、表 family_invites のポリシーと権限の文を、書かれた順に state へ流す */
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

describe('#1912 migration を全部流した後の family_invites のポリシーと権限', () => {
  const finalState = stateAfter(migrations);

  it('ポリシーは SELECT の family_invites_select_adult だけ (書き込みのポリシーが無い)', () => {
    expect(sortedPolicies(finalState)).toEqual([[READ_POLICY, 'SELECT']]);
  });

  it('anon / authenticated は書き込みの権限を持たない。authenticated の SELECT は残る', () => {
    for (const role of USER_ROLES) {
      for (const privilege of WRITE_PRIVILEGES) {
        expect(finalState.grants.get(role)?.has(privilege) ?? false, `${role} ${privilege}`).toBe(false);
      }
    }
    expect(finalState.grants.get('authenticated')?.has('SELECT')).toBe(true);
  });

  it('番兵: 読み取りが本番のベースラインの書き込みのポリシーと権限を拾っている (本冊の直前の状態)', () => {
    const before = stateAfter(migrations.slice(0, migrationIndex));
    expect(sortedPolicies(before)).toEqual(
      [[READ_POLICY, 'SELECT'], [WRITE_POLICIES[0], 'INSERT'], [WRITE_POLICIES[1], 'UPDATE']].sort(([a], [b]) => a.localeCompare(b)),
    );
    for (const role of USER_ROLES) {
      for (const privilege of WRITE_PRIVILEGES) {
        expect(before.grants.get(role)?.has(privilege), `${role} ${privilege}`).toBe(true);
      }
    }
  });
});

describe('#1912 本冊の migration', () => {
  it('実在し、2 つの書き込みのポリシーを外し、4 つの書き込みの権限を anon / authenticated から外す', () => {
    expect(migrationIndex, `${MIGRATION_FILE} が supabase/migrations に無い`).toBeGreaterThanOrEqual(0);
    const own = applySql(stateAfter(migrations.slice(0, migrationIndex)), migrationSql);
    expect(sortedPolicies(own)).toEqual([[READ_POLICY, 'SELECT']]);
    for (const role of USER_ROLES) {
      for (const privilege of WRITE_PRIVILEGES) {
        expect(own.grants.get(role)?.has(privilege) ?? false, `${role} ${privilege}`).toBe(false);
      }
    }
  });

  it('読み取りの権限・ポリシーと service_role の権限には触れない', () => {
    expect(migrationSql).not.toMatch(/\bSELECT\b[^;]*\bON\s+(?:TABLE\s+)?(?:public\.)?family_invites\b/i);
    expect(migrationSql).not.toMatch(new RegExp(READ_POLICY));
    expect(migrationSql).not.toMatch(/service_role/);
  });
});

describe('#1912 戻し口', () => {
  const rollbackRaw = fs.existsSync(ROLLBACK_PATH) ? fs.readFileSync(ROLLBACK_PATH, 'utf-8') : '';

  it('実在し、1 行目が戻す migration の名前', () => {
    expect(fs.existsSync(ROLLBACK_PATH), ROLLBACK_PATH).toBe(true);
    expect(rollbackRaw.split('\n', 1)[0]).toBe(`-- rollback: ${MIGRATION_FILE}`);
  });

  it('書き込みのポリシーを、ベースラインの行と逐語で同じに作り直す', () => {
    const baselineLines = fs.readFileSync(path.join(MIGRATIONS_DIR, BASELINE_FILE), 'utf-8').split('\n');
    const rollbackLines = new Set(rollbackRaw.split('\n'));
    for (const policy of WRITE_POLICIES) {
      const created = baselineLines.filter((line) => line.startsWith(`CREATE POLICY "${policy}" ON "public"."${TABLE}"`));
      expect(created, `${BASELINE_FILE} の ${policy}`).toHaveLength(1);
      expect(rollbackLines.has(created[0]), policy).toBe(true);
    }
  });

  it('流すと、本冊の直前のポリシーと権限に戻る', () => {
    const before = stateAfter(migrations.slice(0, migrationIndex));
    const restored = stateAfter(migrations.slice(0, migrationIndex + 1), [stripLineComments(rollbackRaw)]);
    expect(sortedPolicies(restored)).toEqual(sortedPolicies(before));
    for (const role of USER_ROLES) {
      expect(sortedGrants(restored, role), role).toEqual(sortedGrants(before, role));
    }
  });
});

describe('#1912 アプリのコードは family_invites に直接書かない', () => {
  /** 利用者のセッション・service role のどちらで動くかに依らず、アプリのコードが family_invites に書く箇所 (いまは無い)。
   *  service role で書く箇所を足すときは、利用者の確認と門 (家族プラン・人数・24 時間の上限) を通ることを確かめてから、ここに足す */
  const ALLOWED_WRITERS: readonly string[] = [];
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

  it('.from(\'family_invites\') の insert / update / upsert / delete と、REST の /rest/v1/family_invites が無い', () => {
    const writes = mentioning.filter((file) => {
      const text = textOf(file);
      return (
        new RegExp(String.raw`\.from\(\s*['"\`]${TABLE}['"\`]\s*\)\s*\.(insert|update|upsert|delete)\(`).test(text) ||
        text.includes(`rest/v1/${TABLE}`)
      );
    });
    expect(writes).toEqual([...ALLOWED_WRITERS]);
  });

  it('番兵: 走査はアプリのコードの読み取り (招待の一覧の GET /api/family/invites の SELECT) を拾っている', () => {
    const reads = mentioning.filter((file) =>
      new RegExp(String.raw`\.from\(\s*['"\`]${TABLE}['"\`]\s*\)\s*\.select\(`).test(textOf(file)),
    );
    expect(reads).toContain('src/app/api/family/invites/route.ts');
  });
});
