/**
 * org-admin-gate.test.tsx
 * 組織管理画面のゲート ((org)/_layout.tsx) と isOrgAdmin のユニットテスト (#1235)
 *
 * 組織の管理者 = 所属組織があり、org_role が owner / admin のユーザー (Web の src/lib/auth/org-admin.ts と同じ)。
 * roles 配列の 'org_admin' はどの組織のものかを区別しないため、組織の管理者判定に使わない。
 *
 * テスト対象:
 *  - isOrgAdmin: owner / admin で所属あり → true、それ以外 → false
 *  - (org)/_layout.tsx: 管理者には Stack を表示し、それ以外には「組織管理権限がありません」を表示する
 *  - 未ログインは /login へリダイレクトする
 */

import React from 'react';
import { render, screen } from '@testing-library/react-native';

import { isOrgAdmin } from '../../src/lib/org-admin';

// ── expo-router のモック ──────────────────────────────────────────────────────
jest.mock('expo-router', () => {
  const React = require('react');
  const { View } = require('react-native');
  return {
    Stack: () => React.createElement(View, { testID: 'org-stack' }),
    Redirect: ({ href }: { href: string }) => React.createElement(View, { testID: `redirect-${href}` }),
  };
});

// ── useAuth のモック ──────────────────────────────────────────────────────────
let mockAuthState: { session: any; isLoading: boolean } = {
  session: { user: { id: 'user-1' } },
  isLoading: false,
};

jest.mock('../../src/providers/AuthProvider', () => ({
  useAuth: () => mockAuthState,
}));

// ── useProfile のモック ───────────────────────────────────────────────────────
let mockProfile: any = null;

jest.mock('../../src/providers/ProfileProvider', () => ({
  useProfile: () => {
    const roles: string[] = mockProfile?.roles ?? [];
    return {
      isLoading: false,
      profile: mockProfile,
      roles,
      hasRole: (role: string) => roles.includes(role),
      refresh: jest.fn(),
    };
  },
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const OrgLayout = require('../../app/(org)/_layout').default;

const ORG_ID = 'org-1';

function profileWith(overrides: Record<string, unknown>) {
  return {
    id: 'user-1',
    nickname: 'tester',
    roles: ['user'],
    organizationId: ORG_ID,
    orgRole: null,
    onboardingStartedAt: null,
    onboardingCompletedAt: '2026-01-01',
    onboardingProgress: null,
    weekStartDay: 'monday',
    ...overrides,
  };
}

beforeEach(() => {
  mockAuthState = { session: { user: { id: 'user-1' } }, isLoading: false };
  mockProfile = null;
});

describe('isOrgAdmin', () => {
  it('所属組織があり org_role が owner なら true', () => {
    expect(isOrgAdmin({ organizationId: ORG_ID, orgRole: 'owner' })).toBe(true);
  });

  it('所属組織があり org_role が admin なら true', () => {
    expect(isOrgAdmin({ organizationId: ORG_ID, orgRole: 'admin' })).toBe(true);
  });

  it('org_role が member なら false', () => {
    expect(isOrgAdmin({ organizationId: ORG_ID, orgRole: 'member' })).toBe(false);
  });

  it('所属組織が無ければ org_role が owner でも false', () => {
    expect(isOrgAdmin({ organizationId: null, orgRole: 'owner' })).toBe(false);
  });

  it('プロフィールが無ければ false', () => {
    expect(isOrgAdmin(null)).toBe(false);
    expect(isOrgAdmin(undefined)).toBe(false);
  });
});

describe('(org)/_layout.tsx のゲート', () => {
  it('org_role が owner のユーザーには組織管理画面を表示する', () => {
    mockProfile = profileWith({ orgRole: 'owner' });
    render(<OrgLayout />);
    expect(screen.getByTestId('org-stack')).toBeTruthy();
    expect(screen.queryByText('組織管理権限がありません')).toBeNull();
  });

  it('招待で admin になったユーザー (roles に org_admin なし) にも表示する', () => {
    mockProfile = profileWith({ orgRole: 'admin', roles: ['user'] });
    render(<OrgLayout />);
    expect(screen.getByTestId('org-stack')).toBeTruthy();
  });

  it('roles に org_admin が残っていても、org_role が member なら表示しない', () => {
    mockProfile = profileWith({ orgRole: 'member', roles: ['user', 'org_admin'] });
    render(<OrgLayout />);
    expect(screen.getByText('組織管理権限がありません')).toBeTruthy();
    expect(screen.queryByTestId('org-stack')).toBeNull();
  });

  it('所属組織が無いユーザーには表示しない (roles に org_admin があっても)', () => {
    mockProfile = profileWith({ organizationId: null, orgRole: null, roles: ['org_admin'] });
    render(<OrgLayout />);
    expect(screen.getByText('組織管理権限がありません')).toBeTruthy();
    expect(screen.queryByTestId('org-stack')).toBeNull();
  });

  it('未ログインなら /login へリダイレクトする', () => {
    mockAuthState = { session: null, isLoading: false };
    render(<OrgLayout />);
    expect(screen.getByTestId('redirect-/login')).toBeTruthy();
  });
});
