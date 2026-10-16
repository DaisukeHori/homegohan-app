/**
 * sessions.test.tsx
 * RNTL tests for apps/mobile/app/settings/sessions.tsx — ログイン中の端末の画面 (#1189・#1190。docs/design/cross/16-auth-history-sessions.md §16・§20.4)
 *
 * 一覧・この端末・解除・他の端末をすべて・最近のログインの 5 つを確かめる。API (src/lib/sessions-api.ts) は作り物にする。
 */

import React from 'react';
import { Alert } from 'react-native';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';

const mockFetchSessions = jest.fn();
const mockFetchLoginHistory = jest.fn();
const mockRevokeSession = jest.fn();
const mockRevokeOtherSessions = jest.fn();
jest.mock('../../src/lib/sessions-api', () => ({
  fetchSessions: (...args: unknown[]) => mockFetchSessions(...args),
  fetchLoginHistory: (...args: unknown[]) => mockFetchLoginHistory(...args),
  revokeSession: (...args: unknown[]) => mockRevokeSession(...args),
  revokeOtherSessions: (...args: unknown[]) => mockRevokeOtherSessions(...args),
}));
jest.mock('expo-router', () => ({ router: { back: jest.fn(), push: jest.fn(), replace: jest.fn() } }));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));

import SessionsSettingsScreen from '../../app/settings/sessions';

const CURRENT_ID = '00000000-0000-4000-8000-000000000001';
const OTHER_ID = '00000000-0000-4000-8000-000000000002';

const baseSession = {
  created_at: '2026-10-15T01:00:00.000Z',
  last_active_at: '2026-10-15T02:00:00.000Z',
  ip_address: '203.0.113.10',
  country_code: 'JP',
};
const sessions = [
  { ...baseSession, session_id: CURRENT_ID, device_label: 'ほめゴハンのアプリ (iPhone・iPad)', device_name: 'iPhone 15 Pro (iOS 18.0)', is_current: true },
  { ...baseSession, session_id: OTHER_ID, device_label: 'Windows の Chrome', device_name: null, is_current: false },
];
const history = [
  {
    ...baseSession,
    session_id: OTHER_ID,
    device_label: 'Windows の Chrome',
    device_name: null,
    ended_at: null,
    ended_reason: null,
    is_new_device: true,
    is_new_ip: false,
    is_new_country: true,
    alert_sent_at: '2026-10-15T01:01:00.000Z',
  },
  {
    ...baseSession,
    session_id: '00000000-0000-4000-8000-000000000003',
    device_label: 'Mac の Safari',
    device_name: null,
    ended_at: '2026-10-14T01:00:00.000Z',
    ended_reason: 'signed_out',
    is_new_device: false,
    is_new_ip: false,
    is_new_country: false,
    alert_sent_at: null,
  },
];

/** 確認のダイアログでは、確かめる側のボタン (キャンセルでない方) を押したことにする */
const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation((_title, _message, buttons) => {
  const confirm = buttons?.find((b) => b.style === 'destructive');
  confirm?.onPress?.();
});

beforeEach(() => {
  jest.clearAllMocks();
  mockFetchSessions.mockResolvedValue(sessions);
  mockFetchLoginHistory.mockResolvedValue(history);
  mockRevokeSession.mockResolvedValue(undefined);
  mockRevokeOtherSessions.mockResolvedValue(0);
});

describe('ログイン中の端末の画面 (#1189)', () => {
  it('一覧: 端末の見出しは device_label で、端末名は「端末名: …」として添える', async () => {
    render(<SessionsSettingsScreen />);
    await waitFor(() => expect(screen.getAllByTestId('sessions-item')).toHaveLength(2));

    expect(screen.getByTestId('sessions-screen')).toBeTruthy();
    expect(screen.getByText('ほめゴハンのアプリ (iPhone・iPad)')).toBeTruthy();
    expect(screen.getByText('端末名: iPhone 15 Pro (iOS 18.0)')).toBeTruthy();
    // 端末名は見出しにしない
    expect(screen.queryByText('iPhone 15 Pro (iOS 18.0)')).toBeNull();
  });

  it('この端末: バッジを出し、解除のボタンを出さない (解除のボタンは他の端末の 1 つだけ)', async () => {
    render(<SessionsSettingsScreen />);
    await waitFor(() => expect(screen.getAllByTestId('sessions-item')).toHaveLength(2));

    expect(screen.getAllByTestId('sessions-current-badge')).toHaveLength(1);
    expect(screen.getAllByTestId('sessions-revoke-button')).toHaveLength(1);
  });

  it('解除: 確認のあと DELETE (revokeSession) を呼び、成功したら一覧から消す', async () => {
    render(<SessionsSettingsScreen />);
    await waitFor(() => expect(screen.getAllByTestId('sessions-item')).toHaveLength(2));

    fireEvent.press(screen.getByTestId('sessions-revoke-button'));

    await waitFor(() => expect(mockRevokeSession).toHaveBeenCalledWith(OTHER_ID));
    expect(alertSpy).toHaveBeenCalledWith('端末のログアウト', expect.stringContaining('Windows の Chrome'), expect.any(Array));
    await waitFor(() => expect(screen.getAllByTestId('sessions-item')).toHaveLength(1));
    expect(screen.queryByTestId('sessions-revoke-button')).toBeNull();
  });

  it('他の端末をすべて: 確認のあと POST (revokeOtherSessions) を呼び、一覧を読み直す', async () => {
    render(<SessionsSettingsScreen />);
    await waitFor(() => expect(screen.getAllByTestId('sessions-item')).toHaveLength(2));
    mockFetchSessions.mockResolvedValue([sessions[0]]);

    fireEvent.press(screen.getByTestId('sessions-revoke-others-button'));

    await waitFor(() => expect(mockRevokeOtherSessions).toHaveBeenCalledTimes(1));
    expect(alertSpy).toHaveBeenCalledWith('他の端末のログアウト', expect.any(String), expect.any(Array));
    await waitFor(() => expect(screen.getAllByTestId('sessions-item')).toHaveLength(1));
    expect(mockFetchSessions).toHaveBeenCalledTimes(2);
  });

  it('最近のログイン: 印 (新しい端末・新しい地域) と終了の理由を出す', async () => {
    render(<SessionsSettingsScreen />);
    await waitFor(() => expect(screen.getAllByTestId('login-history-item')).toHaveLength(2));

    const marks = screen.getAllByTestId('login-history-marks');
    expect(marks).toHaveLength(1);
    expect(marks[0].props.children).toBe('新しい端末 ・ 新しい地域');
    expect(screen.getByText('ログアウト')).toBeTruthy();
  });
});
