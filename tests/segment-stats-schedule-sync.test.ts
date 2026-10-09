// @vitest-environment node
//
// #1406: セグメント統計 (比較ランキング) の定期実行の設定と、それを前提にしている画面・API の突き合わせ
//
// 定期実行は migration 20261009100000_schedule_calculate_segment_stats.sql が登録する pg_cron のジョブ
// calculate-segment-stats-daily (毎日 UTC 19:00 = JST 4:00)。ジョブは public.invoke_calculate_segment_stats() を呼び、
// その関数が Edge Function calculate-segment-stats を期間の種類ごとに 1 回ずつ呼ぶ。
// 実 DB での動き (ジョブの登録・Vault が無いときの失敗・送る要求の中身・権限) は
// tests/integration/security/schedule-calculate-segment-stats-cron.test.ts が確かめる。
// ここでは、ファイルどうしの取り決めがずれていないことだけを、DB 無しで確かめる:
//   - モバイルの比較画面が案内する更新時刻 (JST) が、ジョブの時刻 (UTC) を JST にしたものと同じ
//   - ジョブが集計する期間の種類が、画面 (モバイル・Web) の選択肢と、手動の API が受け付ける種類を、過不足なく含む
//   - 関数に渡す本文は periodType だけ (過去の期間を指定しない = 直近の 1 期間だけを集計する)

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const read = (file: string) => fs.readFileSync(path.join(ROOT, file), 'utf8');

const MIGRATION = read('supabase/migrations/20261009100000_schedule_calculate_segment_stats.sql');
const ROLLBACK = read('supabase/rollbacks/20261009100000_schedule_calculate_segment_stats.down.sql');
const MOBILE_SCREEN = read('apps/mobile/app/comparison/index.tsx');
const WEB_PAGE = read('src/app/(main)/comparison/page.tsx');
const TRIGGER_ROUTE = read('src/app/api/comparison/trigger/route.ts');

/** JST は UTC+9 (日本に夏時間は無い) */
const JST_OFFSET_HOURS = 9;
const HOURS_PER_DAY = 24;

/** SQL のコメント行 (-- で始まる行) を除く */
function sqlCode(sql: string): string {
  return sql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');
}

/** 'a', 'b' の並びから文字列の配列を取り出す */
function quotedList(source: string): string[] {
  return [...source.matchAll(/['"]([a-z_]+)['"]/g)].map((m) => m[1]);
}

/** migration が登録するジョブの cron 式 */
function cronExpression(): string {
  const match = /cron\.schedule\(\s*'calculate-segment-stats-daily'\s*,\s*'([^']+)'/.exec(sqlCode(MIGRATION));
  if (!match) throw new Error('migration に cron.schedule(\'calculate-segment-stats-daily\', ...) が見つからない');
  return match[1];
}

/** invoke_calculate_segment_stats が呼ぶ期間の種類 */
function scheduledPeriodTypes(): string[] {
  const match = /c_period_types\s+CONSTANT\s+text\[\]\s*:=\s*ARRAY\[([^\]]*)\]/.exec(sqlCode(MIGRATION));
  if (!match) throw new Error('migration に c_period_types の配列が見つからない');
  return quotedList(match[1]);
}

describe('#1406 セグメント統計の定期実行の設定', () => {
  it('ジョブは毎日 1 回 (分・時だけを指定し、日・月・曜日は * )', () => {
    const [minute, hour, dayOfMonth, month, dayOfWeek] = cronExpression().split(/\s+/);
    expect(minute).toMatch(/^\d+$/);
    expect(hour).toMatch(/^\d+$/);
    expect([dayOfMonth, month, dayOfWeek]).toEqual(['*', '*', '*']);
  });

  it('モバイルの比較画面が案内する更新時刻 (JST) は、ジョブの時刻 (UTC) を JST にしたものと同じ (毎日 4:00)', () => {
    const [minute, hour] = cronExpression().split(/\s+/).map(Number);
    const jst = `${(hour + JST_OFFSET_HOURS) % HOURS_PER_DAY}:${String(minute).padStart(2, '0')}`;
    expect(jst).toBe('4:00');

    const shown = /const RANKING_UPDATE_TIME_JST = "([^"]+)"/.exec(MOBILE_SCREEN)?.[1];
    expect(shown, 'apps/mobile/app/comparison/index.tsx に RANKING_UPDATE_TIME_JST が無い').toBe(jst);
  });

  it('ジョブが集計する期間の種類は daily / weekly / monthly で、画面の選択肢と手動の API の受け付ける種類をすべて含む', () => {
    const scheduled = scheduledPeriodTypes();
    expect(scheduled).toEqual(['daily', 'weekly', 'monthly']);

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

  it('関数に渡す本文は periodType だけ (期間の開始日などを渡さない = 直近の 1 期間だけを集計する)', () => {
    const code = sqlCode(MIGRATION);
    const bodies = [...code.matchAll(/body\s*:=\s*([^\n]+)/g)].map((m) => m[1].trim());
    expect(bodies).toEqual(["jsonb_build_object('periodType', v_period_type),"]);
  });

  it('関数はアプリ・PostgREST から呼べない (PUBLIC / anon / authenticated / service_role の EXECUTE を外す)', () => {
    expect(sqlCode(MIGRATION)).toMatch(
      /REVOKE ALL ON FUNCTION public\.invoke_calculate_segment_stats\(\) FROM PUBLIC, anon, authenticated, service_role;/,
    );
    expect(sqlCode(MIGRATION)).not.toMatch(/GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+public\.invoke_calculate_segment_stats/i);
  });

  it('rollback はジョブの登録を外し、関数を消す (集計済みの表には触れない)', () => {
    const code = sqlCode(ROLLBACK);
    expect(code).toMatch(/cron\.unschedule\('calculate-segment-stats-daily'\)/);
    expect(code).toMatch(/DROP FUNCTION IF EXISTS public\.invoke_calculate_segment_stats\(\);/);
    expect(code).not.toMatch(/\b(DELETE|TRUNCATE|UPDATE|INSERT)\b|DROP\s+TABLE/i);
  });
});
