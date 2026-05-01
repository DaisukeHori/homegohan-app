/**
 * list.test.tsx
 * 食材一覧表示・空状態・refresh のテスト
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

// --- コンポーネント import (モック設定後) ---
import React from 'react';
import PantryPage from '../../app/pantry/index';

const SAMPLE_ITEMS = [
  {
    id: 'item-1',
    name: 'キャベツ',
    amount: '1/2玉',
    category: 'vegetable',
    expirationDate: '2099-12-31',
    addedAt: '2026-04-01',
  },
  {
    id: 'item-2',
    name: '鶏もも肉',
    amount: '300g',
    category: 'meat',
    expirationDate: null,
    addedAt: '2026-04-02',
  },
];

beforeEach(() => {
  jest.clearAllMocks();
});

describe('PantryPage — 一覧表示', () => {
  it('食材一覧が表示される', async () => {
    mockGet.mockResolvedValueOnce({ items: SAMPLE_ITEMS });
    render(<PantryPage />);

    await waitFor(() => {
      // 食材名は量と同じ Text 要素内にネストされるため regex を使用
      expect(screen.getByText(/キャベツ/)).toBeTruthy();
    });
    expect(screen.getByText(/鶏もも肉/)).toBeTruthy();
    // カテゴリラベル表示 (CategoryPicker と一覧の両方に存在するため getAllByText で確認)
    expect(screen.getAllByText('野菜').length).toBeGreaterThan(0);
    expect(screen.getAllByText('肉類').length).toBeGreaterThan(0);
  });

  it('件数ヘッダーが件数を正しく表示する', async () => {
    mockGet.mockResolvedValueOnce({ items: SAMPLE_ITEMS });
    render(<PantryPage />);

    await waitFor(() => {
      expect(screen.getByText('食材一覧（2件）')).toBeTruthy();
    });
  });

  it('エラー時にエラーメッセージを表示する', async () => {
    mockGet.mockRejectedValueOnce(new Error('サーバーエラー'));
    render(<PantryPage />);

    await waitFor(() => {
      expect(screen.getByText('サーバーエラー')).toBeTruthy();
    });
  });
});

describe('PantryPage — 空状態', () => {
  it('食材が0件のとき EmptyState を表示する', async () => {
    mockGet.mockResolvedValueOnce({ items: [] });
    render(<PantryPage />);

    await waitFor(() => {
      expect(screen.getByText('冷蔵庫は空です。')).toBeTruthy();
    });
  });

  it('空状態のアクションラベルが「写真で追加」である', async () => {
    mockGet.mockResolvedValueOnce({ items: [] });
    render(<PantryPage />);

    await waitFor(() => {
      expect(screen.getByText('写真で追加')).toBeTruthy();
    });
  });
});

describe('PantryPage — refresh', () => {
  it('更新ボタン押下で再取得する', async () => {
    mockGet
      .mockResolvedValueOnce({ items: [] })
      .mockResolvedValueOnce({ items: SAMPLE_ITEMS });

    render(<PantryPage />);

    // 初期ロード完了を待つ
    await waitFor(() => {
      expect(screen.getByText('冷蔵庫は空です。')).toBeTruthy();
    });

    const refreshBtn = screen.getByText('更新');
    await act(async () => {
      fireEvent.press(refreshBtn);
    });

    await waitFor(() => {
      expect(screen.getByText(/キャベツ/)).toBeTruthy();
    });
    expect(mockGet).toHaveBeenCalledTimes(2);
  });
});
