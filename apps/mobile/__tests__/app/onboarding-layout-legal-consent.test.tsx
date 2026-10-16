/**
 * onboarding-layout-legal-consent.test.tsx — apps/mobile/app/onboarding/_layout.tsx の同意の状態の待ち
 * (#1442 設計書 cross/13b §6.6.13。T-OB1)
 *
 * 初期設定の layout は、サインイン中なら同意の状態が分かるまで (loading) と required の間は Stack を描かない
 * (初期設定より先に同意。ログインの直後に入口を通らず着く経路も含む)。unknown は待たない。session 無しは /login へ。
 */
import { render } from '@testing-library/react-native';
import React from 'react';

jest.mock('expo-router', () => {
  const ReactActual = require('react');
  const { View } = require('react-native');
  return {
    Stack: () => ReactActual.createElement(View, { testID: 'onboarding-stack' }),
    Redirect: ({ href }: { href: string }) => ReactActual.createElement(View, { testID: `redirect-${href}` }),
    router: { replace: jest.fn() },
  };
});
jest.mock('../../src/lib/error-report', () => ({ reportBoundaryError: jest.fn() }));

type AuthState = { session: { user: { id: string } } | null; isLoading: boolean };
let mockAuth: AuthState;
let mockLegalState: 'loading' | 'clear' | 'required' | 'unknown' = 'clear';
jest.mock('../../src/providers/AuthProvider', () => ({ useAuth: () => mockAuth }));
jest.mock('../../src/providers/LegalConsentProvider', () => ({
  useLegalConsent: () => ({ state: mockLegalState, status: null, refresh: jest.fn() }),
}));

import OnboardingLayout from '../../app/onboarding/_layout';

const SIGNED_IN: AuthState = { session: { user: { id: 'user-1' } }, isLoading: false };

beforeEach(() => {
  mockAuth = SIGNED_IN;
  mockLegalState = 'clear';
});

describe('初期設定の layout — 規約の同意の状態 (#1442 T-OB1)', () => {
  it.each(['loading', 'required'] as const)('session あり: 同意の状態が %s なら LoadingState を描き Stack を描かない', (state) => {
    mockLegalState = state;
    const { queryByTestId } = render(<OnboardingLayout />);

    expect(queryByTestId('onboarding-stack')).toBeNull();
    expect(queryByTestId('redirect-/login')).toBeNull();
  });

  it.each(['clear', 'unknown'] as const)('session あり: 同意の状態が %s なら Stack を描く', (state) => {
    mockLegalState = state;
    const { getByTestId } = render(<OnboardingLayout />);

    expect(getByTestId('onboarding-stack')).toBeTruthy();
  });

  it('clear で Stack を描いた後に required へ変わると LoadingState になる (Stack が外れる)', () => {
    const view = render(<OnboardingLayout />);
    expect(view.getByTestId('onboarding-stack')).toBeTruthy();

    mockLegalState = 'required';
    view.rerender(<OnboardingLayout />);

    expect(view.queryByTestId('onboarding-stack')).toBeNull();
  });

  it('session 無しは /login へ Redirect (同意の状態によらない)', () => {
    mockAuth = { session: null, isLoading: false };
    for (const state of ['loading', 'clear', 'required', 'unknown'] as const) {
      mockLegalState = state;
      const { getByTestId, queryByTestId, unmount } = render(<OnboardingLayout />);
      expect(getByTestId('redirect-/login')).toBeTruthy();
      expect(queryByTestId('onboarding-stack')).toBeNull();
      unmount();
    }
  });

  it('auth の読み込み中は今までどおり Stack を描かない', () => {
    mockAuth = { session: null, isLoading: true };
    const { queryByTestId } = render(<OnboardingLayout />);
    expect(queryByTestId('onboarding-stack')).toBeNull();
    expect(queryByTestId('redirect-/login')).toBeNull();
  });
});
