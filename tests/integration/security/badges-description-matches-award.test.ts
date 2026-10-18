/**
 * #1867 (設計 marketing/01 §24 Q-13) バッジの説明を付く条件に合わせる migration (20261018040000_badges_description_matches_award.sql) と、
 * planner の説明を AI の週の献立の生成でも付くことに合わせた migration (20261018050000_planner_badge_description_weekly_menu.sql) と、
 * planner の説明を AI で複数の日の献立をまとめて作ったとき (1 週間に満たなくても) に付くことに合わせた migration
 * (20261018070000_planner_badge_description_multi_day.sql) の結合テスト
 *
 * 書き方の取り決めと、説明が付く条件と合うことの突き合わせは tests/badges-description-matches-award-contract.test.ts (静的な検査)。
 * ここでは、実 DB の badges の行で次を確かめる。
 *   1. migration を当てた DB では、書き換えた 5 つのバッジの説明がいまの文 (planner は 20261018070000 の文、ほかは 20261018040000 の文) で、
 *      name・condition_json は元の行と同じ
 *   2. 20261018070000 の rollback で planner の説明が 20261018050000 の文に戻り、ほかの列とほかのバッジの行は変わらない。
 *      もう一度流すといまの文に戻り、2 回流しても同じ
 *   3. rollback を新しい順に流すと (20261018070000 → 20261018050000 → 20261018040000)、5 つの説明が元の文に戻り、
 *      ほかの列とほかのバッジの行は変わらない
 *   4. migration を古い順にもう一度流すといまの文に戻り、2 回流しても同じ (ほかの行は変わらない)
 *
 * 最後に migration を古い順にもう一度流し、DB を migration を当てた状態に戻す。
 * 3 つの migration は同じ行 (planner) を書き換えるので、1 つのファイルで順に確かめる (結合テストのファイルが並んで走っても、行の取り合いにならない)。
 * SQL は、ローカルスタックの postgres-meta (/pg/query、service_role キーが必要) で流す。本番には接続しない。
 * 実行 (ローカル Supabase: bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local):
 *   npx vitest run --config vitest.integration.config.ts tests/integration/security/badges-description-matches-award.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BADGE_DESCRIPTION_MIGRATIONS,
  PLANNER_DESCRIPTION_MIGRATION,
  PLANNER_MULTI_DAY_DESCRIPTION_MIGRATION,
  PLANNER_MULTI_DAY_DESCRIPTION_ROLLBACK,
  currentBadgeDescriptions,
  parseDescriptionUpdates,
  readOriginalBadgeRows,
  readRepoFile,
} from '../../helpers/badge-description-migration';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!url || !serviceKey) {
  throw new Error('NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY が未設定です。');
}

/** 説明を書き換える migration を古い順に (いまの DB の状態にする) */
const MIGRATION_SQLS = BADGE_DESCRIPTION_MIGRATIONS.map(({ migration }) => readRepoFile(migration));
/** 戻し口を新しい順に (元の文に戻す) */
const ROLLBACK_SQLS = [...BADGE_DESCRIPTION_MIGRATIONS].reverse().map(({ rollback }) => readRepoFile(rollback));
/** planner のいまの説明を書いた migration (20261018070000) と戻し口 */
const PLANNER_MIGRATION_SQL = readRepoFile(PLANNER_MULTI_DAY_DESCRIPTION_MIGRATION);
const PLANNER_ROLLBACK_SQL = readRepoFile(PLANNER_MULTI_DAY_DESCRIPTION_ROLLBACK);
/** いまの説明 (migration を全部当てたあと) */
const CURRENT_DESCRIPTIONS = currentBadgeDescriptions();
/** 20261018050000 の文 (planner のいまの migration の rollback が戻す先) */
const PREVIOUS_PLANNER_DESCRIPTIONS = parseDescriptionUpdates(readRepoFile(PLANNER_DESCRIPTION_MIGRATION));
const REWRITTEN_CODES = [...CURRENT_DESCRIPTIONS.keys()];
const ORIGINAL_ROWS = readOriginalBadgeRows();

interface BadgeRow {
  code: string;
  name: string;
  description: string | null;
  condition_json: unknown;
  icon: string | null;
  metric_code: string | null;
  priority: number | null;
}

