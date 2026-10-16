/**
 * index-legal-consent.test.tsx — apps/mobile/app/index.tsx の同意の状態の待ち (#1442 設計書 cross/13b §6.6.13。T-IDX1)
 *
 * 入口は、サインイン中なら同意の状態が分かるまで (loading) と required の間はスピナーのまま振り分けない
 * (LegalConsentGate が同意画面 1 つに畳む)。clear / unknown は待たず、今までどおり初期設定かホームへ振り分ける。
 */
import { render } from '@testing-library/react-native';
import React from 'react';

jest.mock('expo-router', () => {
  const ReactActual = require('react');
  const { View } = require('react-native');
  return {
    Link: ({ children }: { children: React.ReactNode }) => children,
    Redirect: ({ href }: { href: string }) => ReactActual.createElement(View, { testID: `redirect-${href}` }),
  };
});
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));

type AuthState = { session: { user: { id: string } } | null; isLoading: boolean };
type ProfileState = { profile: { onboardingCompletedAt: string | null } | null; isLoading: boolean };
let mockAuth: AuthState;
let mockProfile: ProfileState;
let mockLegalState: 'loading' | 'clear' | 'required' | 'unknown' = 'clear';
jest.mock('../../src/providers/AuthProvider', () => ({ useAuth: () => mockAuth }));
jest.mock('../../src/providers/ProfileProvider', () => ({ useProfile: () => mockProfile }));
jest.mock('../../src/providers/LegalConsentProvider', () => ({
  useLegalConsent: () => ({ state: mockLegalState, status: null, refresh: jest.fn() }),
}));

import Index from '../../app/index';

const SIGNED_IN: AuthState = { session: { user: { id: 'user-1' } }, isLoading: false };
const SIGNED_OUT: AuthState = { session: null, isLoading: false };
const ONBOARDED: ProfileState = { profile: { onboardingCompletedAt: '2026-10-01T00:00:00Z' }, isLoading: false };
const NOT_ONBOARDED: ProfileState = { profile: { onboardingCompletedAt: null }, isLoading: false };

beforeEach(() => {
  mockAuth = SIGNED_IN;
  mockProfile = ONBOARDED;
  mockLegalState = 'clear';
});

describe('入口 (app/index.tsx) — 規約の同意の状態 (#1442 T-IDX1)', () => {
  it.each(['loading', 'required'] as const)('session あり: 同意の状態が %s ならスピナー (Redirect を描かない)', (state) => {
    mockLegalState = state;
    const { getByTestId, queryByTestId } = render(<Index />);

    expect(getByTestId('welcome-loading')).toBeTruthy();
    expect(queryByTestId('redirect-/(tabs)/home')).toBeNull();
    expect(queryByTestId('redirect-/onboarding')).toBeNull();
    expect(queryByTestId('welcome-screen')).toBeNull();
  });

  it.each(['clear', 'unknown'] as const)('session あり: 同意の状態が %s なら今までどおり home へ Redirect (初期設定が済んでいる)', (state) => {
    mockLegalState = state;
    const { getByTestId, queryByTestId } = render(<Index />);

    expect(getByTestId('redirect-/(tabs)/home')).toBeTruthy();
    expect(queryByTestId('welcome-loading')).toBeNull();
  });

  it.each(['clear', 'unknown'] as const)('session あり: 同意の状態が %s なら今までどおり /onboarding へ Redirect (初期設定が未完了)', (state) => {
    mockLegalState = state;
    mockProfile = NOT_ONBOARDED;
    const { getByTestId } = render(<Index />);

    expect(getByTestId('redirect-/onboarding')).toBeTruthy();
  });

  it('session 無しはウェルカム (同意の状態によらない)', () => {
    mockAuth = SIGNED_OUT;
    mockProfile = { profile: null, isLoading: false };
    for (const state of ['loading', 'clear', 'required', 'unknown'] as const) {
      mockLegalState = state;
      const { getByTestId, queryByTestId, unmount } = render(<Index />);
      expect(getByTestId('welcome-screen')).toBeTruthy();
      expect(queryByTestId('welcome-loading')).toBeNull();
      unmount();
    }
  });

  it('auth の読み込み中・プロフィールの読み込み中は今までどおりスピナー', () => {
    mockAuth = { session: null, isLoading: true };
    const first = render(<Index />);
    expect(first.getByTestId('welcome-loading')).toBeTruthy();
    first.unmount();

    mockAuth = SIGNED_IN;
    mockProfile = { profile: null, isLoading: true };
    const second = render(<Index />);
    expect(second.getByTestId('welcome-loading')).toBeTruthy();
  });
});
