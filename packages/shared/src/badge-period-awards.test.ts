/**
 * badge-period-awards (比較ランキングのバッジを取った期間の見せ方。#1528) のユニットテスト
 *
 * 確かめること:
 *   - formatBadgeAwardPeriodLabel: 日・週 (月曜〜日曜。月・年をまたぐ形)・月の文。分からない種類・形の違う日付・存在しない日付は null
 *   - summarizeBadgePeriodAwards: バッジごとに、取った期間の数と最新の期間 (付けた時刻 → 開始日の順で新しい方) にまとめる。
 *     読めない行は数えない・同じ期間は 1 回に数える
 *   - formatBadgePeriodAwards: 1 回なら期間だけ、2 回以上なら「（通算 n 回）」を添える
 *   - 期間の種類の一覧が、migration の CHECK 制約・確定の回の種類 (Edge Function の JST_CALENDAR_PERIOD_TYPES) と同じ
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BADGE_AWARD_PERIOD_TYPES,
  formatBadgeAwardPeriodLabel,
  formatBadgePeriodAwards,
  summarizeBadgePeriodAwards,
  type BadgePeriodAwardRow,
} from './badge-period-awards';
import * as shared from './index';

const ROOT = path.resolve(__dirname, '../../..');

const row = (overrides: Partial<BadgePeriodAwardRow> = {}): BadgePeriodAwardRow => ({
  badge_id: 'b-1',
  period_type: 'weekly',
  period_start: '2026-10-05',
  message: null,
  awarded_at: '2026-10-11T15:05:00Z',
  ...overrides,
});

describe('formatBadgeAwardPeriodLabel', () => {
  it.each([
    ['daily', '2026-10-14', '2026年10月14日'],
    ['weekly', '2026-10-05', '2026年10月5日〜11日の週'],
    ['weekly', '2026-09-28', '2026年9月28日〜10月4日の週'],
    ['weekly', '2026-12-28', '2026年12月28日〜2027年1月3日の週'],
    ['monthly', '2026-09-01', '2026年9月'],
    ['monthly', '2027-01-01', '2027年1月'],
  ])('%s %s → %s', (periodType, periodStart, expected) => {
    expect(formatBadgeAwardPeriodLabel(periodType, periodStart)).toBe(expected);
  });

  it('閏年の 2 月末をまたぐ週も暦どおり (2028-02-28 の週は 3 月 5 日まで)', () => {
    expect(formatBadgeAwardPeriodLabel('weekly', '2028-02-28')).toBe('2028年2月28日〜3月5日の週');
  });

  it.each([
    ['all_time', '2024-01-01'],
    ['quarterly', '2026-10-01'],
    ['weekly', '2026-10-5'],
    ['weekly', '2026/10/05'],
    ['daily', '2026-02-30'],
    ['monthly', ''],
  ])('分からない種類・日付は null (%s, %s)', (periodType, periodStart) => {
    expect(formatBadgeAwardPeriodLabel(periodType, periodStart)).toBeNull();
  });
});

describe('summarizeBadgePeriodAwards', () => {
  it('1 期間だけなら回数 1 で、その期間と判定の文を返す', () => {
    const summary = summarizeBadgePeriodAwards([row({ message: '🏆 全体の朝食率で1位！' })]);
    expect(summary.get('b-1')).toEqual({
      count: 1,
      latest: {
        periodType: 'weekly',
        periodStart: '2026-10-05',
        label: '2026年10月5日〜11日の週',
        message: '🏆 全体の朝食率で1位！',
      },
    });
  });

  it('複数の期間は回数を数え、最新 (付けた時刻の新しい方) の期間を返す。行の並びに左右されない', () => {
    const rows = [
      row({ period_type: 'weekly', period_start: '2026-09-28', awarded_at: '2026-10-04T15:05:00Z', message: '9 月末の週' }),
      row({ period_type: 'monthly', period_start: '2026-09-01', awarded_at: '2026-09-30T15:05:10Z', message: '9 月' }),
      row({ period_type: 'weekly', period_start: '2026-10-05', awarded_at: '2026-10-11T15:05:00Z', message: '10 月の週' }),
      row({ period_type: 'daily', period_start: '2026-10-01', awarded_at: '2026-10-01T15:05:00Z', message: '10/1' }),
    ];
    for (const order of [rows, [...rows].reverse(), [rows[2], rows[0], rows[3], rows[1]]]) {
      const summary = summarizeBadgePeriodAwards(order).get('b-1');
      expect(summary?.count).toBe(4);
      expect(summary?.latest).toEqual({
        periodType: 'weekly',
        periodStart: '2026-10-05',
        label: '2026年10月5日〜11日の週',
        message: '10 月の週',
      });
    }
  });

  it('付けた時刻が同じなら、期間の開始日の新しい方を最新にする', () => {
    const at = '2026-10-11T15:05:00Z';
    const summary = summarizeBadgePeriodAwards([
      row({ period_type: 'weekly', period_start: '2026-10-05', awarded_at: at }),
      row({ period_type: 'daily', period_start: '2026-10-11', awarded_at: at }),
    ]).get('b-1');
    expect(summary?.latest.periodType).toBe('daily');
    expect(summary?.latest.periodStart).toBe('2026-10-11');
  });

  it('付けた時刻が読めない行は、最も古い扱い (最新にしない) だが回数には数える', () => {
    const summary = summarizeBadgePeriodAwards([
      row({ period_start: '2026-10-12', awarded_at: 'not-a-date' }),
      row({ period_start: '2026-10-05', awarded_at: '2026-10-11T15:05:00Z' }),
    ]).get('b-1');
    expect(summary?.count).toBe(2);
    expect(summary?.latest.periodStart).toBe('2026-10-05');
  });

  it('バッジごとに分けてまとめる', () => {
    const summary = summarizeBadgePeriodAwards([
      row({ badge_id: 'b-1', period_start: '2026-10-05' }),
      row({ badge_id: 'b-2', period_type: 'monthly', period_start: '2026-09-01' }),
      row({ badge_id: 'b-1', period_start: '2026-09-28', awarded_at: '2026-10-04T15:05:00Z' }),
    ]);
    expect([...summary.keys()].sort()).toEqual(['b-1', 'b-2']);
    expect(summary.get('b-1')?.count).toBe(2);
    expect(summary.get('b-2')).toMatchObject({ count: 1, latest: { label: '2026年9月' } });
  });

  it('期間の種類・開始日が読めない行は数えない (文と回数が食い違わないように)。全部読めなければバッジごと出さない', () => {
    const summary = summarizeBadgePeriodAwards([
      row({ badge_id: 'b-1', period_type: 'all_time', period_start: '2024-01-01' }),
      row({ badge_id: 'b-1', period_start: '2026-02-30' }),
      row({ badge_id: 'b-1', period_start: '2026-10-05' }),
      row({ badge_id: 'b-x', period_type: 'yearly', period_start: '2026-01-01' }),
    ]);
    expect(summary.get('b-1')?.count).toBe(1);
    expect(summary.has('b-x')).toBe(false);
  });

  it('同じ (種類, 開始日) の行が重なっていても 1 回に数える', () => {
    const summary = summarizeBadgePeriodAwards([row(), row({ awarded_at: '2026-10-12T00:00:00Z' })]);
    expect(summary.get('b-1')?.count).toBe(1);
  });

  it('同じ開始日でも種類が違えば別の期間 (2026-10-01 の日と、10 月の月)', () => {
    const summary = summarizeBadgePeriodAwards([
      row({ period_type: 'daily', period_start: '2026-10-01' }),
      row({ period_type: 'monthly', period_start: '2026-10-01' }),
    ]);
    expect(summary.get('b-1')?.count).toBe(2);
  });

  it('行が無ければ空', () => {
    expect(summarizeBadgePeriodAwards([]).size).toBe(0);
  });
});

describe('formatBadgePeriodAwards', () => {
  const latest = { periodType: 'monthly' as const, periodStart: '2026-09-01', label: '2026年9月', message: null };

  it('1 回なら期間だけ', () => {
    expect(formatBadgePeriodAwards({ count: 1, latest })).toBe('2026年9月');
  });

  it('2 回以上なら回数を添える', () => {
    expect(formatBadgePeriodAwards({ count: 2, latest })).toBe('2026年9月（通算 2 回）');
    expect(formatBadgePeriodAwards({ count: 3, latest })).toBe('2026年9月（通算 3 回）');
  });
});

describe('期間の種類の一覧', () => {
  it('migration の CHECK 制約と同じ 3 種類', () => {
    const migrations = fs.readdirSync(path.join(ROOT, 'supabase/migrations')).filter((f) => /^\d{14}_user_badge_period_awards\.sql$/.test(f));
    expect(migrations).toHaveLength(1);
    const sql = fs.readFileSync(path.join(ROOT, 'supabase/migrations', migrations[0]), 'utf8');
    const check = /CHECK \(period_type IN \(([^)]*)\)\)/.exec(sql);
    expect(check).not.toBeNull();
    const values = (check?.[1] ?? '').split(',').map((v) => v.trim().replace(/^'|'$/g, ''));
    expect(values).toEqual([...BADGE_AWARD_PERIOD_TYPES]);
  });

  it('確定の回がある期間の種類 (Edge Function の JST_CALENDAR_PERIOD_TYPES) と同じ', () => {
    const source = fs.readFileSync(path.join(ROOT, 'supabase/functions/_shared/jst-date.ts'), 'utf8');
    const declared = /JST_CALENDAR_PERIOD_TYPES = \[([^\]]*)\]/.exec(source);
    expect(declared).not.toBeNull();
    const values = (declared?.[1] ?? '').split(',').map((v) => v.trim().replace(/^'|'$/g, ''));
    expect(values).toEqual([...BADGE_AWARD_PERIOD_TYPES]);
  });

  it('index から読める (Web・モバイルは @homegohan/shared から使う)', () => {
    expect(shared.formatBadgePeriodAwards).toBe(formatBadgePeriodAwards);
    expect(shared.summarizeBadgePeriodAwards).toBe(summarizeBadgePeriodAwards);
  });
});
