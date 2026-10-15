/**
 * 食事新規作成画面 (meals/new.tsx) のテスト
 * - 手動入力フロー
 * - モード選択
 */
import React from 'react';
import { render, fireEvent, waitFor, act, within } from '@testing-library/react-native';

// ─── モック ─────────────────────────────────────────────
jest.mock('expo-router', () => ({
  router: { back: jest.fn(), push: jest.fn(), replace: jest.fn(), canGoBack: jest.fn(() => true) },
  useLocalSearchParams: jest.fn(() => ({})),
  // 同意の案内から同意画面へ移るときに、この画面 (modal) を閉じるかを決めるのに使う (T15 / #1154)
  useNavigation: jest.fn(() => ({ isFocused: () => true })),
}));

jest.mock('@expo/vector-icons', () => ({
  Ionicons: 'Ionicons',
}));

jest.mock('expo-image-picker', () => ({
  requestMediaLibraryPermissionsAsync: jest.fn().mockResolvedValue({ granted: true }),
  requestCameraPermissionsAsync: jest.fn().mockResolvedValue({ granted: true }),
  launchImageLibraryAsync: jest.fn().mockResolvedValue({
    canceled: false,
    assets: [{ uri: 'file://test/photo.jpg' }],
  }),
  launchCameraAsync: jest.fn().mockResolvedValue({
    canceled: false,
    assets: [{ uri: 'file://test/camera.jpg' }],
  }),
}));

jest.mock('expo-image-manipulator', () => ({
  manipulateAsync: jest.fn().mockResolvedValue({
    uri: 'file://test/resized.jpg',
    base64: 'base64encodedimage',
  }),
  SaveFormat: { JPEG: 'jpeg' },
}));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: jest.fn(() => ({ top: 0, bottom: 0, left: 0, right: 0 })),
  SafeAreaProvider: ({ children }: any) => children,
  SafeAreaView: ({ children }: any) => children,
}));

const mockGet = jest.fn();
const mockPost = jest.fn();
const mockDel = jest.fn();
const mockPatch = jest.fn();

jest.mock('../../src/lib/api', () => ({
  getApi: () => ({
    get: mockGet,
    post: mockPost,
    del: mockDel,
    patch: mockPatch,
  }),
}));

jest.mock('../../src/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: jest.fn().mockResolvedValue({ data: { session: { access_token: 'test-token' } } }),
    },
    from: jest.fn(() => ({
      update: jest.fn(() => ({
        eq: jest.fn(() => ({
          in: jest.fn().mockResolvedValue({ error: null }),
        })),
      })),
    })),
  },
}));

import MealNewPage from '../../app/meals/new';

