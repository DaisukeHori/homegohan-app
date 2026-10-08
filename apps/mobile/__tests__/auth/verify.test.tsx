/**
 * verify.test.tsx
 * RNTL tests for apps/mobile/app/(auth)/auth/verify.tsx
 *
 * Covers:
 *  1. code パラメータがある場合、exchangeCodeForSession を呼ぶ
 *  2. token_hash + type がある場合、verifyOtp を呼ぶ
 *  3. params.error がある場合、エラーアラートを出す
 *  4. (#1038 F7-08) リンクの情報が無い / エラー / 交換失敗のときは「確認が完了しました」と誤表示せず、エラー表示にする
 *  5. (#1038 F7-08) 起動リンクの取得が済むまでは、エラー表示をちらつかせない
 */

import React from 'react';
import { Alert } from 'react-native';
import { render, waitFor } from '@testing-library/react-native';
import { resetAuthLinkResultsForTests } from '../../src/lib/authLink';

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

// expo-linking — useURL / getInitialURL return a controllable value
let mockURL: string | null = null;
// true の間は getInitialURL が解決しない (= 起動リンクをまだ取得できていない状態)
let mockInitialUrlPending = false;
jest.mock('expo-linking', () => ({
  useURL: () => mockURL,
  getInitialURL: () => (mockInitialUrlPending ? new Promise(() => {}) : Promise.resolve(mockURL)),
  createURL: (path: string) => `homegohan://${path}`,
}));

const mockBack = jest.fn();
const mockRedirect = jest.fn();
jest.mock('expo-router', () => ({
  router: { back: (...args: any[]) => mockBack(...args), replace: jest.fn() },
  Redirect: (props: any) => {
    mockRedirect(props);
    return null;
  },
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
  resetAuthLinkResultsForTests();
  jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  mockURL = null;
  mockInitialUrlPending = false;
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


// ---- #1038 F7-08: 成功と誤表示しない ----

describe('VerifyPage — リンクの情報が無い・失敗したときの表示 (#1038 F7-08)', () => {
  it('4-1. リンクを経由せずに開かれた (URL なし) ときは、「確認が完了しました」ではなくエラー表示にする', async () => {
    mockURL = null;

    const { findByTestId, queryByText } = render(<VerifyPage />);

    expect(await findByTestId('verify-error-text')).toBeTruthy();
    expect(queryByText('確認が完了しました。ログインしてください。')).toBeNull();
    expect(mockExchangeCodeForSession).not.toHaveBeenCalled();
    expect(mockVerifyOtp).not.toHaveBeenCalled();
    expect(mockSetSession).not.toHaveBeenCalled();
    expect(mockRedirect).not.toHaveBeenCalled();
  });

  it('4-2. URL はあるがパラメータが無いときも、エラー表示にする (iOS の Google ログインが以前この状態で成功と誤表示していた)', async () => {
    mockURL = 'homegohan:///auth/verify';
    mockExtract.mockReturnValue({});

    const { findByTestId, queryByText } = render(<VerifyPage />);

    expect(await findByTestId('verify-error-text')).toBeTruthy();
    expect(queryByText('確認が完了しました。ログインしてください。')).toBeNull();
    expect(mockRedirect).not.toHaveBeenCalled();
  });

  it('4-3. リンクが error を運んできたときは、アラートに加えてエラー表示にする (以前はアラートの後ろで成功表示になっていた)', async () => {
    mockURL = 'homegohan://auth/verify?error=access_denied&error_description=Token+expired';
    mockExtract.mockReturnValue({ error: 'access_denied', error_description: 'Token expired' });

    const { findByTestId, queryByText } = render(<VerifyPage />);

    expect(await findByTestId('verify-error-text')).toBeTruthy();
    expect(queryByText('確認が完了しました。ログインしてください。')).toBeNull();
    expect(Alert.alert).toHaveBeenCalledWith('エラー', 'Token expired');
  });

  it('4-4. code の交換に失敗したときは、「確認失敗」のアラートとエラー表示にする', async () => {
    mockURL = 'homegohan://auth/verify?code=bad';
    mockExtract.mockReturnValue({ code: 'bad' });
    mockExchangeCodeForSession.mockResolvedValue({ error: new Error('invalid flow state') });

    const { findByTestId } = render(<VerifyPage />);

    expect(await findByTestId('verify-error-text')).toBeTruthy();
    expect(Alert.alert).toHaveBeenCalledWith('確認失敗', 'invalid flow state');
    expect(mockRedirect).not.toHaveBeenCalled();
  });

  it('4-5. 交換に成功してセッションができたら、ホームへ移る', async () => {
    mockURL = 'homegohan://auth/verify?code=good';
    mockExtract.mockReturnValue({ code: 'good' });
    mockExchangeCodeForSession.mockResolvedValue({ error: null });
    mockGetSession.mockResolvedValue({ data: { session: { access_token: 'at' } } });

    render(<VerifyPage />);

    await waitFor(() => expect(mockRedirect).toHaveBeenCalledWith({ href: '/(tabs)/home' }));
  });
});

describe('VerifyPage — 起動リンクの取得待ち (#1038 F7-08)', () => {
  it('5-1. 起動時のリンクをまだ取得できていない間は、「リンクが無い」とは判断せず、確認中の表示のままにする', async () => {
    mockInitialUrlPending = true;

    const { getByTestId, queryByTestId } = render(<VerifyPage />);

    // 少し待っても、エラーにも完了にもならない
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(getByTestId('verify-loading')).toBeTruthy();
    expect(queryByTestId('verify-error-text')).toBeNull();
    expect(mockExchangeCodeForSession).not.toHaveBeenCalled();
  });

  it('5-2. 取得待ちの間に URL イベントが届いたら、それを処理する', async () => {
    mockInitialUrlPending = true;
    mockURL = 'homegohan://auth/verify?code=event-code';
    mockExtract.mockReturnValue({ code: 'event-code' });
    mockExchangeCodeForSession.mockResolvedValue({ error: null });

    render(<VerifyPage />);

    await waitFor(() => expect(mockExchangeCodeForSession).toHaveBeenCalledWith('event-code'));
  });
});
