import { describe, expect, it } from 'vitest';
import {
  ACCEPTED_GOAL_TYPE_DEFS,
  ACCEPTED_GOAL_TYPES,
  ADDITIONAL_GOAL_TYPE_DEFS,
  CANONICAL_GOAL_TYPES,
  FALLBACK_GOAL_RANGES,
  GOAL_TYPE_DEFS,
  HEALTH_GOAL_NUMERIC_MAX,
  describeGoalRangesForPrompt,
  findGoalTypeDef,
  getGoalTypeDef,
  getGoalTypeLabel,
  isWithinGoalRange,
} from '../src/lib/health-goal-types';

// #1055 UX3-15: goals/page.tsx と health/page.tsx (ダッシュボード) が共通で参照する
// 表示名マッピングの契約テスト。goal_type の英語生値がそのまま画面に漏れないことを保証する。
describe('health-goal-types', () => {
  it('returns Japanese labels for all known goal types', () => {
    expect(getGoalTypeLabel('weight')).toBe('体重');
    expect(getGoalTypeLabel('body_fat')).toBe('体脂肪率');
    expect(getGoalTypeLabel('steps')).toBe('1日の歩数');
  });

  it('never falls back to the raw goal_type value for unknown types', () => {
    const label = getGoalTypeLabel('some_future_goal_type');
    expect(label).not.toBe('some_future_goal_type');
    expect(label).toBe('その他の目標');
  });

  it('getGoalTypeDef falls back to the first def for unknown types', () => {
    const def = getGoalTypeDef('unknown');
    expect(def).toEqual(GOAL_TYPE_DEFS[0]);
  });

  it('every def has a non-empty label and unit', () => {
    for (const def of GOAL_TYPE_DEFS) {
      expect(def.label.length).toBeGreaterThan(0);
      expect(def.unit.length).toBeGreaterThan(0);
    }
  });
});

// #1229: API (POST/PUT /api/health/goals) と AI 相談の set_health_goal が受け付ける goal_type の契約。
describe('accepted goal types (#1229)', () => {
  it('the web creation list is unchanged: weight / body_fat / steps', () => {
    expect(GOAL_TYPE_DEFS.map((d) => d.type)).toEqual(['weight', 'body_fat', 'steps']);
  });

  it('also accepts what the current mobile app sends (step_count / sleep_hours) without offering them in the web UI', () => {
    expect(ADDITIONAL_GOAL_TYPE_DEFS.map((d) => d.type)).toEqual(['step_count', 'sleep_hours']);
    expect(ACCEPTED_GOAL_TYPES).toEqual(['weight', 'body_fat', 'steps', 'step_count', 'sleep_hours']);
    for (const type of ['weight', 'body_fat', 'steps', 'step_count', 'sleep_hours']) {
      expect(findGoalTypeDef(type)?.type).toBe(type);
    }
  });

  it('rejects everything else, including the AI prompt candidates the old prompt suggested', () => {
    for (const type of ['', ' ', ' weight', 'weight ', 'Weight', 'WEIGHT', 'exercise', 'etc', 'weight|body_fat', 'weight\n', '体重']) {
      expect(findGoalTypeDef(type)).toBeUndefined();
    }
  });

  it('does not resolve prototype keys as goal types (goal_type comes from user input)', () => {
    for (const type of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf']) {
      expect(findGoalTypeDef(type)).toBeUndefined();
      expect(getGoalTypeLabel(type)).toBe('その他の目標');
      expect(getGoalTypeDef(type)).toEqual(GOAL_TYPE_DEFS[0]);
    }
  });

  it('step_count is an alias of steps with the same label, unit and ranges', () => {
    const steps = findGoalTypeDef('steps')!;
    const stepCount = findGoalTypeDef('step_count')!;
    expect(stepCount.aliasOf).toBe('steps');
    expect({ ...stepCount, type: 'steps', aliasOf: undefined }).toEqual({ ...steps, aliasOf: undefined });
    // Web・AI には正式名だけを出す
    expect(CANONICAL_GOAL_TYPES).toEqual(['weight', 'body_fat', 'steps', 'sleep_hours']);
  });

  it('shows Japanese labels for the types the mobile app creates (web dashboard must not show raw keys)', () => {
    expect(getGoalTypeLabel('step_count')).toBe('1日の歩数');
    expect(getGoalTypeLabel('sleep_hours')).toBe('睡眠時間');
    expect(getGoalTypeDef('sleep_hours').unit).toBe('時間');
    expect(getGoalTypeDef('step_count').unit).toBe('歩');
  });

  // DB の health_goals_goal_type_format (supabase/migrations/20261007160600_health_goals_value_constraints.sql) と同じ式。
  // アプリが受け付ける種類が DB の CHECK 制約に弾かれないことを保証する。
  it('every accepted goal type satisfies the DB format check', () => {
    const dbFormat = /^[a-z][a-z0-9_-]{0,63}$/;
    for (const type of ACCEPTED_GOAL_TYPES) {
      expect(type).toMatch(dbFormat);
    }
  });
});