// ─── テスト ───────────────────────────────────────────────
describe('MealNewPage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPost.mockResolvedValue({});
    mockGet.mockResolvedValue({ products: [] });
  });

  describe('初期表示', () => {
    it('モード選択画面が最初に表示される', () => {
      const { getByText } = render(<MealNewPage />);
      expect(getByText('オート')).toBeTruthy();
      expect(getByText('食事')).toBeTruthy();
      expect(getByText('冷蔵庫')).toBeTruthy();
    });

    it('手動入力への導線が表示される', () => {
      const { getByText } = render(<MealNewPage />);
      // モード選択画面に「手動で食事名・栄養を入力」ボタンがある
      expect(getByText('手動で食事名・栄養を入力')).toBeTruthy();
    });

    it('全5つのモードが表示される', () => {
      const { getByText } = render(<MealNewPage />);
      expect(getByText('オート')).toBeTruthy();
      expect(getByText('食事')).toBeTruthy();
      expect(getByText('冷蔵庫')).toBeTruthy();
      expect(getByText('健診')).toBeTruthy();
      expect(getByText('体重計')).toBeTruthy();
    });

    it('「撮影へ進む」ボタンが表示される', () => {
      const { getByText } = render(<MealNewPage />);
      expect(getByText('撮影へ進む')).toBeTruthy();
    });
  });

  describe('手動入力フロー', () => {
    it('「手動で食事名・栄養を入力」を押すと手動入力フォームに遷移する', async () => {
      const { getByText } = render(<MealNewPage />);

      act(() => {
        fireEvent.press(getByText('手動で食事名・栄養を入力'));
      });

      await waitFor(() => {
        expect(getByText('食事情報')).toBeTruthy();
      });
    });

    it('料理名フィールドが表示される', async () => {
      const { getByText, getByPlaceholderText } = render(<MealNewPage />);

      act(() => {
        fireEvent.press(getByText('手動で食事名・栄養を入力'));
      });

      await waitFor(() => {
        expect(getByPlaceholderText('食事名（必須）')).toBeTruthy();
      });
    });

    it('料理名を入力できる', async () => {
      const { getByText, getByPlaceholderText } = render(<MealNewPage />);

      act(() => {
        fireEvent.press(getByText('手動で食事名・栄養を入力'));
      });

      await waitFor(() => {
        expect(getByPlaceholderText('食事名（必須）')).toBeTruthy();
      });

      const input = getByPlaceholderText('食事名（必須）');
      act(() => {
        fireEvent.changeText(input, '鶏の唐揚げ定食');
      });

      expect(input.props.value).toBe('鶏の唐揚げ定食');
    });

    it('カロリーフィールドが表示される', async () => {
      const { getByText, getByPlaceholderText } = render(<MealNewPage />);

      act(() => {
        fireEvent.press(getByText('手動で食事名・栄養を入力'));
      });

      await waitFor(() => {
        expect(getByPlaceholderText('カロリー (kcal)')).toBeTruthy();
      });
    });

    it('カロリーを入力できる', async () => {
      const { getByText, getByPlaceholderText } = render(<MealNewPage />);

      act(() => {
        fireEvent.press(getByText('手動で食事名・栄養を入力'));
      });

      await waitFor(() => {
        expect(getByPlaceholderText('カロリー (kcal)')).toBeTruthy();
      });

      const input = getByPlaceholderText('カロリー (kcal)');
      act(() => {
        fireEvent.changeText(input, '650');
      });

      expect(input.props.value).toBe('650');
    });

    it('タンパク質を入力できる', async () => {
      const { getByText, getByPlaceholderText } = render(<MealNewPage />);

      act(() => {
        fireEvent.press(getByText('手動で食事名・栄養を入力'));
      });

      await waitFor(() => {
        expect(getByPlaceholderText('タンパク質 (g)')).toBeTruthy();
      });

      const input = getByPlaceholderText('タンパク質 (g)');
      act(() => {
        fireEvent.changeText(input, '35');
      });

      expect(input.props.value).toBe('35');
    });

    it('「献立表に保存」ボタンが手動入力フォームに存在する', async () => {
      const { getByText } = render(<MealNewPage />);

      act(() => {
        fireEvent.press(getByText('手動で食事名・栄養を入力'));
      });

      await waitFor(() => {
        expect(getByText('献立表に保存')).toBeTruthy();
      });
    });

    it('キャンセルを押すとモード選択に戻る', async () => {
      const { getByText } = render(<MealNewPage />);

      act(() => {
        fireEvent.press(getByText('手動で食事名・栄養を入力'));
      });

      await waitFor(() => {
        expect(getByText('キャンセル')).toBeTruthy();
      });

      act(() => {
        fireEvent.press(getByText('キャンセル'));
      });

      await waitFor(() => {
        expect(getByText('手動で食事名・栄養を入力')).toBeTruthy();
      });
    });
  });

  // #1631: 手動入力の食事の区分のボタンの並び。2 段目 (おやつ・夜食) は手書きをやめ、正本 MEAL_ORDER から基本の 3 食を
  // 除いて作る形に書き換えたので、その結果 (段ごとの値と並び) を固定する。期待値はここで手で書く
  describe('食事の区分のボタンの並び (#1631)', () => {
    /** 段の中の区分のボタンの testID の接頭辞 */
    const MEAL_TYPE_BUTTON_ID_PREFIX = 'meal-type-select-';

    /** 段の中のボタンが表す区分を、描かれた順に返す */
    function mealTypesInRow(row: Parameters<typeof within>[0]): string[] {
      return within(row)
        .getAllByTestId(new RegExp(`^${MEAL_TYPE_BUTTON_ID_PREFIX}`))
        .map((button) => String(button.props.testID).slice(MEAL_TYPE_BUTTON_ID_PREFIX.length));
    }

    it('1 段目は 朝食 → 昼食 → 夕食、2 段目は おやつ → 夜食', async () => {
      const { getByText, getByTestId } = render(<MealNewPage />);

      act(() => {
        fireEvent.press(getByText('手動で食事名・栄養を入力'));
      });

      await waitFor(() => {
        expect(getByTestId('meal-type-row-base')).toBeTruthy();
      });

      expect(mealTypesInRow(getByTestId('meal-type-row-base'))).toEqual(['breakfast', 'lunch', 'dinner']);
      expect(mealTypesInRow(getByTestId('meal-type-row-extra'))).toEqual(['snack', 'midnight_snack']);
      // 2 段目のボタンは区分の表示名で出る
      expect(within(getByTestId('meal-type-row-extra')).getByText('おやつ')).toBeTruthy();
      expect(within(getByTestId('meal-type-row-extra')).getByText('夜食')).toBeTruthy();
    });
  });

  describe('モード選択', () => {
    it('各モードが選択可能である', () => {
      const { getByText } = render(<MealNewPage />);

      expect(getByText('オート')).toBeTruthy();
      expect(getByText('食事')).toBeTruthy();
      expect(getByText('冷蔵庫')).toBeTruthy();
      expect(getByText('健診')).toBeTruthy();
      expect(getByText('体重計')).toBeTruthy();
    });

    it('食事モードを選択しても手動入力ボタンが残る', async () => {
      const { getByText } = render(<MealNewPage />);

      act(() => {
        fireEvent.press(getByText('食事'));
      });

      await waitFor(() => {
        expect(getByText('手動で食事名・栄養を入力')).toBeTruthy();
      });
    });

    it('冷蔵庫モードを選択しても手動入力ボタンが残る', async () => {
      const { getByText } = render(<MealNewPage />);

      act(() => {
        fireEvent.press(getByText('冷蔵庫'));
      });

      await waitFor(() => {
        expect(getByText('手動で食事名・栄養を入力')).toBeTruthy();
      });
    });
  });
});
