// @vitest-environment node
//
// #1432: POST /api/health/insights が health_insights に保存する行 (src/lib/health-insight-rows.ts) の単体テスト。
//
// 修正前のルートは、health_insights に無い `content` 列と、数値の `priority` (列は text、CHECK は low / medium / high /
// critical) を入れ、NOT NULL で既定値の無い analysis_date / period_start / period_end / period_type / summary を
// 入れていなかった。insert は必ず失敗していた。
//
// ここで確かめること:
//   - 送る列が、スキーマ (supabase/baseline/prod_schema.sql の CREATE TABLE health_insights) にある列の部分集合で、
//     NOT NULL かつ既定値の無い列がすべて埋まっている。priority は CHECK 制約が許す値だけ
//   - 日付と期間は JST の暦日で、Edge Function 用の calculateJstLookbackPeriod (supabase/functions/_shared/jst-date.ts) と
//     同じ結果になる (Edge Function generate-health-insights の monthly と同じ 30 日)
//   - LLM の応答の想定外の値 (数値の priority・未知の insight_type・空の本文) を、列に合う値へ直す / 捨てる
// 実 DB に保存できることは tests/integration/security/health-insights-write.test.ts で確かめる。

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildHealthInsightRows,
  calculateHealthInsightPeriod,
  HEALTH_INSIGHT_LOOKBACK_DAYS,
  HEALTH_INSIGHT_PRIORITIES,
  MAX_INSIGHT_RECOMMENDATIONS,
  MAX_INSIGHT_TITLE_LENGTH,
} from '../src/lib/health-insight-rows';
import { calculateJstLookbackPeriod } from '../supabase/functions/_shared/jst-date.ts';

const ROOT = join(__dirname, '..');
const USER_ID = '00000000-0000-4000-8000-000000000001';

// ---- スキーマの読み取り -------------------------------------------------------

interface ColumnDef {
  name: string;
  notNull: boolean;
  hasDefault: boolean;
}

/** prod_schema.sql の CREATE TABLE health_insights の本体 (括弧の中) を取り出す */
function healthInsightsTableBody(sql: string): string {
  const match = sql.match(/CREATE TABLE IF NOT EXISTS "public"\."health_insights" \(([\s\S]*?)\n\);/);
  if (!match) throw new Error('CREATE TABLE health_insights が見つかりません');
  return match[1];
}

function parseColumns(body: string): ColumnDef[] {
  return body
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('"'))
    .map((line) => {
      const name = line.match(/^"([^"]+)"/)![1];
      return { name, notNull: /\bNOT NULL\b/.test(line), hasDefault: /\bDEFAULT\b/.test(line) };
    });
}

function parsePriorityCheck(body: string): string[] {
  const match = body.match(/CONSTRAINT "health_insights_priority_check" CHECK \(\("priority" = ANY \(ARRAY\[([^\]]+)\]\)\)\)/);
  if (!match) throw new Error('health_insights_priority_check が見つかりません');
  return [...match[1].matchAll(/'([^']+)'::"text"/g)].map((m) => m[1]);
}

const baseline = readFileSync(join(ROOT, 'supabase/baseline/prod_schema.sql'), 'utf8');
const tableBody = healthInsightsTableBody(baseline);
const columns = parseColumns(tableBody);
const requiredColumns = columns.filter((c) => c.notNull && !c.hasDefault).map((c) => c.name);

describe('前提: health_insights のスキーマ', () => {
  it('baseline から列と NOT NULL を読み取れている', () => {
    expect(columns.map((c) => c.name)).toContain('summary');
    expect(columns.map((c) => c.name)).not.toContain('content');
    // id は DEFAULT gen_random_uuid() があるので、送らなくてよい
    expect([...requiredColumns].sort()).toEqual(
      ['analysis_date', 'insight_type', 'period_end', 'period_start', 'period_type', 'summary', 'title', 'user_id'].sort(),
    );
  });

  it('後続の migration は health_insights の列を変えていない (変えたら、このテストの読み取りも追随させる)', () => {
    const dir = join(ROOT, 'supabase/migrations');
    const offenders = readdirSync(dir)
      .filter((file) => file.endsWith('.sql') && !file.endsWith('.down.sql'))
      .filter((file) => {
        const sql = readFileSync(join(dir, file), 'utf8');
        return /ALTER TABLE[^;]*"?health_insights"?[^;]*\b(ADD COLUMN|DROP COLUMN|ALTER COLUMN|RENAME)\b/i.test(sql);
      });
    expect(offenders).toEqual([]);
  });
});

// ---- 行の組み立て -------------------------------------------------------------

/** JST 2026-10-08 05:30 (UTC ではまだ 10-07) */
const NOW = new Date('2026-10-07T20:30:00Z');

const GOOD = {
  title: '睡眠',
  summary: '睡眠を確保しましょう',
  insight_type: 'sleep',
  is_alert: true,
  priority: 'critical',
  recommendations: ['23 時までに寝る'],
};

