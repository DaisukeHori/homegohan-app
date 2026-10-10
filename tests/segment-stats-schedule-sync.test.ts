// @vitest-environment node
//
// #1406: セグメント統計 (比較ランキング) の定期実行の設定と、それを前提にしている画面・API・Edge Function の突き合わせ
//
// 定期実行は migration 20261009100000_schedule_calculate_segment_stats.sql が登録する pg_cron のジョブ
// calculate-segment-stats (毎時 5 分)。ジョブは public.invoke_calculate_segment_stats() を呼び、
// その関数が public.calculate_segment_stats_request_bodies(now()) の本文ごとに Edge Function calculate-segment-stats を呼ぶ
// (daily / weekly / monthly と、期間が切り替わった直後の回は直前の期間 previousPeriod: true)。
// 実 DB での動き (ジョブの登録・Vault が無いときの失敗・送る要求の中身・時刻ごとの本文・権限) は
// tests/integration/security/schedule-calculate-segment-stats-cron.test.ts が確かめる。
// ここでは、ファイルどうしの取り決めがずれていないことだけを、DB 無しで確かめる:
//   - モバイルの比較画面が案内する更新の間隔 (時間) が、ジョブの cron 式の間隔と同じ
//   - 直前の期間の集計し直しを担う JST 0 時台 (UTC 15 時台) の回が、ジョブのスケジュールに含まれる。
//     集計し直す範囲 (期間の始まりから c_finalize_window) は、ジョブの間隔と同じ
//   - ジョブが集計する期間の種類が、画面 (モバイル・Web) の選択肢と、手動の API が受け付ける種類と、
//     Edge Function が「直前の期間」を受け付ける種類 (JST_CALENDAR_PERIOD_TYPES) を、過不足なく含む
//   - 関数に渡す本文は periodType と previousPeriod: true だけ (過去の任意の期間を指定しない)

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { JST_CALENDAR_PERIOD_TYPES } from '../supabase/functions/_shared/jst-date.ts';

const ROOT = path.resolve(__dirname, '..');
const read = (file: string) => fs.readFileSync(path.join(ROOT, file), 'utf8');

const MIGRATION = read('supabase/migrations/20261009100000_schedule_calculate_segment_stats.sql');
const ROLLBACK = read('supabase/rollbacks/20261009100000_schedule_calculate_segment_stats.down.sql');
const MOBILE_SCREEN = read('apps/mobile/app/comparison/index.tsx');
const WEB_PAGE = read('src/app/(main)/comparison/page.tsx');
const TRIGGER_ROUTE = read('src/app/api/comparison/trigger/route.ts');

const JOB_NAME = 'calculate-segment-stats';
/** 毎日 1 回だったころのジョブ名。migration と rollback が外す */
const OLD_JOB_NAME = 'calculate-segment-stats-daily';

/** JST は UTC+9 (日本に夏時間は無い) */
const JST_OFFSET_HOURS = 9;
const HOURS_PER_DAY = 24;
/** 日・週・月の期間が切り替わる JST の時 (0 時) */
const PERIOD_BOUNDARY_HOUR_JST = 0;

/** SQL のコメント行 (-- で始まる行) を除く */
function sqlCode(sql: string): string {
  return sql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');
}

