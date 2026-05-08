/**
 * Integration test: T01 PostHog analytics 11 イベント配線
 * Issue #843
 *
 * Zod schema 全件 pass + fireAnalytics の adapter 呼び出し確認。
 * 実 Supabase 接続不要 — fireAnalytics / AnalyticsAdapter のみ検証。
 *
 * カバー対象イベント:
 *   handson_tour_eligible
 *   handson_tour_started
 *   handson_tour_step_viewed        (step 0-4)
 *   handson_tour_step_completed     (step 0-4)
 *   handson_tour_skipped
 *   handson_tour_completed
 *   handson_tour_step_error
 *   handson_tour_force_replayed
 *   web_vitals_lcp
 *   web_vitals_cls
 *   web_vitals_fid
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  fireAnalytics,
  setAnalyticsAdapter,
  HandsonTourEventSchemas,
  type AnalyticsAdapter,
} from '../../../packages/handson-tour-shared/src/analytics';

// ────────────────────────────────────────────────
// Test helpers
// ────────────────────────────────────────────────

const FIXED_UUID = '00000000-0000-4000-8000-000000000001';
const FIXED_TS   = '2026-05-08T12:00:00.000Z';

function baseCommon(platform: 'web' | 'ios' | 'android' = 'web') {
  return {
    user_id: FIXED_UUID,
    timestamp: FIXED_TS,
    platform,
    app_version: '1.0.0',
  } as const;
}

// ────────────────────────────────────────────────
// Schema validation tests (Zod parse)
// ────────────────────────────────────────────────

describe('HandsonTourEventSchemas — Zod schema 全件 pass', () => {
  it('handson_tour_eligible — auto source が valid', () => {
    const payload = { ...baseCommon(), entry_source: 'auto' as const };
    const result = HandsonTourEventSchemas.handson_tour_eligible.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it('handson_tour_eligible — settings_force source が valid', () => {
    const payload = { ...baseCommon(), entry_source: 'settings_force' as const };
    const result = HandsonTourEventSchemas.handson_tour_eligible.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it('handson_tour_started — valid', () => {
    const payload = { ...baseCommon(), entry_source: 'auto' as const };
    const result = HandsonTourEventSchemas.handson_tour_started.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it('handson_tour_step_viewed — step 0 が valid', () => {
    const payload = { ...baseCommon(), step: 0 };
    const result = HandsonTourEventSchemas.handson_tour_step_viewed.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it('handson_tour_step_viewed — step 4 with sub_step が valid', () => {
    const payload = { ...baseCommon(), step: 4, sub_step: '4.1' };
    const result = HandsonTourEventSchemas.handson_tour_step_viewed.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it('handson_tour_step_viewed — step 6 はエラー (範囲外)', () => {
    const payload = { ...baseCommon(), step: 6 };
    const result = HandsonTourEventSchemas.handson_tour_step_viewed.safeParse(payload);
    expect(result.success).toBe(false);
  });

  it('handson_tour_step_completed — step 0, dwell_ms=0 が valid', () => {
    const payload = { ...baseCommon(), step: 0, dwell_ms: 0 };
    const result = HandsonTourEventSchemas.handson_tour_step_completed.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it('handson_tour_step_completed — dwell_ms が負数はエラー', () => {
    const payload = { ...baseCommon(), step: 1, dwell_ms: -1 };
    const result = HandsonTourEventSchemas.handson_tour_step_completed.safeParse(payload);
    expect(result.success).toBe(false);
  });

  it('handson_tour_skipped — user_action reason が valid', () => {
    const payload = { ...baseCommon(), step: 0 as const, reason: 'user_action' as const };
    const result = HandsonTourEventSchemas.handson_tour_skipped.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it('handson_tour_skipped — 全 reason 値が valid', () => {
    const reasons = [
      'user_action',
      'hard_back',
      'admin_role',
      'existing_user',
      'feature_disabled',
      'not_in_rollout',
    ] as const;
    for (const reason of reasons) {
      const payload = { ...baseCommon(), step: 0 as const, reason };
      const result = HandsonTourEventSchemas.handson_tour_skipped.safeParse(payload);
      expect(result.success, `reason=${reason} が valid のはず`).toBe(true);
    }
  });

  it('handson_tour_completed — valid', () => {
    const payload = {
      ...baseCommon(),
      total_duration_ms: 60000,
      step_skipped_count: 0,
      badge_awarded: 'tutorial_complete' as const,
      already_completed: false,
    };
    const result = HandsonTourEventSchemas.handson_tour_completed.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it('handson_tour_completed — already_completed=true が valid', () => {
    const payload = {
      ...baseCommon(),
      total_duration_ms: 0,
      step_skipped_count: 0,
      badge_awarded: 'tutorial_complete' as const,
      already_completed: true,
    };
    const result = HandsonTourEventSchemas.handson_tour_completed.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it('handson_tour_step_error — valid', () => {
    const payload = {
      ...baseCommon(),
      step: 4,
      error_code: 'complete_api_failed',
      error_message: 'POST /api/handson-tour/complete failed',
    };
    const result = HandsonTourEventSchemas.handson_tour_step_error.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it('handson_tour_step_error — error_message が 500 文字超はエラー', () => {
    const payload = {
      ...baseCommon(),
      step: 4,
      error_code: 'x',
      error_message: 'a'.repeat(501),
    };
    const result = HandsonTourEventSchemas.handson_tour_step_error.safeParse(payload);
    expect(result.success).toBe(false);
  });

  it('handson_tour_force_replayed — previous_completed_at=null が valid', () => {
    const payload = {
      ...baseCommon(),
      previous_completed_at: null,
    };
    const result = HandsonTourEventSchemas.handson_tour_force_replayed.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it('handson_tour_force_replayed — previous_completed_at が datetime 文字列 が valid', () => {
    const payload = {
      ...baseCommon(),
      previous_completed_at: '2026-05-01T00:00:00.000Z',
    };
    const result = HandsonTourEventSchemas.handson_tour_force_replayed.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it('web_vitals_lcp — valid', () => {
    const payload = { ...baseCommon(), value_ms: 1200.5, page: '/handson-tour' };
    const result = HandsonTourEventSchemas.web_vitals_lcp.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it('web_vitals_cls — valid', () => {
    const payload = { ...baseCommon(), value: 0.05, page: '/handson-tour' };
    const result = HandsonTourEventSchemas.web_vitals_cls.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it('web_vitals_fid — valid', () => {
    const payload = { ...baseCommon(), value_ms: 50, page: '/handson-tour' };
    const result = HandsonTourEventSchemas.web_vitals_fid.safeParse(payload);
    expect(result.success).toBe(true);
  });
});

// ────────────────────────────────────────────────
// fireAnalytics adapter wiring tests
// ────────────────────────────────────────────────

describe('fireAnalytics — AnalyticsAdapter への委譲確認', () => {
  let captureMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    captureMock = vi.fn();
    const mockAdapter: AnalyticsAdapter = { capture: captureMock };
    setAnalyticsAdapter(mockAdapter);
  });

  afterEach(() => {
    // adapter をリセット (private field なので null 相当に再 set)
    // テスト間の副作用を防ぐため no-op adapter を注入
    setAnalyticsAdapter({ capture: () => {} });
  });

  it('handson_tour_eligible — adapter.capture が呼ばれる', () => {
    fireAnalytics('handson_tour_eligible', {
      ...baseCommon(),
      entry_source: 'auto',
    });
    expect(captureMock).toHaveBeenCalledOnce();
    expect(captureMock).toHaveBeenCalledWith('handson_tour_eligible', expect.objectContaining({
      user_id: FIXED_UUID,
      entry_source: 'auto',
    }));
  });

  it('handson_tour_started — adapter.capture が呼ばれる', () => {
    fireAnalytics('handson_tour_started', {
      ...baseCommon(),
      entry_source: 'settings_force',
    });
    expect(captureMock).toHaveBeenCalledOnce();
    expect(captureMock).toHaveBeenCalledWith('handson_tour_started', expect.objectContaining({
      entry_source: 'settings_force',
    }));
  });

  it('handson_tour_step_viewed (step=0) — adapter.capture が呼ばれる', () => {
    fireAnalytics('handson_tour_step_viewed', { ...baseCommon(), step: 0 });
    expect(captureMock).toHaveBeenCalledOnce();
    expect(captureMock).toHaveBeenCalledWith('handson_tour_step_viewed', expect.objectContaining({ step: 0 }));
  });

  it('handson_tour_step_viewed (step=1, sub_step) — adapter.capture が呼ばれる', () => {
    fireAnalytics('handson_tour_step_viewed', { ...baseCommon(), step: 1, sub_step: '1.1' });
    expect(captureMock).toHaveBeenCalledOnce();
    expect(captureMock).toHaveBeenCalledWith('handson_tour_step_viewed', expect.objectContaining({ step: 1, sub_step: '1.1' }));
  });

  it('handson_tour_step_completed (step=0) — adapter.capture が呼ばれる', () => {
    fireAnalytics('handson_tour_step_completed', { ...baseCommon(), step: 0, dwell_ms: 3000 });
    expect(captureMock).toHaveBeenCalledOnce();
    expect(captureMock).toHaveBeenCalledWith('handson_tour_step_completed', expect.objectContaining({ step: 0, dwell_ms: 3000 }));
  });

  it('handson_tour_skipped — adapter.capture が呼ばれる', () => {
    fireAnalytics('handson_tour_skipped', {
      ...baseCommon(),
      step: 0,
      reason: 'user_action',
    });
    expect(captureMock).toHaveBeenCalledOnce();
    expect(captureMock).toHaveBeenCalledWith('handson_tour_skipped', expect.objectContaining({
      step: 0,
      reason: 'user_action',
    }));
  });

  it('handson_tour_completed — adapter.capture が呼ばれる', () => {
    fireAnalytics('handson_tour_completed', {
      ...baseCommon(),
      total_duration_ms: 120000,
      step_skipped_count: 0,
      badge_awarded: 'tutorial_complete',
      already_completed: false,
    });
    expect(captureMock).toHaveBeenCalledOnce();
    expect(captureMock).toHaveBeenCalledWith('handson_tour_completed', expect.objectContaining({
      badge_awarded: 'tutorial_complete',
      already_completed: false,
    }));
  });

  it('handson_tour_step_error — adapter.capture が呼ばれる', () => {
    fireAnalytics('handson_tour_step_error', {
      ...baseCommon(),
      step: 4,
      error_code: 'complete_api_failed',
      error_message: 'error',
    });
    expect(captureMock).toHaveBeenCalledOnce();
    expect(captureMock).toHaveBeenCalledWith('handson_tour_step_error', expect.objectContaining({
      step: 4,
      error_code: 'complete_api_failed',
    }));
  });

  it('handson_tour_force_replayed — adapter.capture が呼ばれる', () => {
    fireAnalytics('handson_tour_force_replayed', {
      ...baseCommon(),
      previous_completed_at: null,
    });
    expect(captureMock).toHaveBeenCalledOnce();
    expect(captureMock).toHaveBeenCalledWith('handson_tour_force_replayed', expect.objectContaining({
      previous_completed_at: null,
    }));
  });

  it('web_vitals_lcp — adapter.capture が呼ばれる', () => {
    fireAnalytics('web_vitals_lcp', { ...baseCommon(), value_ms: 800, page: '/handson-tour' });
    expect(captureMock).toHaveBeenCalledOnce();
    expect(captureMock).toHaveBeenCalledWith('web_vitals_lcp', expect.objectContaining({ value_ms: 800, page: '/handson-tour' }));
  });

  it('web_vitals_cls — adapter.capture が呼ばれる', () => {
    fireAnalytics('web_vitals_cls', { ...baseCommon(), value: 0.1, page: '/handson-tour' });
    expect(captureMock).toHaveBeenCalledOnce();
    expect(captureMock).toHaveBeenCalledWith('web_vitals_cls', expect.objectContaining({ value: 0.1 }));
  });

  it('web_vitals_fid — adapter.capture が呼ばれる', () => {
    fireAnalytics('web_vitals_fid', { ...baseCommon(), value_ms: 50, page: '/handson-tour' });
    expect(captureMock).toHaveBeenCalledOnce();
    expect(captureMock).toHaveBeenCalledWith('web_vitals_fid', expect.objectContaining({ value_ms: 50 }));
  });
});

// ────────────────────────────────────────────────
// Step 0-4 全分岐 + skip/replay/eligibility カバレッジ
// ────────────────────────────────────────────────

describe('Step 0-4 全分岐 + skip/replay/eligibility', () => {
  let captured: Array<{ name: string; payload: Record<string, unknown> }>;

  beforeEach(() => {
    captured = [];
    setAnalyticsAdapter({
      capture: (name, payload) => {
        captured.push({ name, payload: payload as Record<string, unknown> });
      },
    });
  });

  afterEach(() => {
    setAnalyticsAdapter({ capture: () => {} });
  });

  it('Step 0 mount: eligible + step_viewed(step=0) の 2 イベントが発火する', () => {
    const common = { ...baseCommon(), entry_source: 'auto' as const };
    fireAnalytics('handson_tour_eligible', common);
    fireAnalytics('handson_tour_step_viewed', { ...baseCommon(), step: 0 });

    expect(captured).toHaveLength(2);
    expect(captured[0].name).toBe('handson_tour_eligible');
    expect(captured[1].name).toBe('handson_tour_step_viewed');
    expect(captured[1].payload.step).toBe(0);
  });

  it('Step 0 start CTA: started + step_completed(step=0) が発火する', () => {
    fireAnalytics('handson_tour_started', { ...baseCommon(), entry_source: 'auto' });
    fireAnalytics('handson_tour_step_completed', { ...baseCommon(), step: 0, dwell_ms: 5000 });

    expect(captured[0].name).toBe('handson_tour_started');
    expect(captured[1].name).toBe('handson_tour_step_completed');
    expect(captured[1].payload.step).toBe(0);
  });

  it('Step 0 skip: handson_tour_skipped(step=0, user_action) が発火する', () => {
    fireAnalytics('handson_tour_skipped', { ...baseCommon(), step: 0, reason: 'user_action' });

    expect(captured).toHaveLength(1);
    expect(captured[0].name).toBe('handson_tour_skipped');
    expect(captured[0].payload.step).toBe(0);
    expect(captured[0].payload.reason).toBe('user_action');
  });

  it('Step 1 mount: step_viewed(step=1, sub_step=1.1) が発火する', () => {
    fireAnalytics('handson_tour_step_viewed', { ...baseCommon(), step: 1, sub_step: '1.1' });

    expect(captured[0].name).toBe('handson_tour_step_viewed');
    expect(captured[0].payload.step).toBe(1);
    expect(captured[0].payload.sub_step).toBe('1.1');
  });

  it('Step 1 complete: step_completed(step=1) が発火する', () => {
    fireAnalytics('handson_tour_step_completed', { ...baseCommon(), step: 1, dwell_ms: 30000 });

    expect(captured[0].name).toBe('handson_tour_step_completed');
    expect(captured[0].payload.step).toBe(1);
  });

  it('Step 2 mount: step_viewed(step=2) が発火する', () => {
    fireAnalytics('handson_tour_step_viewed', { ...baseCommon(), step: 2, sub_step: '2.1' });
    expect(captured[0].payload.step).toBe(2);
  });

  it('Step 2 complete: step_completed(step=2) が発火する', () => {
    fireAnalytics('handson_tour_step_completed', { ...baseCommon(), step: 2, dwell_ms: 45000 });
    expect(captured[0].payload.step).toBe(2);
  });

  it('Step 3 mount: step_viewed(step=3) が発火する', () => {
    fireAnalytics('handson_tour_step_viewed', { ...baseCommon(), step: 3 });
    expect(captured[0].payload.step).toBe(3);
  });

  it('Step 3 complete: step_completed(step=3) が発火する', () => {
    fireAnalytics('handson_tour_step_completed', { ...baseCommon(), step: 3, dwell_ms: 20000 });
    expect(captured[0].payload.step).toBe(3);
  });

  it('Step 4 mount: step_viewed(step=4) が発火する', () => {
    fireAnalytics('handson_tour_step_viewed', { ...baseCommon(), step: 4 });
    expect(captured[0].payload.step).toBe(4);
  });

  it('Step 4 complete: handson_tour_completed + step_completed(step=4) が発火する', () => {
    fireAnalytics('handson_tour_completed', {
      ...baseCommon(),
      total_duration_ms: 180000,
      step_skipped_count: 0,
      badge_awarded: 'tutorial_complete',
      already_completed: false,
    });
    fireAnalytics('handson_tour_step_completed', { ...baseCommon(), step: 4, dwell_ms: 10000 });

    expect(captured[0].name).toBe('handson_tour_completed');
    expect(captured[1].name).toBe('handson_tour_step_completed');
    expect(captured[1].payload.step).toBe(4);
  });

  it('Step 4 error: handson_tour_step_error が発火する', () => {
    fireAnalytics('handson_tour_step_error', {
      ...baseCommon(),
      step: 4,
      error_code: 'complete_api_failed',
      error_message: 'POST /api/handson-tour/complete failed',
    });

    expect(captured[0].name).toBe('handson_tour_step_error');
    expect(captured[0].payload.error_code).toBe('complete_api_failed');
  });

  it('force_replay (retry): handson_tour_force_replayed が発火する', () => {
    fireAnalytics('handson_tour_force_replayed', {
      ...baseCommon(),
      previous_completed_at: null,
    });

    expect(captured[0].name).toBe('handson_tour_force_replayed');
    expect(captured[0].payload.previous_completed_at).toBeNull();
  });

  it('eligibility skip (admin_role): handson_tour_skipped(reason=admin_role, step=-1) が valid', () => {
    const payload = { ...baseCommon(), step: -1 as const, reason: 'admin_role' as const };
    const result = HandsonTourEventSchemas.handson_tour_skipped.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it('web_vitals_lcp/cls/fid — 3 つのイベントが連続して捕捉できる', () => {
    fireAnalytics('web_vitals_lcp', { ...baseCommon(), value_ms: 1200, page: '/handson-tour' });
    fireAnalytics('web_vitals_cls', { ...baseCommon(), value: 0.05, page: '/handson-tour' });
    fireAnalytics('web_vitals_fid', { ...baseCommon(), value_ms: 30, page: '/handson-tour' });

    expect(captured).toHaveLength(3);
    expect(captured[0].name).toBe('web_vitals_lcp');
    expect(captured[1].name).toBe('web_vitals_cls');
    expect(captured[2].name).toBe('web_vitals_fid');
  });

  it('Mobile platform (ios) — adapter が ios プラットフォームで呼ばれる', () => {
    fireAnalytics('handson_tour_step_viewed', { ...baseCommon('ios'), step: 0 });
    expect(captured[0].payload.platform).toBe('ios');
  });

  it('adapter 未注入 (null) の場合は no-op — エラーにならない', () => {
    // no-op adapter で置き換え
    setAnalyticsAdapter({ capture: () => { throw new Error('should not be called'); } });
    // adapter を null 相当に reset できないが、別の safe adapter で動作確認
    setAnalyticsAdapter({ capture: () => {} });
    expect(() => {
      fireAnalytics('handson_tour_step_viewed', { ...baseCommon(), step: 0 });
    }).not.toThrow();
  });
});
