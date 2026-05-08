/**
 * tests/handson-tour-unit/schemas.test.ts
 *
 * src/lib/handson-tour/schemas.ts の Zod スキーマ検証テスト。
 * 設計書: docs/design/family/09-onboarding-handson-tour/11-testing.md §2
 *
 * テスト対象:
 *   - HandsonTourStatusResponseSchema
 *   - HandsonTourCompleteResponseSchema
 *   - HandsonTourSkipRequestSchema
 *   - HandsonTourSkipResponseSchema
 */

import { describe, it, expect } from 'vitest';
import {
  HandsonTourStatusResponseSchema,
  HandsonTourCompleteResponseSchema,
  HandsonTourSkipRequestSchema,
  HandsonTourSkipResponseSchema,
} from '@/lib/handson-tour/schemas';

// ──────────────────────────────────────────────────────────────
// HandsonTourStatusResponseSchema
// ──────────────────────────────────────────────────────────────

describe('HandsonTourStatusResponseSchema', () => {
  const validBase = {
    should_show: true,
    completed_at: null,
    skipped_at: null,
    reason: 'eligible' as const,
  };

  it('eligible の valid データをパースできる', () => {
    const result = HandsonTourStatusResponseSchema.safeParse(validBase);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.should_show).toBe(true);
      expect(result.data.reason).toBe('eligible');
    }
  });

  it('should_show=false / reason=already_completed をパースできる', () => {
    const data = {
      should_show: false,
      completed_at: '2026-05-08T11:00:00.000Z',
      skipped_at: null,
      reason: 'already_completed',
    };
    const result = HandsonTourStatusResponseSchema.safeParse(data);
    expect(result.success).toBe(true);
  });

  it('全ての有効な reason 値をパースできる', () => {
    const reasons = [
      'eligible',
      'onboarding_not_completed',
      'already_completed',
      'already_skipped',
      'admin_role',
      'existing_user_auto_skip',
      'feature_disabled',
      'not_in_rollout',
    ] as const;

    for (const reason of reasons) {
      const result = HandsonTourStatusResponseSchema.safeParse({
        ...validBase,
        should_show: false,
        reason,
      });
      expect(result.success, `reason=${reason} はパース成功すべき`).toBe(true);
    }
  });

  it('不明な reason 値はエラーになる', () => {
    const result = HandsonTourStatusResponseSchema.safeParse({
      ...validBase,
      reason: 'unknown_reason',
    });
    expect(result.success).toBe(false);
  });

  it('should_show が boolean でない場合はエラー', () => {
    const result = HandsonTourStatusResponseSchema.safeParse({
      ...validBase,
      should_show: 'true',
    });
    expect(result.success).toBe(false);
  });

  it('completed_at が ISO datetime でない文字列はエラー', () => {
    const result = HandsonTourStatusResponseSchema.safeParse({
      ...validBase,
      completed_at: 'not-a-datetime',
    });
    expect(result.success).toBe(false);
  });

  it('completed_at が null は許可される', () => {
    const result = HandsonTourStatusResponseSchema.safeParse({
      ...validBase,
      completed_at: null,
    });
    expect(result.success).toBe(true);
  });

  it('skipped_at が ISO datetime 文字列は許可される', () => {
    const result = HandsonTourStatusResponseSchema.safeParse({
      ...validBase,
      should_show: false,
      skipped_at: '2026-05-08T12:00:00.000Z',
      reason: 'already_skipped',
    });
    expect(result.success).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────
// HandsonTourCompleteResponseSchema
// ──────────────────────────────────────────────────────────────

describe('HandsonTourCompleteResponseSchema', () => {
  const validComplete = {
    completed_at: '2026-05-08T11:00:00.000Z',
    badge_awarded: {
      code: 'tutorial_complete' as const,
      name: 'チュートリアル完了',
      obtained_at: '2026-05-08T11:00:00.000Z',
      icon_url: null,
    },
    already_completed: false,
  };

  it('valid な完了レスポンスをパースできる', () => {
    const result = HandsonTourCompleteResponseSchema.safeParse(validComplete);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.already_completed).toBe(false);
      expect(result.data.badge_awarded.code).toBe('tutorial_complete');
    }
  });

  it('already_completed=true もパースできる', () => {
    const result = HandsonTourCompleteResponseSchema.safeParse({
      ...validComplete,
      already_completed: true,
    });
    expect(result.success).toBe(true);
  });

  it('total_duration_ms は省略可能', () => {
    const result = HandsonTourCompleteResponseSchema.safeParse(validComplete);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.total_duration_ms).toBeUndefined();
    }
  });

  it('total_duration_ms が整数で存在する場合はパースできる', () => {
    const result = HandsonTourCompleteResponseSchema.safeParse({
      ...validComplete,
      total_duration_ms: 12345,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.total_duration_ms).toBe(12345);
    }
  });

  it('badge_awarded.code が tutorial_complete 以外はエラー', () => {
    const result = HandsonTourCompleteResponseSchema.safeParse({
      ...validComplete,
      badge_awarded: {
        ...validComplete.badge_awarded,
        code: 'first_bite',
      },
    });
    expect(result.success).toBe(false);
  });

  it('icon_url に文字列を設定できる', () => {
    const result = HandsonTourCompleteResponseSchema.safeParse({
      ...validComplete,
      badge_awarded: {
        ...validComplete.badge_awarded,
        icon_url: 'https://example.com/badge.png',
      },
    });
    expect(result.success).toBe(true);
  });

  it('completed_at が ISO datetime でない場合はエラー', () => {
    const result = HandsonTourCompleteResponseSchema.safeParse({
      ...validComplete,
      completed_at: '2026/05/08',
    });
    expect(result.success).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────
// HandsonTourSkipRequestSchema
// ──────────────────────────────────────────────────────────────

describe('HandsonTourSkipRequestSchema', () => {
  it('step=0 / reason=user_action をパースできる', () => {
    const result = HandsonTourSkipRequestSchema.safeParse({
      step: 0,
      reason: 'user_action',
    });
    expect(result.success).toBe(true);
  });

  it('step=4 / reason=hard_back をパースできる', () => {
    const result = HandsonTourSkipRequestSchema.safeParse({
      step: 4,
      reason: 'hard_back',
    });
    expect(result.success).toBe(true);
  });

  it('step が 0〜4 の範囲の各値をパースできる', () => {
    for (let step = 0; step <= 4; step++) {
      const result = HandsonTourSkipRequestSchema.safeParse({
        step,
        reason: 'user_action',
      });
      expect(result.success, `step=${step} はパース成功すべき`).toBe(true);
    }
  });

  it('step が 5 以上はエラー', () => {
    const result = HandsonTourSkipRequestSchema.safeParse({
      step: 5,
      reason: 'user_action',
    });
    expect(result.success).toBe(false);
  });

  it('step が -1 はエラー', () => {
    const result = HandsonTourSkipRequestSchema.safeParse({
      step: -1,
      reason: 'user_action',
    });
    expect(result.success).toBe(false);
  });

  it('step が小数はエラー', () => {
    const result = HandsonTourSkipRequestSchema.safeParse({
      step: 1.5,
      reason: 'user_action',
    });
    expect(result.success).toBe(false);
  });

  it('不明な reason はエラー', () => {
    const result = HandsonTourSkipRequestSchema.safeParse({
      step: 1,
      reason: 'timeout',
    });
    expect(result.success).toBe(false);
  });

  it('reason が欠落するとエラー', () => {
    const result = HandsonTourSkipRequestSchema.safeParse({ step: 0 });
    expect(result.success).toBe(false);
  });

  it('step が欠落するとエラー', () => {
    const result = HandsonTourSkipRequestSchema.safeParse({ reason: 'user_action' });
    expect(result.success).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────
// HandsonTourSkipResponseSchema
// ──────────────────────────────────────────────────────────────

describe('HandsonTourSkipResponseSchema', () => {
  it('valid な skipped_at をパースできる', () => {
    const result = HandsonTourSkipResponseSchema.safeParse({
      skipped_at: '2026-05-08T12:00:00.000Z',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.skipped_at).toBe('2026-05-08T12:00:00.000Z');
    }
  });

  it('skipped_at が ISO datetime でない場合はエラー', () => {
    const result = HandsonTourSkipResponseSchema.safeParse({
      skipped_at: '2026-05-08',
    });
    expect(result.success).toBe(false);
  });

  it('skipped_at が null はエラー (nullable でない)', () => {
    const result = HandsonTourSkipResponseSchema.safeParse({
      skipped_at: null,
    });
    expect(result.success).toBe(false);
  });

  it('skipped_at が欠落するとエラー', () => {
    const result = HandsonTourSkipResponseSchema.safeParse({});
    expect(result.success).toBe(false);
  });
});
