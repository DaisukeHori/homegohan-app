// @vitest-environment node
/**
 * src/__tests__/lib/super-admin/evaluate-flag-fetch.test.ts
 *
 * #1148: feature_flags の行を読む fetchFlagRecord と、それを使う fetchAndEvaluateFlag。
 *
 * - 行が無いときは null (「読めなかった」とは区別する)
 * - 読み出しに失敗したときは、握りつぶさず例外を投げる (isFeatureEnabled が既定値に倒してログに残す)
 * - key で 1 行に絞って読む (フラグの行以外は読まない)
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockMaybeSingle = vi.fn();
const mockEq = vi.fn((_column: string, _value: string) => ({ maybeSingle: mockMaybeSingle }));
const mockSelect = vi.fn((_columns: string) => ({ eq: mockEq }));
const mockFrom = vi.fn((_table: string) => ({ select: mockSelect }));

vi.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: () => ({ from: (table: string) => mockFrom(table) }),
}));

import { fetchAndEvaluateFlag, fetchFlagRecord } from '@/lib/super-admin/evaluate-flag';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('fetchFlagRecord', () => {
  it('feature_flags を key で 1 行に絞って読み、行をそのまま返す', async () => {
    const record = { key: 'ai_chat_enabled', enabled: true, rollout_strategy: null, constraints: null };
    mockMaybeSingle.mockResolvedValue({ data: record, error: null });

    await expect(fetchFlagRecord('ai_chat_enabled')).resolves.toEqual(record);

    expect(mockFrom).toHaveBeenCalledWith('feature_flags');
    expect(mockSelect).toHaveBeenCalledWith('key, enabled, rollout_strategy, constraints');
    expect(mockEq).toHaveBeenCalledWith('key', 'ai_chat_enabled');
  });

  it('行が無いときは null', async () => {
    mockMaybeSingle.mockResolvedValue({ data: null, error: null });
    await expect(fetchFlagRecord('missing_flag')).resolves.toBeNull();
  });

  it('読み出しに失敗したときは、null にせず例外を投げる (メッセージとコードを含める)', async () => {
    mockMaybeSingle.mockResolvedValue({ data: null, error: { message: 'permission denied', code: '42501' } });

    const error = await fetchFlagRecord('ai_chat_enabled').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('permission denied');
    expect((error as Error).message).toContain('42501');
  });
});

describe('fetchAndEvaluateFlag', () => {
  const ctx = { userId: 'user-1' };

  it('行があれば evaluateFlag の判定を返す', async () => {
    mockMaybeSingle.mockResolvedValue({
      data: { key: 'f', enabled: true, rollout_strategy: null, constraints: null },
      error: null,
    });
    await expect(fetchAndEvaluateFlag('f', ctx)).resolves.toBe(true);

    mockMaybeSingle.mockResolvedValue({
      data: { key: 'f', enabled: false, rollout_strategy: null, constraints: null },
      error: null,
    });
    await expect(fetchAndEvaluateFlag('f', ctx)).resolves.toBe(false);
  });

  it('行が無いときは無効 (evaluateFlag の fail-closed の規則どおり)', async () => {
    mockMaybeSingle.mockResolvedValue({ data: null, error: null });
    await expect(fetchAndEvaluateFlag('missing_flag', ctx)).resolves.toBe(false);
  });

  it('読み出しに失敗したときは、無効として黙って返さず例外を投げる', async () => {
    mockMaybeSingle.mockResolvedValue({ data: null, error: { message: 'boom', code: 'XX000' } });
    await expect(fetchAndEvaluateFlag('f', ctx)).rejects.toThrow(/boom/);
  });
});
