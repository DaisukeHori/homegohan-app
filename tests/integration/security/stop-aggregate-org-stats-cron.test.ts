/**
 * #1325 組織統計の集計 (Edge Function aggregate-org-stats) の定期実行 (pg_cron) を止める migration の回帰テスト
 *
 * オーナー判断 (2026-10-08): 組織の統計は「止める」。夜間バッチは作らず、画面には「準備中」を出す。
 * 本番に aggregate-org-stats を呼ぶ pg_cron のジョブが残っているかどうかは、リポジトリからは分からない
 * (ジョブの定義は migration に無く、ダッシュボードや SQL エディタで作られた可能性がある)。
 * そこで migration 20261008130000_stop_aggregate_org_stats_cron.sql が、cron.job の中から
 * 「command に aggregate-org-stats を含むジョブ」を探して unschedule する。ジョブが無ければ何もしない。
 *
 * 確認すること:
 *   A. ファイル: migration と rollback が同じ version / 名前で対になっていて、rollback は実行文を含まない (コメントだけ)
 *   B. migration を流すと、command に aggregate-org-stats を含むジョブ (名前付き・名前なし) が消え、
 *      無関係なジョブ (似た名前の別の関数を呼ぶジョブを含む) は残る
 *   C. もう一度流しても同じ結果になる (冪等)。マッチするジョブが 1 つも無くても失敗しない
 *   D. cron.job が存在しない環境 (pg_cron が無い DB) では、何もせず成功する
 *      (本物の pg_cron には触れず、migration の cron. を存在しない名前に差し替えたコピーを流して確かめる)
 *
 * migration を流すのは、本番 (supabase db push) と同じ postgres ロールで行う (SET LOCAL ROLE postgres)。
 * postgres は cron.job の RLS (username = current_user) を BYPASSRLS で通り抜けるため、
 * 別のロールが作ったジョブも見える。ここではそのうえで、postgres が作ったジョブを使う。
 * テスト用のジョブは、1 月 1 日にしか動かない予定にして、command も SELECT 1 だけにする
 * (テスト中に pg_cron が実行しても何も起きない)。作ったジョブは必ず消す。
 *
 * SQL は、ローカルスタックの postgres-meta (/pg/query、service_role キーが必要) で流す。
 * 複数の文を 1 回の要求で流すと 1 つのトランザクションになり、SET LOCAL は次の要求に残らない。
 * 本番には接続しない。
 *
 * 実行 (ローカル Supabase: bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local):
 *   npx vitest run --config vitest.integration.config.ts tests/integration/security/stop-aggregate-org-stats-cron.test.ts
 */

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!url || !serviceKey) {
  throw new Error('NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY が未設定です。');
}

const REPO_ROOT = path.resolve(__dirname, '../../..');
const VERSION = '20261008130000';
const NAME = 'stop_aggregate_org_stats_cron';
const MIGRATION_FILE = `supabase/migrations/${VERSION}_${NAME}.sql`;
const ROLLBACK_FILE = `supabase/rollbacks/${VERSION}_${NAME}.down.sql`;
const MIGRATION_SQL = fs.readFileSync(path.join(REPO_ROOT, MIGRATION_FILE), 'utf8');

/** ローカルスタックの postgres-meta で SQL を流す (テスト用のジョブの作成・確認・migration の実行にだけ使う) */
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
function asPostgres(sql: string): Promise<Record<string, unknown>[]> {
  return pgQuery(`SET LOCAL ROLE postgres;\n${sql}`);
}

