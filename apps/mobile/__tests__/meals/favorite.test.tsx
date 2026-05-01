/**
 * お気に入り (ハートトグル) のテスト
 * - toggle: off → on、on → off
 * - Supabase update モック経由の確認
 * - API エラー時のロールバック
 * - ダブルタップ防止
 */
import React from 'react';
import { render, fireEvent, waitFor, act } from '@testing-library/react-native';

// ─── モック ─────────────────────────────────────────────
jest.mock('expo-router', () => ({
  router: { back: jest.fn(), push: jest.fn(), replace: jest.fn() },
  useLocalSearchParams: jest.fn(() => ({ id: 'meal-fav-001' })),
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

import MealDetailPage from '../../app/meals/[id]';

// ─── テストデータ ─────────────────────────────────────────
const MOCK_MEAL = {
  id: 'meal-fav-001',
  meal_type: 'dinner',
  mode: 'cook',
  dish_name: '肉じゃが',
  description: null,
  image_url: null,
  calories_kcal: 400,
  protein_g: 20,
  fat_g: 10,
  carbs_g: 50,
  fiber_g: null, sugar_g: null, sodium_g: null,
  potassium_mg: null, calcium_mg: null, phosphorus_mg: null,
  iron_mg: null, zinc_mg: null, iodine_ug: null,
  cholesterol_mg: null, vitamin_a_ug: null, vitamin_b1_mg: null,
  vitamin_b2_mg: null, vitamin_b6_mg: null, vitamin_b12_ug: null,
  vitamin_c_mg: null, vitamin_d_ug: null, vitamin_e_mg: null,
  vitamin_k_ug: null, folic_acid_ug: null, saturated_fat_g: null,
  monounsaturated_fat_g: null, polyunsaturated_fat_g: null,
  is_completed: false,
  completed_at: null,
  dishes: [],
  is_simple: true,
  cooking_time_minutes: null,
  daily_meal_id: 'daily-001',
  user_daily_meals: { day_date: '2026-05-01' },
};

// ─── テスト ───────────────────────────────────────────────
describe('お気に入りトグル (MealDetailPage)', () => {
  describe('初期状態: お気に入りなし', () => {
    beforeEach(() => {
      jest.clearAllMocks();
      mockGet.mockImplementation((path: string) => {
        if (path.includes('/api/meals/')) return Promise.resolve(MOCK_MEAL);
        if (path.includes('/like')) return Promise.resolve({ liked: false });
        return Promise.resolve(null);
      });
    });

    it('「お気に入りに追加」ラベルで表示される', async () => {
      const { getByLabelText } = render(<MealDetailPage />);

      await waitFor(() => {
        expect(getByLabelText('お気に入りに追加')).toBeTruthy();
      });
    });

    it('ハートボタンを押すと POST /api/recipes/:name/like が呼ばれる', async () => {
      mockPost.mockResolvedValue({});
      const { getByLabelText } = render(<MealDetailPage />);

      await waitFor(() => {
        expect(getByLabelText('お気に入りに追加')).toBeTruthy();
      });

      act(() => {
        fireEvent.press(getByLabelText('お気に入りに追加'));
      });

      await waitFor(() => {
        expect(mockPost).toHaveBeenCalledTimes(1);
        expect(mockPost).toHaveBeenCalledWith(
          expect.stringMatching(/\/api\/recipes\/.+\/like/),
          {}
        );
      });
    });

    it('POST 成功後にラベルが「お気に入りから削除」に変わる', async () => {
      mockPost.mockResolvedValue({});
      const { getByLabelText } = render(<MealDetailPage />);

      await waitFor(() => {
        expect(getByLabelText('お気に入りに追加')).toBeTruthy();
      });

      act(() => {
        fireEvent.press(getByLabelText('お気に入りに追加'));
      });

      await waitFor(() => {
        expect(getByLabelText('お気に入りから削除')).toBeTruthy();
      });
    });
  });

  describe('初期状態: お気に入り済み', () => {
    beforeEach(() => {
      jest.clearAllMocks();
      mockGet.mockImplementation((path: string) => {
        if (path.includes('/api/meals/')) return Promise.resolve(MOCK_MEAL);
        if (path.includes('/like')) return Promise.resolve({ liked: true });
        return Promise.resolve(null);
      });
    });

    it('「お気に入りから削除」ラベルで表示される', async () => {
      const { getByLabelText } = render(<MealDetailPage />);

      await waitFor(() => {
        expect(getByLabelText('お気に入りから削除')).toBeTruthy();
      });
    });

    it('ハートボタンを押すと DELETE /api/recipes/:name/like が呼ばれる', async () => {
      mockDel.mockResolvedValue({});
      const { getByLabelText } = render(<MealDetailPage />);

      await waitFor(() => {
        expect(getByLabelText('お気に入りから削除')).toBeTruthy();
      });

      act(() => {
        fireEvent.press(getByLabelText('お気に入りから削除'));
      });

      await waitFor(() => {
        expect(mockDel).toHaveBeenCalledTimes(1);
        expect(mockDel).toHaveBeenCalledWith(
          expect.stringMatching(/\/api\/recipes\/.+\/like/)
        );
      });
    });

    it('DELETE 成功後にラベルが「お気に入りに追加」に変わる', async () => {
      mockDel.mockResolvedValue({});
      const { getByLabelText } = render(<MealDetailPage />);

      await waitFor(() => {
        expect(getByLabelText('お気に入りから削除')).toBeTruthy();
      });

      act(() => {
        fireEvent.press(getByLabelText('お気に入りから削除'));
      });

      await waitFor(() => {
        expect(getByLabelText('お気に入りに追加')).toBeTruthy();
      });
    });
  });

  describe('APIエラー時のロールバック', () => {
    beforeEach(() => {
      jest.clearAllMocks();
      mockGet.mockImplementation((path: string) => {
        if (path.includes('/api/meals/')) return Promise.resolve(MOCK_MEAL);
        if (path.includes('/like')) return Promise.resolve({ liked: false });
        return Promise.resolve(null);
      });
    });

    it('POST が失敗した場合、ハートは元の状態に戻る', async () => {
      mockPost.mockRejectedValue(new Error('Network error'));
      const { getByLabelText } = render(<MealDetailPage />);

      await waitFor(() => {
        expect(getByLabelText('お気に入りに追加')).toBeTruthy();
      });

      act(() => {
        fireEvent.press(getByLabelText('お気に入りに追加'));
      });

      // 楽観的更新でいったん「から削除」になる
      await waitFor(() => {
        expect(getByLabelText('お気に入りから削除')).toBeTruthy();
      });

      // POST失敗後にロールバックされる
      await waitFor(() => {
        expect(getByLabelText('お気に入りに追加')).toBeTruthy();
      });
    });
  });

  describe('ダブルタップ防止 (isFavoriteLoading)', () => {
    beforeEach(() => {
      jest.clearAllMocks();
      mockGet.mockImplementation((path: string) => {
        if (path.includes('/api/meals/')) return Promise.resolve(MOCK_MEAL);
        if (path.includes('/like')) return Promise.resolve({ liked: false });
        return Promise.resolve(null);
      });
    });

    it('POST 進行中に再度押しても POST は1回だけ呼ばれる', async () => {
      let resolvePost!: () => void;
      mockPost.mockReturnValue(
        new Promise<void>((r) => { resolvePost = r; })
      );

      const { getByLabelText } = render(<MealDetailPage />);

      await waitFor(() => {
        expect(getByLabelText('お気に入りに追加')).toBeTruthy();
      });

      // 1回目プレス
      act(() => {
        fireEvent.press(getByLabelText('お気に入りに追加'));
      });

      // ローディング中にもう一度プレス (無効化されているはず)
      await waitFor(() => {
        expect(getByLabelText('お気に入りから削除')).toBeTruthy();
      });

      act(() => {
        // disabled なので実際には何も起きない
        fireEvent.press(getByLabelText('お気に入りから削除'));
      });

      // Promiseを解決
      act(() => { resolvePost(); });

      await waitFor(() => {
        // POST は1回だけ
        expect(mockPost).toHaveBeenCalledTimes(1);
      });
    });
  });
});
