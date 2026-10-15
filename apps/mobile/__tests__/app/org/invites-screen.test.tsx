/**
 * invites-screen.test.tsx
 * モバイルの組織管理画面「招待」(apps/mobile/app/(org)/org/invites.tsx) の招待 URL (#1647)
 *
 * 招待 URL は、招待を受ける人がブラウザで開く Web のページ (/invite/<token>)。以前は API の基点
 * (EXPO_PUBLIC_API_BASE_URL。getApiBaseUrl) で組んでいて、API と Web のオリジンが違うビルドでは開けない URL を出し、
 * API の基点が無いときは「(token) …」とトークンだけを出していた。Web のページの URL を組む関数
 * (siteConfig.ts の orgInvitePageUrl → webPageUrl。EXPO_PUBLIC_WEB_URL) で組むことを確かめる。
 */

import React from 'react';
import { render, screen, waitFor } from '@testing-library/react-native';

import OrgInvitesPage from '../../../app/(org)/org/invites';

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn() }),
}));
jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));

const mockGet = jest.fn();
const mockGetApiBaseUrl = jest.fn();
jest.mock('../../../src/lib/api', () => ({
  getApi: () => ({ get: (...args: unknown[]) => mockGet(...args), post: jest.fn(), del: jest.fn() }),
  getApiBaseUrl: (...args: unknown[]) => mockGetApiBaseUrl(...args),
}));

const ENV_NAMES = ['EXPO_PUBLIC_WEB_URL', 'EXPO_PUBLIC_API_BASE_URL'] as const;
const originalEnv: Record<string, string | undefined> = {};

function invite(overrides: Record<string, unknown> = {}) {
  return {
    id: 'inv-1',
    email: 'member@example.test',
    role: 'member',
    departmentName: null,
    token: 'tok123',
    expiresAt: '2026-11-01',
    acceptedAt: null,
    createdAt: '2026-10-01',
    isExpired: false,
    isAccepted: false,
    ...overrides,
  };
}

beforeEach(() => {
  mockGet.mockReset();
  mockGetApiBaseUrl.mockReset();
  mockGetApiBaseUrl.mockReturnValue('https://api.example.test');
  for (const name of ENV_NAMES) {
    originalEnv[name] = process.env[name];
    delete process.env[name];
  }
});

afterEach(() => {
  for (const name of ENV_NAMES) {
    if (originalEnv[name] === undefined) delete process.env[name];
    else process.env[name] = originalEnv[name];
  }
});

describe('組織管理の招待一覧の招待 URL', () => {
  it('Web のページのオリジン (EXPO_PUBLIC_WEB_URL) の /invite/<token> を出す。API の基点は使わない', async () => {
    process.env.EXPO_PUBLIC_WEB_URL = 'https://web.example.test';
    process.env.EXPO_PUBLIC_API_BASE_URL = 'https://api.example.test';
    mockGet.mockResolvedValue({ invites: [invite()] });

    render(<OrgInvitesPage />);

    await waitFor(() => expect(screen.getByText('https://web.example.test/invite/tok123')).toBeTruthy());
    expect(mockGet).toHaveBeenCalledWith('/api/org/invites');
    expect(screen.queryByText(/api\.example\.test/)).toBeNull();
    expect(mockGetApiBaseUrl).not.toHaveBeenCalled();
  });

  it('API の基点が無いビルドでも、トークンだけでなく Web のページの URL を出す', async () => {
    process.env.EXPO_PUBLIC_WEB_URL = 'https://web.example.test';
    mockGetApiBaseUrl.mockImplementation(() => {
      throw new Error('[mobile] Missing env: EXPO_PUBLIC_API_BASE_URL');
    });
    mockGet.mockResolvedValue({ invites: [invite({ token: 'tok456' })] });

    render(<OrgInvitesPage />);

    await waitFor(() => expect(screen.getByText('https://web.example.test/invite/tok456')).toBeTruthy());
    expect(screen.queryByText(/\(token\)/)).toBeNull();
  });
});
