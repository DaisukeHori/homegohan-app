import { describe, expect, it } from 'vitest';
import { sanitizePerformanceCheckinPayload } from '../src/lib/performance-payloads';

/**
 * #1048 F2-18: performance 系 POST の入力検証欠如(weight 汚染・nutrition_targets 無制限変更)
 * の回帰テスト。user_performance_checkins には weight 等に DB CHECK が無いため、
 * アプリ層のレンジ検証が唯一の防波堤になる。
 */
describe('sanitizePerformanceCheckinPayload', () => {
  it('accepts a fully valid payload', () => {
    const result = sanitizePerformanceCheckinPayload({
      sleepHours: 7.5,
      sleepQuality: 4,
      fatigue: 2,
      focus: 4,
      hunger: 3,
      trainingLoadRpe: 6,
      trainingMinutes: 60,
      weight: 65.5,
      bodyFatPercentage: 18.2,
      restingHeartRate: 55,
      mood: 4,
      soreness: 2,
      note: 'いい感じ',
    });

    expect(result.errors).toEqual([]);
    expect(result.data).toEqual({
      sleepHours: 7.5,
      sleepQuality: 4,
      fatigue: 2,
      focus: 4,
      hunger: 3,
      trainingLoadRpe: 6,
      trainingMinutes: 60,
      weight: 65.5,
      bodyFatPercentage: 18.2,
      restingHeartRate: 55,
      mood: 4,
      soreness: 2,
      note: 'いい感じ',
    });
  });

  it('rejects an out-of-range weight (weight pollution, e.g. 5000kg)', () => {
    const result = sanitizePerformanceCheckinPayload({ weight: 5000 });
    expect(result.data.weight).toBeUndefined();
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('rejects a negative or zero weight', () => {
    const result = sanitizePerformanceCheckinPayload({ weight: -10 });
    expect(result.data.weight).toBeUndefined();
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('accepts the weight boundary values (20 and 300)', () => {
    expect(sanitizePerformanceCheckinPayload({ weight: 20 }).errors).toEqual([]);
    expect(sanitizePerformanceCheckinPayload({ weight: 300 }).errors).toEqual([]);
  });

  it('rejects values just outside the weight boundary', () => {
    expect(sanitizePerformanceCheckinPayload({ weight: 19.9 }).errors.length).toBeGreaterThan(0);
    expect(sanitizePerformanceCheckinPayload({ weight: 300.1 }).errors.length).toBeGreaterThan(0);
  });

  it('rejects 1-5 scale fields outside their range (mirrors the DB CHECK constraint)', () => {
    expect(sanitizePerformanceCheckinPayload({ mood: 0 }).errors.length).toBeGreaterThan(0);
    expect(sanitizePerformanceCheckinPayload({ mood: 6 }).errors.length).toBeGreaterThan(0);
    expect(sanitizePerformanceCheckinPayload({ fatigue: 10 }).errors.length).toBeGreaterThan(0);
  });

  it('rejects non-integer values for integer-only fields', () => {
    expect(sanitizePerformanceCheckinPayload({ mood: 3.5 }).errors.length).toBeGreaterThan(0);
    expect(sanitizePerformanceCheckinPayload({ trainingMinutes: 30.5 }).errors.length).toBeGreaterThan(0);
  });

  it('rejects trainingLoadRpe outside 1-10', () => {
    expect(sanitizePerformanceCheckinPayload({ trainingLoadRpe: 0 }).errors.length).toBeGreaterThan(0);
    expect(sanitizePerformanceCheckinPayload({ trainingLoadRpe: 11 }).errors.length).toBeGreaterThan(0);
    expect(sanitizePerformanceCheckinPayload({ trainingLoadRpe: 10 }).errors).toEqual([]);
  });

  it('rejects an absurd trainingMinutes value (> 1 day)', () => {
    expect(sanitizePerformanceCheckinPayload({ trainingMinutes: 100000 }).errors.length).toBeGreaterThan(0);
  });

  it('rejects an out-of-range restingHeartRate', () => {
    expect(sanitizePerformanceCheckinPayload({ restingHeartRate: 500 }).errors.length).toBeGreaterThan(0);
    expect(sanitizePerformanceCheckinPayload({ restingHeartRate: 0 }).errors.length).toBeGreaterThan(0);
  });

  it('strips unknown/forbidden keys (mass assignment protection)', () => {
    const result = sanitizePerformanceCheckinPayload({
      mood: 4,
      user_id: 'blocked',
      isAdmin: true,
    } as any);
    expect(result.errors).toEqual([]);
    expect(result.data).toEqual({ mood: 4 });
  });

  it('treats null/empty values as "not provided" rather than erroring', () => {
    const result = sanitizePerformanceCheckinPayload({ weight: null, note: '' });
    expect(result.errors).toEqual([]);
    expect(result.data.weight).toBeUndefined();
    expect(result.data.note).toBeUndefined();
  });

  it('rejects NaN-producing strings instead of silently coercing', () => {
    const result = sanitizePerformanceCheckinPayload({ weight: 'abc' });
    expect(result.data.weight).toBeUndefined();
    expect(result.errors.length).toBeGreaterThan(0);
  });
});
