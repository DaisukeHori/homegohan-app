/**
 * #1867 (設計 marketing/01 §24 Q-13) バッジの説明を付く条件に合わせる migration (20261018040000_badges_description_matches_award.sql) の結合テスト
 *
 * 書き方の取り決めと、説明が付く条件と合うことの突き合わせは tests/badges-description-matches-award-contract.test.ts (静的な検査)。
 * ここでは、実 DB の badges の行で次を確かめる。
 *   1. migration を当てた DB では、5 つのバッジの説明が新しい文で、name・condition_json・icon・metric_code・priority は元の行と同じ
 *   2. rollback で 5 つの説明が元の文に戻り、ほかの列は変わらない。もう一度 migration を流すと新しい文に戻る (何度流しても同じ)
 *   3. 5 つ以外のバッジの行は、migration と rollback のどちらでも変わらない
 *
 * 最後に migration をもう一度流し、DB を migration を当てた状態に戻す。
 * SQL は、ローカルスタックの postgres-meta (/pg/query、service_role キーが必要) で流す。本番には接続しない。
 * 実行 (ローカル Supabase: bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local):
 *   npx vitest run --config vitest.integration.config.ts tests/integration/security/badges-description-matches-award.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BADGE_DESCRIPTION_MIGRATION,
  BADGE_DESCRIPTION_ROLLBACK,
  parseDescriptionUpdates,
  readOriginalBadgeRows,
  readRepoFile,
} from '../../helpers/badge-description-migration';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!url || !serviceKey) {
  throw new Error('NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY が未設定です。');
}

const MIGRATION_SQL = readRepoFile(BADGE_DESCRIPTION_MIGRATION);
const ROLLBACK_SQL = readRepoFile(BADGE_DESCRIPTION_ROLLBACK);
const NEW_DESCRIPTIONS = parseDescriptionUpdates(MIGRATION_SQL);
const OLD_DESCRIPTIONS = parseDescriptionUpdates(ROLLBACK_SQL);
const REWRITTEN_CODES = [...NEW_DESCRIPTIONS.keys()];
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
  await asPostgres(MIGRATION_SQL);
});

describe('#1867 バッジの説明の migration (実 DB)', () => {
  it('migration を当てた DB では、5 つの説明が新しい文で、name と condition_json は元の行と同じ', () => {
    expect(REWRITTEN_CODES.length).toBeGreaterThan(0);
    for (const code of REWRITTEN_CODES) {
      const row = before.get(code);
      const original = ORIGINAL_ROWS.get(code);
      expect(row, `${code} の行が DB に無い`).toBeDefined();
      expect(original, `${code} の行が元の migration に無い`).toBeDefined();
      expect(row?.description, code).toBe(NEW_DESCRIPTIONS.get(code));
      expect(row?.name, `${code} の名前は変えない`).toBe(original?.name);
      expect(row?.condition_json, `${code} の条件は変えない`).toEqual(JSON.parse(original?.conditionJson ?? 'null'));
    }
  });

  it('rollback で 5 つの説明が元の文に戻り、ほかの列とほかのバッジの行は変わらない', async () => {
    await asPostgres(ROLLBACK_SQL);
    const afterRollback = await readBadges();

    expect([...afterRollback.keys()]).toEqual([...before.keys()]);
    for (const [code, row] of afterRollback) {
      expect(withoutDescription(row), `${code} の description 以外の列が変わった`).toEqual(withoutDescription(before.get(code)));
      if (NEW_DESCRIPTIONS.has(code)) {
        expect(row.description, code).toBe(OLD_DESCRIPTIONS.get(code));
        expect(row.description, `${code} は元の migration の説明に戻る`).toBe(ORIGINAL_ROWS.get(code)?.description);
      } else {
        expect(row.description, `${code} は書き換えの対象外`).toBe(before.get(code)?.description);
      }
    }
  });

  it('もう一度 migration を流すと新しい文に戻り、2 回流しても同じ (ほかの行は変わらない)', async () => {
    await asPostgres(MIGRATION_SQL);
    await asPostgres(MIGRATION_SQL);
    const reapplied = await readBadges();

    expect(reapplied).toEqual(before);
  });
});
