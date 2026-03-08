import { describe, expect, it } from 'vitest';

import {
  countExtractedHealthFields,
  extractWeightScaleResult,
  normalizeClassifyPhotoResult,
  normalizeFridgeAnalysisResult,
  normalizeHealthCheckupExtractedData,
} from '../src/lib/ai/image-recognition';

describe('image recognition normalization', () => {
  it('normalizes and de-duplicates classification candidates', () => {
    const result = normalizeClassifyPhotoResult({
      type: 'fridge',
      confidence: '0.88',
      description: '冷蔵庫の棚',
      candidates: [
        { type: 'fridge', confidence: 0.88 },
        { type: 'meal', confidence: 0.44 },
        { type: 'fridge', confidence: 0.2 },
      ],
    });

    expect(result).toEqual({
      type: 'fridge',
      confidence: 0.88,
      description: '冷蔵庫の棚',
      candidates: [
        { type: 'fridge', confidence: 0.88 },
        { type: 'meal', confidence: 0.44 },
      ],
    });
  });

  it('filters invalid fridge ingredients and normalizes fields', () => {
    const result = normalizeFridgeAnalysisResult({
      ingredients: [
        { name: 'にんじん', category: '野菜', quantity: '2本', freshness: 'fresh', daysRemaining: 5 },
        { name: '', category: 'その他', quantity: '', freshness: 'good', daysRemaining: -1 },
        { name: '牛乳', category: 'invalid', quantity: '', freshness: 'invalid', daysRemaining: '2' },
      ],
      summary: '食材が入っています',
      suggestions: ['シチュー', '', '野菜炒め'],
    });

    expect(result).toEqual({
      ingredients: [
        { name: 'にんじん', category: '野菜', quantity: '2本', freshness: 'fresh', daysRemaining: 5 },
        { name: '牛乳', category: 'その他', quantity: '不明', freshness: 'good', daysRemaining: 2 },
      ],
      summary: '食材が入っています',
      suggestions: ['シチュー', '野菜炒め'],
    });
  });

  it('extracts weight scale values from nested function response', () => {
    const result = extractWeightScaleResult({
      success: true,
      result: {
        type: 'weight_scale',
        values: {
          weight: 65.2,
          body_fat_percentage: 18.4,
          muscle_mass: 48.1,
        },
        confidence: 0.93,
        raw_text: '65.2 18.4 48.1',
      },
    });

    expect(result).toEqual({
      weight: 65.2,
      bodyFat: 18.4,
      muscleMass: 48.1,
      confidence: 0.93,
      rawText: '65.2 18.4 48.1',
    });
  });

  it('counts extracted health fields excluding metadata', () => {
    const extracted = normalizeHealthCheckupExtractedData({
      checkupDate: '2026-03-01',
      height: 170.2,
      weight: 65.4,
      confidence: 0.91,
      notes: '良好',
    });

    expect(countExtractedHealthFields(extracted)).toBe(3);
  });
});
