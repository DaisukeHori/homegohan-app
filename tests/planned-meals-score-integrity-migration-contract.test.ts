// @vitest-environment node
/**
 * #2025: planned_meals の 3 列 (is_completed / completed_at / veg_score) をサーバの計算値だけにする migration 2 本 (と戻し口) の
 * contract テスト (DB には接続しない)。設計: docs/design/cross/23-planned-meals-score-integrity.md §7.1〜§7.4
 *
 * 本物の DB での振る舞い (利用者の 3 列の書き込みが 42501・RPC が本人の行だけ・service_role は通る・戻し口) は
 * tests/integration/rls/planned-meals-score-integrity.test.ts が確かめる。ここでは文面だけで崩れやすい所を確かめる。
 *   C-1. migration と戻し口が、2 本とも 1 本ずつ・同じ番号で対。1 行目 (-- migration:) と 2 行目 (-- 戻し方:) と戻し口の 1 行目 (-- rollback:) が自分の番号を指す。
 *        RPC の migration は権限の migration より小さい番号 (先に当てる)
 *   C-2. RPC の migration: 関数 planned_meals_set_completed(uuid, boolean) を 1 本だけ作る (SECURITY DEFINER・search_path 空・RETURNS TABLE の 4 列)。
 *        本文は本人の行 (user_daily_meals.user_id = auth.uid()) だけを UPDATE し、無ければ PLANNED_MEAL_NOT_FOUND (P0002)。
 *        EXECUTE を PUBLIC, anon, authenticated, service_role から外し、authenticated, service_role にだけ付ける。表・ポリシー・権限・行に触れない
 *   C-3. RPC の戻し口は DROP FUNCTION IF EXISTS だけ
 *   C-4. 権限の migration: 文は lock_timeout・REVOKE INSERT, UPDATE (anon, authenticated)・GRANT INSERT (列), UPDATE (列) TO authenticated の 3 つだけ。
 *        列の一覧 (INSERT と UPDATE) は、ベースラインの CREATE TABLE の列から 3 列を除いたものと同じ (並びも)。anon への GRANT・ALL・TRUNCATE は無い。
 *        ポリシー・トリガー・行に触れない
 *   C-5. 権限の戻し口: 列の権限を外し (同じ列の一覧)、表の INSERT, UPDATE を anon, authenticated に付け直す。TRUNCATE / ALL は付けない
 *   C-6. 同じ型の機械検査: 権限の migration より後に planned_meals に列を足す migration は、同じファイルで authenticated へその列の INSERT (列) / UPDATE (列) を GRANT する
 *   C-7. どの migration も planned_meals のポリシーを ALTER POLICY で変えず、RLS を切らず、3 列を authenticated / anon / PUBLIC へ列単位で GRANT しない
 *   C-8. 設計書 (cross/23) が名指す migration と戻し口のファイル名の番号が、2 本とも、すべて置き場のままか、すべて実在する番号 (混ざらない)
 *   C-9. 3 列の名前 (PLANNED_MEALS_SERVER_ONLY_COLUMNS) が、権限の migration が除いた列と同じ
 *   C-10. 組織のチャレンジの集計 (update_org_challenge_progress) は変えない: 2 本の migration と戻し口は、その関数を作り直さず、消さない
 *         (集計の振る舞いは tests/integration/rls/org-challenge-progress.test.ts が今までどおり確かめる)
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PLANNED_MEALS_SERVER_ONLY_COLUMNS, PLANNED_MEALS_SET_COMPLETED_RPC } from '@homegohan/shared';
import { collectMigrationNameMentions, findMigrationNumberProblems } from './helpers/design-doc-migration-number';

const ROOT = path.resolve(__dirname, '..');
const MIGRATIONS_DIR = path.join(ROOT, 'supabase', 'migrations');
const ROLLBACKS_DIR = path.join(ROOT, 'supabase', 'rollbacks');
const DESIGN_DOC_PATH = path.join(ROOT, 'docs', 'design', 'cross', '23-planned-meals-score-integrity.md');
const BASELINE_FILE = '20251126124224_create_meal_planner_tables.sql';
const RPC_MIGRATION_NAME = 'planned_meals_set_completed_rpc';
const PRIVILEGE_MIGRATION_NAME = 'planned_meals_score_columns_server_only';
const TABLE = 'planned_meals';
const FUNCTION_SIGNATURE = `public.${PLANNED_MEALS_SET_COMPLETED_RPC}(uuid, boolean)`;
/** 組織のチャレンジの日次の集計の関数 (本書では変えない。C-10) */
const ORG_CHALLENGE_PROGRESS_FUNCTION = 'update_org_challenge_progress';
/** 利用者から外す 3 列 (packages/shared の正典と同じであることを C-9 が見る) */
const SERVER_ONLY_COLUMNS = ['is_completed', 'completed_at', 'veg_score'] as const;
const VERSION = /^\d{14}$/;

