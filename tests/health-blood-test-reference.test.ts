import { describe, expect, it } from 'vitest';
import {
  BLOOD_METRIC_DEFS,
  evaluateStatus,
  formatRangeText,
  getRangeForSex,
} from '../src/lib/health-blood-test-reference';

// #1055 UX3-24: checkups詳細画面とblood-tests一覧画面が共通で参照する基準値モジュールの契約テスト。
// 従来は性別非依存 (実質女性寄り) の固定値だったため、性別で分岐することを保証する。
describe('health-blood-test-reference', () => {
  it('uses different hemoglobin ranges for male and female', () => {
    const male = getRangeForSex('hemoglobin', 'male');
    const female = getRangeForSex('hemoglobin', 'female');
    expect(male).not.toEqual(female);
    expect(male?.low).toBeGreaterThan(female?.low ?? 0);
  });

  it('flags a male-normal hemoglobin value as low when evaluated against the female range but normal for male', () => {
    // 12.5 g/dL: 女性の正常範囲内だが、男性の下限 (13.5) を下回る
    expect(evaluateStatus('hemoglobin', 12.5, 'male')).toBe('low');
    expect(evaluateStatus('hemoglobin', 12.5, 'female')).toBe('normal');
  });

  it('falls back to a combined (widened) range when sex is unknown, flagging only values that are definitively abnormal for either sex (avoiding false positives)', () => {
    const combined = getRangeForSex('hemoglobin', null);
    const male = getRangeForSex('hemoglobin', 'male');
    const female = getRangeForSex('hemoglobin', 'female');
    expect(combined?.low).toBe(Math.min(male!.low!, female!.low!));
    expect(combined?.high).toBe(Math.max(male!.high!, female!.high!));
  });

  // #1055 (wave-3b): combinedRange のコメント/テスト名が「見逃さない」設計だと誤って
  // 逆方向に説明していたのを修正。実際の挙動 = 性別不明時は widened range により、
  // 「片方の性別なら異常」という値でも誤って異常フラグを立てない (false positive 回避)。
  // その代わり、実際の性別を知っていれば異常と判定できたはずの値を見逃す (false negative) 余地はある。
  it('does not flag a value that is normal for one sex but low for the other when sex is unknown (avoids a false alarm)', () => {
    // 12.5 g/dL は男性なら low、女性なら normal。性別不明時は誤警報を避け normal 扱いにする。
    expect(evaluateStatus('hemoglobin', 12.5, null)).toBe('normal');
  });

  it('evaluates high/low/normal/unknown correctly', () => {
    expect(evaluateStatus('ldl_cholesterol', 200, 'male')).toBe('high');
    expect(evaluateStatus('hdl_cholesterol', 20, 'female')).toBe('low');
    expect(evaluateStatus('egfr', 90, 'male')).toBe('normal');
    expect(evaluateStatus('egfr', undefined, 'male')).toBe('unknown');
    expect(evaluateStatus('not_a_real_metric', 100, 'male')).toBe('unknown');
  });

  it('formats range text for both single-bound and double-bound ranges', () => {
    expect(formatRangeText({ low: 40 })).toBe('40以上');
    expect(formatRangeText({ high: 130 })).toBe('130以下');
    expect(formatRangeText({ low: 13.5, high: 17.6 })).toBe('13.5〜17.6');
    expect(formatRangeText(null)).toBe('-');
  });

  it('every metric def has a label and unit usable in both consuming screens', () => {
    for (const key of Object.keys(BLOOD_METRIC_DEFS)) {
      const def = BLOOD_METRIC_DEFS[key];
      expect(def.label.length).toBeGreaterThan(0);
      expect(typeof def.unit).toBe('string');
    }
  });
});
