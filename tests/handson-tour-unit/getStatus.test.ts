/**
 * tests/handson-tour-unit/getStatus.test.ts
 *
 * src/lib/handson-tour/getStatus.ts の getHandsonTourStatusInternal() ユニットテスト。
 * 設計書: docs/design/family/09-onboarding-handson-tour/11-testing.md §2.2
 *
 * カバレッジ対象 6 ケース:
 *   1. 新規ユーザー (eligible)
 *   2. 完了済み (already_completed)
 *   3. スキップ済み (already_skipped)
 *   4. admin ロール (admin_role)
 *   5. 既存活動あり → auto-skip (existing_user_auto_skip)
 *   6. onboarding 未完 (onboarding_not_completed)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  mockProfile,
  mockProfileError,
  mockRpcReturn,
  mockSupabaseClient,
  resetSupabaseMock,
} from './helpers/supabase-mock';

// ──────────────────────────────────────────────────────────────
// @/lib/supabase/server を mock
// ──────────────────────────────────────────────────────────────

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(mockSupabaseClient),
}));

// ──────────────────────────────────────────────────────────────
// テスト対象 import (mock 設定後)
// ──────────────────────────────────────────────────────────────

import { getHandsonTourStatusInternal } from '@/lib/handson-tour/getStatus';

const USER_ID = 'test-user-001';

describe('getHandsonTourStatusInternal', () => {
  beforeEach(() => {
    resetSupabaseMock();
    vi.useRealTimers();
  });

  // ────────────────────────────────────────────────────────────
  // ケース 1: 新規ユーザー → eligible
  // ────────────────────────────────────────────────────────────
  it('新規ユーザーは should_show=true / reason=eligible を返す', async () => {
    mockProfile({
      onboarding_completed_at: '2026-05-08T10:00:00Z',
      handson_tour_completed_at: null,
      handson_tour_skipped_at: null,
      roles: ['user'],
    });
    mockRpcReturn({ rpc_name: 'user_has_non_sandbox_activity', value: false });

    const result = await getHandsonTourStatusInternal(USER_ID);

    expect(result.should_show).toBe(true);
    expect(result.reason).toBe('eligible');
    expect(result.completed_at).toBeNull();
    expect(result.skipped_at).toBeNull();
  });

  // ────────────────────────────────────────────────────────────
  // ケース 2: 完了済み → already_completed
  // ────────────────────────────────────────────────────────────
  it('handson_tour_completed_at が設定済みなら should_show=false / reason=already_completed', async () => {
    const completedAt = '2026-05-08T11:00:00Z';
    mockProfile({
      onboarding_completed_at: '2026-05-08T10:00:00Z',
      handson_tour_completed_at: completedAt,
      handson_tour_skipped_at: null,
      roles: ['user'],
    });

    const result = await getHandsonTourStatusInternal(USER_ID);

    expect(result.should_show).toBe(false);
    expect(result.reason).toBe('already_completed');
    expect(result.completed_at).toBe(completedAt);
  });

  // ────────────────────────────────────────────────────────────
  // ケース 3: スキップ済み → already_skipped
  // ────────────────────────────────────────────────────────────
  it('handson_tour_skipped_at が設定済みなら should_show=false / reason=already_skipped', async () => {
    const skippedAt = '2026-05-08T11:30:00Z';
    mockProfile({
      onboarding_completed_at: '2026-05-08T10:00:00Z',
      handson_tour_completed_at: null,
      handson_tour_skipped_at: skippedAt,
      roles: ['user'],
    });

    const result = await getHandsonTourStatusInternal(USER_ID);

    expect(result.should_show).toBe(false);
    expect(result.reason).toBe('already_skipped');
    expect(result.skipped_at).toBe(skippedAt);
  });

  // ────────────────────────────────────────────────────────────
  // ケース 4: admin ロール → admin_role (skipped_at はセットしない)
  // ────────────────────────────────────────────────────────────
  it('admin ロールを持つユーザーは should_show=false / reason=admin_role', async () => {
    mockProfile({
      onboarding_completed_at: '2026-05-08T10:00:00Z',
      handson_tour_completed_at: null,
      handson_tour_skipped_at: null,
      roles: ['user', 'admin'],
    });

    const result = await getHandsonTourStatusInternal(USER_ID);

    expect(result.should_show).toBe(false);
    expect(result.reason).toBe('admin_role');
    // admin は skipped_at を書き込まない (rpc は呼ばれない)
    expect(mockSupabaseClient.rpc).not.toHaveBeenCalled();
  });

  it('super_admin ロールも admin_role と同様に扱う', async () => {
    mockProfile({
      onboarding_completed_at: '2026-05-08T10:00:00Z',
      handson_tour_completed_at: null,
      handson_tour_skipped_at: null,
      roles: ['user', 'super_admin'],
    });

    const result = await getHandsonTourStatusInternal(USER_ID);

    expect(result.should_show).toBe(false);
    expect(result.reason).toBe('admin_role');
  });

  // ────────────────────────────────────────────────────────────
  // ケース 5: 既存活動あり → existing_user_auto_skip
  // ────────────────────────────────────────────────────────────
  it('既存の非 sandbox 活動があれば auto-skip して should_show=false / reason=existing_user_auto_skip', async () => {
    vi.useFakeTimers();
    const fakeNow = new Date('2026-05-08T12:00:00.000Z');
    vi.setSystemTime(fakeNow);

    mockProfile({
      onboarding_completed_at: '2026-05-08T10:00:00Z',
      handson_tour_completed_at: null,
      handson_tour_skipped_at: null,
      roles: ['user'],
    });
    mockRpcReturn({ rpc_name: 'user_has_non_sandbox_activity', value: true });

    const result = await getHandsonTourStatusInternal(USER_ID);

    expect(result.should_show).toBe(false);
    expect(result.reason).toBe('existing_user_auto_skip');
    expect(result.skipped_at).toBe(fakeNow.toISOString());
    // DB UPDATE が呼ばれた
    expect(mockSupabaseClient.from).toHaveBeenCalledWith('user_profiles');

    vi.useRealTimers();
  });

  // ────────────────────────────────────────────────────────────
  // ケース 6: onboarding 未完 → onboarding_not_completed
  // ────────────────────────────────────────────────────────────
  it('onboarding_completed_at が null なら should_show=false / reason=onboarding_not_completed', async () => {
    mockProfile({
      onboarding_completed_at: null,
      handson_tour_completed_at: null,
      handson_tour_skipped_at: null,
      roles: ['user'],
    });

    const result = await getHandsonTourStatusInternal(USER_ID);

    expect(result.should_show).toBe(false);
    expect(result.reason).toBe('onboarding_not_completed');
    expect(result.completed_at).toBeNull();
    expect(result.skipped_at).toBeNull();
  });

  // ────────────────────────────────────────────────────────────
  // エラーケース: profile が取得できない
  // ────────────────────────────────────────────────────────────
  it('profile 取得エラー時は profile_not_found エラーをスローする', async () => {
    mockProfileError('not found');

    await expect(getHandsonTourStatusInternal(USER_ID)).rejects.toMatchObject({
      message: 'profile_not_found',
    });
  });
});