/** `--` から行末までのコメントを除く (この 4 ファイルでは、文字列リテラルの中に `--` は出てこない) */
const stripLineComments = (sql: string): string => sql.replace(/--.*$/gm, '');
/** ドル引用 ($$ ... $$) の中身を除く (関数の本文の中の文を、文として数えない) */
const stripDollarQuoted = (sql: string): string => sql.replace(/(\$[A-Za-z_]*\$)[\s\S]*?\1/g, '$$$$');
/** コメントと関数の本文を除き、空白を 1 つに詰めて、文 (セミコロン区切り) に分ける */
const statements = (sql: string): string[] =>
  stripDollarQuoted(stripLineComments(sql)).replace(/\s+/g, ' ').split(';').map((s) => s.trim()).filter((s) => s.length > 0);

const migrationFiles = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
const readMigration = (file: string): string => fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');

function pairOf(name: string): { migration: string; rollback: string; version: string } {
  // モジュールの読み込み時に走るので expect でなく例外で止める (1 本ずつ・同じ番号の対であることは C-1 でも見る)
  const migrations = migrationFiles.filter((f) => f.endsWith(`_${name}.sql`));
  const rollbacks = fs.readdirSync(ROLLBACKS_DIR).filter((f) => f.endsWith(`_${name}.down.sql`));
  if (migrations.length !== 1) throw new Error(`${name} の migration は 1 本のはず: ${migrations.join(', ')}`);
  if (rollbacks.length !== 1) throw new Error(`${name} の戻し口は 1 本のはず: ${rollbacks.join(', ')}`);
  const version = migrations[0].slice(0, 14);
  if (!VERSION.test(version)) throw new Error(`${name} の版の番号が 14 桁でない: ${migrations[0]}`);
  if (rollbacks[0].slice(0, 14) !== version) throw new Error(`${name} の戻し口の番号が migration と違う: ${rollbacks[0]}`);
  return { migration: migrations[0], rollback: rollbacks[0], version };
}

const rpc = pairOf(RPC_MIGRATION_NAME);
const priv = pairOf(PRIVILEGE_MIGRATION_NAME);
const rpcMigrationRaw = readMigration(rpc.migration);
const rpcRollbackRaw = fs.readFileSync(path.join(ROLLBACKS_DIR, rpc.rollback), 'utf8');
const privMigrationRaw = readMigration(priv.migration);
const privRollbackRaw = fs.readFileSync(path.join(ROLLBACKS_DIR, priv.rollback), 'utf8');

/** ベースラインの CREATE TABLE planned_meals の列 (宣言の順) */
function baselineColumns(): string[] {
  const create = /CREATE TABLE IF NOT EXISTS "public"\."planned_meals" \(([\s\S]*?)\n\);/.exec(readMigration(BASELINE_FILE));
  if (!create) throw new Error('ベースラインの CREATE TABLE planned_meals が見つからない');
  return [...create[1].matchAll(/^\s+"([a-z_0-9]+)" /gm)].map((m) => m[1]);
}
const EXPECTED_WRITABLE_COLUMNS = baselineColumns().filter((c) => !(SERVER_ONLY_COLUMNS as readonly string[]).includes(c));

