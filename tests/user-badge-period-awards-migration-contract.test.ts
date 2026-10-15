/**
 * #1528 バッジを取った期間の表 (supabase/migrations/20261015120000_user_badge_period_awards.sql) の、ファイルどうしの突き合わせ (DB 無し)
 *
 * 確かめること:
 *   - 表の主キーが (user_id, badge_id, period_type, period_start) で、Edge Function calculate-segment-stats の upsert の onConflict と同じ
 *     (違うと、確定の回の再試行で同じ期間が 2 行になる・PostgREST が 42P10 で拒否する)
 *   - 権限: RLS を有効にし、authenticated には SELECT だけ (本人の行だけのポリシー)。anon には何も付けない。
 *     利用者が自分で行を足せない (バッジの自己付与の防止。user_badges と同じ考え方 #1215)
 *   - 利用者を消すと行も消える (auth.users への ON DELETE CASCADE)
 *   - GET /api/badges が読む列が、表に実在する
 *   - ロールバックが表を消す
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

  it('GET /api/badges が読む列は、どれも表に実在する', () => {
    const columns = tableColumns();
    const select = /\.from\('user_badge_period_awards'\)\s*\.select\('([^']*)'\)/.exec(badgesRoute)?.[1];
    expect(select).toBeDefined();
    for (const column of (select ?? '').split(',').map((c) => c.trim())) expect(columns, column).toContain(column);
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

  it('ロールバックは表を消す', () => {
    const rollback = stripSqlComments(
      fs.readFileSync(path.join(ROOT, 'supabase/rollbacks/20261015120000_user_badge_period_awards.down.sql'), 'utf8'),
    );
    expect(rollback.trim()).toBe('DROP TABLE IF EXISTS public.user_badge_period_awards;');
  });
});
