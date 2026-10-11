/**
 * stacked-modals-close-with-parent.test.tsx
 * 週の画面のモーダルの上に重ねて開くモーダルは、下のモーダルが閉じられたら一緒に閉じる (T15 / #1154)
 *
 * 週の画面は、「同意が必要です」の案内の「同意画面を開く」を押したときに、画面のモーダルをすべて閉じてから同意画面へ移る
 * (closeAllModals。閉じないと、同意画面がモーダルの下に隠れる)。closeAllModals が閉じるのは週の画面が持つモーダル
 * (買い物リスト・冷蔵庫・手動編集など) で、その上に重ねたモーダル (追加・写真から入力) は、それぞれの部品が持っている。
 * 下のモーダルだけが閉じて上に重ねたモーダルが残ると、同意画面がその下に隠れる (R4 の指摘と同じ型)。
 * ここでは、下のモーダルの visible を false にしたら上に重ねたモーダルも消え、次に開いたときに上のモーダルだけが
 * 出てこないことを確かめる。
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';

const mockGet = jest.fn();

jest.mock('../../src/lib/api', () => ({
  getApi: () => ({ get: mockGet, post: jest.fn(), del: jest.fn(), patch: jest.fn() }),
  getApiBaseUrl: () => 'http://localhost:3000',
}));

jest.mock('../../src/lib/supabase', () => ({
  supabase: { auth: { getSession: jest.fn() }, channel: jest.fn(), from: jest.fn(), removeChannel: jest.fn() },
}));

jest.mock('expo-router', () => ({ router: { push: jest.fn() } }));

jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));

jest.mock('expo-image-picker', () => ({
  requestCameraPermissionsAsync: jest.fn(),
  requestMediaLibraryPermissionsAsync: jest.fn(),
  launchCameraAsync: jest.fn(),
  launchImageLibraryAsync: jest.fn(),
}));

import React from 'react';
import { ManualEditModal, type ManualEditMeal } from '../../src/components/menu/ManualEditModal';
import { PantryModal } from '../../src/components/menu/PantryModal';
import { ShoppingListModal } from '../../src/components/menu/ShoppingListModal';

// 最初の描画 (RN の Modal の初回描画) は読み込むモジュールが多く、キャッシュの無い環境では 5 秒の既定を超えることがある
jest.setTimeout(30000);

// 非同期の段数が多く、遅い環境で既定の 1 秒では足りないことがあるため、長めに待つ
const WAIT = { timeout: 5000 };

const MEAL: ManualEditMeal = {
  id: 'meal-1',
  dish_name: '焼き魚定食',
  mode: 'cook',
  calories_kcal: 600,
  dishes: [{ name: '焼き魚', role: 'main', calories_kcal: 300 }],
};

beforeEach(() => {
  jest.clearAllMocks();
  mockGet.mockResolvedValue({ items: [] });
});

describe('上に重ねたモーダルは、下のモーダルが閉じられたら一緒に閉じる', () => {
  it('買い物リスト → 追加', async () => {
    const props = { onClose: jest.fn(), onOpenAdd: jest.fn(), onOpenRange: jest.fn(), onOpenServings: jest.fn() };
    const { rerender } = render(<ShoppingListModal visible {...props} />);
    await waitFor(() => expect(mockGet).toHaveBeenCalledWith('/api/shopping-list'), WAIT);
    await act(async () => {
      fireEvent.press(screen.getByTestId('shopping-list-add-btn'));
    });
    expect(screen.getByTestId('add-shopping-modal')).toBeTruthy();

    rerender(<ShoppingListModal visible={false} {...props} />);
    expect(screen.queryByTestId('shopping-list-modal')).toBeNull();
    expect(screen.queryByTestId('add-shopping-modal')).toBeNull();

    // 次に開いたときに、追加のモーダルだけが出てこない
    rerender(<ShoppingListModal visible {...props} />);
    await waitFor(() => expect(screen.getByTestId('shopping-list-modal')).toBeTruthy(), WAIT);
    expect(screen.queryByTestId('add-shopping-modal')).toBeNull();
  });

  it('冷蔵庫 → 追加', async () => {
    const onClose = jest.fn();
    const { rerender } = render(<PantryModal visible onClose={onClose} />);
    await waitFor(() => expect(mockGet).toHaveBeenCalledWith('/api/pantry'), WAIT);
    await act(async () => {
      fireEvent.press(screen.getByTestId('pantry-add-btn'));
    });
    expect(screen.getByTestId('add-fridge-modal')).toBeTruthy();

    rerender(<PantryModal visible={false} onClose={onClose} />);
    expect(screen.queryByTestId('pantry-modal')).toBeNull();
    expect(screen.queryByTestId('add-fridge-modal')).toBeNull();

    rerender(<PantryModal visible onClose={onClose} />);
    await waitFor(() => expect(screen.getByTestId('pantry-modal')).toBeTruthy(), WAIT);
    expect(screen.queryByTestId('add-fridge-modal')).toBeNull();
  });

  it('手動編集 → 写真から入力', async () => {
    const props = { meal: MEAL, onClose: jest.fn(), onSave: jest.fn() };
    const { rerender } = render(<ManualEditModal visible {...props} />);
    fireEvent.press(screen.getByTestId('manual-edit-photo-btn'));
    expect(screen.getByTestId('photo-edit-modal')).toBeTruthy();

    rerender(<ManualEditModal visible={false} {...props} />);
    expect(screen.queryByTestId('manual-edit-modal')).toBeNull();
    expect(screen.queryByTestId('photo-edit-modal')).toBeNull();

    rerender(<ManualEditModal visible {...props} />);
    expect(screen.getByTestId('manual-edit-modal')).toBeTruthy();
    expect(screen.queryByTestId('photo-edit-modal')).toBeNull();
  });
});