/** `GRANT|REVOKE INSERT (...), UPDATE (...) ON TABLE public.planned_meals TO|FROM <roles>` を分解する */
function parseColumnPrivilege(statement: string): { verb: string; insert: string[]; update: string[]; roles: string } | null {
  const m = /^(GRANT|REVOKE) INSERT \(([^)]*)\), UPDATE \(([^)]*)\) ON TABLE public\.planned_meals (?:TO|FROM) (.+)$/.exec(statement);
  if (!m) return null;
  const cols = (s: string) => s.split(',').map((c) => c.trim());
  return { verb: m[1], insert: cols(m[2]), update: cols(m[3]), roles: m[4] };
}

describe('#2025 C-1: migration と戻し口の対・見出し・順', () => {
  it('2 本とも 1 行目・2 行目・戻し口の 1 行目が自分の番号を指す', () => {
    for (const [pair, migrationRaw, rollbackRaw] of [
      [rpc, rpcMigrationRaw, rpcRollbackRaw],
      [priv, privMigrationRaw, privRollbackRaw],
    ] as const) {
      const [first, second] = migrationRaw.split('\n');
      expect(first).toBe(`-- migration: ${pair.migration}`);
      expect(second).toBe(`-- 戻し方: supabase/rollbacks/${pair.rollback}`);
      expect(rollbackRaw.split('\n')[0]).toBe(`-- rollback: ${pair.migration}`);
    }
  });

  it('RPC の migration は権限の migration より小さい番号 (先に当てる。段 A → 段 C)', () => {
    expect(rpc.version < priv.version).toBe(true);
  });
});

