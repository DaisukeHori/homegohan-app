/**
 * #1561 pg_cron のジョブを数える見張り (tests/helpers/migration-cron-jobs.ts) の単体テスト (DB には接続しない)
 *
 * 見張りは、設計書 08-cron-batches.md の §3.0・§3.1 の注記のジョブの名前と数を、migration の実物と突き合わせる
 * (tests/log-cleanup-dau-snapshot-contract.test.ts)。直書きしか数えなかったため、#1561 の migration が
 * DECLARE の定数の変数で登録した 2 つのジョブを数え落とし、設計書の「8 つ」と食い違った。
 *   1. 直書き・名前付きの引数・DECLARE の定数の変数のどれで登録しても、名前で数える
 *   2. 名前を解けない書き方 (式・連結・CONSTANT でない変数・名前の無いジョブなど) は、空振りせずに「解けない呼び出し」として返す
 *   3. コメントの中の cron.schedule は数えない
 *   4. いまの supabase/migrations のジョブは、解けない呼び出しが無く、#1561 の 2 つを含む
 */
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { collectMigrationCronJobs, scanCronJobNames, splitCallArguments } from './helpers/migration-cron-jobs';

const MIGRATIONS_DIR = path.resolve(__dirname, '..', 'supabase', 'migrations');
const LABEL = 'sample.sql';

describe('#1561 見張り: 名前で数える書き方', () => {
  it('文字列の直書き (SELECT / PERFORM。引用符の重なりを 1 つに戻す)', () => {
    const sql = [
      "SELECT cron.schedule(",
      "  'calculate-segment-stats',",
      "  '5 * * * *',",
      "  $$ SELECT public.invoke_calculate_segment_stats() $$",
      ");",
      "DO $$ BEGIN PERFORM cron.schedule('it''s-job', '15 18 * * *', 'SELECT public.f(''a, b'');'); END $$;",
    ].join('\n');
    expect(scanCronJobNames(sql, LABEL)).toEqual({ names: ['calculate-segment-stats', "it's-job"], unresolved: [] });
  });

  it('DECLARE の定数の変数で登録したジョブ (#1561 の migration の書き方) を、定数の値で数える', () => {
    const sql = [
      'DO $$',
      'DECLARE',
      "  c_requeue_job      CONSTANT text := 'requeue-stale-meal-image-jobs';",
      "  c_requeue_schedule CONSTANT text := '*/5 * * * *';",
      "  c_requeue_command  CONSTANT text := 'SELECT public.requeue_stale_meal_image_jobs()';",
      "  c_pickup_job       CONSTANT text := 'process-pending-meal-image-jobs';",
      "  c_pickup_schedule  CONSTANT text := '2-59/5 * * * *';",
      "  c_pickup_command   CONSTANT text := 'SELECT public.invoke_process_meal_image_jobs()';",
      'BEGIN',
      '  PERFORM cron.schedule(c_requeue_job, c_requeue_schedule, c_requeue_command);',
      '  PERFORM cron.schedule(C_PICKUP_JOB, c_pickup_schedule, c_pickup_command);',
      'END',
      '$$;',
    ].join('\n');
    expect(scanCronJobNames(sql, LABEL)).toEqual({
      names: ['requeue-stale-meal-image-jobs', 'process-pending-meal-image-jobs'],
      unresolved: [],
    });
  });

  it('名前付きの引数 (job_name := / =>) と、cron.schedule_in_database も数える', () => {
    const sql = [
      "SELECT cron.schedule(schedule := '5 * * * *', command := 'SELECT 1', job_name := 'named-job');",
      "SELECT cron.schedule(job_name => 'arrow-job', schedule => '5 * * * *', command => 'SELECT 1');",
      "SELECT cron.schedule_in_database('other-db-job', '5 * * * *', 'SELECT 1', 'postgres');",
    ].join('\n');
    expect(scanCronJobNames(sql, LABEL)).toEqual({ names: ['named-job', 'arrow-job', 'other-db-job'], unresolved: [] });
  });

  it('囲む DECLARE の節の定数だけを読む (前のブロックの同じ名前の定数の値を取らない)', () => {
    const sql = [
      "DO $$ DECLARE c_job CONSTANT text := 'first-job'; BEGIN PERFORM cron.schedule(c_job, '1 * * * *', 'SELECT 1'); END $$;",
      "DO $$ DECLARE c_job CONSTANT text := 'second-job'; BEGIN PERFORM cron.schedule(c_job, '2 * * * *', 'SELECT 2'); END $$;",
    ].join('\n');
    expect(scanCronJobNames(sql, LABEL)).toEqual({ names: ['first-job', 'second-job'], unresolved: [] });
  });

  it('コメント (-- の行・/* */) の中の cron.schedule は数えない。報告の行番号はコメントを除いても元のファイルと同じ', () => {
    const sql = [
      "-- SELECT cron.schedule('commented-job', '5 * * * *', 'SELECT 1');",
      '/*',
      "  SELECT cron.schedule('block-commented-job', '5 * * * *', 'SELECT 1');",
      '*/',
      "SELECT cron.schedule('real-job' || '-x', '5 * * * *', 'SELECT 1');",
    ].join('\n');
    expect(scanCronJobNames(sql, LABEL)).toEqual({
      names: [],
      unresolved: [expect.stringMatching(/^sample\.sql:5: 名前が文字列の直書きでも定数の変数でもない/)],
    });
  });
});