describe('buildHealthInsightRows', () => {
  it('送る列はスキーマの列の部分集合で、NOT NULL かつ既定値の無い列はすべて空でない値で埋まる', () => {
    const [row] = buildHealthInsightRows(USER_ID, [GOOD], NOW);
    const schemaColumns = new Set(columns.map((c) => c.name));

    for (const key of Object.keys(row)) {
      expect(schemaColumns.has(key), `${key} は health_insights に無い列`).toBe(true);
    }
    for (const name of requiredColumns) {
      const value = (row as Record<string, unknown>)[name];
      expect(typeof value, `${name} が埋まっていない`).toBe('string');
      expect((value as string).length, `${name} が空`).toBeGreaterThan(0);
    }
  });

  it('priority は CHECK 制約が許す値だけ。数値や未知の文字列は列の既定値 (medium) にする', () => {
    expect([...HEALTH_INSIGHT_PRIORITIES]).toEqual(parsePriorityCheck(tableBody));

    const rows = buildHealthInsightRows(
      USER_ID,
      [
        { ...GOOD, priority: 1 },
        { ...GOOD, priority: 'urgent' },
        { ...GOOD, priority: undefined },
        { ...GOOD, priority: 'low' },
      ],
      NOW,
    );
    expect(rows.map((r) => r.priority)).toEqual(['medium', 'medium', 'medium', 'low']);
    for (const row of rows) {
      expect(parsePriorityCheck(tableBody)).toContain(row.priority);
    }
  });

  it('日付は JST の暦日。期間は JST の今日から 30 日さかのぼり、period_type は monthly', () => {
    const [row] = buildHealthInsightRows(USER_ID, [GOOD], NOW);
    expect(row).toEqual({
      user_id: USER_ID,
      analysis_date: '2026-10-08',
      period_start: '2026-09-08',
      period_end: '2026-10-08',
      period_type: 'monthly',
      insight_type: 'sleep',
      title: '睡眠',
      summary: '睡眠を確保しましょう',
      recommendations: ['23 時までに寝る'],
      priority: 'critical',
      is_alert: true,
      is_read: false,
      is_dismissed: false,
    });
  });

  it('未知の insight_type は trend、空のタイトルは既定のタイトル、長いタイトルは切る', () => {
    const rows = buildHealthInsightRows(
      USER_ID,
      [
        { ...GOOD, insight_type: 'weight_trend' },
        { ...GOOD, title: '  ' },
        { ...GOOD, title: 'あ'.repeat(MAX_INSIGHT_TITLE_LENGTH + 10) },
      ],
      NOW,
    );
    expect(rows[0].insight_type).toBe('trend');
    expect(rows[1].title).toBe('健康インサイト');
    expect(rows[2].title).toHaveLength(MAX_INSIGHT_TITLE_LENGTH);
  });

  it('本文 (summary) が空・文字列でないものは保存しない', () => {
    const rows = buildHealthInsightRows(
      USER_ID,
      [{ ...GOOD, summary: '' }, { ...GOOD, summary: '   ' }, { ...GOOD, summary: 42 }, { ...GOOD, summary: undefined }, GOOD],
      NOW,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].summary).toBe('睡眠を確保しましょう');
  });

  it('recommendations は空でない文字列だけを、上限まで残す。配列でなければ空配列', () => {
    const many = Array.from({ length: MAX_INSIGHT_RECOMMENDATIONS + 2 }, (_, i) => `行動${i + 1}`);
    const rows = buildHealthInsightRows(
      USER_ID,
      [
        { ...GOOD, recommendations: [' 歩く ', '', 3, null, '寝る'] },
        { ...GOOD, recommendations: many },
        { ...GOOD, recommendations: '歩く' },
      ],
      NOW,
    );
    expect(rows[0].recommendations).toEqual(['歩く', '寝る']);
    expect(rows[1].recommendations).toEqual(many.slice(0, MAX_INSIGHT_RECOMMENDATIONS));
    expect(rows[2].recommendations).toEqual([]);
  });

  it('is_alert は true のときだけ true (文字列の "false" などを true にしない)', () => {
    const rows = buildHealthInsightRows(
      USER_ID,
      [
        { ...GOOD, is_alert: true },
        { ...GOOD, is_alert: 'false' },
        { ...GOOD, is_alert: 1 },
        { ...GOOD, is_alert: undefined },
      ],
      NOW,
    );
    expect(rows.map((r) => r.is_alert)).toEqual([true, false, false, false]);
  });
});

// ---- 期間 (Edge Function と同じ結果) ------------------------------------------

describe('calculateHealthInsightPeriod は Edge Function の calculateJstLookbackPeriod と同じ期間を返す', () => {
  const originalTz = process.env.TZ;
  afterEach(() => {
    vi.useRealTimers();
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  });

  // [現在時刻 (UTC), 開始日, 終了日 (= analysis_date), 説明]。期待値は暦を手で引いた固定値
  const cases: Array<[string, string, string, string]> = [
    ['2026-07-12T14:59:59.999Z', '2026-06-12', '2026-07-12', 'JST 7/12 23:59:59.999'],
    ['2026-07-12T15:00:00.000Z', '2026-06-13', '2026-07-13', 'JST 7/13 0:00 ちょうど (UTC はまだ 7/12)'],
    ['2026-12-31T15:00:00.000Z', '2026-12-02', '2027-01-01', '年をまたぐ: JST 元日 0:00 (UTC はまだ 12/31)'],
    ['2028-02-29T15:00:00.000Z', '2028-01-31', '2028-03-01', 'うるう日の翌日 JST 3/1 0:00'],
    ['2026-03-30T15:00:00.000Z', '2026-03-01', '2026-03-31', '2 月を含む: JST 3/31 0:00'],
  ];

  it.each(cases)('%s → %s 〜 %s (%s)', (now, start, end) => {
    for (const tz of ['UTC', 'Asia/Tokyo', 'America/Los_Angeles']) {
      process.env.TZ = tz;
      const at = new Date(now);
      const period = calculateHealthInsightPeriod(at);
      expect(period, tz).toEqual({ analysisDate: end, periodStart: start, periodEnd: end, periodType: 'monthly' });
      expect({ periodStart: period.periodStart, periodEnd: period.periodEnd }, tz).toEqual(
        calculateJstLookbackPeriod(HEALTH_INSIGHT_LOOKBACK_DAYS, at),
      );
    }
  });
});