describe('#2025 C-2・C-3: RPC の migration と戻し口', () => {
  const sql = stripLineComments(rpcMigrationRaw);

  it('関数 planned_meals_set_completed(uuid, boolean) を 1 本だけ作る (SECURITY DEFINER・search_path 空・RETURNS TABLE の 4 列)', () => {
    const creates = [...sql.matchAll(/CREATE OR REPLACE FUNCTION public\.([a-z_]+)\(/g)].map((m) => m[1]);
    expect(creates).toEqual([PLANNED_MEALS_SET_COMPLETED_RPC]);
    expect(sql).toMatch(new RegExp(String.raw`CREATE OR REPLACE FUNCTION public\.${PLANNED_MEALS_SET_COMPLETED_RPC}\(p_meal_id uuid, p_completed boolean\)\s+RETURNS TABLE \(id uuid, is_completed boolean, completed_at timestamptz, updated_at timestamptz\)`));
    const header = sql.slice(0, sql.indexOf('AS $$'));
    expect(header).toMatch(/SECURITY DEFINER/);
    expect(header).toMatch(/SET search_path = ''/);
  });

  it('本文は本人の行 (user_daily_meals.user_id = auth.uid()) だけを UPDATE し、無ければ PLANNED_MEAL_NOT_FOUND (P0002)。completed_at は now() か既存か NULL', () => {
    const body = /AS \$\$([\s\S]*?)\$\$;/.exec(sql)?.[1] ?? '';
    const compact = body.replace(/\s+/g, ' ');
    expect(compact).toContain('v_user_id uuid := auth.uid()');
    expect(compact).toContain('UPDATE public.planned_meals AS pm SET is_completed = p_completed');
    expect(compact).toContain('WHEN NOT p_completed THEN NULL');
    expect(compact).toContain('WHEN pm.is_completed IS TRUE AND pm.completed_at IS NOT NULL THEN pm.completed_at');
    expect(compact).toContain('ELSE now()');
    expect(compact).toContain('WHERE d.id = pm.daily_meal_id AND d.user_id = v_user_id');
    expect(compact).toContain("RAISE EXCEPTION 'PLANNED_MEAL_NOT_FOUND' USING ERRCODE = 'P0002'");
    expect(compact).toContain('RETURNING pm.id, pm.is_completed, pm.completed_at, pm.updated_at');
    // veg_score には触れない
    expect(compact).not.toMatch(/veg_score/);
  });

  it('EXECUTE を PUBLIC, anon, authenticated, service_role から外し、authenticated, service_role にだけ付ける。表・ポリシー・権限・行に触れない', () => {
    const outside = statements(rpcMigrationRaw);
    expect(outside).toContain("SET LOCAL lock_timeout = '10s'");
    expect(outside).toContain(`REVOKE ALL ON FUNCTION ${FUNCTION_SIGNATURE} FROM PUBLIC, anon, authenticated, service_role`);
    expect(outside).toContain(`GRANT EXECUTE ON FUNCTION ${FUNCTION_SIGNATURE} TO authenticated, service_role`);
    expect(outside.filter((s) => /^(GRANT|REVOKE)\b/.test(s))).toHaveLength(2);
    expect(sql).not.toMatch(/\b(CREATE|ALTER|DROP) POLICY\b/);
    expect(sql).not.toMatch(/\bON TABLE\b/);
    // 行に触れる文が関数の外に無い (関数の本文の UPDATE は statements() が除くので数えない。本文の中身は 1 つ前の it が見る)
    expect(outside.filter((s) => /^(INSERT|UPDATE|DELETE|TRUNCATE)\b/i.test(s))).toEqual([]);
  });

  it('C-3: 戻し口は DROP FUNCTION IF EXISTS だけ', () => {
    expect(statements(rpcRollbackRaw)).toEqual([
      "SET LOCAL lock_timeout = '10s'",
      `DROP FUNCTION IF EXISTS ${FUNCTION_SIGNATURE}`,
    ]);
  });
});

describe('#2025 C-4・C-5: 権限の migration と戻し口', () => {
  const migration = statements(privMigrationRaw);
  const rollback = statements(privRollbackRaw);

  it('C-4: 文は lock_timeout・表の INSERT, UPDATE の REVOKE・56 列の GRANT の 3 つだけ', () => {
    expect(migration).toHaveLength(3);
    expect(migration[0]).toBe("SET LOCAL lock_timeout = '10s'");
    expect(migration[1]).toBe('REVOKE INSERT, UPDATE ON TABLE public.planned_meals FROM anon, authenticated');
    const grant = parseColumnPrivilege(migration[2]);
    expect(grant).not.toBeNull();
    expect(grant!.verb).toBe('GRANT');
    expect(grant!.roles).toBe('authenticated');
    expect(grant!.insert).toEqual(EXPECTED_WRITABLE_COLUMNS);
    expect(grant!.update).toEqual(EXPECTED_WRITABLE_COLUMNS);
    expect(EXPECTED_WRITABLE_COLUMNS).toHaveLength(baselineColumns().length - SERVER_ONLY_COLUMNS.length);
  });

  it('C-4: ポリシー・トリガー・行に触れず、ALL / TRUNCATE / anon への GRANT が無い', () => {
    const sql = stripLineComments(privMigrationRaw);
    expect(sql).not.toMatch(/\b(CREATE|ALTER|DROP) (POLICY|TRIGGER)\b/);
    expect(sql).not.toMatch(/\bROW LEVEL SECURITY\b/);
    expect(sql).not.toMatch(/^\s*(INSERT INTO|UPDATE|DELETE FROM|TRUNCATE)\s/m);
    expect(sql).not.toMatch(/\b(ALL|TRUNCATE)\b/);
    expect(migration.filter((s) => /^GRANT\b/.test(s) && /\banon\b/.test(s))).toEqual([]);
  });

  it('C-5: 戻し口は列の権限を外し (同じ列の一覧)、表の INSERT, UPDATE を anon, authenticated に付け直す。TRUNCATE / ALL は無い', () => {
    expect(rollback).toHaveLength(3);
    expect(rollback[0]).toBe("SET LOCAL lock_timeout = '10s'");
    const revoke = parseColumnPrivilege(rollback[1]);
    expect(revoke).not.toBeNull();
    expect(revoke!.verb).toBe('REVOKE');
    expect(revoke!.roles).toBe('authenticated');
    expect(revoke!.insert).toEqual(EXPECTED_WRITABLE_COLUMNS);
    expect(revoke!.update).toEqual(EXPECTED_WRITABLE_COLUMNS);
    expect(rollback[2]).toBe('GRANT INSERT, UPDATE ON TABLE public.planned_meals TO anon, authenticated');
    expect(stripLineComments(privRollbackRaw)).not.toMatch(/\b(ALL|TRUNCATE)\b/);
  });
});

describe('#2025 C-6・C-7: 同じ型の機械検査', () => {
  it('C-6: 権限の migration より後に planned_meals に列を足す migration は、同じファイルで authenticated へその列の INSERT (列) / UPDATE (列) を GRANT する', () => {
    const later = migrationFiles.filter((f) => f > priv.migration);
    const offenders: string[] = [];
    for (const file of later) {
      const sql = stripLineComments(readMigration(file)).replace(/\s+/g, ' ');
      const added = [...sql.matchAll(/ALTER TABLE (?:ONLY )?(?:"?public"?\.)?"?planned_meals"? ADD COLUMN (?:IF NOT EXISTS )?"?([a-z_0-9]+)"?/gi)].map((m) => m[1]);
      for (const col of added) {
        const granted = new RegExp(String.raw`GRANT [^;]*INSERT \([^)]*\b${col}\b[^)]*\)[^;]*UPDATE \([^)]*\b${col}\b[^)]*\) ON TABLE public\.planned_meals TO authenticated`).test(sql);
        if (!granted) offenders.push(`${file}: ${col}`);
      }
    }
    expect(offenders, '列を足したら、同じ migration で authenticated に INSERT (列) / UPDATE (列) を付ける (付けないと利用者はその列を書けない)').toEqual([]);
  });

  it('C-7: どの migration も planned_meals のポリシーを ALTER POLICY で変えず、RLS を切らず、3 列を利用者へ列単位で GRANT しない', () => {
    for (const file of migrationFiles) {
      const sql = stripLineComments(readMigration(file)).replace(/\s+/g, ' ');
      expect(sql, file).not.toMatch(/ALTER POLICY "[^"]+" ON (?:"?public"?\.)?"?planned_meals"?\b/i);
      expect(sql, file).not.toMatch(/ALTER TABLE (?:ONLY )?(?:"?public"?\.)?"?planned_meals"? (?:DISABLE|NO FORCE) ROW LEVEL SECURITY/i);
      for (const col of SERVER_ONLY_COLUMNS) {
        const grantsColumnToUsers = new RegExp(String.raw`GRANT [^;]*\(([^)]*)\)[^;]*ON TABLE (?:"?public"?\.)?"?planned_meals"? TO [^;]*\b(?:anon|authenticated|PUBLIC)\b`, 'gi');
        for (const m of sql.matchAll(grantsColumnToUsers)) {
          expect(m[0].includes(col), `${file}: ${col} を利用者に GRANT している`).toBe(false);
        }
      }
    }
  });
});

describe('#2025 C-8・C-9: 設計書と正典の一致', () => {
  it('C-8: 設計書が名指す 2 本のファイル名の番号は、すべて置き場のままか、すべて実在する番号 (混ざらない)', () => {
    const doc = fs.readFileSync(DESIGN_DOC_PATH, 'utf8');
    for (const [name, pair] of [[RPC_MIGRATION_NAME, rpc], [PRIVILEGE_MIGRATION_NAME, priv]] as const) {
      const mentions = collectMigrationNameMentions(doc, name);
      expect(mentions.length, `${name} の名指し`).toBeGreaterThan(0);
      expect(findMigrationNumberProblems(mentions, pair.version)).toEqual([]);
    }
  });

  it('C-9: packages/shared の 3 列は、権限の migration が除いた列と同じ', () => {
    expect([...PLANNED_MEALS_SERVER_ONLY_COLUMNS].sort()).toEqual([...SERVER_ONLY_COLUMNS].sort());
    const grant = parseColumnPrivilege(statements(privMigrationRaw)[2])!;
    for (const col of PLANNED_MEALS_SERVER_ONLY_COLUMNS) {
      expect(grant.insert).not.toContain(col);
      expect(grant.update).not.toContain(col);
      expect(baselineColumns()).toContain(col);
    }
  });
});

describe('#2025 C-10: 組織のチャレンジの集計は変えない', () => {
  it('C-10: 2 本の migration と戻し口は update_org_challenge_progress を作り直さず、消さない', () => {
    for (const [label, raw] of [
      [rpc.migration, rpcMigrationRaw],
      [rpc.rollback, rpcRollbackRaw],
      [priv.migration, privMigrationRaw],
      [priv.rollback, privRollbackRaw],
    ] as const) {
      expect(stripLineComments(raw), label).not.toContain(ORG_CHALLENGE_PROGRESS_FUNCTION);
    }
  });
});
