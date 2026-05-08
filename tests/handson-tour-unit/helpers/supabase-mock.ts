/**
 * tests/handson-tour-unit/helpers/supabase-mock.ts
 *
 * Supabase クライアント mock ヘルパー。
 * vi.mock('@/lib/supabase/server') と組み合わせて使う。
 */

import { vi } from 'vitest';

// ──────────────────────────────────────────────────────────────
// 型定義
// ──────────────────────────────────────────────────────────────

export interface ProfileData {
  onboarding_completed_at: string | null;
  handson_tour_completed_at: string | null;
  handson_tour_skipped_at: string | null;
  roles: string[];
}

export interface MockProfileOptions {
  onboarding_completed_at?: string | null;
  handson_tour_completed_at?: string | null;
  handson_tour_skipped_at?: string | null;
  roles?: string[];
}

export interface RpcReturnOptions {
  rpc_name: string;
  value: unknown;
}

// ──────────────────────────────────────────────────────────────
// mock client の内部状態
// ──────────────────────────────────────────────────────────────

let _profileResult: { data: ProfileData | null; error: null | { message: string } } = {
  data: null,
  error: null,
};

let _rpcResult: { data: unknown; error: null } = { data: null, error: null };
let _updateResult: { error: null } = { error: null };

// ──────────────────────────────────────────────────────────────
// クエリビルダー (スタブ)
// ──────────────────────────────────────────────────────────────

function makeFromBuilder(profileResult: typeof _profileResult, updateResult: typeof _updateResult) {
  return vi.fn((table: string) => {
    if (table === 'user_profiles') {
      const builder: Record<string, unknown> = {};
      builder.select = vi.fn().mockReturnValue(builder);
      builder.eq = vi.fn().mockReturnValue(builder);
      builder.single = vi.fn().mockResolvedValue(profileResult);
      builder.update = vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          is: vi.fn().mockResolvedValue(updateResult),
        }),
      });
      return builder;
    }
    // fallback
    const builder: Record<string, unknown> = {};
    builder.select = vi.fn().mockReturnValue(builder);
    builder.eq = vi.fn().mockReturnValue(builder);
    builder.single = vi.fn().mockResolvedValue({ data: null, error: null });
    return builder;
  });
}

// ──────────────────────────────────────────────────────────────
// mock supabase client ファクトリ
// ──────────────────────────────────────────────────────────────

export const mockSupabaseClient = {
  from: makeFromBuilder(_profileResult, _updateResult),
  rpc: vi.fn().mockResolvedValue(_rpcResult),
};

// ──────────────────────────────────────────────────────────────
// ヘルパー: profile の返却値をセット
// ──────────────────────────────────────────────────────────────

export function mockProfile(opts: MockProfileOptions = {}): void {
  // Explicitly handle null so that opts.xxx = null is honored (not swallowed by ??)
  const data: ProfileData = {
    onboarding_completed_at: opts.onboarding_completed_at !== undefined
      ? opts.onboarding_completed_at
      : '2026-05-08T10:00:00Z',
    handson_tour_completed_at: opts.handson_tour_completed_at !== undefined
      ? opts.handson_tour_completed_at
      : null,
    handson_tour_skipped_at: opts.handson_tour_skipped_at !== undefined
      ? opts.handson_tour_skipped_at
      : null,
    roles: opts.roles ?? ['user'],
  };
  _profileResult = { data, error: null };

  // from builder を再生成して最新の _profileResult を参照させる
  mockSupabaseClient.from = makeFromBuilder(_profileResult, _updateResult);
}

export function mockProfileError(message: string): void {
  _profileResult = { data: null, error: { message } };
  mockSupabaseClient.from = makeFromBuilder(_profileResult, _updateResult);
}

// ──────────────────────────────────────────────────────────────
// ヘルパー: RPC の返却値をセット
// ──────────────────────────────────────────────────────────────

export function mockRpcReturn(opts: RpcReturnOptions): void {
  _rpcResult = { data: opts.value, error: null };
  mockSupabaseClient.rpc = vi.fn().mockResolvedValue(_rpcResult);
}

// ──────────────────────────────────────────────────────────────
// リセット
// ──────────────────────────────────────────────────────────────

export function resetSupabaseMock(): void {
  _profileResult = { data: null, error: null };
  _rpcResult = { data: null, error: null };
  _updateResult = { error: null };
  mockSupabaseClient.from = makeFromBuilder(_profileResult, _updateResult);
  mockSupabaseClient.rpc = vi.fn().mockResolvedValue(_rpcResult);
}