/** 'a', 'b' の並びから文字列の配列を取り出す */
function quotedList(source: string): string[] {
  return [...source.matchAll(/['"]([a-z_-]+)['"]/g)].map((m) => m[1]);
}

/** migration が登録するジョブの名前と cron 式 */
function scheduledJob(): { name: string; expression: string } {
  const match = /cron\.schedule\(\s*'([^']+)'\s*,\s*'([^']+)'/.exec(sqlCode(MIGRATION));
  if (!match) throw new Error('migration に cron.schedule(...) が見つからない');
  return { name: match[1], expression: match[2] };
}

/** cron 式の「時」の欄 (*, * /N, a,b,c) が表す UTC の時の一覧 */
function hoursOf(hourField: string): number[] {
  const all = Array.from({ length: HOURS_PER_DAY }, (_, h) => h);
  if (hourField === '*') return all;
  const step = /^\*\/(\d+)$/.exec(hourField);
  if (step) return all.filter((h) => h % Number(step[1]) === 0);
  if (/^\d+(,\d+)*$/.test(hourField)) return hourField.split(',').map(Number);
  throw new Error(`この突き合わせが読めない「時」の欄: ${hourField}`);
}

/** cron 式が等間隔に動く間隔 (時間)。等間隔でなければ例外 */
function intervalHoursOf(hours: number[]): number {
  const sorted = [...hours].sort((a, b) => a - b);
  const gaps = sorted.map((h, i) => (i + 1 < sorted.length ? sorted[i + 1] - h : sorted[0] + HOURS_PER_DAY - h));
  const unique = [...new Set(gaps)];
  if (unique.length !== 1) throw new Error(`ジョブの間隔が等間隔ではない: ${sorted.join(',')}`);
  return unique[0];
}

/** SQL の配列定数 (c_xxx CONSTANT text[] := ARRAY[...]) の中身 */
function sqlTextArray(name: string): string[] {
  const match = new RegExp(`${name}\\s+CONSTANT\\s+text\\[\\]\\s*:=\\s*ARRAY\\[([^\\]]*)\\]`).exec(sqlCode(MIGRATION));
  if (!match) throw new Error(`migration に ${name} の配列が見つからない`);
  return quotedList(match[1]);
}

/** SELECT cron.unschedule(jobname) FROM cron.job WHERE jobname IN (...) が外すジョブ名 */
function unscheduledJobNames(sql: string): string[] {
  const match = /SELECT cron\.unschedule\(jobname\)\s+FROM cron\.job\s+WHERE jobname IN \(([^)]*)\);/.exec(sqlCode(sql));
  if (!match) throw new Error('cron.unschedule(jobname) ... WHERE jobname IN (...) が見つからない');
  return quotedList(match[1]).sort();
}

describe('#1406 セグメント統計の定期実行の設定', () => {
  it('ジョブ calculate-segment-stats は毎時 5 分 (日・月・曜日は * )', () => {
    expect(scheduledJob()).toEqual({ name: JOB_NAME, expression: '5 * * * *' });
  });

  it('モバイルの比較画面が案内する更新の間隔 (時間) は、ジョブの間隔と同じ (1 時間ごと)', () => {
    const [, hourField, dayOfMonth, month, dayOfWeek] = scheduledJob().expression.split(/\s+/);
    expect([dayOfMonth, month, dayOfWeek]).toEqual(['*', '*', '*']);
    const interval = intervalHoursOf(hoursOf(hourField));
    expect(interval).toBe(1);

    const shown = /const RANKING_UPDATE_INTERVAL_HOURS = (\d+);/.exec(MOBILE_SCREEN)?.[1];
    expect(shown, 'apps/mobile/app/comparison/index.tsx に RANKING_UPDATE_INTERVAL_HOURS が無い').toBeDefined();
    expect(Number(shown)).toBe(interval);
    expect(MOBILE_SCREEN).toContain('ランキングは ${RANKING_UPDATE_INTERVAL_HOURS} 時間ごとに更新されます。');
    expect(MOBILE_SCREEN, '毎日の時刻の案内が残っていない').not.toMatch(/毎日|RANKING_UPDATE_TIME_JST/);
  });

  it('期間が切り替わる JST 0 時台 (UTC 15 時台) の回がスケジュールに含まれ、直前の期間を集計し直す範囲はジョブの間隔と同じ', () => {
    const [, hourField] = scheduledJob().expression.split(/\s+/);
    const boundaryHourUtc = (PERIOD_BOUNDARY_HOUR_JST - JST_OFFSET_HOURS + HOURS_PER_DAY) % HOURS_PER_DAY;
    expect(hoursOf(hourField)).toContain(boundaryHourUtc);

    const window = /c_finalize_window\s+CONSTANT\s+interval\s*:=\s*interval\s+'(\d+) hours?'/.exec(sqlCode(MIGRATION))?.[1];
    expect(window, 'migration に c_finalize_window が無い').toBeDefined();
    expect(Number(window)).toBe(intervalHoursOf(hoursOf(hourField)));
  });

  it('ジョブが集計する期間の種類は daily / weekly / monthly で、画面の選択肢・手動の API・Edge Function の「直前の期間」の種類と揃う', () => {
    const scheduled = sqlTextArray('c_period_types');
    expect(scheduled).toEqual(['daily', 'weekly', 'monthly']);
    // date_trunc の単位は、種類と同じ順で日・週・月
    expect(sqlTextArray('c_period_units')).toEqual(['day', 'week', 'month']);
    // 直前の期間 (previousPeriod: true) を Edge Function が受け付ける種類と同じ
    expect(scheduled).toEqual([...JST_CALENDAR_PERIOD_TYPES]);

    const mobileOptions = [...MOBILE_SCREEN.matchAll(/value: "([a-z_]+)" as const/g)].map((m) => m[1]);
    expect(mobileOptions.length, 'モバイルの選択肢の取り出しが空振りしていないこと').toBeGreaterThan(0);
    const webOptions = quotedList(/\(\[([^\]]*)\] as const\)\.map\(\(period\)/.exec(WEB_PAGE)?.[1] ?? '');
    expect(webOptions.length, 'Web の選択肢の取り出しが空振りしていないこと').toBeGreaterThan(0);
    const routeTypes = quotedList(/const PERIOD_TYPES = \[([^\]]*)\] as const/.exec(TRIGGER_ROUTE)?.[1] ?? '');
    expect(routeTypes, '手動の API の受け付ける種類は、定期実行と同じ').toEqual(scheduled);

    for (const option of [...mobileOptions, ...webOptions]) {
      expect(scheduled, `画面の選択肢 ${option} が定期実行の対象に無い (その期間の画面が空のままになる)`).toContain(option);
    }
  });

  it('関数に渡す本文は periodType と previousPeriod: true だけ (期間の開始日などを渡さない = 今の期間か直前の期間だけを集計する)', () => {
    const code = sqlCode(MIGRATION);
    const built = [...code.matchAll(/jsonb_build_object\(\s*'periodType'([^)]*)\)/g)].map((m) => m[1].trim());
    expect(built).toEqual([", c_period_types[i]", ", c_period_types[i], 'previousPeriod', true"]);
    // net.http_post に渡す本文は、上で組み立てた本文だけ
    expect([...code.matchAll(/body\s*:=\s*([^\n]+)/g)].map((m) => m[1].trim())).toEqual(['v_body,']);
    expect(code).toMatch(/FOREACH v_body IN ARRAY public\.calculate_segment_stats_request_bodies\(now\(\)\) LOOP/);
  });

  it('2 つの関数はアプリ・PostgREST から呼べない (PUBLIC / anon / authenticated / service_role の EXECUTE を外す)', () => {
    const code = sqlCode(MIGRATION);
    for (const signature of ['public.invoke_calculate_segment_stats()', 'public.calculate_segment_stats_request_bodies(timestamptz)']) {
      const escaped = signature.replace(/[.()]/g, (c) => `\\${c}`);
      expect(code).toMatch(new RegExp(`REVOKE ALL ON FUNCTION ${escaped} FROM PUBLIC, anon, authenticated, service_role;`));
    }
    expect(code).not.toMatch(/GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+public\.(invoke_calculate_segment_stats|calculate_segment_stats_request_bodies)/i);
  });

  it('migration は、以前の名前 (calculate-segment-stats-daily) と同じ名前のジョブを外してから登録する', () => {
    expect(unscheduledJobNames(MIGRATION)).toEqual([JOB_NAME, OLD_JOB_NAME].sort());
    const code = sqlCode(MIGRATION);
    expect(code.indexOf('cron.unschedule'), '外してから登録する').toBeLessThan(code.indexOf('cron.schedule('));
  });

  it('rollback はジョブの登録 (新旧の名前) を外し、2 つの関数を消す (集計済みの表には触れない)', () => {
    expect(unscheduledJobNames(ROLLBACK)).toEqual([JOB_NAME, OLD_JOB_NAME].sort());
    const code = sqlCode(ROLLBACK);
    expect(code).toMatch(/DROP FUNCTION IF EXISTS public\.invoke_calculate_segment_stats\(\);/);
    expect(code).toMatch(/DROP FUNCTION IF EXISTS public\.calculate_segment_stats_request_bodies\(timestamptz\);/);
    expect(code).not.toMatch(/\b(DELETE|TRUNCATE|UPDATE|INSERT)\b|DROP\s+TABLE/i);
  });
});
