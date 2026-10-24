/**
 * #1482 (#1463 の続き) の回帰テスト (画面とサーバーで共有する値・スキーマ・純粋な関数)。
 *
 * 2. 献立生成の「期間を指定」の上限 (@homegohan/shared の menu-generation-range) を、Web の画面・モバイルの画面・
 *    サーバー (POST /api/ai/menu/v4/generate・/v5/generate。実際に呼ぶ確認は tests/date-entry-leftovers-1482-routes.test.ts)・
 *    端末の slot-builder が同じ値で使うこと。値そのもの (31 日・今日から 30 日先) もここで固定する
 * 1. 運営の A/B テスト・エクスポートのスキーマと、健康の入力の日付の項目は、存在しない日付 (2026-02-30 など) を通さない
 * 5. 運営の LLM 使用量の異常使用は、1 日あたり (JST の暦日) のリクエスト数で判定し、画面の文も同じ値から作る
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  addDaysToDate,
  isWithinMenuGenerationRange,
  MENU_GENERATION_RANGE_MAX_DAYS,
  MENU_GENERATION_RANGE_START_MAX_DAYS_AHEAD,
  menuGenerationRangeEndMax,
  menuGenerationRangeStartMax,
} from '@homegohan/shared';
import { generateRangeEndMax, generateRangeStartMax } from '@/components/ai-assistant/V4GenerateModal';
import { buildAllFutureSlots, buildRangeSlots, validateSlotCount } from '../lib/slot-builder';
import { CreateExperimentSchema, UpdateExperimentSchema } from '@/lib/super-admin/experiments-schemas';
import { CreateExportSchema } from '@/lib/super-admin/exports-schemas';
import {
  sanitizeHealthCheckupPayload,
  sanitizeHealthGoalCreate,
  sanitizeNotificationPreferences,
} from '@/lib/health-payloads';
import {
  findLlmUsageAnomalousUsers,
  LLM_USAGE_ANOMALY_DAILY_REQUESTS,
  LLM_USAGE_ANOMALY_NOTICE,
} from '@/lib/super-admin/llm-usage-anomaly';

const ROOT = resolve(__dirname, '..');
const read = (path: string) => readFileSync(resolve(ROOT, path), 'utf8');

/** 画面の説明「最大31日」の日数 (手で書いた期待値) */
const EXPECTED_RANGE_MAX_DAYS = 31;
/** 画面の説明「今日から1ヶ月先まで」の日数 (手で書いた期待値) */
const EXPECTED_START_MAX_DAYS_AHEAD = 30;

/** 実在しない日付・範囲の外の日付 */
const INVALID_DATES = ['2026-02-30', '2027-02-29', '2026-13-01', '9999-12-31', '0100-01-01'] as const;

