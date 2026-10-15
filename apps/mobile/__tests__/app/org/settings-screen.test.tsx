/**
 * settings-screen.test.tsx
 * モバイルの組織管理画面「設定」(apps/mobile/app/(org)/org/settings.tsx) が送るキーと読む形 (#1735)
 *
 * 以前は、業種・従業員数・連絡先を route が知らない camelCase のキー (employeeCount / contactEmail / contactName) で送り、
 * route が捨てたまま 200 を返したので「保存しました」と出ていた。GET も { data } を返すのに organization を読んでいた。
 * 送る本文のキーが、route のスキーマが受け取るキー (ORG_SETTINGS_FORM_KEYS。@homegohan/shared) と一致することを確かめる。
 * route のスキーマ側とこのキーの一致は tests/org-settings-keys.test.tsx (Web の vitest) が確かめる。
 */

import React from 'react';
import { Alert } from 'react-native';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { ORG_SETTINGS_EMPLOYEE_COUNT_MESSAGE, ORG_SETTINGS_FORM_KEYS } from '@homegohan/shared';

import OrgSettingsPage from '../../../app/(org)/org/settings';

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn() }),
}));
jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));

const mockGet = jest.fn();
const mockPut = jest.fn();
jest.mock('../../../src/lib/api', () => ({
  getApi: () => ({
    get: (...args: unknown[]) => mockGet(...args),
    put: (...args: unknown[]) => mockPut(...args),
    post: jest.fn(),
    del: jest.fn(),
  }),
}));

const STORED = {
  id: 'org-1',
  name: 'A 株式会社',
  plan: 'standard',
  industry: 'IT',
  employee_count: 30,
  contact_email: 'old@example.com',
  contact_name: '前の担当',
  subscription_status: 'active',
  subscription_expires_at: null,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
};

let alertSpy: jest.SpyInstance;

beforeEach(() => {
  mockGet.mockReset();
  mockPut.mockReset();
  mockGet.mockResolvedValue({ data: STORED });
  mockPut.mockResolvedValue({ data: STORED });
  alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
});

afterEach(() => {
  alertSpy.mockRestore();
});

describe('組織管理の設定', () => {
  it('GET の data (snake_case) を入力欄に出す', async () => {
    render(<OrgSettingsPage />);

    await waitFor(() => expect(screen.getByDisplayValue('A 株式会社')).toBeTruthy());
    expect(mockGet).toHaveBeenCalledWith('/api/org/settings');
    expect(screen.getByDisplayValue('IT')).toBeTruthy();
    expect(screen.getByDisplayValue('30')).toBeTruthy();
    expect(screen.getByDisplayValue('old@example.com')).toBeTruthy();
    expect(screen.getByDisplayValue('前の担当')).toBeTruthy();
  });

  it('保存で送る本文のキーは ORG_SETTINGS_FORM_KEYS と一致し、入力した値を snake_case で送る', async () => {
    render(<OrgSettingsPage />);
    await waitFor(() => expect(screen.getByDisplayValue('A 株式会社')).toBeTruthy());

    fireEvent.changeText(screen.getByDisplayValue('IT'), '製造');
    fireEvent.changeText(screen.getByDisplayValue('30'), '120');
    fireEvent.changeText(screen.getByDisplayValue('old@example.com'), 'hr@example.com');
    fireEvent.changeText(screen.getByDisplayValue('前の担当'), '人事 太郎');
    fireEvent.press(screen.getByText('保存'));

    await waitFor(() => expect(mockPut).toHaveBeenCalledTimes(1));
    const [path, body] = mockPut.mock.calls[0];
    expect(path).toBe('/api/org/settings');
    expect(Object.keys(body).sort()).toEqual([...ORG_SETTINGS_FORM_KEYS].sort());
    expect(body).toEqual({
      name: 'A 株式会社',
      industry: '製造',
      employee_count: 120,
      contact_email: 'hr@example.com',
      contact_name: '人事 太郎',
    });
    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith('保存しました', '組織設定を更新しました。'));
  });

  it('空欄は null で送る (保存されている値を消す)', async () => {
    render(<OrgSettingsPage />);
    await waitFor(() => expect(screen.getByDisplayValue('A 株式会社')).toBeTruthy());

    fireEvent.changeText(screen.getByDisplayValue('IT'), '');
    fireEvent.changeText(screen.getByDisplayValue('30'), '');
    fireEvent.press(screen.getByText('保存'));

    await waitFor(() => expect(mockPut).toHaveBeenCalledTimes(1));
    expect(mockPut.mock.calls[0][1]).toMatchObject({ industry: null, employee_count: null });
  });

  it('従業員数が整数でないときは送らず、「保存しました」を出さない', async () => {
    render(<OrgSettingsPage />);
    await waitFor(() => expect(screen.getByDisplayValue('A 株式会社')).toBeTruthy());

    fireEvent.changeText(screen.getByDisplayValue('30'), '1.5');
    fireEvent.press(screen.getByText('保存'));

    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith('保存失敗', ORG_SETTINGS_EMPLOYEE_COUNT_MESSAGE));
    expect(mockPut).not.toHaveBeenCalled();
    expect(alertSpy).not.toHaveBeenCalledWith('保存しました', expect.anything());
  });

  it('route が失敗を返したときは「保存しました」を出さない', async () => {
    mockPut.mockRejectedValue(new Error('入力内容を確認してください'));
    render(<OrgSettingsPage />);
    await waitFor(() => expect(screen.getByDisplayValue('A 株式会社')).toBeTruthy());

    fireEvent.press(screen.getByText('保存'));

    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith('保存失敗', '入力内容を確認してください'));
    expect(alertSpy).not.toHaveBeenCalledWith('保存しました', expect.anything());
  });
});
