/**
 * 食事詳細画面 (meals/[id].tsx) のテスト
 * - 詳細情報の表示
 * - 27栄養素の折りたたみ表示
 * - お気に入りトグル
 */
import React from 'react';
import { render, fireEvent, waitFor, act } from '@testing-library/react-native';

// ─── モック ─────────────────────────────────────────────
jest.mock('expo-router', () => ({
  router: { back: jest.fn(), push: jest.fn(), replace: jest.fn() },
  useLocalSearchParams: jest.fn(() => ({ id: 'meal-001' })),
}));

jest.mock('@expo/vector-icons', () => ({
  Ionicons: 'Ionicons',
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
    auth: { getSession: jest.fn().mockResolvedValue({ data: { session: null } }) },
  },
}));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  SafeAreaProvider: ({ children }: any) => children,
  SafeAreaView: ({ children }: any) => children,
}));

// ─── コンポーネントをモック設定後にインポート ──────────────
import MealDetailPage from '../../app/meals/[id]';

// ─── テストデータ ─────────────────────────────────────────
const MOCK_MEAL = {
  id: 'meal-001',
  meal_type: 'lunch',
  mode: 'cook',
  dish_name: '鶏の唐揚げ定食',
  description: 'ジューシーな唐揚げ',
  image_url: null,
  calories_kcal: 650,
  protein_g: 35,
  fat_g: 20,
  carbs_g: 80,
  fiber_g: 3,
  sugar_g: 5,
  sodium_g: 1.5,
  potassium_mg: 400,
  calcium_mg: 80,
  phosphorus_mg: 250,
  iron_mg: 2.5,
  zinc_mg: 3.0,
  iodine_ug: 15,
  cholesterol_mg: 120,
  vitamin_a_ug: 50,
  vitamin_b1_mg: 0.3,
  vitamin_b2_mg: 0.2,
  vitamin_b6_mg: 0.5,
  vitamin_b12_ug: 1.5,
  vitamin_c_mg: 10,
  vitamin_d_ug: 2.0,
  vitamin_e_mg: 1.5,
  vitamin_k_ug: 30,
  folic_acid_ug: 40,
  saturated_fat_g: 5,
  monounsaturated_fat_g: 8,
  polyunsaturated_fat_g: 4,
  is_completed: false,
  completed_at: null,
  dishes: [
    {
      name: '唐揚げ',
      role: 'main',
      calories_kcal: 400,
      ingredientsMd: '| 材料 | 量 |\n|---|---|\n| 鶏もも肉 | 200g |',
      recipeStepsMd: '1. 鶏肉を一口大に切る\n2. 揚げる',
      ingredients: ['鶏もも肉 200g', '醤油 大さじ2'],
    },
  ],
  is_simple: false,
  cooking_time_minutes: 30,
  daily_meal_id: 'daily-001',
  user_daily_meals: { day_date: '2026-05-01' },
};

