// @vitest-environment node
/**
 * #2025: planned_meals の 3 列 (is_completed / completed_at / veg_score) をサーバの計算値だけにする migration (と戻し口) の
 * contract テスト (DB には接続しない)。設計: docs/design/cross/23-planned-meals-score-integrity.md §7.1〜§7.4・§7.19
 *
 * 本物の DB での振る舞い (RPC が本人の行だけ・service_role は通る・戻し口) は
 * tests/integration/rls/planned-meals-score-integrity.test.ts が確かめる。ここでは文面だけで崩れやすい所を確かめる。
 *
 * 段 A (設計書 §15) の分だけを置く: RPC の migration (planned_meals_set_completed_rpc) と戻し口。
 * 権限の migration (planned_meals_score_columns_server_only) の検査 (C-4〜C-7・C-9) と、C-1・C-8・C-10 の「2 本」への広げは段 C で足す。
 *   C-1. migration と戻し口が 1 本ずつ・同じ番号で対。1 行目 (-- migration:) と 2 行目 (-- 戻し方:) と戻し口の 1 行目 (-- rollback:) が自分の番号を指す
 *   C-2. RPC の migration: 関数 planned_meals_set_completed(uuid, boolean) を 1 本だけ作る (SECURITY DEFINER・search_path 空・RETURNS TABLE の 4 列)。
 *        本文は本人の行 (user_daily_meals.user_id = auth.uid()) だけを UPDATE し、無ければ PLANNED_MEAL_NOT_FOUND (P0002)。
 *        EXECUTE を PUBLIC, anon, authenticated, service_role から外し、authenticated, service_role にだけ付ける。表・ポリシー・権限・行に触れない
 *   C-3. RPC の戻し口は DROP FUNCTION IF EXISTS だけ
 *   C-8. 設計書 (cross/23) が名指す migration と戻し口のファイル名の番号が、すべて置き場のままか、すべて実在する番号 (混ざらない)
 *   C-10. 組織のチャレンジの集計 (update_org_challenge_progress) は変えない: migration と戻し口は、その関数を作り直さず、消さない
 *         (集計の振る舞いは tests/integration/rls/org-challenge-progress.test.ts が今までどおり確かめる)
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PLANNED_MEALS_SET_COMPLETED_RPC } from '@homegohan/shared';
import { collectMigrationNameMentions, findMigrationNumberProblems } from './helpers/design-doc-migration-number';

const ROOT = path.resolve(__dirname, '..');
const MIGRATIONS_DIR = path.join(ROOT, 'supabase', 'migrations');
const ROLLBACKS_DIR = path.join(ROOT, 'supabase', 'rollbacks');
const DESIGN_DOC_PATH = path.join(ROOT, 'docs', 'design', 'cross', '23-planned-meals-score-integrity.md');
const RPC_MIGRATION_NAME = 'planned_meals_set_completed_rpc';
const FUNCTION_SIGNATURE = `public.${PLANNED_MEALS_SET_COMPLETED_RPC}(uuid, boolean)`;
/** 組織のチャレンジの日次の集計の関数 (本書では変えない。C-10) */
const ORG_CHALLENGE_PROGRESS_FUNCTION = 'update_org_challenge_progress';
const VERSION = /^\d{14}$/;

/** `--` から行末までのコメントを除く (このファイルが読む SQL では、文字列リテラルの中に `--` は出てこない) */
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
const rpcMigrationRaw = readMigration(rpc.migration);
const rpcRollbackRaw = fs.readFileSync(path.join(ROLLBACKS_DIR, rpc.rollback), 'utf8');

describe('#2025 C-1: migration と戻し口の対・見出し', () => {
  it('1 行目・2 行目・戻し口の 1 行目が自分の番号を指す', () => {
    const [first, second] = rpcMigrationRaw.split('\n');
    expect(first).toBe(`-- migration: ${rpc.migration}`);
    expect(second).toBe(`-- 戻し方: supabase/rollbacks/${rpc.rollback}`);
    expect(rpcRollbackRaw.split('\n')[0]).toBe(`-- rollback: ${rpc.migration}`);
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

describe('#2025 C-8: 設計書と正典の一致', () => {
  it('C-8: 設計書が名指す RPC の migration と戻し口のファイル名の番号は、すべて置き場のままか、すべて実在する番号 (混ざらない)', () => {
    const doc = fs.readFileSync(DESIGN_DOC_PATH, 'utf8');
    const mentions = collectMigrationNameMentions(doc, RPC_MIGRATION_NAME);
    expect(mentions.length, `${RPC_MIGRATION_NAME} の名指し`).toBeGreaterThan(0);
    expect(findMigrationNumberProblems(mentions, rpc.version)).toEqual([]);
  });
});

describe('#2025 C-10: 組織のチャレンジの集計は変えない', () => {
  it('C-10: RPC の migration と戻し口は update_org_challenge_progress を作り直さず、消さない', () => {
    for (const [label, raw] of [
      [rpc.migration, rpcMigrationRaw],
      [rpc.rollback, rpcRollbackRaw],
    ] as const) {
      expect(stripLineComments(raw), label).not.toContain(ORG_CHALLENGE_PROGRESS_FUNCTION);
    }
  });
});
