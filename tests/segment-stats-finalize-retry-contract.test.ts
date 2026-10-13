// @vitest-environment node
//
// #1500: 比較ランキングの確定の回 (JST 0:05) の再試行と、お試しの記録を数えない total_meals の、ファイルどうしの突き合わせ (DB 無し)
//
// migration 20261011120000_segment_stats_finalize_retry.sql は次を足す:
//   - public.count_meals_per_user() の作り直し (meals.is_sandbox = false の行だけを数える)
//   - 表 public.segment_stats_finalized_periods (確定の回をやり終えた期間)
//   - public.calculate_segment_stats_finalize_retry_bodies(p_at) / public.invoke_calculate_segment_stats_finalize_retry()
//   - pg_cron のジョブ calculate-segment-stats-finalize-retry (JST 0:20・0:35)
// 実 DB での動き (ジョブの登録・時刻ごとの本文・権限・表) は tests/integration/security/segment-stats-finalize-retry.test.ts、
// お試しの記録を数えないことは tests/integration/security/count-meals-per-user.test.ts と
// tests/integration/rls/stats-edge-functions-user-daily-meals.test.ts が確かめる。
// ここでは、再試行の時刻・呼び方が確定の回 (20261009100000_schedule_calculate_segment_stats.sql) と食い違っていないことを見る:
//   - 再試行は確定の回と同じ JST 0 時台 (UTC 15 時台) にあり、どれも確定の回の窓 (c_finalize_window) の中
//   - 再試行どうし・確定の回との間隔は、呼び出しの待ち時間の上限 (c_timeout_ms = Edge Function の実行時間の上限) より長い
//   - 呼び先・待ち時間の上限・秘密の読み方・要求の組み立ては、確定の回の関数と同じ
//   - rollback は足したものを外し、count_meals_per_user を 20261011060000 の定義に戻す

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const read = (file: string) => fs.readFileSync(path.join(ROOT, file), 'utf8');

const VERSION = '20261011120000';
const MIGRATION = read(`supabase/migrations/${VERSION}_segment_stats_finalize_retry.sql`);
const ROLLBACK = read(`supabase/rollbacks/${VERSION}_segment_stats_finalize_retry.down.sql`);
/** 確定の回 (毎時 5 分のジョブ calculate-segment-stats) を足した migration */
const SCHEDULE_MIGRATION = read('supabase/migrations/20261009100000_schedule_calculate_segment_stats.sql');
/** count_meals_per_user を最初に足した migration (rollback が戻す先) */
const COUNT_MEALS_MIGRATION = read('supabase/migrations/20261011060000_count_meals_per_user.sql');
const EDGE_FUNCTION = read('supabase/functions/calculate-segment-stats/index.ts');

const RETRY_JOB_NAME = 'calculate-segment-stats-finalize-retry';
const RETRY_FUNCTION = 'public.invoke_calculate_segment_stats_finalize_retry()';
const RETRY_BODIES_FUNCTION = 'public.calculate_segment_stats_finalize_retry_bodies(timestamptz)';
const FINALIZED_TABLE = 'segment_stats_finalized_periods';

/** JST は UTC+9 (日本に夏時間は無い) */
const JST_OFFSET_HOURS = 9;
const HOURS_PER_DAY = 24;
const MINUTES_PER_HOUR = 60;
const SECONDS_PER_MINUTE = 60;
const MS_PER_SECOND = 1000;
/** 日・週・月の期間が切り替わる JST の時 (0 時) */
const PERIOD_BOUNDARY_HOUR_JST = 0;
/** 窓の中で再試行する回数 (仕様: 2 回まで) */
const EXPECTED_RETRY_COUNT = 2;

/** SQL のコメント行 (-- で始まる行) を除く */
function sqlCode(sql: string): string {
  return sql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');
}

/** 名前の cron.schedule の cron 式 */
function cronExpressionOf(sql: string, jobName: string): string {
  const escaped = jobName.replace(/[-]/g, '\\-');
  const match = new RegExp(`cron\\.schedule\\(\\s*'${escaped}'\\s*,\\s*'([^']+)'`).exec(sqlCode(sql));
  if (!match) throw new Error(`cron.schedule('${jobName}', ...) が見つからない`);
  return match[1];
}

