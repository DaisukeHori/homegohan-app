/**
 * billing/02 (手動のプラン付与) 段 A: 期限切れの pg_cron のジョブ expire-manual-plan-grants の結合テスト
 * (設計: docs/design/billing/02-manual-plan-grant.md §6.4 の (6)・§13.2 の 48・59)
 *
 *   48. cron.job に expire-manual-plan-grants が 1 行だけあり、時刻・command・所有者が決めたとおり (pg_cron が無い DB では飛ばす)
 *   59. migration の cron. の名前を存在しない名前に差し替えたコピーを流しても失敗しない (to_regclass のガードが効く)。
 *       関数 4 本とプロシージャ 1 本は作られたまま・本物のジョブは変わらない (S20)
 *
 * 先例: tests/integration/security/log-cleanup-and-dau-snapshot.test.ts の H (cron.job が存在しない環境)。
 * SQL は、ローカルスタックの postgres-meta (/pg/query、service_role キーが必要) で流す。本番には接続しない。
 * migration を流すのは、本番 (supabase db push) と同じ postgres ロールで行う (SET LOCAL ROLE postgres)。
 *
 * 実行 (ローカル Supabase: bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local):
 *   npx vitest run --config vitest.integration.config.ts tests/integration/security/billing-manual-grant-cron.test.ts
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!url || !anonKey || !serviceKey) {
  throw new Error(
    'NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY が未設定です。',
  );
}

const REPO_ROOT = path.resolve(__dirname, '../../..');
const STEM = '_billing_manual_plan_grant';
const MIGRATIONS_DIR = path.join(REPO_ROOT, 'supabase/migrations');
const MIGRATION_FILES = fs.readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith(`${STEM}.sql`));
const MIGRATION_SQL = fs.readFileSync(path.join(MIGRATIONS_DIR, MIGRATION_FILES[0] ?? ''), 'utf8');

/** migration が登録するジョブ。時刻は UTC (pg_cron は cron.timezone = GMT で解釈する) */
const JOB = {
  name: 'expire-manual-plan-grants',
  schedule: '11 15 * * *',
  command: 'CALL public.billing_expire_manual_subscriptions();',
  owner: 'postgres',
};

/** migration が作る関数 4 本 (to_regprocedure に渡す名前) とプロシージャ 1 本 */
const FUNCTION_SIGNATURES = [
  'public.billing_grant_manual_subscription(uuid, text, timestamptz)',
  'public.billing_revoke_manual_subscription(uuid)',
  'public.billing_expire_manual_subscription_for_user(uuid)',
  'public.billing_manual_subscription_sync_after_end(uuid, text)',
] as const;
const PROCEDURE_SIGNATURE = 'public.billing_expire_manual_subscriptions()';

/** ローカルスタックの postgres-meta で SQL を流す (テストの確認・migration の実行にだけ使う) */
async function pgQuery<T = Record<string, unknown>>(query: string): Promise<T[]> {
  const res = await fetch(`${url}/pg/query`, {
    method: 'POST',
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
    },
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

/** SQL の文字列リテラルにする (テストが決めた固定の文字列だけを渡す) */
function lit(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

interface JobRow {
  jobid: number;
  jobname: string;
  schedule: string;
  command: string;
  active: boolean;
  username: string;
}

async function hasCronJobTable(): Promise<boolean> {
  const rows = await pgQuery<{ cron_job: string | null }>(`SELECT to_regclass('cron.job')::text AS cron_job;`);
  return rows[0]?.cron_job !== null && rows[0]?.cron_job !== undefined;
}

async function jobsByName(name: string): Promise<JobRow[]> {
  return pgQuery<JobRow>(`
    SELECT jobid, jobname, schedule, command, active, username FROM cron.job
    WHERE jobname = ${lit(name)}
    ORDER BY jobid;
  `);
}

describe('billing/02 §6.4 (6): 期限切れのジョブ expire-manual-plan-grants', () => {
  it('migration を読めている (読み取りが壊れて素通りしない)', () => {
    expect(MIGRATION_FILES).toHaveLength(1);
    expect(MIGRATION_SQL).toContain("'expire-manual-plan-grants'");
  });

  // 48
  it('cron.job has exactly one expire-manual-plan-grants row with schedule 11 15 * * *, command CALL public.billing_expire_manual_subscriptions();, owned by postgres (skipped when cron.job is absent)', async ({ skip }) => {
    if (!(await hasCronJobTable())) skip();
    const rows = await jobsByName(JOB.name);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ schedule: JOB.schedule, command: JOB.command, username: JOB.owner, active: true });
    // command は CALL の 1 文だけ (複数の文だとトランザクションのブロックになり、プロシージャの COMMIT が 2D000 になる)
    expect(rows[0].command.trim().replace(/;$/, '')).not.toContain(';');
  });

  // 59
  it('a copy of the migration with every cron. replaced by a missing name (public.t1797_absent_) runs as postgres without error: the to_regclass guard skips the registration, the 4 functions and the procedure still exist, and the real expire-manual-plan-grants job is unchanged (S20)', async ({ skip }) => {
    if (!(await hasCronJobTable())) skip();
    const before = await jobsByName(JOB.name);
    expect(before).toHaveLength(1);

    // cron.job の持ち主 (supabase_admin) でないと、本物の cron.job は別名にできない。
    // そのため、本物の pg_cron には触れず、migration の cron.job / cron.unschedule / cron.schedule を
    // 存在しない public.t1797_absent_job / _unschedule / _schedule に差し替えたコピーで確かめる。
    const absent = MIGRATION_SQL.replace(/\bcron\./g, 'public.t1797_absent_');
    expect(absent).not.toMatch(/\bcron\./);
    expect(absent).toContain("to_regclass('public.t1797_absent_job')");
    expect(absent).toContain('public.t1797_absent_schedule(');

    // 対照: 存在を確かめずに読めば、同じ流し方でエラーになる (差し替えた名前が本当に存在しないことの確認)
    await expect(asPostgres('DO $t1797$ BEGIN PERFORM 1 FROM public.t1797_absent_job; END $t1797$;')).rejects.toThrow(/t1797_absent_job/);

    // 差し替えたコピーは成功する (migration は CREATE OR REPLACE だけなので、すでに流した後でも通る)
    await asPostgres(absent);

    // 関数 4 本とプロシージャ 1 本は作られている
    for (const signature of FUNCTION_SIGNATURES) {
      const rows = await pgQuery<{ found: string | null }>(`SELECT to_regprocedure(${lit(signature)})::text AS found;`);
      expect(rows[0]?.found, signature).not.toBeNull();
    }
    const procedure = await pgQuery<{ prokind: string }>(
      `SELECT prokind FROM pg_proc WHERE oid = to_regprocedure(${lit(PROCEDURE_SIGNATURE)})::oid;`,
    );
    expect(procedure).toEqual([{ prokind: 'p' }]);

    // 本物のジョブは 1 行のまま・変わらない
    const after = await jobsByName(JOB.name);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ jobid: before[0].jobid, schedule: JOB.schedule, command: JOB.command, username: JOB.owner });
  });
});
