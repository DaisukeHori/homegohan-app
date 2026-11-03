// @vitest-environment node
/**
 * #2189 W1-b AI 相談の提案の種類の一覧を 3 か所でそろえる (DB を使わない静的な検査)。
 *
 * 問題 (修正前):
 *   - AI への指示が最も勧めている generate_single_meal (1 食を作る) が、画面の ACTION_LABELS (src/components/AIChatBubble.tsx) に無かった。
 *     提案のカードの見出しに英字の『generate_single_meal』がそのまま出て、成功の文も『✅ アクションを実行しました！』になっていた。
 *     逆に ACTION_LABELS の create_meal は、実行の側 (src/lib/ai/consultation-action-executor.ts) に case が無い古いキーだった
 *   - 記録 (ai_action_logs) の種類の制約 ai_action_logs_action_type_check にも generate_single_meal が無かった。
 *     行を作れず (23514)、自動実行も「実行する」も実行されなかった
 *
 * ここで確かめること:
 *   - R-1 実行の側の種類と ACTION_LABELS の鍵が同じ集合 (足りない・余分が無い)。create_meal が無く、generate_single_meal がある
 *   - R-2 migration を番号順に流したあとの種類の制約が、実行の側の種類を全部含む。修正前の制約 (ベースライン) には
 *         generate_single_meal が無かった (この検査が修正前の形で赤になることの番兵)
 *   - R-3 制約を作り直す migration と戻し口: 見出しと「戻し方」の参照が対になる・新しい一覧 = 前の一覧 + generate_single_meal・
 *         戻し口の一覧 = 前の一覧 (消す種類は無い)・戻し口は NOT VALID で既存の行を確かめない
 *   - R-4 やり直させない種類 (AI_ACTION_TYPES_NOT_RETRYABLE_AFTER_FAILURE) は実行の側にある種類
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AI_ACTION_TYPES_NOT_RETRYABLE_AFTER_FAILURE } from '@/lib/ai/consultation-action-lifecycle';
import {
  AI_ACTION_LOGS_ACTION_TYPE_CHECK,
  AI_ACTION_LOGS_ACTION_TYPE_MIGRATION_NAME,
  MIGRATIONS_DIR,
  actionLabelKeys,
  executorActionTypes,
  latestAiActionLogsActionTypeCheck,
} from './helpers/consultation-action-types';

const ROOT = path.resolve(__dirname, '..');
const ROLLBACKS_DIR = path.join(ROOT, 'supabase', 'rollbacks');
const BASELINE_MIGRATION = '20251126124224_create_meal_planner_tables.sql';
const CHECK_TYPE_LITERAL = /'([a-z_]+)'::text/g;
const SQL_LINE_COMMENT = /--[^\n]*/g;

/** 番兵: 実行の側に必ずある種類 (読み取りが壊れて 0 件になったときに素通りしない) */
const SENTINEL_EXECUTOR_TYPES = ['generate_single_meal', 'generate_day_menu', 'update_profile_preferences'] as const;
/** 修正で足した種類 */
const ADDED_TYPE = 'generate_single_meal';
/** 実行の側に case が無い古い種類 (画面の名前から消した) */
const REMOVED_LABEL = 'create_meal';

function sorted(values: Iterable<string>): string[] {
  return [...values].sort();
}

const migrationFile = fs
  .readdirSync(MIGRATIONS_DIR)
  .filter((name) => name.endsWith(`_${AI_ACTION_LOGS_ACTION_TYPE_MIGRATION_NAME}.sql`));

describe('R-1 実行の側の種類と画面の ACTION_LABELS (#2189 W1-b)', () => {
  it('実行の側の種類を読み取れている (番兵)', () => {
    const types = executorActionTypes();
    for (const sentinel of SENTINEL_EXECUTOR_TYPES) expect(types).toContain(sentinel);
    expect(new Set(types).size).toBe(types.length);
  });

  it('ACTION_LABELS の鍵は実行の側の種類と同じ集合 (generate_single_meal があり、create_meal が無い)', () => {
    const labels = actionLabelKeys();
    expect(new Set(labels).size).toBe(labels.length);
    expect(sorted(labels)).toEqual(sorted(executorActionTypes()));
    expect(labels).toContain(ADDED_TYPE);
    expect(labels).not.toContain(REMOVED_LABEL);
  });
});