describe('goal value ranges (#1229)', () => {
  it('matches the ranges health_records uses for the same quantities', () => {
    // 体重 20-300 / 体脂肪率 1-70 / 歩数 0-100000 / 睡眠時間 0-24 (sanitizeHealthRecordPayload と同値)
    expect(findGoalTypeDef('weight')).toMatchObject({ target: { min: 20, max: 300 }, current: { min: 20, max: 300 } });
    expect(findGoalTypeDef('body_fat')).toMatchObject({ target: { min: 1, max: 70 }, current: { min: 1, max: 70 } });
    expect(findGoalTypeDef('steps')).toMatchObject({ target: { min: 1, max: 100000 }, current: { min: 0, max: 100000 } });
    expect(findGoalTypeDef('sleep_hours')).toMatchObject({ target: { min: 1, max: 24 }, current: { min: 0, max: 24 } });
  });

  // DB の health_goals_target_value_positive (target_value > 0) / health_goals_current_value_nonnegative
  // (current_value >= 0) と、numeric(10,2) の桁あふれに、アプリが受け付ける範囲が収まっていること。
  it('every range stays inside what the DB accepts', () => {
    for (const def of ACCEPTED_GOAL_TYPE_DEFS) {
      expect(def.target.min, `${def.type} target.min`).toBeGreaterThan(0);
      expect(def.target.min, `${def.type} target`).toBeLessThanOrEqual(def.target.max);
      expect(def.target.max, `${def.type} target.max`).toBeLessThanOrEqual(HEALTH_GOAL_NUMERIC_MAX);
      expect(def.current.min, `${def.type} current.min`).toBeGreaterThanOrEqual(0);
      expect(def.current.min, `${def.type} current`).toBeLessThanOrEqual(def.current.max);
      expect(def.current.max, `${def.type} current.max`).toBeLessThanOrEqual(HEALTH_GOAL_NUMERIC_MAX);
    }
  });

  it('the fallback range for unknown types only stops signs and overflow', () => {
    // 0.01 は numeric(10,2) に丸めても 0 にならない最小の正の値
    expect(FALLBACK_GOAL_RANGES.target).toEqual({ min: 0.01, max: 99999999.99 });
    expect(FALLBACK_GOAL_RANGES.current).toEqual({ min: 0, max: 99999999.99 });
  });

  it('isWithinGoalRange is inclusive at both ends and rejects non-finite or non-number values', () => {
    const range = { min: 20, max: 300 };
    expect(isWithinGoalRange(20, range)).toBe(true);
    expect(isWithinGoalRange(300, range)).toBe(true);
    expect(isWithinGoalRange(19.99, range)).toBe(false);
    expect(isWithinGoalRange(300.01, range)).toBe(false);
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, '60', null, undefined, {}]) {
      expect(isWithinGoalRange(value, range)).toBe(false);
    }
  });

  it('describes the canonical types and their target ranges for the AI prompt (no alias)', () => {
    const text = describeGoalRangesForPrompt();
    expect(text).toBe(
      'weight=体重 20〜300kg / body_fat=体脂肪率 1〜70% / steps=1日の歩数 1〜100000歩 / sleep_hours=睡眠時間 1〜24時間',
    );
    expect(text).not.toContain('step_count');
  });
});