describe('#1561 見張り: 解けない書き方は空振りせずに返す', () => {
  const cases: Array<{ title: string; sql: string; reason: RegExp }> = [
    {
      title: '連結',
      sql: "SELECT cron.schedule('job-' || 'a', '5 * * * *', 'SELECT 1');",
      reason: /名前が文字列の直書きでも定数の変数でもない/,
    },
    {
      title: '関数の呼び出し',
      sql: "SELECT cron.schedule(format('job-%s', 1), '5 * * * *', 'SELECT 1');",
      reason: /名前が文字列の直書きでも定数の変数でもない/,
    },
    {
      title: 'E の文字列',
      sql: "SELECT cron.schedule(E'job', '5 * * * *', 'SELECT 1');",
      reason: /名前が文字列の直書きでも定数の変数でもない/,
    },
    {
      title: 'CONSTANT でない変数 (あとで代入し直せる)',
      sql: "DO $$ DECLARE v_job text := 'job'; BEGIN PERFORM cron.schedule(v_job, '5 * * * *', 'SELECT 1'); END $$;",
      reason: /文字列の定数 \(CONSTANT\) として無い変数 v_job/,
    },
    {
      title: '囲む DECLARE の節に無い定数',
      sql: "DO $$ BEGIN PERFORM cron.schedule(c_unknown, '5 * * * *', 'SELECT 1'); END $$;",
      reason: /文字列の定数 \(CONSTANT\) として無い変数 c_unknown/,
    },
    {
      title: '同じ名前の定数が 2 つ',
      sql: "DO $$ DECLARE c_job CONSTANT text := 'a'; c_job CONSTANT text := 'b'; BEGIN PERFORM cron.schedule(c_job, '5 * * * *', 'SELECT 1'); END $$;",
      reason: /c_job の定数が 2 つある/,
    },
    {
      title: '名前の無いジョブ (schedule と command の 2 つの引数)',
      sql: "SELECT cron.schedule('5 * * * *', 'SELECT 1');",
      reason: /ジョブの名前の引数が無い/,
    },
    {
      title: '名前付きの引数で job_name が無い',
      sql: "SELECT cron.schedule(schedule := '5 * * * *', command := 'SELECT 1', database := 'postgres');",
      reason: /ジョブの名前の引数が無い/,
    },
    {
      title: 'EXECUTE の文字列の中 (引用符が重なる)',
      sql: "DO $$ BEGIN EXECUTE 'SELECT cron.schedule(''job'', ''5 * * * *'', ''SELECT 1'')'; END $$;",
      reason: /名前が文字列の直書きでも定数の変数でもない/,
    },
    {
      title: '閉じかっこが無い',
      sql: "SELECT cron.schedule('job', '5 * * * *', 'SELECT 1'",
      reason: /閉じかっこ・引用符の終わりが見つからない/,
    },
  ];

  for (const { title, sql, reason } of cases) {
    it(title, () => {
      const result = scanCronJobNames(sql, LABEL);
      expect(result.names).toEqual([]);
      expect(result.unresolved).toEqual([expect.stringMatching(reason)]);
    });
  }
});

describe('#1561 見張り: 引数の分け方', () => {
  it("引用符・ドル引用・かっこの中のカンマで分けない", () => {
    const sql = "('a,b', $tag$ x, ) $tag$, f(1, 2), \"q,\"\"r\")";
    expect(splitCallArguments(sql, 1)).toEqual(["'a,b'", '$tag$ x, ) $tag$', 'f(1, 2)', '"q,""r"']);
  });

  it('閉じていない引用符・ドル引用は null', () => {
    expect(splitCallArguments("('a, b)", 1)).toBeNull();
    expect(splitCallArguments('($$ a, b)', 1)).toBeNull();
  });
});

describe('#1561 見張り: いまの supabase/migrations', () => {
  it('名前を解けない呼び出しが無く、定数の変数で登録した #1561 の 2 つのジョブを含む', () => {
    const { names, unresolved } = collectMigrationCronJobs(MIGRATIONS_DIR);
    expect(unresolved).toEqual([]);
    expect(names).toEqual(
      expect.arrayContaining(['requeue-stale-meal-image-jobs', 'process-pending-meal-image-jobs', 'cleanup-old-app-logs']),
    );
  });
});
