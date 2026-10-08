/**
 * layout-auth-guard.test.tsx
 * app/handson-tour/_layout.tsx の認証ガードのテスト (#1049 F7-14)
 *
 * 以前は未ログイン時に存在しないルート '/(auth)/sign-in' へ replace していたため、
 * 未ログインでツアーに入ると「Unmatched Route」になっていた。
 * ログイン画面の実体は app/(auth)/login.tsx (URL は '/login') なので、そこへ送る。
 *
 * テスト対象:
 *  - 未ログイン → '/login' へ replace する ('/(auth)/sign-in' は使わない)
 *  - replace 先のルートが app/ 配下に実在する (リンク切れの回帰防止)
 *  - ツアー表示不要 (should_show=false) なら '/home' へ、force=1 のときは留まる
 *  - 認証確認中は何もせず待つ
 */

import fs from 'fs';
import path from 'path';

import React from 'react';
import { render, waitFor } from '@testing-library/react-native';

// ── expo-router のモック ──────────────────────────────────────────────────────
const mockReplace = jest.fn();
let mockSearchParams: Record<string, string | undefined> = {};

jest.mock('expo-router', () => {
  const React = require('react');
  const { View } = require('react-native');
  function Stack({ children }: { children?: React.ReactNode }) {
    return React.createElement(View, { testID: 'tour-stack' }, children);
  }
  Stack.Screen = function StackScreen() {
    return null;
  };
  return {
    Stack,
    useRouter: () => ({ replace: mockReplace }),
    useLocalSearchParams: () => mockSearchParams,
  };
});

// ── useAuth のモック ──────────────────────────────────────────────────────────
let mockAuthState: { session: unknown; isLoading: boolean } = { session: null, isLoading: false };

jest.mock('../../src/providers/AuthProvider', () => ({
  useAuth: () => mockAuthState,
}));

// ── TourProvider は中身に依存しないので素通しにする ──────────────────────────────
jest.mock('../../src/contexts/TourContext', () => ({
  TourProvider: ({ children }: { children: React.ReactNode }) => children,
}));

// ── API クライアントのモック ─────────────────────────────────────────────────
const mockApiGet = jest.fn();
jest.mock('../../src/lib/api', () => ({
  getApi: () => ({ get: mockApiGet }),
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const HandsonTourLayout = require('../../app/handson-tour/_layout').default;

const APP_DIR = path.resolve(__dirname, '../../app');

beforeEach(() => {
  jest.clearAllMocks();
  mockSearchParams = {};
  mockAuthState = { session: null, isLoading: false };
  mockApiGet.mockResolvedValue({ should_show: true });
});

describe('handson-tour/_layout — 未ログイン', () => {
  it("未ログインなら '/login' へ replace する", async () => {
    render(<HandsonTourLayout />);

    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalledWith('/login');
    });
    expect(mockReplace).toHaveBeenCalledTimes(1);
  });

  it("存在しない '/(auth)/sign-in' へは遷移しない", async () => {
    render(<HandsonTourLayout />);

    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalled();
    });
    const targets = mockReplace.mock.calls.map((call) => String(call[0]));
    expect(targets.some((t) => t.includes('sign-in'))).toBe(false);
  });

  it('replace 先 (/login) の画面ファイルが app/ 配下に実在する', async () => {
    render(<HandsonTourLayout />);

    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalled();
    });
    const target = String(mockReplace.mock.calls[0][0]);
    expect(target).toBe('/login');

    // '/login' は (auth) グループ内の login.tsx。グループ名は URL に出ない。
    expect(fs.existsSync(path.join(APP_DIR, '(auth)', 'login.tsx'))).toBe(true);
    // 旧ルートの実体は無い (ファイルが生えて仕様が変わったときに気付けるように)
    expect(fs.existsSync(path.join(APP_DIR, '(auth)', 'sign-in.tsx'))).toBe(false);
  });

  it('認証確認中 (isLoading) は遷移しない', async () => {
    mockAuthState = { session: null, isLoading: true };
    render(<HandsonTourLayout />);

    // effect が走る時間を与えてから、何も起きていないことを確認する
    await waitFor(() => {
      expect(mockApiGet).not.toHaveBeenCalled();
    });
    expect(mockReplace).not.toHaveBeenCalled();
  });
});

describe('handson-tour/_layout — ログイン済み', () => {
  beforeEach(() => {
    mockAuthState = { session: { user: { id: 'user-1' } }, isLoading: false };
  });

  it("ツアー表示不要 (should_show=false) なら '/home' へ replace する", async () => {
    mockApiGet.mockResolvedValue({ should_show: false });
    render(<HandsonTourLayout />);

    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalledWith('/home');
    });
  });

  it('force=1 のときは should_show=false でも留まる (設定画面からの再表示)', async () => {
    mockSearchParams = { force: '1' };
    mockApiGet.mockResolvedValue({ should_show: false });
    const { getByTestId } = render(<HandsonTourLayout />);

    await waitFor(() => {
      expect(getByTestId('tour-stack')).toBeTruthy();
    });
    expect(mockReplace).not.toHaveBeenCalled();
  });
});