/** SQL の文字列リテラルにする (テストが決めた固定の文字列だけを渡す) */
function lit(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

// ---------------------------------------------------------------
// A. ファイル
// ---------------------------------------------------------------
describe('#1325 A. migration と rollback のファイル', () => {
  it('rollback が同じ version / 名前で対になっていて、実行文を含まない (コメントだけ)', () => {
    const rollbackPath = path.join(REPO_ROOT, ROLLBACK_FILE);
    expect(fs.existsSync(rollbackPath), `${ROLLBACK_FILE} が無い`).toBe(true);

    const rollback = fs.readFileSync(rollbackPath, 'utf8');
    const statements = rollback
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('--'));
    // 消したジョブの定義は分からないので、自動では戻せない (戻すには新しいオーナー判断と新しい migration が要る)
    expect(statements, 'rollback はコメントだけ (実行文を置かない)').toEqual([]);
  });

  it('migration は cron.job の存在を確かめてから触り、command だけでジョブを選ぶ', () => {
    // 実際の動きは B〜D で確かめる。ここは、書き方の取り決めを固定する
    expect(MIGRATION_SQL).toContain("to_regclass('cron.job')");
    expect(MIGRATION_SQL).toMatch(/cron\.unschedule\(/);
    expect(MIGRATION_SQL).toMatch(/command\s+ILIKE\s+'%aggregate-org-stats%'/);
    // command には認証の秘密が入っていることがある。実行ログ (RAISE) に載せない。
    // RAISE は複数行にまたがることがあるので、コメント行を除いたうえで、RAISE から ; までを 1 文として見る
    const code = MIGRATION_SQL.split('\n')
      .filter((line) => !line.trim().startsWith('--'))
      .join('\n');
    const raises = code.match(/\bRAISE\b[^;]*;/gi) ?? [];
    expect(raises.length, 'RAISE の検査が空振りしていないこと').toBeGreaterThan(0);
    for (const statement of raises) {
      expect(statement, 'RAISE に command を渡さない (秘密が実行ログに残る)').not.toMatch(/\bcommand\b/i);
    }
  });
});

// ---------------------------------------------------------------
// B / C. ジョブの停止
// ---------------------------------------------------------------
const RUN = randomBytes(4).toString('hex');
const MARK = `T08-TEST-${RUN}`;
/** 1 月 1 日 00:00 にだけ動く予定 (テストの間に動くことはない) */
const NEVER_SOON = '0 0 1 1 *';

interface JobRow {
  jobid: number | string;
  jobname: string | null;
  command: string;
  username: string;
}

const jobIds: Record<'named' | 'unnamed' | 'unrelated' | 'similar', number> = {
  named: 0,
  unnamed: 0,
  unrelated: 0,
  similar: 0,
};

async function schedule(name: string | null, command: string): Promise<number> {
  const call = name
    ? `cron.schedule(${lit(name)}, ${lit(NEVER_SOON)}, ${lit(command)})`
    : `cron.schedule(${lit(NEVER_SOON)}, ${lit(command)})`;
  const rows = await asPostgres(`SELECT ${call} AS jobid;`);
  return Number(rows[0].jobid);
}

/** このテストが作ったジョブ (名前か command の印で判別) をすべて消す。前回の異常終了の残りも片付ける */
async function removeTestJobs(): Promise<void> {
  await asPostgres(`
    SELECT cron.unschedule(jobid)
    FROM cron.job
    WHERE jobname LIKE 't08-test-%' OR command LIKE '%T08-TEST-%';
  `);
}

async function remainingJobIds(): Promise<number[]> {
  const rows = await asPostgres(`
    SELECT jobid FROM cron.job
    WHERE jobname LIKE 't08-test-%' OR command LIKE '%T08-TEST-%'
    ORDER BY jobid;
  `);
  return rows.map((r) => Number(r.jobid));
}

beforeAll(async () => {
  const rows = await pgQuery<{ cron_job: string | null }>(`SELECT to_regclass('cron.job')::text AS cron_job;`);
  if (!rows[0]?.cron_job) {
    throw new Error('cron.job がありません。ローカル DB に pg_cron が入っていません (ベースラインの拡張を確認してください)。');
  }

  await removeTestJobs();

  // 本番にありそうな形: Edge Function の URL を net.http_post で呼ぶジョブ (名前付き / 名前なし)
  // 実際には実行されないよう、command は SELECT 1 にし、呼び先の URL はコメントの中に書く
  jobIds.named = await schedule(
    `t08-test-${RUN}-nightly`,
    `SELECT 1 /* ${MARK} net.http_post(url := 'https://example.invalid/functions/v1/aggregate-org-stats') */`,
  );
  jobIds.unnamed = await schedule(
    null,
    `SELECT 1 /* ${MARK} headers := jsonb_build_object('Authorization', 'Bearer x'), url := 'https://example.invalid/functions/v1/aggregate-org-stats' */`,
  );
  // 残るべきジョブ: 無関係なジョブと、似た名前の別の関数を呼ぶジョブ
  jobIds.unrelated = await schedule(`t08-test-${RUN}-unrelated`, `SELECT 1 /* ${MARK} unrelated */`);
  jobIds.similar = await schedule(
    `t08-test-${RUN}-similar`,
    `SELECT 1 /* ${MARK} calculate-segment-stats aggregate-user-stats aggregate-org */`,
  );
}, 30_000);

afterAll(async () => {
  await removeTestJobs();
  expect(await remainingJobIds(), 'テスト用のジョブを消し切れていない').toEqual([]);
}, 30_000);

describe('#1325 B. migration は aggregate-org-stats を呼ぶジョブだけを止める', () => {
  it('流す前は、4 つのジョブがすべて登録されている (テストの前提)', async () => {
    const rows = await asPostgres(`
      SELECT jobid, jobname, command, username FROM cron.job
      WHERE jobname LIKE 't08-test-%' OR command LIKE '%T08-TEST-%'
      ORDER BY jobid;
    `);
    const ids = (rows as unknown as JobRow[]).map((r) => Number(r.jobid));
    expect(ids).toEqual(Object.values(jobIds).sort((a, b) => a - b));
    // 本番のジョブと同じく postgres が作ったもの
    expect((rows as unknown as JobRow[]).every((r) => r.username === 'postgres')).toBe(true);
    // 名前なしのジョブがある (cron.schedule の 2 引数版)
    expect((rows as unknown as JobRow[]).find((r) => Number(r.jobid) === jobIds.unnamed)?.jobname).toBeNull();
  });

  it('migration を流すと、command に aggregate-org-stats を含むジョブ (名前付き・名前なし) が消え、ほかは残る', async () => {
    await asPostgres(MIGRATION_SQL);

    const remaining = await remainingJobIds();
    expect(remaining, 'aggregate-org-stats を呼ぶジョブが残っている').not.toContain(jobIds.named);
    expect(remaining, 'aggregate-org-stats を呼ぶ名前なしのジョブが残っている').not.toContain(jobIds.unnamed);
    expect(remaining, '無関係なジョブまで消えた').toContain(jobIds.unrelated);
    expect(remaining, '似た名前の別の関数を呼ぶジョブまで消えた').toContain(jobIds.similar);
    expect(remaining).toEqual([jobIds.unrelated, jobIds.similar].sort((a, b) => a - b));
  });

  it('cron.job に、aggregate-org-stats を command に含むジョブが 1 つも無い (テスト用以外も含めて)', async () => {
    const rows = await asPostgres(`
      SELECT jobid FROM cron.job WHERE command ILIKE '%aggregate-org-stats%';
    `);
    expect(rows).toEqual([]);
  });
});

describe('#1325 C. 何度流しても同じ結果になる (冪等)', () => {
  it('マッチするジョブが無い状態でもう一度流しても失敗せず、無関係なジョブはそのまま残る', async () => {
    await asPostgres(MIGRATION_SQL);
    await asPostgres(MIGRATION_SQL);

    expect(await remainingJobIds()).toEqual([jobIds.unrelated, jobIds.similar].sort((a, b) => a - b));
  });
});

// ---------------------------------------------------------------
// D. cron.job が無い環境
// ---------------------------------------------------------------
describe('#1325 D. cron.job が存在しない環境では何もせず成功する', () => {
  it('cron. の名前を存在しない名前に差し替えたコピーを流しても失敗しない (ガードより前に cron の名前を評価しない)', async () => {
    // cron.job の持ち主 (supabase_admin) でないと、本物の cron.job は別名にできない。
    // そのため、本物の pg_cron には触れず、migration の cron.job / cron.unschedule を
    // 存在しない public.t08_absent_job / public.t08_absent_unschedule に差し替えたコピーで確かめる。
    const absent = MIGRATION_SQL.replace(/\bcron\./g, 'public.t08_absent_');
    expect(absent).not.toMatch(/\bcron\./);
    expect(absent).toContain("to_regclass('public.t08_absent_job')");

    // 対照: 存在を確かめずに読めば、同じ流し方でエラーになる (差し替えた名前が本当に存在しないことの確認)
    await expect(asPostgres('DO $t08$ BEGIN PERFORM 1 FROM public.t08_absent_job; END $t08$;')).rejects.toThrow(
      /t08_absent_job/,
    );

    // 差し替えたコピーは成功する (何もしない)
    await asPostgres(absent);
  });

  it('流したあとも、本物の cron.job は無傷で、テスト用のジョブも残っている', async () => {
    const rows = await pgQuery<{ cron_job: string | null }>(`SELECT to_regclass('cron.job')::text AS cron_job;`);
    expect(rows[0].cron_job).toBe('cron.job');
    expect(await remainingJobIds()).toEqual([jobIds.unrelated, jobIds.similar].sort((a, b) => a - b));
  });
});
