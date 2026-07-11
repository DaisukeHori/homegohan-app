import { describe, expect, it } from 'vitest';
import { calculateGoalProgressPercentage } from '../src/lib/health-goal-progress';

// #1046 F2-12: 進捗率が変化の「方向」を無視する問題の回帰テスト。
// Math.abs で符号を潰すと、目標から遠ざかっても進捗が増えてしまっていた
// (例: start=80kg, target=70kg なのに current=85kg で進捗50%になっていた)。
describe('calculateGoalProgressPercentage', () => {
  it('returns 0% when moving away from a weight-loss goal (80 -> 85, target 70)', () => {
    // 修正前は Math.abs(85-80)/Math.abs(70-80) = 5/10 = 50% になっていた
    const result = calculateGoalProgressPercentage(80, 70, 85, 0);
    expect(result).toBe(0);
  });

  it('returns 50% for halfway progress toward a weight-loss goal (80 -> 75, target 70)', () => {
    const result = calculateGoalProgressPercentage(80, 70, 75, 0);
    expect(result).toBe(50);
  });

  it('clamps to 100% when the value overshoots past the weight-loss target (80 -> 60, target 70)', () => {
    const result = calculateGoalProgressPercentage(80, 70, 60, 0);
    expect(result).toBe(100);
  });

  it('works symmetrically for a weight-gain goal (60 -> 65, target 70)', () => {
    const result = calculateGoalProgressPercentage(60, 70, 65, 0);
    expect(result).toBe(50);
  });

  it('returns 0% when moving away from a weight-gain goal (60 -> 55, target 70)', () => {
    const result = calculateGoalProgressPercentage(60, 70, 55, 0);
    expect(result).toBe(0);
  });

  it('guards against division by zero when start equals target, returning the fallback', () => {
    const result = calculateGoalProgressPercentage(70, 70, 65, 42);
    expect(result).toBe(42);
  });

  it('returns exactly 100% at the target value', () => {
    expect(calculateGoalProgressPercentage(80, 70, 70, 0)).toBe(100);
  });

  it('returns exactly 0% at the start value', () => {
    expect(calculateGoalProgressPercentage(80, 70, 80, 0)).toBe(0);
  });
});