describe('2. 献立生成の期間の上限: 画面・サーバー・slot-builder が同じ値', () => {
  it('上限の値は、期間 31 日 (開始日を含む)・開始日は今日から 30 日先まで', () => {
    expect(MENU_GENERATION_RANGE_MAX_DAYS).toBe(EXPECTED_RANGE_MAX_DAYS);
    expect(MENU_GENERATION_RANGE_START_MAX_DAYS_AHEAD).toBe(EXPECTED_START_MAX_DAYS_AHEAD);
    expect(menuGenerationRangeStartMax('2026-10-14')).toBe('2026-11-13');
    expect(menuGenerationRangeEndMax('2026-10-14')).toBe('2026-11-13');
    expect(menuGenerationRangeEndMax('2026-12-15')).toBe('2027-01-14');
    // 開始日が日付でない (空欄・入力の途中) ときは上限を付けない
    expect(menuGenerationRangeEndMax('')).toBeUndefined();
    expect(menuGenerationRangeEndMax('2026-1')).toBeUndefined();
  });

  it('Web の画面の上限 (generateRangeStartMax / generateRangeEndMax) は、共有の関数そのもの', () => {
    expect(generateRangeStartMax).toBe(menuGenerationRangeStartMax);
    expect(generateRangeEndMax).toBe(menuGenerationRangeEndMax);
  });

  it.each(['2026-10-01', '2026-12-15', '2028-02-10', '2026-01-31'])(
    '開始日 %s: 画面が選ばせる最後の日まではサーバーの幅の確認を通り、その翌日は通らない',
    (start) => {
      const endMax = generateRangeEndMax(start)!;
      expect(isWithinMenuGenerationRange([start, endMax])).toBe(true);
      expect(isWithinMenuGenerationRange([start, addDaysToDate(endMax, 1)])).toBe(false);
      // 並び順によらない
      expect(isWithinMenuGenerationRange([addDaysToDate(endMax, 1), start])).toBe(false);
    },
  );

  it('サーバー (v4 / v5 generate)・モバイルの画面は、共有の値と関数を使う (別の数値を書かない)', () => {
    for (const path of ['src/app/api/ai/menu/v4/generate/route.ts', 'src/app/api/ai/menu/v5/generate/route.ts']) {
      const source = read(path);
      expect(source, path).toMatch(/import \{[^}]*isWithinMenuGenerationRange[^}]*\} from '@homegohan\/shared'/);
      expect(source, path).toContain('isWithinMenuGenerationRange(validated.map(');
      expect(source, path).not.toMatch(/slots\.length > 93/);
    }
    const mobile = read('apps/mobile/src/components/menu/V4GenerateModal.tsx');
    expect(mobile).toMatch(/import \{[^}]*menuGenerationRangeEndMax[^}]*menuGenerationRangeStartMax[^}]*\} from "@homegohan\/shared"/);
  });

  it('画面の説明「最大31日」は、共有の値と同じ日数', () => {
    for (const path of ['src/components/ai-assistant/V4GenerateModal.tsx', 'apps/mobile/src/components/menu/V4GenerateModal.tsx']) {
      expect(read(path), path).toContain(`開始〜終了を選んで生成（最大${MENU_GENERATION_RANGE_MAX_DAYS}日）`);
    }
  });

  it('slot-builder: 31 日間 (開始日 + 30 日) は作り、32 日間は投げる (以前は 32 日間まで通り、サーバーの上限と 1 日ずれていた)', () => {
    const slots = buildRangeSlots({ mealPlanDays: [], startDate: '2026-10-01', endDate: '2026-10-31' });
    expect(slots).toHaveLength(EXPECTED_RANGE_MAX_DAYS * 3);
    expect(validateSlotCount(slots)).toEqual({ valid: true });
    expect(() => buildRangeSlots({ mealPlanDays: [], startDate: '2026-10-01', endDate: '2026-11-01' })).toThrow(
      '期間は最大31日までです',
    );
    expect(() => buildAllFutureSlots({ mealPlanDays: [], startDate: '2026-10-01', endDate: '2026-11-01' })).toThrow(
      '期間は最大31日までです',
    );
    // 日付が空・不正・逆順のときは以前どおり 0 件 (投げない)
    expect(buildRangeSlots({ mealPlanDays: [], startDate: '', endDate: '2030-01-01' })).toEqual([]);
    expect(buildRangeSlots({ mealPlanDays: [], startDate: '2026-10-31', endDate: '2026-10-01' })).toEqual([]);
  });

  it('slot-builder: slot の数の上限は 93 (31 日 × 3 食)', () => {
    const slot = { date: '2026-10-01', mealType: 'dinner' as const };
    expect(validateSlotCount(Array.from({ length: 93 }, () => slot))).toEqual({ valid: true });
    expect(validateSlotCount(Array.from({ length: 94 }, () => slot))).toEqual({
      valid: false,
      message: 'スロット数が上限を超えています（94/93）',
    });
  });
});

describe('1. 運営の A/B テスト・エクスポートのスキーマは、実在する日付だけを通す', () => {
  const experiment = {
    key: 'exp_a',
    name: 'A',
    variants: [
      { key: 'a', weight: 50 },
      { key: 'b', weight: 50 },
    ],
  };

  it.each(INVALID_DATES)('%s は通さない (以前は正規表現だけで 2026-02-30 が通った)', (date) => {
    expect(CreateExperimentSchema.safeParse({ ...experiment, start_date: date }).success).toBe(false);
    expect(CreateExperimentSchema.safeParse({ ...experiment, end_date: date }).success).toBe(false);
    expect(UpdateExperimentSchema.safeParse({ end_date: date }).success).toBe(false);
    for (const key of ['registered_from', 'registered_to', 'from', 'to']) {
      expect(CreateExportSchema.safeParse({ export_type: 'user_data', filters: { [key]: date } }).success, key).toBe(false);
    }
  });

  it('実在する日付 (うるう年の 2/29) と、日付の省略は通す', () => {
    expect(CreateExperimentSchema.parse({ ...experiment, start_date: '2028-02-29', end_date: '2028-03-01' })).toMatchObject({
      start_date: '2028-02-29',
      end_date: '2028-03-01',
    });
    expect(CreateExperimentSchema.safeParse(experiment).success).toBe(true);
    expect(UpdateExperimentSchema.parse({ end_date: '2028-02-29' })).toEqual({ end_date: '2028-02-29' });
    expect(
      CreateExportSchema.parse({ export_type: 'user_data', filters: { from: '2028-02-29', to: '2028-03-01' } }).filters,
    ).toEqual({ from: '2028-02-29', to: '2028-03-01' });
  });
});