// ─── テスト ───────────────────────────────────────────────
describe('MealDetailPage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGet.mockImplementation((path: string) => {
      if (path === '/api/meals/meal-001') return Promise.resolve(MOCK_MEAL);
      if (path.includes('/like')) return Promise.resolve({ liked: false });
      return Promise.resolve(null);
    });
  });

  describe('基本表示', () => {
    it('料理名が表示される', async () => {
      const { getByText } = render(<MealDetailPage />);
      await waitFor(() => {
        expect(getByText('鶏の唐揚げ定食')).toBeTruthy();
      });
    });

    it('コメント(description)が表示される', async () => {
      const { getByText } = render(<MealDetailPage />);
      await waitFor(() => {
        expect(getByText('ジューシーな唐揚げ')).toBeTruthy();
      });
    });

    it('カロリーが表示される', async () => {
      const { getByText } = render(<MealDetailPage />);
      await waitFor(() => {
        expect(getByText('650')).toBeTruthy();
      });
    });
  });

  describe('27栄養素の折りたたみ表示', () => {
    it('初期状態では詳細栄養素が非表示', async () => {
      const { queryByText, getByText } = render(<MealDetailPage />);
      await waitFor(() => {
        // 料理名が表示されてから確認
        expect(getByText('鶏の唐揚げ定食')).toBeTruthy();
      });
      // 折りたたまれているのでミネラルセクションは非表示
      expect(queryByText('タンパク質')).toBeFalsy();
    });

    it('「詳細栄養素を見る」ボタンを押すと展開される', async () => {
      const { getByText } = render(<MealDetailPage />);

      await waitFor(() => {
        expect(getByText('詳細栄養素を見る（27項目）')).toBeTruthy();
      });

      act(() => {
        fireEvent.press(getByText('詳細栄養素を見る（27項目）'));
      });

      await waitFor(() => {
        expect(getByText('詳細栄養素を閉じる')).toBeTruthy();
      });
    });

    it('展開後にタンパク質が表示される', async () => {
      const { getByText } = render(<MealDetailPage />);

      await waitFor(() => {
        expect(getByText('詳細栄養素を見る（27項目）')).toBeTruthy();
      });

      act(() => {
        fireEvent.press(getByText('詳細栄養素を見る（27項目）'));
      });

      await waitFor(() => {
        expect(getByText('タンパク質')).toBeTruthy();
        expect(getByText('食物繊維')).toBeTruthy();
        expect(getByText('塩分')).toBeTruthy();
        expect(getByText('ビタミンA')).toBeTruthy();
        expect(getByText('飽和脂肪酸')).toBeTruthy();
      });
    });

    it('もう一度押すと折りたたまれる', async () => {
      const { getByText } = render(<MealDetailPage />);

      await waitFor(() => {
        expect(getByText('詳細栄養素を見る（27項目）')).toBeTruthy();
      });

      act(() => {
        fireEvent.press(getByText('詳細栄養素を見る（27項目）'));
      });

      await waitFor(() => {
        expect(getByText('詳細栄養素を閉じる')).toBeTruthy();
      });

      act(() => {
        fireEvent.press(getByText('詳細栄養素を閉じる'));
      });

      await waitFor(() => {
        expect(getByText('詳細栄養素を見る（27項目）')).toBeTruthy();
      });
    });
  });

  describe('お気に入りトグル', () => {
    it('お気に入りボタンが存在する', async () => {
      const { getByLabelText } = render(<MealDetailPage />);
      await waitFor(() => {
        expect(getByLabelText('お気に入りに追加')).toBeTruthy();
      });
    });

    it('お気に入りボタンを押すと API が呼ばれる', async () => {
      mockPost.mockResolvedValue({});
      const { getByLabelText } = render(<MealDetailPage />);

      await waitFor(() => {
        expect(getByLabelText('お気に入りに追加')).toBeTruthy();
      });

      act(() => {
        fireEvent.press(getByLabelText('お気に入りに追加'));
      });

      await waitFor(() => {
        expect(mockPost).toHaveBeenCalledWith(
          expect.stringContaining('/like'),
          {}
        );
      });
    });

    it('お気に入り済みの状態でボタンを押すと DELETE が呼ばれる', async () => {
      mockGet.mockImplementation((path: string) => {
        if (path === '/api/meals/meal-001') return Promise.resolve(MOCK_MEAL);
        if (path.includes('/like')) return Promise.resolve({ liked: true });
        return Promise.resolve(null);
      });
      mockDel.mockResolvedValue({});

      const { getByLabelText } = render(<MealDetailPage />);

      await waitFor(() => {
        expect(getByLabelText('お気に入りから削除')).toBeTruthy();
      });

      act(() => {
        fireEvent.press(getByLabelText('お気に入りから削除'));
      });

      await waitFor(() => {
        expect(mockDel).toHaveBeenCalledWith(
          expect.stringContaining('/like')
        );
      });
    });
  });

  describe('エラー状態', () => {
    it('API が失敗した場合にエラーカードが表示される', async () => {
      mockGet.mockImplementation((path: string) => {
        if (path === '/api/meals/meal-001') return Promise.reject(new Error('取得に失敗しました。'));
        return Promise.resolve(null);
      });

      const { getByText } = render(<MealDetailPage />);

      await waitFor(() => {
        expect(getByText('取得に失敗しました。')).toBeTruthy();
      });
    });
  });

  describe('完了状態トグル', () => {
    it('完了ボタンを押すと PATCH が呼ばれる', async () => {
      mockPatch.mockResolvedValue({});
      const { getByText } = render(<MealDetailPage />);

      await waitFor(() => {
        expect(getByText('完了にする')).toBeTruthy();
      });

      act(() => {
        fireEvent.press(getByText('完了にする'));
      });

      await waitFor(() => {
        expect(mockPatch).toHaveBeenCalledWith(
          '/api/meals/meal-001',
          expect.objectContaining({ is_completed: true })
        );
      });
    });
  });
});
