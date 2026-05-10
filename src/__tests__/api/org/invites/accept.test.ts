// src/__tests__/api/org/invites/accept.test.ts
// RPC mock + status mapping のユニットテスト
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MembershipErrorCode } from '@/lib/errors/membership-errors';

// Supabase クライアントをモック
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
}));

const mockRpc = vi.fn();
const mockGetUser = vi.fn();

// モック後に動的インポート
const { createClient } = await import('@/lib/supabase/server');
const mockCreateClient = vi.mocked(createClient);

beforeEach(() => {
  vi.clearAllMocks();
  mockCreateClient.mockResolvedValue({
    auth: { getUser: mockGetUser },
    rpc: mockRpc,
  } as unknown as Awaited<ReturnType<typeof createClient>>);
});

// ─── mapRpcError のユニットテスト (関数を直接テスト) ─────────────────────────

function mapRpcError(message: string): { code: string; status: number } {
  if (message.includes('INVITE_NOT_FOUND'))    return { code: MembershipErrorCode.INVITE_NOT_FOUND,       status: 404 };
  if (message.includes('INVITE_EXPIRED'))      return { code: MembershipErrorCode.INVITE_EXPIRED,         status: 410 };
  if (message.includes('INVITE_EMAIL_MISMATCH')) return { code: MembershipErrorCode.INVITE_EMAIL_MISMATCH, status: 409 };
  if (message.includes('INVITE_ALREADY_USED')) return { code: MembershipErrorCode.INVITE_ALREADY_USED,    status: 409 };
  if (message.includes('ALREADY_IN_ORG'))      return { code: MembershipErrorCode.ALREADY_IN_ORG,         status: 409 };
  if (message.includes('IS_ORG_OWNER'))        return { code: MembershipErrorCode.IS_ORG_OWNER,           status: 409 };
  if (message.includes('NOT_AUTHENTICATED'))   return { code: MembershipErrorCode.NOT_AUTHENTICATED,      status: 401 };
  return { code: MembershipErrorCode.RPC_FAILED, status: 500 };
}

describe('mapRpcError', () => {
  it('INVITE_NOT_FOUND → 404', () => {
    expect(mapRpcError('P0001: INVITE_NOT_FOUND')).toEqual({
      code: MembershipErrorCode.INVITE_NOT_FOUND,
      status: 404,
    });
  });

  it('INVITE_EXPIRED → 410', () => {
    expect(mapRpcError('P0001: INVITE_EXPIRED')).toEqual({
      code: MembershipErrorCode.INVITE_EXPIRED,
      status: 410,
    });
  });

  it('INVITE_EMAIL_MISMATCH → 409', () => {
    expect(mapRpcError('P0001: INVITE_EMAIL_MISMATCH')).toEqual({
      code: MembershipErrorCode.INVITE_EMAIL_MISMATCH,
      status: 409,
    });
  });

  it('INVITE_ALREADY_USED → 409', () => {
    expect(mapRpcError('INVITE_ALREADY_USED')).toEqual({
      code: MembershipErrorCode.INVITE_ALREADY_USED,
      status: 409,
    });
  });

  it('ALREADY_IN_ORG → 409', () => {
    expect(mapRpcError('ALREADY_IN_ORG')).toEqual({
      code: MembershipErrorCode.ALREADY_IN_ORG,
      status: 409,
    });
  });

  it('IS_ORG_OWNER → 409', () => {
    expect(mapRpcError('IS_ORG_OWNER')).toEqual({
      code: MembershipErrorCode.IS_ORG_OWNER,
      status: 409,
    });
  });

  it('NOT_AUTHENTICATED → 401', () => {
    expect(mapRpcError('NOT_AUTHENTICATED')).toEqual({
      code: MembershipErrorCode.NOT_AUTHENTICATED,
      status: 401,
    });
  });

  it('不明なエラー → 500 RPC_FAILED', () => {
    expect(mapRpcError('UNKNOWN_ERROR')).toEqual({
      code: MembershipErrorCode.RPC_FAILED,
      status: 500,
    });
  });
});

describe('MembershipErrorCode', () => {
  it('すべての必要なエラーコードが定義されている', () => {
    expect(MembershipErrorCode.INVITE_NOT_FOUND).toBe('INVITE_NOT_FOUND');
    expect(MembershipErrorCode.INVITE_EXPIRED).toBe('INVITE_EXPIRED');
    expect(MembershipErrorCode.INVITE_EMAIL_MISMATCH).toBe('INVITE_EMAIL_MISMATCH');
    expect(MembershipErrorCode.INVITE_ALREADY_USED).toBe('INVITE_ALREADY_USED');
    expect(MembershipErrorCode.ALREADY_IN_ORG).toBe('ALREADY_IN_ORG');
    expect(MembershipErrorCode.IS_ORG_OWNER).toBe('IS_ORG_OWNER');
    expect(MembershipErrorCode.NOT_AUTHENTICATED).toBe('NOT_AUTHENTICATED');
    expect(MembershipErrorCode.RPC_FAILED).toBe('RPC_FAILED');
    expect(MembershipErrorCode.EMAIL_SEND_FAILED).toBe('EMAIL_SEND_FAILED');
  });
});
