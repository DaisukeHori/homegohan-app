/**
 * checkup-form.test.tsx
 * RNTL tests for apps/mobile/app/health/checkups/new.tsx
 *
 * Covers:
 *  1. 検査日が空のとき Alert を出して API を呼ばない (必須フィールド検証)
 *  2. 検査日を入力して保存ボタンを押すと /api/health/checkups に POST が呼ばれる
 *  3. API 成功後に review ステップへ遷移する (AI分析結果テキストが表示される)
 */

import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Alert } from 'react-native';

// ---- Mocks ----

const mockPost = jest.fn();
const mockGet = jest.fn();

jest.mock('../../src/lib/api', () => ({
  getApi: () => ({
    get: mockGet,
    post: mockPost,
  }),
}));

jest.mock('expo-router', () => ({
  useRouter: () => ({ back: jest.fn(), push: jest.fn() }),
}));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

jest.mock('@expo/vector-icons', () => ({
  Ionicons: () => null,
}));

jest.mock('../../src/theme', () => ({
  colors: {
    bg: '#fff',
    card: '#fafafa',
    accent: '#4f46e5',
    accentLight: '#eef2ff',
    text: '#111',
    textLight: '#555',
    textMuted: '#999',
    purple: '#7c3aed',
    purpleLight: '#f5f3ff',
    warning: '#d97706',
    warningLight: '#fffbeb',
    success: '#16a34a',
    successLight: '#f0fdf4',
    error: '#dc2626',
    errorLight: '#fef2f2',
    border: '#e5e7eb',
  },
  spacing: { xs: 4, sm: 8, md: 16, lg: 24, xl: 32 },
  radius: { sm: 4, md: 8, lg: 12, xl: 16, full: 9999 },
  shadows: { sm: {} },
}));

jest.mock('../../src/components/ui', () => {
  const React = require('react');
  const { Text, TouchableOpacity } = require('react-native');
  return {
    Button: ({ children, onPress, loading, disabled }: any) => (
      <TouchableOpacity onPress={onPress} disabled={disabled || loading} testID="save-button">
        <Text>{loading ? '保存中...' : children}</Text>
      </TouchableOpacity>
    ),
  };
});

import NewCheckupPage from '../../app/health/checkups/new';

const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});

beforeEach(() => {
  jest.clearAllMocks();
  alertSpy.mockClear();
});

describe('NewCheckupPage — checkup-form', () => {
  it('1. 検査日を消してから保存を押すと Alert が出て POST は呼ばれない', async () => {
    render(<NewCheckupPage />);

    // 検査日フィールドをクリア
    const dateInput = screen.getByPlaceholderText('YYYY-MM-DD');
    fireEvent.changeText(dateInput, '');

    await act(async () => {
      fireEvent.press(screen.getByTestId('save-button'));
    });

    await waitFor(() => {
      expect(alertSpy).toHaveBeenCalledWith('エラー', '検査日を入力してください。');
    });
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('2. 検査日を入力して保存を押すと /api/health/checkups に POST が呼ばれる', async () => {
    mockPost.mockResolvedValueOnce({
      checkup: { id: 'c-1', individual_review: null },
    });

    render(<NewCheckupPage />);

    // 検査日は初期値 (todayStr) が入っている — そのまま保存
    await act(async () => {
      fireEvent.press(screen.getByTestId('save-button'));
    });

    await waitFor(() => {
      expect(mockPost).toHaveBeenCalledWith(
        '/api/health/checkups',
        expect.objectContaining({
          checkup_date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
        }),
      );
    });
  });

  it('3. API 成功後に AI分析結果テキストが表示される (review ステップ)', async () => {
    mockPost.mockResolvedValueOnce({
      checkup: {
        id: 'c-2',
        individual_review: {
          summary: '全体的に良好です。',
          concerns: [],
          positives: [],
          recommendations: [],
        },
      },
    });

    render(<NewCheckupPage />);

    await act(async () => {
      fireEvent.press(screen.getByTestId('save-button'));
    });

    await waitFor(() => {
      // 'AI分析結果' は header と card の両方に出るため、getAllByText で存在確認
      expect(screen.getAllByText('AI分析結果').length).toBeGreaterThan(0);
      expect(screen.getByText('全体的に良好です。')).toBeTruthy();
    });
  });

  it('4. 数値フィールドに値を入力すると payload に数値として含まれる', async () => {
    mockPost.mockResolvedValueOnce({
      checkup: { id: 'c-3', individual_review: null },
    });

    render(<NewCheckupPage />);

    // HbA1c フィールドに値を入力 (placeholder "5.6")
    fireEvent.changeText(screen.getByPlaceholderText('5.6'), '6.2');

    await act(async () => {
      fireEvent.press(screen.getByTestId('save-button'));
    });

    await waitFor(() => {
      expect(mockPost).toHaveBeenCalledWith(
        '/api/health/checkups',
        expect.objectContaining({ hba1c: 6.2 }),
      );
    });
  });

  it('5. API エラー時に Alert(保存失敗) が出る', async () => {
    mockPost.mockRejectedValueOnce(new Error('サーバーエラー'));

    render(<NewCheckupPage />);

    await act(async () => {
      fireEvent.press(screen.getByTestId('save-button'));
    });

    await waitFor(() => {
      expect(alertSpy).toHaveBeenCalledWith('保存失敗', 'サーバーエラー');
    });
  });
});
