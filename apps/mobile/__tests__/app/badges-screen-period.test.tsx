/**
 * badges-screen-period.test.tsx
 * モバイルのバッジ一覧 (apps/mobile/app/badges/index.tsx) で、確定した期間に取ったバッジ (先週・先月の 1 位など) に
 * どの期間のものかを添える (#1528)
 *
 * GET /api/badges は、比較ランキングのバッジを取った期間がある獲得済みのバッジに periodAwards (最新の期間と取った回数) を付ける。
 * 画面は Web と同じ整形 (formatBadgePeriodAwards。@homegohan/shared) で「獲得した期間: 2026年9月（通算 3 回）」のように出し、
 * その期間の判定の文 (「🏆 全体の朝食率で1位！」) も添える。periodAwards の無いバッジ・未獲得のバッジには何も出さない。
 */

import React from 'react';
import { render, screen, waitFor } from '@testing-library/react-native';

import BadgesPage from '../../app/badges/index';

jest.mock('expo-router', () => ({
  useLocalSearchParams: () => ({}),
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn() }),
}));
jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

const mockGet = jest.fn();
jest.mock('../../src/lib/api', () => ({
  getApi: () => ({ get: (...args: unknown[]) => mockGet(...args), post: jest.fn(), put: jest.fn() }),
}));

function badge(overrides: Record<string, unknown>) {
  return {
    id: 'b-1',
    code: 'segment_rank_1',
    name: 'セグメント1位',
    description: 'セグメント内で1位を獲得しました！',
    earned: true,
    obtainedAt: '2026-09-01T15:05:00Z',
    periodAwards: null,
    ...overrides,
  };
}

beforeEach(() => {
  mockGet.mockReset();
});

describe('バッジ一覧の、確定した期間に取ったバッジの期間 (#1528)', () => {
  it('1 回だけ取ったバッジは、期間と判定の文を出す', async () => {
    mockGet.mockResolvedValue({
      badges: [
        badge({
          periodAwards: {
            count: 1,
            latest: { periodType: 'weekly', periodStart: '2026-09-28', label: '2026年9月28日〜10月4日の週', message: '🏆 全体の朝食率で1位！' },
          },
        }),
      ],
    });
    render(<BadgesPage />);

    await waitFor(() => expect(screen.getByTestId('badges-badge-period-segment_rank_1')).toBeTruthy());
    expect(screen.getByText('獲得した期間: 2026年9月28日〜10月4日の週')).toBeTruthy();
    expect(screen.getByTestId('badges-badge-period-message-segment_rank_1')).toBeTruthy();
    expect(screen.getByText('🏆 全体の朝食率で1位！')).toBeTruthy();
    expect(mockGet).toHaveBeenCalledWith('/api/badges');
  });

  it('複数の期間で取ったバッジは、最新の期間に通算の回数を添える', async () => {
    mockGet.mockResolvedValue({
      badges: [
        badge({
          periodAwards: {
            count: 3,
            latest: { periodType: 'monthly', periodStart: '2026-09-01', label: '2026年9月', message: null },
          },
        }),
      ],
    });
    render(<BadgesPage />);

    await waitFor(() => expect(screen.getByText('獲得した期間: 2026年9月（通算 3 回）')).toBeTruthy());
    // 判定の文が無ければ、その行は出さない
    expect(screen.queryByTestId('badges-badge-period-message-segment_rank_1')).toBeNull();
  });

  it('期間の無いバッジ・未獲得のバッジには、期間の行を出さない', async () => {
    mockGet.mockResolvedValue({
      badges: [
        badge({ id: 'b-first', code: 'first_bite', name: '最初の一口', periodAwards: null }),
        badge({
          id: 'b-top10',
          code: 'segment_top_10',
          name: '上位10%',
          earned: false,
          obtainedAt: null,
          // 未獲得なら API は null を返すが、万一付いていても出さない
          periodAwards: { count: 1, latest: { periodType: 'daily', periodStart: '2026-10-01', label: '2026年10月1日', message: null } },
        }),
      ],
    });
    render(<BadgesPage />);

    await waitFor(() => expect(screen.getByText('最初の一口')).toBeTruthy());
    expect(screen.queryByTestId('badges-badge-period-first_bite')).toBeNull();
    expect(screen.queryByTestId('badges-badge-period-segment_top_10')).toBeNull();
    expect(screen.queryByText(/獲得した期間/)).toBeNull();
  });
});
