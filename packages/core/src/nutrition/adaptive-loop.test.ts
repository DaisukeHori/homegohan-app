import { describe, expect, it } from 'vitest';
import { applyRecommendations } from './adaptive-loop';

/**
 * #1048 F2-18: performance/analyze の POST が recommendations をクライアントから
 * 信頼して適用しており、delta を捏造されると nutrition_targets を無制限に
 * 書き換えられた。applyRecommendations 側にも防御的な delta クランプを追加した
 * ので、その挙動を検証する。
 */
describe('applyRecommendations', () => {
  const baseTargets = { calories: 2000, protein: 100, fat: 60, carbs: 250 };

  it('applies a normal, small delta unchanged', () => {
    const result = applyRecommendations(
      baseTargets,
      [{ type: 'calories', delta: -150, reason: 'test', confidence: 'high', priority: 1 }],
      { applyTop: 1 },
    );
    expect(result.calories).toBe(1850);
    expect(result.appliedRecommendations[0].delta).toBe(-150);
  });

  it('clamps an oversized calories delta to maxCalorieChange', () => {
    const result = applyRecommendations(
      baseTargets,
      [{ type: 'calories', delta: 999999, reason: 'malicious', confidence: 'high', priority: 1 }],
      { applyTop: 1 },
    );
    expect(result.calories).toBe(2000 + 200); // default maxCalorieChange = 200
    expect(result.appliedRecommendations[0].delta).toBe(200);
  });

  it('clamps an oversized protein delta (previously unbounded)', () => {
    const result = applyRecommendations(
      baseTargets,
      [{ type: 'protein', delta: 999999, reason: 'malicious', confidence: 'high', priority: 1 }],
      { applyTop: 1 },
    );
    expect(result.protein).toBe(100 + 60); // default maxProteinChange = 60
    expect(result.appliedRecommendations[0].delta).toBe(60);
  });

  it('clamps an oversized carbs delta (previously unbounded)', () => {
    const result = applyRecommendations(
      baseTargets,
      [{ type: 'carbs', delta: -999999, reason: 'malicious', confidence: 'high', priority: 1 }],
      { applyTop: 1 },
    );
    expect(result.carbs).toBe(150); // 250 - 100 (clamped from -999999)
    expect(result.appliedRecommendations[0].delta).toBe(-100);
  });

  it('clamps an oversized fat delta (previously unbounded)', () => {
    const result = applyRecommendations(
      baseTargets,
      [{ type: 'fat', delta: 999999, reason: 'malicious', confidence: 'high', priority: 1 }],
      { applyTop: 1 },
    );
    expect(result.fat).toBe(60 + 50); // default maxFatChange = 50
    expect(result.appliedRecommendations[0].delta).toBe(50);
  });

  it('still respects the floor values (calories>=1200, protein>=40, carbs>=50, fat>=20)', () => {
    const tiny = { calories: 1250, protein: 45, fat: 25, carbs: 55 };
    const result = applyRecommendations(
      tiny,
      [
        { type: 'calories', delta: -999999, reason: 'x', confidence: 'high', priority: 1 },
      ],
      { applyTop: 1 },
    );
    expect(result.calories).toBe(1200);
  });

  it('only applies the top N recommendations', () => {
    const result = applyRecommendations(
      baseTargets,
      [
        { type: 'calories', delta: -100, reason: 'a', confidence: 'high', priority: 1 },
        { type: 'protein', delta: 15, reason: 'b', confidence: 'medium', priority: 2 },
      ],
      { applyTop: 1 },
    );
    expect(result.appliedRecommendations).toHaveLength(1);
    expect(result.protein).toBe(100); // 未適用のまま
  });
});