/** 整数の定数 (name CONSTANT integer := N) */
function integerConstant(sql: string, name: string): number {
  const match = new RegExp(`${name}\\s+CONSTANT\\s+integer\\s*:=\\s*(\\d+)`).exec(sqlCode(sql));
  if (!match) throw new Error(`${name} の定数が見つからない`);
  return Number(match[1]);
}

/** 文字列の定数 (name CONSTANT text := '...') */
function textConstant(sql: string, name: string): string {
  const match = new RegExp(`${name}\\s+CONSTANT\\s+text\\s*:=\\s*'([^']+)'`).exec(sqlCode(sql));
  if (!match) throw new Error(`${name} の定数が見つからない`);
  return match[1];
}

/** 関数の本文 ($$ ... $$) */
function functionBody(sql: string, qualifiedName: string): string {
  const start = sqlCode(sql).indexOf(`CREATE OR REPLACE FUNCTION ${qualifiedName}(`);
  if (start < 0) throw new Error(`${qualifiedName} の定義が見つからない`);
  const code = sqlCode(sql).slice(start);
  const open = code.indexOf('$$');
  const close = code.indexOf('$$', open + 2);
  return code.slice(open + 2, close);
}

/** Vault の秘密を読んでから net.http_post で送るまでの部分 (空白をそろえる) */
function postingBlock(body: string): string {
  const start = body.indexOf('SELECT decrypted_secret INTO v_secret');
  const end = body.indexOf('RETURN v_request_ids;');
  if (start < 0 || end < 0) throw new Error('秘密の読み込みから要求の送信までの部分が見つからない');
  return body
    .slice(start, end)
    .replace(/public\.calculate_segment_stats_(request|finalize_retry)_bodies\(now\(\)\)/, '<BODIES>(now())')
    .replace(/\s+/g, ' ')
    .trim();
}

describe('#1500 確定の回の再試行のジョブ', () => {
  const [minuteField, hourField, dayOfMonth, month, dayOfWeek] = cronExpressionOf(MIGRATION, RETRY_JOB_NAME).split(/\s+/);
  const retryMinutes = minuteField.split(',').map(Number);
  const boundaryHourUtc = (PERIOD_BOUNDARY_HOUR_JST - JST_OFFSET_HOURS + HOURS_PER_DAY) % HOURS_PER_DAY;

  it('毎日 1 回、期間が切り替わる JST 0 時台 (UTC 15 時台) に、2 回 (JST 0:20 と 0:35) 動く', () => {
    expect(cronExpressionOf(MIGRATION, RETRY_JOB_NAME)).toBe('20,35 15 * * *');
    expect([dayOfMonth, month, dayOfWeek]).toEqual(['*', '*', '*']);
    expect(Number(hourField)).toBe(boundaryHourUtc);
    expect(retryMinutes).toHaveLength(EXPECTED_RETRY_COUNT);
  });

  it('再試行はどれも、確定の回 (毎時のジョブの JST 0 時台の回) のあとで、確定の回の窓 (c_finalize_window) の中', () => {
    const [primaryMinute, primaryHour] = cronExpressionOf(SCHEDULE_MIGRATION, 'calculate-segment-stats').split(/\s+/);
    expect(primaryHour, '確定の回のジョブは毎時').toBe('*');
    const window = /c_finalize_window\s+CONSTANT\s+interval\s*:=\s*interval\s+'(\d+) hours?'/.exec(sqlCode(SCHEDULE_MIGRATION))?.[1];
    expect(window, '確定の回の migration に c_finalize_window が無い').toBeDefined();
    const windowMinutes = Number(window) * MINUTES_PER_HOUR;
    for (const minute of retryMinutes) {
      expect(minute).toBeGreaterThan(Number(primaryMinute));
      expect(minute).toBeLessThan(windowMinutes);
    }
  });

  it('確定の回と再試行の間隔は、呼び出しの待ち時間の上限 (Edge Function の実行時間の上限) より長い (前の試みと重ならない)', () => {
    const [primaryMinute] = cronExpressionOf(SCHEDULE_MIGRATION, 'calculate-segment-stats').split(/\s+/);
    const attempts = [Number(primaryMinute), ...retryMinutes].sort((a, b) => a - b);
    const timeoutMs = integerConstant(functionBody(MIGRATION, 'public.invoke_calculate_segment_stats_finalize_retry'), 'c_timeout_ms');
    for (let i = 1; i < attempts.length; i += 1) {
      const gapMs = (attempts[i] - attempts[i - 1]) * SECONDS_PER_MINUTE * MS_PER_SECOND;
      expect(gapMs, `${attempts[i - 1]} 分 → ${attempts[i]} 分`).toBeGreaterThan(timeoutMs);
    }
  });

  it('同じ名前のジョブを外してから登録し、所有者 postgres の関数を呼ぶ', () => {
    const code = sqlCode(MIGRATION);
    const unschedule = /SELECT cron\.unschedule\(jobname\)\s+FROM cron\.job\s+WHERE jobname IN \('([^']+)'\);/.exec(code);
    expect(unschedule?.[1]).toBe(RETRY_JOB_NAME);
    expect(code.indexOf('cron.unschedule')).toBeLessThan(code.indexOf('cron.schedule('));
    expect(code).toMatch(new RegExp(`\\$\\$ SELECT ${RETRY_FUNCTION.replace(/[.()]/g, (c) => `\\${c}`)} \\$\\$`));
  });
});