/** ローカルスタックの postgres-meta で SQL を流す (確認と migration の実行にだけ使う) */
async function pgQuery<T = Record<string, unknown>>(query: string): Promise<T[]> {
  const res = await fetch(`${url}/pg/query`, {
    method: 'POST',
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`pg/query ${res.status}: ${JSON.stringify(body)}`);
  return body as T[];
}

/** 本番の migration と同じ postgres ロールで流す (このリクエストの中だけ) */
function asPostgres<T = Record<string, unknown>>(sql: string): Promise<T[]> {
  return pgQuery<T>(`SET LOCAL ROLE postgres;\n${sql}`);
}

/** SQL を順に流す */
async function runInOrder(sqls: readonly string[]): Promise<void> {
  for (const sql of sqls) await asPostgres(sql);
}

/** badges の全行 (code → 行) */
async function readBadges(): Promise<Map<string, BadgeRow>> {
  const rows = await pgQuery<BadgeRow>(
    'SELECT code, name, description, condition_json, icon, metric_code, priority FROM public.badges ORDER BY code;',
  );
  return new Map(rows.map((row) => [row.code, row]));
}

/** description 以外の列 (migration と rollback が触れてはいけないもの) */
function withoutDescription(row: BadgeRow | undefined): Omit<BadgeRow, 'description'> | undefined {
  if (!row) return undefined;
  const { description: _description, ...rest } = row;
  return rest;
}

let before: Map<string, BadgeRow>;

beforeAll(async () => {
  before = await readBadges();
});

afterAll(async () => {
  // 途中で失敗しても、DB を migration を当てた状態に戻す
  await runInOrder(MIGRATION_SQLS);
});

describe('#1867 バッジの説明の migration (実 DB)', () => {
  it('migration を当てた DB では、5 つの説明がいまの文 (planner は 20261018070000 の文) で、name と condition_json は元の行と同じ', () => {
    expect(REWRITTEN_CODES.length).toBeGreaterThan(0);
    expect(CURRENT_DESCRIPTIONS.get('planner')).toBe(parseDescriptionUpdates(PLANNER_MIGRATION_SQL).get('planner'));
    for (const code of REWRITTEN_CODES) {
      const row = before.get(code);
      const original = ORIGINAL_ROWS.get(code);
      expect(row, `${code} の行が DB に無い`).toBeDefined();
      expect(original, `${code} の行が元の migration に無い`).toBeDefined();
      expect(row?.description, code).toBe(CURRENT_DESCRIPTIONS.get(code));
      expect(row?.name, `${code} の名前は変えない`).toBe(original?.name);
      expect(row?.condition_json, `${code} の条件は変えない`).toEqual(JSON.parse(original?.conditionJson ?? 'null'));
    }
  });

  it('20261018070000 の rollback で planner の説明が 20261018050000 の文に戻り、もう一度流すといまの文に戻る (ほかの列・ほかの行は変わらない)', async () => {
    await asPostgres(PLANNER_ROLLBACK_SQL);
    const afterRollback = await readBadges();

    expect([...afterRollback.keys()]).toEqual([...before.keys()]);
    for (const [code, row] of afterRollback) {
      expect(withoutDescription(row), `${code} の description 以外の列が変わった`).toEqual(withoutDescription(before.get(code)));
      if (code === 'planner') {
        expect(row.description).toBe(PREVIOUS_PLANNER_DESCRIPTIONS.get('planner'));
        expect(row.description).not.toBe(before.get(code)?.description);
      } else {
        expect(row.description, `${code} は planner の rollback の対象外`).toBe(before.get(code)?.description);
      }
    }

    await asPostgres(PLANNER_MIGRATION_SQL);
    await asPostgres(PLANNER_MIGRATION_SQL);
    expect(await readBadges()).toEqual(before);
  });

  it('rollback を新しい順に流すと 5 つの説明が元の文に戻り、ほかの列とほかのバッジの行は変わらない', async () => {
    await runInOrder(ROLLBACK_SQLS);
    const afterRollback = await readBadges();

    expect([...afterRollback.keys()]).toEqual([...before.keys()]);
    for (const [code, row] of afterRollback) {
      expect(withoutDescription(row), `${code} の description 以外の列が変わった`).toEqual(withoutDescription(before.get(code)));
      if (CURRENT_DESCRIPTIONS.has(code)) {
        expect(row.description, `${code} は元の migration の説明に戻る`).toBe(ORIGINAL_ROWS.get(code)?.description);
      } else {
        expect(row.description, `${code} は書き換えの対象外`).toBe(before.get(code)?.description);
      }
    }
  });

  it('migration を古い順にもう一度流すといまの文に戻り、2 回流しても同じ (ほかの行は変わらない)', async () => {
    await runInOrder(MIGRATION_SQLS);
    await runInOrder(MIGRATION_SQLS);
    const reapplied = await readBadges();

    expect(reapplied).toEqual(before);
  });
});