describe('1. 健康の入力の日付の項目 (健康診断の日・目標の期日・休止の期限) は、実在する日付だけを通す', () => {
  it.each(INVALID_DATES)('%s は errors に入り、data に入らない', (date) => {
    const checkup = sanitizeHealthCheckupPayload({ checkup_date: date });
    expect(checkup.errors).toEqual(['受診日 (checkup_date)はYYYY-MM-DD の形の、0101-01-02 から 9998-12-30 までの実在する日付で指定してください']);
    expect(checkup.data).not.toHaveProperty('checkup_date');

    const goal = sanitizeHealthGoalCreate({ goal_type: 'weight', target_value: 60, target_date: date });
    expect(goal.errors).toContain('目標の日付 (target_date)はYYYY-MM-DD の形の、0101-01-02 から 9998-12-30 までの実在する日付で指定してください');

    const prefs = sanitizeNotificationPreferences({ vacation_until: date });
    expect(prefs.errors).toEqual(['お休みモードの終わりの日 (vacation_until)はYYYY-MM-DD の形の、0101-01-02 から 9998-12-30 までの実在する日付で指定してください']);
  });

  it('実在する日付は前後の空白を除いて通す', () => {
    expect(sanitizeHealthCheckupPayload({ checkup_date: ' 2028-02-29 ' })).toEqual({
      data: { checkup_date: '2028-02-29' },
      errors: [],
    });
  });
});

describe('5. 運営の LLM 使用量: 異常使用は 1 日あたり (JST の暦日) で判定する', () => {
  // 1 日あたりの回数は DB の関数 llm_usage_summary が JST の暦日ごとに数え、ユーザーごとの最大の日の回数 (max_daily_requests) を返す (#1498)。
  // 以前は route が読んだ行を数えていたので、ここでも 5,000 行超の行を組み立てていた (全件の実行で時間切れになった)。
  // 行を数える部分 (JST の日の区切り・期間の合計では判定しないこと・打ち切りが無いこと) は、実 DB の
  // tests/integration/security/llm-usage-summary.test.ts で確かめる。ここでは、しきい値の境界と user_id の扱いを確かめる
  const USER_A = 'user-a';
  const USER_B = 'user-b';

  it('基準は 1 日 5,000 リクエスト (設計書 operator/03-ui-spec.md「1 ユーザー 5,000 req/日超」)、画面の文も同じ値', () => {
    expect(LLM_USAGE_ANOMALY_DAILY_REQUESTS).toBe(5000);
    expect(LLM_USAGE_ANOMALY_NOTICE).toBe('1日 5,000 リクエスト超のユーザーがいます');
    expect(read('src/app/super-admin/llm/page.tsx')).toContain('{LLM_USAGE_ANOMALY_NOTICE}');
  });

  it('1 日の最大が 5,001 回なら異常、5,000 回ちょうどは異常でない', () => {
    const anomalous = findLlmUsageAnomalousUsers([
      { user_id: USER_A, max_daily_requests: 5001 },
      { user_id: USER_B, max_daily_requests: 5000 },
    ]);
    expect([...anomalous]).toEqual([USER_A]);
  });

  it('判定に使うのは 1 日あたりの最大の回数 (DB の関数が返す max_daily_requests)。期間の合計では判定しない', () => {
    // 期間の合計が 5,000 回を超えていても (3,000 回の日が 2 日)、1 日の最大が 3,000 回なら異常でない
    expect(findLlmUsageAnomalousUsers([{ user_id: USER_A, max_daily_requests: 3000 }]).size).toBe(0);
    // route は DB の関数に同じ定数をしきい値として渡す (値を 2 か所に書かない)
    expect(read('src/lib/super-admin/llm-usage-summary.ts')).toContain('p_anomaly_daily_requests: LLM_USAGE_ANOMALY_DAILY_REQUESTS');
  });

  it('user_id が null (user_id の無い行をまとめたもの) は "unknown" にまとめる', () => {
    const anomalous = findLlmUsageAnomalousUsers([
      { user_id: null, max_daily_requests: 5001 },
      { user_id: USER_B, max_daily_requests: 0 },
    ]);
    expect([...anomalous]).toEqual(['unknown']);
  });
});