describe('#1500 再試行の呼び方は、確定の回と同じ', () => {
  const retryBody = functionBody(MIGRATION, 'public.invoke_calculate_segment_stats_finalize_retry');
  const primaryBody = functionBody(SCHEDULE_MIGRATION, 'public.invoke_calculate_segment_stats');

  it('呼び先 (c_url) と待ち時間の上限 (c_timeout_ms) が同じ', () => {
    expect(textConstant(retryBody, 'c_url')).toBe(textConstant(primaryBody, 'c_url'));
    expect(integerConstant(retryBody, 'c_timeout_ms')).toBe(integerConstant(primaryBody, 'c_timeout_ms'));
  });

  it('秘密の読み方 (Vault の app_cron_secret・無ければ例外) と要求の組み立て (Bearer・本文・待ち時間) が同じ。違うのは本文の配列だけ', () => {
    expect(postingBlock(retryBody)).toBe(postingBlock(primaryBody));
    expect(retryBody).toContain('public.calculate_segment_stats_finalize_retry_bodies(now())');
  });

  it('再試行の本文は、毎時の回の本文のうち previousPeriod: true のものだけ (今の期間の本文は送らない)', () => {
    const bodies = functionBody(MIGRATION, 'public.calculate_segment_stats_finalize_retry_bodies');
    expect(bodies).toMatch(/FOREACH v_body IN ARRAY public\.calculate_segment_stats_request_bodies\(p_at\) LOOP/);
    expect(bodies).toMatch(/IF \(v_body ->> 'previousPeriod'\)::boolean IS TRUE THEN/);
    expect(bodies, '本文を新しく組み立てない').not.toMatch(/jsonb_build_object/);
  });

  it('2 つの関数はアプリ・PostgREST から呼べない (PUBLIC / anon / authenticated / service_role の EXECUTE を外す)', () => {
    const code = sqlCode(MIGRATION);
    for (const signature of [RETRY_FUNCTION, RETRY_BODIES_FUNCTION]) {
      const escaped = signature.replace(/[.()]/g, (c) => `\\${c}`);
      expect(code).toMatch(new RegExp(`REVOKE ALL ON FUNCTION ${escaped} FROM PUBLIC, anon, authenticated, service_role;`));
    }
    expect(code).not.toMatch(/GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+public\.(invoke_calculate_segment_stats_finalize_retry|calculate_segment_stats_finalize_retry_bodies)/i);
  });
});

