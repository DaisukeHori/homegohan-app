import { describe, expect, it } from 'vitest';
import { GOAL_TYPE_DEFS, getGoalTypeDef, getGoalTypeLabel } from '../src/lib/health-goal-types';

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
