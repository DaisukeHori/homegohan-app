/**
 * #1528 バッジを取った期間の表 (supabase/migrations/20261015120000_user_badge_period_awards.sql) の、ファイルどうしの突き合わせ (DB 無し)
 *
 * 確かめること:
 *   - 表の主キーが (user_id, badge_id, period_type, period_start) で、Edge Function calculate-segment-stats の upsert の onConflict と同じ
 *     (違うと、確定の回の再試行で同じ期間が 2 行になる・PostgREST が 42P10 で拒否する)
 *   - 権限: RLS を有効にし、authenticated には SELECT だけ (本人の行だけのポリシー)。anon には何も付けない。
 *     利用者が自分で行を足せない (バッジの自己付与の防止。user_badges と同じ考え方 #1215)
 *   - 利用者を消すと行も消える (auth.users への ON DELETE CASCADE)
 *   - GET /api/badges は、表を行のまま読まず (PostgREST の max_rows 1,000 で黙って打ち切られるため)、関数 get_my_badge_period_award_summaries を呼ぶ
 *   - 関数: 引数なし・SECURITY INVOKER・search_path 固定・本人 (auth.uid()) の行だけ・バッジごとに 1 行 (DISTINCT ON)・回数は窓関数の count・
 *     最新の決め方 (付けた時刻 → 開始日 → 種類の新しい順)・EXECUTE は authenticated だけ。返す列が、型 (database.types.ts) と
 *     route が使う行の型 (packages/shared の BadgePeriodAwardSummaryRow) と食い違わない
 *   - ロールバックが関数と表を消す (関数が先)
 * 実 DB での確認は tests/integration/rls/user-badge-period-awards.test.ts。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const NAME = 'user_badge_period_awards';

function readMigration(): string {
  const dir = path.join(ROOT, 'supabase/migrations');
  const files = fs.readdirSync(dir).filter((f) => new RegExp(`^\\d{14}_${NAME}\\.sql$`).test(f));
  expect(files).toHaveLength(1);
  return fs.readFileSync(path.join(dir, files[0]), 'utf8');
}

/** SQL のコメント (-- から行末) を外す。説明文の中の語に当たらないようにする */
function stripSqlComments(sql: string): string {
  return sql.replace(/--.*$/gm, '');
}

const migration = stripSqlComments(readMigration());
const edgeFunction = fs.readFileSync(path.join(ROOT, 'supabase/functions/calculate-segment-stats/index.ts'), 'utf8');
const badgesRoute = fs.readFileSync(path.join(ROOT, 'src/app/api/badges/route.ts'), 'utf8');
const sharedSource = fs.readFileSync(path.join(ROOT, 'packages/shared/src/badge-period-awards.ts'), 'utf8');
const TYPE_FILES = ['src/types/database.types.ts', 'packages/shared/src/database.types.ts'] as const;
const FUNCTION_NAME = 'get_my_badge_period_award_summaries';

/** CREATE FUNCTION 文 (本文の $$ ... $$ まで) */
function functionStatement(): string {
  const statement = /CREATE OR REPLACE FUNCTION public\.get_my_badge_period_award_summaries\(\)[\s\S]*?\$\$[\s\S]*?\$\$;/.exec(migration)?.[0];
  expect(statement).toBeDefined();
  return statement ?? '';
}

/** RETURNS TABLE の列名の一覧 (書いた順) */
function functionReturnColumns(): string[] {
  const body = /RETURNS TABLE \(([\s\S]*?)\n\)/.exec(functionStatement())?.[1];
  expect(body).toBeDefined();
  return (body ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^[a-z_]+\s/.test(line))
    .map((line) => line.split(/\s+/)[0]);
}

/** CREATE TABLE の列名の一覧 */
function tableColumns(): string[] {
  const body = /CREATE TABLE IF NOT EXISTS public\.user_badge_period_awards \(([\s\S]*?)\n\);/.exec(migration)?.[1];
  expect(body).toBeDefined();
  return (body ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^[a-z_]+\s/.test(line) && !line.startsWith('PRIMARY'))
    .map((line) => line.split(/\s+/)[0]);
}