describe('#1500 確定の回をやり終えた期間の表と、Edge Function', () => {
  it('表は (period_type, period_start) が主キーで、Edge Function はその 2 列で引き、同じ 2 列で ignoreDuplicates に書く', () => {
    const code = sqlCode(MIGRATION);
    expect(code).toMatch(new RegExp(`CREATE TABLE IF NOT EXISTS public\\.${FINALIZED_TABLE} \\(`));
    expect(code).toMatch(/PRIMARY KEY \(period_type, period_start\)/);
    expect(EDGE_FUNCTION).toContain(`const FINALIZED_PERIODS_TABLE = '${FINALIZED_TABLE}';`);
    expect(EDGE_FUNCTION).toContain("{ onConflict: 'period_type,period_start', ignoreDuplicates: true }");
  });

  it('表は service_role だけ (anon / authenticated の権限を外し、全拒否のポリシーも置く)', () => {
    const code = sqlCode(MIGRATION);
    expect(code).toContain(`ALTER TABLE public.${FINALIZED_TABLE} ENABLE ROW LEVEL SECURITY;`);
    expect(code).toContain(`REVOKE ALL ON public.${FINALIZED_TABLE} FROM PUBLIC, anon, authenticated, service_role;`);
    expect(code).toContain(`GRANT SELECT, INSERT, UPDATE, DELETE ON public.${FINALIZED_TABLE} TO service_role;`);
    expect(code).toMatch(/TO anon, authenticated\s+USING \(false\)\s+WITH CHECK \(false\);/);
  });
});

describe('#1500 total_meals の件数は、お試しの記録を数えない', () => {
  it('count_meals_per_user は meals.is_sandbox = false の行だけを数える (形と権限は 20261011060000 と同じ)', () => {
    const body = functionBody(MIGRATION, 'public.count_meals_per_user');
    expect(body.replace(/\s+/g, ' ').trim()).toBe(
      'SELECT m.user_id, count(*)::bigint AS meal_count FROM public.meals AS m WHERE m.is_sandbox = false GROUP BY m.user_id',
    );
    const code = sqlCode(MIGRATION);
    expect(code).toContain('REVOKE ALL ON FUNCTION public.count_meals_per_user() FROM PUBLIC, anon, authenticated;');
    expect(code).toContain('GRANT EXECUTE ON FUNCTION public.count_meals_per_user() TO service_role;');
  });

  it('Edge Function の期間内の meals の読み込みも、お試しの記録を除く', () => {
    const query = /'meals \(期間内\) の取得'[\s\S]*?\.lt\('eaten_at', mealsRange\.before\)/.exec(EDGE_FUNCTION)?.[0];
    expect(query, '期間内の meals の読み込みが見つからない').toBeDefined();
    expect(query).toContain(".eq('is_sandbox', false)");
  });
});

describe('#1500 rollback', () => {
  it('ジョブを外し、関数 2 本と表を消し、count_meals_per_user を 20261011060000 の定義に戻す (集計の結果の表には触れない)', () => {
    const code = sqlCode(ROLLBACK);
    expect(/WHERE jobname IN \('([^']+)'\);/.exec(code)?.[1]).toBe(RETRY_JOB_NAME);
    expect(code).toContain('DROP FUNCTION IF EXISTS public.invoke_calculate_segment_stats_finalize_retry();');
    expect(code).toContain('DROP FUNCTION IF EXISTS public.calculate_segment_stats_finalize_retry_bodies(timestamptz);');
    expect(code).toContain(`DROP TABLE IF EXISTS public.${FINALIZED_TABLE};`);
    expect(functionBody(ROLLBACK, 'public.count_meals_per_user').replace(/\s+/g, ' ').trim()).toBe(
      functionBody(COUNT_MEALS_MIGRATION, 'public.count_meals_per_user').replace(/\s+/g, ' ').trim(),
    );
    expect(code).not.toMatch(/\b(DELETE|TRUNCATE|UPDATE|INSERT)\b/);
    expect(code).not.toMatch(/DROP\s+TABLE\s+(IF EXISTS\s+)?public\.(segment_stats|user_metrics|user_segment_rankings|user_badges)\b/i);
  });
});
