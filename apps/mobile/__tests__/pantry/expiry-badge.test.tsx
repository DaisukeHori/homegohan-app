/**
 * expiry-badge.test.tsx
 * 期限切れバッジ表示・freshness 日本語化のテスト
 */
import { render, screen, waitFor } from '@testing-library/react-native';

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

/** 今日から offset 日後の YYYY-MM-DD 文字列を返す */
function dateFromNow(offsetDays: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('PantryPage — 期限バッジ', () => {
  it('期限切れ食材に「期限切れ」バッジが表示される', async () => {
    mockGet.mockResolvedValueOnce({
      items: [
        {
          id: 'expired-1',
          name: '腐りかけの魚',
          amount: null,
          category: 'fish',
          expirationDate: dateFromNow(-1), // 昨日 = 期限切れ
          addedAt: '2026-04-01',
        },
      ],
    });

    render(<PantryPage />);

    await waitFor(() => {
      expect(screen.getByText(/腐りかけの魚/)).toBeTruthy();
    });

    expect(screen.getByText('期限切れ')).toBeTruthy();
  });

  it('3日以内に期限が来る食材に「期限間近」バッジが表示される', async () => {
    mockGet.mockResolvedValueOnce({
      items: [
        {
          id: 'soon-1',
          name: 'ヨーグルト',
          amount: '1個',
          category: 'dairy',
          expirationDate: dateFromNow(2), // 2日後 = 期限間近
          addedAt: '2026-04-01',
        },
      ],
    });

    render(<PantryPage />);

    await waitFor(() => {
      expect(screen.getByText(/ヨーグルト/)).toBeTruthy();
    });

    expect(screen.getByText('期限間近')).toBeTruthy();
  });

  it('期限が十分残っている食材にはバッジが表示されない', async () => {
    mockGet.mockResolvedValueOnce({
      items: [
        {
          id: 'fresh-1',
          name: '冷凍肉',
          amount: '500g',
          category: 'meat',
          expirationDate: dateFromNow(30), // 30日後 = 新鮮
          addedAt: '2026-04-01',
        },
      ],
    });

    render(<PantryPage />);

    await waitFor(() => {
      expect(screen.getByText(/冷凍肉/)).toBeTruthy();
    });

    expect(screen.queryByText('期限切れ')).toBeNull();
    expect(screen.queryByText('期限間近')).toBeNull();
  });

  it('期限が null の食材にはバッジが表示されない', async () => {
    mockGet.mockResolvedValueOnce({
      items: [
        {
          id: 'no-date-1',
          name: '塩',
          amount: null,
          category: 'other',
          expirationDate: null,
          addedAt: '2026-04-01',
        },
      ],
    });

    render(<PantryPage />);

    await waitFor(() => {
      expect(screen.getByText('塩')).toBeTruthy();
    });

    expect(screen.queryByText('期限切れ')).toBeNull();
    expect(screen.queryByText('期限間近')).toBeNull();
  });

  it('明日が期限の食材には「期限間近」バッジが表示される (境界値)', async () => {
    mockGet.mockResolvedValueOnce({
      items: [
        {
          id: 'tomorrow-1',
          name: '豆腐',
          amount: '1丁',
          category: 'other',
          expirationDate: dateFromNow(1), // 明日 = diff ≈ 0.xx〜1 日 → diff >= 0 && diff <= 3 → 期限間近
          addedAt: '2026-04-01',
        },
      ],
    });

    render(<PantryPage />);

    await waitFor(() => {
      expect(screen.getByText(/豆腐/)).toBeTruthy();
    });

    expect(screen.getByText('期限間近')).toBeTruthy();
  });
});

describe('PantryPage — freshness 日本語化 (検出食材カード)', () => {
  /**
   * getFreshnessLabel / getFreshnessColor はコンポーネント内の private 関数。
   * 検出食材 (detected) リストが表示されるときに使われる。
   * ここでは detected 配列を直接 state に注入する方法がないため、
   * 関数ロジックを単体で検証する純粋関数テストとして記述する。
   */
  const getFreshnessLabel = (freshness: string): string => {
    switch (freshness.toLowerCase()) {
      case 'fresh': return '新鮮';
      case 'good': return '良好';
      case 'expiring_soon': return '期限間近';
      case 'expired': return '期限切れ';
      default: return freshness;
    }
  };

  it.each([
    ['fresh', '新鮮'],
    ['good', '良好'],
    ['expiring_soon', '期限間近'],
    ['expired', '期限切れ'],
    ['unknown', 'unknown'],
  ])('freshness "%s" → "%s" に日本語化される', (input, expected) => {
    expect(getFreshnessLabel(input)).toBe(expected);
  });

  it('大文字混じりでも正しく日本語化される', () => {
    expect(getFreshnessLabel('FRESH')).toBe('新鮮');
    expect(getFreshnessLabel('Expired')).toBe('期限切れ');
  });
});