describe('#1528 user_badge_period_awards の migration', () => {
  it('主キーが (user_id, badge_id, period_type, period_start) で、Edge Function の upsert の onConflict と同じ', () => {
    const pk = /PRIMARY KEY \(([^)]*)\)/.exec(migration)?.[1];
    expect(pk?.split(',').map((c) => c.trim())).toEqual(['user_id', 'badge_id', 'period_type', 'period_start']);
    const upsert = /\.from\('user_badge_period_awards'\)\s*\.upsert\(chunk, \{\s*onConflict: '([^']*)',\s*ignoreDuplicates: true,/.exec(edgeFunction);
    expect(upsert?.[1]).toBe(pk?.split(',').map((c) => c.trim()).join(','));
  });

  it('Edge Function が書く列は、どれも表に実在する', () => {
    const columns = tableColumns();
    const mapped = /const periodAwards = \[\.\.\.awards\.values\(\)\]\.map\(\(award\) => \(\{([\s\S]*?)\}\)\);/.exec(edgeFunction)?.[1];
    expect(mapped).toBeDefined();
    const written = [...(mapped ?? '').matchAll(/^\s*([a-z_]+):/gm)].map((m) => m[1]);
    expect(written.length).toBeGreaterThan(0);
    for (const column of written) expect(columns, column).toContain(column);
  });

  it('GET /api/badges は表を行のまま読まず、関数 get_my_badge_period_award_summaries を引数なしで呼ぶ', () => {
    // 行のまま読むと、期間の行が 1,000 を超えたとき PostgREST の max_rows で黙って打ち切られ、回数が小さく・最新が古く出る
    expect(badgesRoute).not.toMatch(/\.from\(\s*'user_badge_period_awards'\s*\)/);
    expect(badgesRoute).toMatch(/\.rpc\('get_my_badge_period_award_summaries'\)/);
  });

  it('関数は引数なし・SECURITY INVOKER・search_path 固定で、本人 (auth.uid()) の行だけをバッジごとに 1 行にまとめる', () => {
    const statement = functionStatement();
    expect(statement).toMatch(/LANGUAGE sql\s+STABLE\s+SECURITY INVOKER\s+SET search_path = ''/);
    expect(statement).not.toMatch(/SECURITY DEFINER/);
    expect(statement).toMatch(/FROM public\.user_badge_period_awards AS a\s+WHERE a\.user_id = auth\.uid\(\)\s+ORDER BY/);
    expect(statement).toMatch(/SELECT DISTINCT ON \(a\.badge_id\)/);
    // 回数 = 本人のそのバッジの行の数 (主キーで、行の数 = 期間の数)
    expect(statement).toMatch(/\(pg_catalog\.count\(\*\) OVER \(PARTITION BY a\.badge_id\)\)::INTEGER/);
    // 最新 = 付けた時刻 → 期間の開始日 → 期間の種類の新しい順 (並びを必ず 1 つに決める)
    expect(statement).toMatch(/ORDER BY a\.badge_id, a\.awarded_at DESC, a\.period_start DESC, a\.period_type DESC\s*\$\$;/);
  });

  it('関数の EXECUTE は authenticated だけ (anon・PUBLIC・service_role からは外す)', () => {
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION public\.get_my_badge_period_award_summaries\(\) FROM PUBLIC, anon, authenticated, service_role;/,
    );
    const grants = [...migration.matchAll(/GRANT (\w+) ON FUNCTION public\.get_my_badge_period_award_summaries\(\) TO ([a-z_, ]+);/g)].map(
      (m) => [m[1], m[2]],
    );
    expect(grants).toEqual([['EXECUTE', 'authenticated']]);
  });

  it('関数が返す列が、型 (database.types.ts の 2 つ) と、route が使う行の型 (BadgePeriodAwardSummaryRow) と食い違わない', () => {
    const columns = functionReturnColumns();
    expect(columns).toEqual([
      'badge_id',
      'award_count',
      'latest_period_type',
      'latest_period_start',
      'latest_message',
      'latest_awarded_at',
    ]);
    for (const file of TYPE_FILES) {
      const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
      const block = new RegExp(`\\n      ${FUNCTION_NAME}: \\{\\n        Args: never\\n        Returns: \\{\\n([\\s\\S]*?)\\n        \\}\\[\\]\\n      \\}`).exec(source)?.[1];
      expect(block, file).toBeDefined();
      const typed = (block ?? '').split('\n').map((line) => line.trim().split(':')[0]);
      expect([...typed].sort(), file).toEqual([...columns].sort());
    }
    // route が使う列 (BadgePeriodAwardSummaryRow の項目) は、どれも関数が返す
    const rowType = /export interface BadgePeriodAwardSummaryRow \{([\s\S]*?)\n\}/.exec(sharedSource)?.[1];
    expect(rowType).toBeDefined();
    const used = [...(rowType ?? '').matchAll(/^\s*([a-z_]+):/gm)].map((m) => m[1]);
    expect(used.length).toBeGreaterThan(0);
    for (const column of used) expect(columns, column).toContain(column);
  });

  it('RLS を有効にし、authenticated には SELECT だけ (本人の行だけのポリシー)。anon には何も付けない', () => {
    expect(migration).toMatch(/ALTER TABLE public\.user_badge_period_awards ENABLE ROW LEVEL SECURITY;/);
    expect(migration).toMatch(/REVOKE ALL ON public\.user_badge_period_awards FROM PUBLIC, anon, authenticated, service_role;/);
    const grants = [...migration.matchAll(/GRANT ([A-Z, ]+) ON public\.user_badge_period_awards TO ([a-z_]+);/g)].map((m) => [m[2], m[1]]);
    expect(grants).toEqual([
      ['authenticated', 'SELECT'],
      ['service_role', 'SELECT, INSERT, UPDATE, DELETE'],
    ]);
    const policies = [...migration.matchAll(/CREATE POLICY (\w+) ON public\.user_badge_period_awards\s+FOR (\w+)\s+TO (\w+)\s+USING \(([^;]*)\);/g)];
    expect(policies.map((m) => [m[1], m[2], m[3], m[4].trim()])).toEqual([
      ['user_badge_period_awards_select_own', 'SELECT', 'authenticated', 'auth.uid() = user_id'],
    ]);
    expect(migration).not.toMatch(/FOR (INSERT|UPDATE|DELETE|ALL)/);
  });

  it('利用者・バッジのマスターを消すと行も消える (ON DELETE CASCADE)。期間の種類は確定の回のある 3 種類だけ', () => {
    expect(migration).toMatch(/user_id\s+UUID\s+NOT NULL REFERENCES auth\.users \(id\) ON DELETE CASCADE/);
    expect(migration).toMatch(/badge_id\s+UUID\s+NOT NULL REFERENCES public\.badges \(id\) ON DELETE CASCADE/);
    expect(migration).toMatch(/CHECK \(period_type IN \('daily', 'weekly', 'monthly'\)\)/);
  });

  it('既存の user_badges の写しは、期間の入った行だけを、すでにあれば何もしない形で入れる', () => {
    const insert = /INSERT INTO public\.user_badge_period_awards[\s\S]*?;/.exec(migration)?.[0] ?? '';
    expect(insert).toContain("WHERE ub.context_json ->> 'period_type' IN ('daily', 'weekly', 'monthly')");
    expect(insert).toContain("ub.context_json ->> 'period_start' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'");
    expect(insert).toMatch(/ON CONFLICT \(user_id, badge_id, period_type, period_start\) DO NOTHING;$/);
  });

  it('ロールバックは関数と表を消す (関数が先。SQL の関数の本文は表への依存として記録されず、表を先に消すと壊れた関数が残る)', () => {
    const rollback = stripSqlComments(
      fs.readFileSync(path.join(ROOT, 'supabase/rollbacks/20261015120000_user_badge_period_awards.down.sql'), 'utf8'),
    );
    expect(rollback.trim().split(/\n+/)).toEqual([
      'DROP FUNCTION IF EXISTS public.get_my_badge_period_award_summaries();',
      'DROP TABLE IF EXISTS public.user_badge_period_awards;',
    ]);
  });
});
