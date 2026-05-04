/**
 * add.test.tsx
 * 食材追加 (name, qty, unit, expiration)・validation・API モックのテスト
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';

// --- モック設定 ---
const mockGet = jest.fn();
const mockPost = jest.fn();
const mockPatch = jest.fn();
const mockDel = jest.fn();

jest.mock('../../src/lib/api', () => ({
  getApi: () => ({
    get: mockGet,
    post: mockPost,
    patch: mockPatch,
    del: mockDel,
  }),
}));

jest.mock('expo-router', () => ({
  Link: ({ children }: { children: React.ReactNode }) => children,
  router: { back: jest.fn(), push: jest.fn(), replace: jest.fn() },
}));

jest.mock('@expo/vector-icons', () => ({
  Ionicons: 'Ionicons',
}));

jest.mock('expo-image-picker', () => ({
  requestCameraPermissionsAsync: jest.fn(),
  requestMediaLibraryPermissionsAsync: jest.fn(),
  launchCameraAsync: jest.fn(),
  launchImageLibraryAsync: jest.fn(),
}));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
  SafeAreaProvider: ({ children }: { children: React.ReactNode }) => children,
  SafeAreaView: ({ children }: { children: React.ReactNode }) => children,
}));

import React from 'react';
import PantryPage from '../../app/pantry/index';

beforeEach(() => {
  jest.clearAllMocks();
  // デフォルト: 一覧は空
  mockGet.mockResolvedValue({ items: [] });
  // 追加後の再取得は食材ありを返す
  mockPost.mockResolvedValue({});
});

describe('PantryPage — 食材追加', () => {
  it('食材名・量・期限を入力して追加ボタンを押すと API が呼ばれる', async () => {
    mockGet
      .mockResolvedValueOnce({ items: [] })
      .mockResolvedValueOnce({
        items: [
          {
            id: 'new-1',
            name: 'トマト',
            amount: '2個',
            category: 'vegetable',
            expirationDate: '2026-05-10',
            addedAt: '2026-05-01',
          },
        ],
      });

    render(<PantryPage />);

    await waitFor(() => {
      expect(screen.getByPlaceholderText('例: キャベツ')).toBeTruthy();
    });

    fireEvent.changeText(screen.getByPlaceholderText('例: キャベツ'), 'トマト');
    fireEvent.changeText(screen.getByPlaceholderText('量（任意）'), '2個');
    fireEvent.changeText(screen.getByPlaceholderText('期限 YYYY-MM-DD（任意）'), '2026-05-10');

    await act(async () => {
      // SectionHeader の「追加」と Button の「追加」が両方存在するため最後の要素（Button）を使用
      const addButtons = screen.getAllByText('追加');
      fireEvent.press(addButtons[addButtons.length - 1]);
    });

    await waitFor(() => {
      expect(mockPost).toHaveBeenCalledWith(
        '/api/pantry',
        expect.objectContaining({
          name: 'トマト',
          amount: '2個',
          expirationDate: '2026-05-10',
        }),
      );
    });
  });

  it('食材名が空のとき追加ボタンを押しても API を呼ばない (validation)', async () => {
    render(<PantryPage />);

    await waitFor(() => {
      expect(screen.getAllByText('追加').length).toBeGreaterThan(0);
    });

    // 名前は空のまま追加
    await act(async () => {
      const addButtons = screen.getAllByText('追加');
      fireEvent.press(addButtons[addButtons.length - 1]);
    });

    expect(mockPost).not.toHaveBeenCalled();
  });

  it('カテゴリを選択して追加すると category が送信される', async () => {
    mockGet
      .mockResolvedValueOnce({ items: [] })
      .mockResolvedValueOnce({ items: [] });

    render(<PantryPage />);

    await waitFor(() => {
      expect(screen.getByPlaceholderText('例: キャベツ')).toBeTruthy();
    });

    fireEvent.changeText(screen.getByPlaceholderText('例: キャベツ'), '牛肉');
    // カテゴリ「肉類」を選択
    fireEvent.press(screen.getByText('肉類'));

    await act(async () => {
      const addButtons = screen.getAllByText('追加');
      fireEvent.press(addButtons[addButtons.length - 1]);
    });

    await waitFor(() => {
      expect(mockPost).toHaveBeenCalledWith(
        '/api/pantry',
        expect.objectContaining({
          name: '牛肉',
          category: 'meat',
        }),
      );
    });
  });

  it('追加後にフォームがリセットされる', async () => {
    mockGet
      .mockResolvedValueOnce({ items: [] })
      .mockResolvedValueOnce({ items: [] });

    render(<PantryPage />);

    await waitFor(() => {
      expect(screen.getByPlaceholderText('例: キャベツ')).toBeTruthy();
    });

    const nameInput = screen.getByPlaceholderText('例: キャベツ');
    const amountInput = screen.getByPlaceholderText('量（任意）');

    fireEvent.changeText(nameInput, 'にんじん');
    fireEvent.changeText(amountInput, '3本');

    await act(async () => {
      const addButtons = screen.getAllByText('追加');
      fireEvent.press(addButtons[addButtons.length - 1]);
    });

    await waitFor(() => {
      // フォームリセット後はプレースホルダーが表示状態に戻る
      expect(nameInput.props.value).toBe('');
    });
    expect(amountInput.props.value).toBe('');
  });

  it('API エラー時に Alert が表示される', async () => {
    const { Alert } = require('react-native');
    const alertSpy = jest.spyOn(Alert, 'alert');
    mockPost.mockRejectedValueOnce(new Error('ネットワークエラー'));

    render(<PantryPage />);

    await waitFor(() => {
      expect(screen.getByPlaceholderText('例: キャベツ')).toBeTruthy();
    });

    fireEvent.changeText(screen.getByPlaceholderText('例: キャベツ'), 'なす');

    await act(async () => {
      const addButtons = screen.getAllByText('追加');
      fireEvent.press(addButtons[addButtons.length - 1]);
    });

    await waitFor(() => {
      expect(alertSpy).toHaveBeenCalledWith('追加失敗', 'ネットワークエラー');
    });
  });
});
