/**
 * verify.test.tsx
 * RNTL tests for apps/mobile/app/(auth)/auth/verify.tsx
 *
 * Covers:
 *  1. code パラメータがある場合、exchangeCodeForSession を呼ぶ
 *  2. token_hash + type がある場合、verifyOtp を呼ぶ
 *  3. params.error がある場合、エラーアラートを出す
 */

import React from 'react';
import { Alert } from 'react-native';
import { render, waitFor } from '@testing-library/react-native';

// ---- Mocks ----

const mockExchangeCodeForSession = jest.fn();
const mockVerifyOtp = jest.fn();
const mockSetSession = jest.fn();
const mockGetSession = jest.fn();

jest.mock('../../src/lib/supabase', () => ({
  supabase: {
    auth: {
      exchangeCodeForSession: (...args: any[]) => mockExchangeCodeForSession(...args),
      verifyOtp: (...args: any[]) => mockVerifyOtp(...args),
      setSession: (...args: any[]) => mockSetSession(...args),
      getSession: (...args: any[]) => mockGetSession(...args),
    },
  },
}));

// deeplink module — controlled per test via mockExtract
const mockExtract = jest.fn();
jest.mock('../../src/lib/deeplink', () => ({
  extractSupabaseLinkParams: (...args: any[]) => mockExtract(...args),
}));

// expo-linking — useURL returns a controllable value
let mockURL: string | null = null;
jest.mock('expo-linking', () => ({
  useURL: () => mockURL,
  createURL: (path: string) => `homegohan://${path}`,
}));

const mockBack = jest.fn();
jest.mock('expo-router', () => ({
  router: { back: (...args: any[]) => mockBack(...args) },
  Redirect: () => null,
}));

jest.mock('@expo/vector-icons', () => ({
  Ionicons: () => null,
}));

jest.mock('../../src/theme', () => ({
  colors: {
    bg: '#fff', accent: '#f00', text: '#000', textMuted: '#888',
    textLight: '#666', card: '#fafafa', border: '#eee',
    blue: '#00f', blueLight: '#e8f0ff',
    error: '#f00', errorLight: '#ffe8e8',
    success: '#0a0', successLight: '#e8ffe8',
  },
  spacing: { sm: 8, md: 16, lg: 24, xl: 32 },
  radius: { lg: 12 },
  shadows: { sm: {}, md: {} },
}));

import VerifyPage from '../../app/(auth)/auth/verify';

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  mockURL = null;
  mockGetSession.mockResolvedValue({ data: { session: null } });
});

describe('VerifyPage', () => {
  it('1. code パラメータがある場合、exchangeCodeForSession を呼ぶ', async () => {
    mockURL = 'homegohan://auth/verify?code=abc123';
    mockExtract.mockReturnValue({ code: 'abc123' });
    mockExchangeCodeForSession.mockResolvedValue({ error: null });

    render(<VerifyPage />);

    await waitFor(() => {
      expect(mockExchangeCodeForSession).toHaveBeenCalledWith('abc123');
    });
  });

  it('2. token_hash + type がある場合、verifyOtp を呼ぶ', async () => {
    mockURL = 'homegohan://auth/verify?token_hash=hash123&type=signup';
    mockExtract.mockReturnValue({ token_hash: 'hash123', type: 'signup' });
    mockVerifyOtp.mockResolvedValue({ error: null });

    render(<VerifyPage />);

    await waitFor(() => {
      expect(mockVerifyOtp).toHaveBeenCalledWith({
        token_hash: 'hash123',
        type: 'signup',
      });
    });
  });

  it('3. params.error がある場合、エラーアラートを出す', async () => {
    mockURL = 'homegohan://auth/verify?error=access_denied&error_description=Token+expired';
    mockExtract.mockReturnValue({
      error: 'access_denied',
      error_description: 'Token expired',
    });

    render(<VerifyPage />);

    await waitFor(() => {
      expect(Alert.alert).toHaveBeenCalledWith('エラー', 'Token expired');
    });
    expect(mockExchangeCodeForSession).not.toHaveBeenCalled();
    expect(mockVerifyOtp).not.toHaveBeenCalled();
  });
});
