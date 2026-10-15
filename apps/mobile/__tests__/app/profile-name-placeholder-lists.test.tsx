/**
 * profile-name-placeholder-lists.test.tsx
 * 組織のメンバー一覧・サポートのユーザー検索・サポートのユーザー詳細で、仮置きの名前 'Guest' を出さない (#1635)
 *
 * 名前が無いときにアプリが入れる仮置きの 'Guest' は、名前が無い人と同じく従来の既定 (no name) で出す。
 * 判定は Web と同じ @homegohan/shared の normalizeProfileName (前後の空白を除いて 'Guest' と厳密一致・空・空白だけは名前なし)。
 * 'guest'・'ゲスト' などは本人が付けた名前としてそのまま出す。
 */
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react-native';

const mockGet = jest.fn();
jest.mock('../../src/lib/api', () => ({
  getApi: () => ({ get: mockGet, post: jest.fn(), put: jest.fn(), patch: jest.fn(), del: jest.fn() }),
}));

jest.mock('expo-router', () => ({
  router: { back: jest.fn(), push: jest.fn(), replace: jest.fn() },
  useRouter: () => ({ back: jest.fn(), push: jest.fn(), replace: jest.fn() }),
  useLocalSearchParams: () => ({ id: 'user-1' }),
}));

jest.mock('@expo/vector-icons', () => ({
  Ionicons: 'Ionicons',
}));

import OrgMembersPage from '../../app/(org)/org/members';
import SupportUsersPage from '../../app/(support)/support/users';
import SupportUserDetailPage from '../../app/(support)/support/users/[id]';

beforeEach(() => {
  mockGet.mockReset();
});

describe('組織のメンバー一覧 (#1635)', () => {
  it("仮置きの 'Guest' は (no name)、本人が付けた名前は前後の空白を除いてそのまま出す", async () => {
    mockGet.mockResolvedValue({
      members: [
        { id: 'm-1', nickname: ' Guest ', roles: ['member'], department: null, created_at: '2026-01-01T00:00:00.000Z' },
        { id: 'm-2', nickname: ' ゲスト ', roles: ['member'], department: null, created_at: '2026-01-02T00:00:00.000Z' },
      ],
    });
    render(<OrgMembersPage />);

    expect(await screen.findByText('(no name)')).toBeTruthy();
    expect(screen.getByText('ゲスト')).toBeTruthy();
    expect(screen.queryByText(/Guest/)).toBeNull();
  });
});

describe('サポートのユーザー検索 (#1635)', () => {
  it("仮置きの 'Guest' は (no name)、本人が付けた名前は前後の空白を除いてそのまま出す", async () => {
    mockGet.mockResolvedValue({
      users: [
        { id: 'u-1', nickname: 'Guest', roles: ['user'], organizationId: null, isBanned: false, lastLoginAt: null },
        { id: 'u-2', nickname: ' guest ', roles: ['user'], organizationId: null, isBanned: false, lastLoginAt: null },
      ],
    });
    render(<SupportUsersPage />);

    expect(await screen.findByText('(no name)')).toBeTruthy();
    expect(screen.getByText('guest')).toBeTruthy();
    expect(screen.queryByText(/Guest/)).toBeNull();
  });
});

describe('サポートのユーザー詳細 (#1635)', () => {
  function detail(nickname: string | null) {
    return {
      user: {
        id: 'user-1',
        nickname,
        ageGroup: null,
        gender: null,
        roles: ['user'],
        organizationId: null,
        isBanned: false,
        bannedAt: null,
        bannedReason: null,
        lastLoginAt: null,
        loginCount: null,
        profileCompleteness: null,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      stats: { mealCount: 0, aiSessionCount: 0 },
      inquiries: [],
      notes: [],
    };
  }

  it("仮置きの 'Guest' は (no name) と出す", async () => {
    mockGet.mockResolvedValue(detail('  Guest\t'));
    render(<SupportUserDetailPage />);

    expect(await screen.findByText('(no name)')).toBeTruthy();
    expect(screen.queryByText(/Guest/)).toBeNull();
  });

  it('本人が付けた名前は前後の空白を除いてそのまま出す', async () => {
    mockGet.mockResolvedValue(detail(' 太郎 '));
    render(<SupportUserDetailPage />);

    await waitFor(() => expect(screen.getByText('太郎')).toBeTruthy());
    expect(screen.queryByText('(no name)')).toBeNull();
  });
});
