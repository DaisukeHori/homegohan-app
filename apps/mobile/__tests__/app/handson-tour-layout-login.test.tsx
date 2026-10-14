/**
 * #1049 F7-14: ハンズオンツアーを未ログインで開いたとき、ログイン画面 ('/login' = app/(auth)/login.tsx) へ遷移する。
 *
 * 以前は存在しない '/(auth)/sign-in' へ遷移し、「Unmatched Route」の画面が出ていた。
 * ログイン済みのときは、ログイン画面へは遷移しない (ツアーの表示の確認へ進む)。
 */

import React from 'react';
import { render, waitFor } from '@testing-library/react-native';

const mockReplace = jest.fn();
jest.mock('expo-router', () => {
  const React = require('react');
  const { View } = require('react-native');
  function Stack() {
    return React.createElement(View, { testID: 'stack' });
  }
  Stack.Screen = function StackScreen() {
    return null;
  };
  return {
    Stack,
    useRouter: () => ({ replace: (...args: unknown[]) => mockReplace(...args), push: jest.fn() }),
    useLocalSearchParams: () => ({}),
  };
});

const mockUseAuth = jest.fn();
jest.mock('../../src/providers/AuthProvider', () => ({
  useAuth: () => mockUseAuth(),
}));

const mockGet = jest.fn();
jest.mock('../../src/lib/api', () => ({
  getApi: () => ({ get: mockGet }),
}));

jest.mock('../../src/contexts/TourContext', () => ({
  TourProvider: ({ children }: { children: React.ReactNode }) => children,
}));

import HandsonTourLayout from '../../app/handson-tour/_layout';

describe('ハンズオンツアーの入口: 未ログインならログイン画面へ (#1049 F7-14)', () => {
  beforeEach(() => {
    mockReplace.mockReset();
    mockGet.mockReset();
    mockUseAuth.mockReset();
  });

  it('未ログインなら /login へ replace する (存在しない /(auth)/sign-in ではない)。ツアーの状態は取りに行かない', async () => {
    mockUseAuth.mockReturnValue({ session: null, isLoading: false });

    render(<HandsonTourLayout />);

    await waitFor(() => expect(mockReplace).toHaveBeenCalledTimes(1));
    expect(mockReplace).toHaveBeenCalledWith('/login');
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('ログインの確認中は、どこへも遷移しない', () => {
    mockUseAuth.mockReturnValue({ session: null, isLoading: true });

    render(<HandsonTourLayout />);

    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('ログイン済みなら、ログイン画面へは遷移せず、ツアーの状態を確かめてツアーを出す', async () => {
    mockUseAuth.mockReturnValue({ session: { user: { id: 'user-1' } }, isLoading: false });
    mockGet.mockResolvedValue({ should_show: true });

    const screen = render(<HandsonTourLayout />);

    expect(await screen.findByTestId('stack')).toBeTruthy();
    expect(mockGet).toHaveBeenCalledWith('/api/handson-tour/status');
    expect(mockReplace).not.toHaveBeenCalled();
  });
});
