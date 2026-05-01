/**
 * delete.test.tsx
 * 削除確認ダイアログ・削除後の一覧再取得テスト
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Alert } from 'react-native';

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

const ITEMS = [
  {
    id: 'item-a',
    name: 'ほうれん草',
    amount: '1束',
    category: 'vegetable',
    expirationDate: '2099-12-31',
    addedAt: '2026-04-01',
  },
  {
    id: 'item-b',
    name: '豚バラ肉',
    amount: '200g',
    category: 'meat',
    expirationDate: null,
    addedAt: '2026-04-02',
  },
];

beforeEach(() => {
  jest.clearAllMocks();
});

describe('PantryPage — 削除', () => {
  it('削除ボタン押下で Alert が表示される', async () => {
    const alertSpy = jest.spyOn(Alert, 'alert');
    mockGet.mockResolvedValue({ items: ITEMS });

    render(<PantryPage />);

    await waitFor(() => {
      expect(screen.getByText(/ほうれん草/)).toBeTruthy();
    });

    // 「削除」ボタンは複数あるので最初の1件を対象とする
    const deleteButtons = screen.getAllByText('削除');
    await act(async () => {
      fireEvent.press(deleteButtons[0]);
    });

    expect(alertSpy).toHaveBeenCalledWith(
      '削除',
      'この食材を削除しますか？',
      expect.arrayContaining([
        expect.objectContaining({ text: 'キャンセル' }),
        expect.objectContaining({ text: '削除' }),
      ]),
    );
  });

  it('確認ダイアログで「削除」を選択すると API が呼ばれる', async () => {
    mockGet.mockResolvedValue({ items: ITEMS });
    mockDel.mockResolvedValueOnce({});

    // Alert.alert をキャプチャして destructive ボタンを直接呼び出す
    let capturedOnPress: (() => void) | undefined;
    jest.spyOn(Alert, 'alert').mockImplementationOnce((_title, _msg, buttons) => {
      const destructiveBtn = (buttons as any[]).find((b) => b.style === 'destructive');
      capturedOnPress = destructiveBtn?.onPress;
    });

    render(<PantryPage />);

    await waitFor(() => {
      expect(screen.getByText(/ほうれん草/)).toBeTruthy();
    });

    const deleteButtons = screen.getAllByText('削除');
    await act(async () => {
      fireEvent.press(deleteButtons[0]);
    });

    expect(capturedOnPress).toBeDefined();
    await act(async () => {
      capturedOnPress!();
    });

    await waitFor(() => {
      expect(mockDel).toHaveBeenCalledWith('/api/pantry/item-a');
    });
  });

  it('削除後に一覧からアイテムが消える', async () => {
    mockGet.mockResolvedValue({ items: ITEMS });
    mockDel.mockResolvedValueOnce({});

    let capturedOnPress: (() => void) | undefined;
    jest.spyOn(Alert, 'alert').mockImplementationOnce((_title, _msg, buttons) => {
      const destructiveBtn = (buttons as any[]).find((b) => b.style === 'destructive');
      capturedOnPress = destructiveBtn?.onPress;
    });

    render(<PantryPage />);

    await waitFor(() => {
      expect(screen.getByText(/ほうれん草/)).toBeTruthy();
    });

    const deleteButtons = screen.getAllByText('削除');
    await act(async () => {
      fireEvent.press(deleteButtons[0]);
    });

    await act(async () => {
      capturedOnPress!();
    });

    await waitFor(() => {
      expect(screen.queryByText(/ほうれん草/)).toBeNull();
    });
    // 2件目はまだ表示されていること
    expect(screen.getByText(/豚バラ肉/)).toBeTruthy();
  });

  it('確認ダイアログで「キャンセル」を選択すると API は呼ばれない', async () => {
    mockGet.mockResolvedValue({ items: ITEMS });

    jest.spyOn(Alert, 'alert').mockImplementationOnce((_title, _msg, buttons) => {
      // キャンセルを即時呼び出し
      const cancelBtn = (buttons as any[]).find((b) => b.style === 'cancel');
      cancelBtn?.onPress?.();
    });

    render(<PantryPage />);

    await waitFor(() => {
      expect(screen.getByText(/ほうれん草/)).toBeTruthy();
    });

    const deleteButtons = screen.getAllByText('削除');
    await act(async () => {
      fireEvent.press(deleteButtons[0]);
    });

    expect(mockDel).not.toHaveBeenCalled();
    // 食材はまだ表示されている
    expect(screen.getByText(/ほうれん草/)).toBeTruthy();
  });

  it('削除 API エラー時に Alert が表示される', async () => {
    mockGet.mockResolvedValue({ items: ITEMS });
    mockDel.mockRejectedValueOnce(new Error('削除に失敗'));

    const alertMock = jest.spyOn(Alert, 'alert')
      .mockImplementationOnce((_title, _msg, buttons) => {
        // 最初の呼び出しは削除確認ダイアログ: destructive を自動押下
        const destructiveBtn = (buttons as any[]).find((b) => b.style === 'destructive');
        destructiveBtn?.onPress?.();
      });

    render(<PantryPage />);

    await waitFor(() => {
      expect(screen.getByText(/ほうれん草/)).toBeTruthy();
    });

    const deleteButtons = screen.getAllByText('削除');
    await act(async () => {
      fireEvent.press(deleteButtons[0]);
    });

    await waitFor(() => {
      // 2回目の Alert.alert 呼び出しがエラー通知
      expect(alertMock).toHaveBeenCalledTimes(2);
      expect(alertMock).toHaveBeenLastCalledWith('削除失敗', '削除に失敗');
    });
  });
});
