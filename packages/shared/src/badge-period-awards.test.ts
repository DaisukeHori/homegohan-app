/**
 * badge-period-awards (比較ランキングのバッジを取った期間の見せ方。#1528) のユニットテスト
 *
 * 確かめること:
 *   - formatBadgeAwardPeriodLabel: 日・週 (月曜〜日曜。月・年をまたぐ形)・月の文。分からない種類・形の違う日付・存在しない日付は null
 *   - toBadgePeriodAwardsByBadgeId: DB の関数 get_my_badge_period_award_summaries がバッジごとにまとめた行 (回数と最新の期間) を、
 *     一覧に添える形 (回数・最新の期間の文) にする。回数は DB の数をそのまま使う (1,000 を超えても丸めない)。
 *     最新の期間が読めない行・回数が 1 以上の整数でない行は出さない
 *     (まとめ方 (回数・最新の決め方) そのものは DB の関数。実 DB の tests/integration/rls/user-badge-period-awards.test.ts で確かめる)
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
  toBadgePeriodAwardsByBadgeId,
  type BadgePeriodAwardSummaryRow,
} from './badge-period-awards';
import * as shared from './index';

const ROOT = path.resolve(__dirname, '../../..');

const row = (overrides: Partial<BadgePeriodAwardSummaryRow> = {}): BadgePeriodAwardSummaryRow => ({
  badge_id: 'b-1',
  award_count: 1,
  latest_period_type: 'weekly',
  latest_period_start: '2026-10-05',
  latest_message: null,
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

describe('toBadgePeriodAwardsByBadgeId', () => {
  it('回数 1 なら、その期間と判定の文を返す', () => {
    const summary = toBadgePeriodAwardsByBadgeId([row({ latest_message: '🏆 全体の朝食率で1位！' })]);
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

  it('回数は DB の数をそのまま使う (PostgREST の 1 回の上限 1,000 を超えた数も丸めない)', () => {
    const summary = toBadgePeriodAwardsByBadgeId([
      row({ award_count: 1500, latest_period_type: 'daily', latest_period_start: '2030-02-07' }),
    ]).get('b-1');
    expect(summary).toEqual({
      count: 1500,
      latest: { periodType: 'daily', periodStart: '2030-02-07', label: '2030年2月7日', message: null },
    });
  });

  it('バッジごとに分ける', () => {
    const summary = toBadgePeriodAwardsByBadgeId([
      row({ badge_id: 'b-1', award_count: 2 }),
      row({ badge_id: 'b-2', latest_period_type: 'monthly', latest_period_start: '2026-09-01' }),
    ]);
    expect([...summary.keys()].sort()).toEqual(['b-1', 'b-2']);
    expect(summary.get('b-1')?.count).toBe(2);
    expect(summary.get('b-2')).toMatchObject({ count: 1, latest: { label: '2026年9月' } });
  });

  it.each([
    ['種類が分からない', { latest_period_type: 'all_time', latest_period_start: '2024-01-01' }],
    ['存在しない日付', { latest_period_start: '2026-02-30' }],
    ['形の違う日付', { latest_period_start: '2026/10/05' }],
    ['回数が 0', { award_count: 0 }],
    ['回数が負', { award_count: -1 }],
    ['回数が整数でない', { award_count: 1.5 }],
  ])('最新の期間が読めない・回数が意味を持たない行は出さない (%s)', (_label, overrides) => {
    const summary = toBadgePeriodAwardsByBadgeId([row({ badge_id: 'b-x', ...overrides }), row({ badge_id: 'b-ok' })]);
    expect(summary.has('b-x')).toBe(false);
    expect(summary.has('b-ok')).toBe(true);
  });

  it('行が無ければ空', () => {
    expect(toBadgePeriodAwardsByBadgeId([]).size).toBe(0);
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
    expect(shared.toBadgePeriodAwardsByBadgeId).toBe(toBadgePeriodAwardsByBadgeId);
  });
});