describe('R-2 記録の種類の制約 (#2189 W1)', () => {
  it('migration を番号順に流したあとの制約は、実行の側の種類を全部含む', () => {
    const { types } = latestAiActionLogsActionTypeCheck();
    expect(types.length).toBeGreaterThan(0);
    const missing = executorActionTypes().filter((type) => !types.includes(type));
    expect(missing).toEqual([]);
  });

  it('修正前の制約 (ベースライン) には generate_single_meal が無かった (この検査が修正前の形で赤になることの番兵)', () => {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, BASELINE_MIGRATION), 'utf8');
    const start = sql.indexOf(`CONSTRAINT "${AI_ACTION_LOGS_ACTION_TYPE_CHECK}" CHECK`);
    expect(start).toBeGreaterThanOrEqual(0);
    const body = sql.slice(start, sql.indexOf(')))', start));
    const baselineTypes = Array.from(body.matchAll(/'([a-z_]+)'::"text"/g), (m) => m[1]);
    expect(baselineTypes.length).toBeGreaterThan(0);
    expect(baselineTypes).not.toContain(ADDED_TYPE);
    expect(executorActionTypes().filter((type) => !baselineTypes.includes(type))).toEqual([ADDED_TYPE]);
  });
});

describe('R-3 制約を作り直す migration と戻し口 (#2189 W1)', () => {
  it('migration はちょうど 1 本。見出しと「戻し方」が対になり、戻し口が実在して対の migration を指す', () => {
    expect(migrationFile).toHaveLength(1);
    const name = migrationFile[0];
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8');
    const lines = sql.split('\n');
    expect(lines[0]).toBe(`-- migration: ${name}`);
    const rollbackName = name.replace(/\.sql$/, '.down.sql');
    expect(lines[1]).toBe(`-- 戻し方: supabase/rollbacks/${rollbackName}`);
    const rollback = fs.readFileSync(path.join(ROLLBACKS_DIR, rollbackName), 'utf8');
    expect(rollback.split('\n')[0]).toBe(`-- rollback: ${name}`);
  });

  it('新しい一覧 = 前の一覧 + generate_single_meal。戻し口の一覧 = 前の一覧で、NOT VALID (既存の行を確かめない)', () => {
    const baselineSql = fs.readFileSync(path.join(MIGRATIONS_DIR, BASELINE_MIGRATION), 'utf8');
    const start = baselineSql.indexOf(`CONSTRAINT "${AI_ACTION_LOGS_ACTION_TYPE_CHECK}" CHECK`);
    const previous = Array.from(baselineSql.slice(start, baselineSql.indexOf(')))', start)).matchAll(/'([a-z_]+)'::"text"/g), (m) => m[1]);

    const name = migrationFile[0];
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8').replace(SQL_LINE_COMMENT, '');
    const next = Array.from(sql.matchAll(CHECK_TYPE_LITERAL), (m) => m[1]);
    expect(sorted(next)).toEqual(sorted([...previous, ADDED_TYPE]));
    expect(sql).toMatch(/DROP CONSTRAINT IF EXISTS ai_action_logs_action_type_check;/);
    expect(sql).toMatch(/NOT VALID;/);
    expect(sql).toMatch(/VALIDATE CONSTRAINT ai_action_logs_action_type_check;/);

    const rollback = fs
      .readFileSync(path.join(ROLLBACKS_DIR, name.replace(/\.sql$/, '.down.sql')), 'utf8')
      .replace(SQL_LINE_COMMENT, '');
    const restored = Array.from(rollback.matchAll(CHECK_TYPE_LITERAL), (m) => m[1]);
    expect(sorted(restored)).toEqual(sorted(previous));
    expect(rollback).toMatch(/NOT VALID;/);
    expect(rollback).not.toMatch(/VALIDATE CONSTRAINT/);
    // 戻し口は行を消さない・表の権限を付け直さない
    expect(rollback).not.toMatch(/\bDELETE\b|\bGRANT\b/i);
  });
});

describe('R-4 やり直させない種類 (#2189 W1-a)', () => {
  it('どれも実行の側にある種類', () => {
    const types = executorActionTypes();
    for (const type of AI_ACTION_TYPES_NOT_RETRYABLE_AFTER_FAILURE.keys()) expect(types).toContain(type);
  });
});
