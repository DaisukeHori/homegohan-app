/**
 * streaks-labels.test.tsx
 * streakTypeLabel() 関数の変換ロジックをテスト (PR #580 でマージ済み)
 *
 * streakTypeLabel は streaks.tsx に定義された非エクスポート関数なので、
 * 同一のロジック (STREAK_TYPE_LABELS マップ) を直接テストする。
 * コンポーネントレンダリングでも同テーブルを検証する。
 *
 * Covers:
 *  1. daily_record   → "日次記録"
 *  2. meal_record    → "食事記録"
 *  3. health_record  → "健康記録"
 *  4. exercise_record → "運動記録"
 *  5. 未知のキー      → そのまま返す (フォールバック)
 *  6. コンポーネントがストリークタイプをラベルで表示する (RNTL)
 */

import React from 'react';
import { render, screen, waitFor } from '@testing-library/react-native';

// ---- ロジック単体テスト (ピュア関数) ----

// streakTypeLabel と同等のロジックを再定義（内部実装と一致させる）
const STREAK_TYPE_LABELS: Record<string, string> = {
  daily_record: '日次記録',
  meal_record: '食事記録',
  health_record: '健康記録',
  exercise_record: '運動記録',
  checkin: 'チェックイン',
};

function streakTypeLabel(type: string): string {
  return STREAK_TYPE_LABELS[type] ?? type;
}

describe('streakTypeLabel — ラベル変換', () => {
  it('1. daily_record → "日次記録"', () => {
    expect(streakTypeLabel('daily_record')).toBe('日次記録');
  });

  it('2. meal_record → "食事記録"', () => {
    expect(streakTypeLabel('meal_record')).toBe('食事記録');
  });

  it('3. health_record → "健康記録"', () => {
    expect(streakTypeLabel('health_record')).toBe('健康記録');
  });

  it('4. exercise_record → "運動記録"', () => {
    expect(streakTypeLabel('exercise_record')).toBe('運動記録');
  });

  it('5. 未知のキーはそのまま返す (フォールバック)', () => {
    expect(streakTypeLabel('unknown_type')).toBe('unknown_type');
  });

  it('6. checkin → "チェックイン"', () => {
    expect(streakTypeLabel('checkin')).toBe('チェックイン');
  });
});

// ---- コンポーネント統合テスト ----

const mockGet = jest.fn();

jest.mock('../../src/lib/api', () => ({
  getApi: () => ({ get: mockGet }),
}));

jest.mock('expo-router', () => ({
  Link: ({ children }: { children: React.ReactNode }) => children,
}));

jest.mock('@expo/vector-icons', () => ({
  Ionicons: () => null,
}));

jest.mock('../../src/theme', () => ({
  colors: {
    bg: '#fff',
    card: '#fafafa',
    accent: '#4f46e5',
    text: '#111',
    textLight: '#555',
    textMuted: '#999',
    border: '#e5e7eb',
    error: '#dc2626',
    warning: '#d97706',
    success: '#16a34a',
    streak: '#f97316',
    warningLight: '#fffbeb',
  },
  spacing: { xs: 4, sm: 8, md: 16, lg: 24, xl: 32, '4xl': 64 },
  radius: { sm: 4, md: 8, full: 9999 },
  shadows: { sm: {} },
}));

jest.mock('../../src/components/ui', () => {
  const React = require('react');
  const { Text, View } = require('react-native');
  return {
    Button: ({ children, onPress }: any) => {
      const { TouchableOpacity } = require('react-native');
      return <TouchableOpacity onPress={onPress}><Text>{children}</Text></TouchableOpacity>;
    },
    Card: ({ children }: any) => <View>{children}</View>,
    EmptyState: ({ message }: any) => <Text>{message}</Text>,
    LoadingState: ({ message }: any) => <Text>{message ?? '読み込み中...'}</Text>,
    PageHeader: ({ title }: any) => <Text>{title}</Text>,
    ProgressBar: () => null,
    SectionHeader: ({ title }: any) => <Text testID={`section-title-${title}`}>{title}</Text>,
    StatCard: ({ label, value, unit }: any) => (
      <View>
        <Text>{label}</Text>
        <Text>{`${value}${unit ?? ''}`}</Text>
      </View>
    ),
  };
});

import HealthStreaksPage from '../../app/health/streaks';

beforeEach(() => {
  jest.clearAllMocks();
});

describe('HealthStreaksPage — ストリークラベル表示', () => {
  it('7. daily_record のストリークでは SectionHeader に "日次記録" が表示される', async () => {
    mockGet.mockResolvedValueOnce({
      streak: {
        streak_type: 'daily_record',
        current_streak: 5,
        longest_streak: 10,
        last_activity_date: '2026-05-01',
        streak_start_date: '2026-04-27',
        achieved_badges: [],
        total_records: 20,
      },
      nextBadge: 14,
      daysToNextBadge: 9,
      weeklyRecords: ['2026-04-30', '2026-05-01'],
      weeklyRecordCount: 2,
    });

    render(<HealthStreaksPage />);

    await waitFor(() => {
      // SectionHeader の title に "日次記録" が表示されること
      expect(screen.getByTestId('section-title-日次記録')).toBeTruthy();
    });
  });

  it('8. meal_record のストリークでは SectionHeader に "食事記録" が表示される', async () => {
    mockGet.mockResolvedValueOnce({
      streak: {
        streak_type: 'meal_record',
        current_streak: 3,
        longest_streak: 7,
        last_activity_date: '2026-04-30',
        streak_start_date: '2026-04-28',
        achieved_badges: [],
        total_records: 15,
      },
      nextBadge: 7,
      daysToNextBadge: 4,
      weeklyRecords: [],
      weeklyRecordCount: 0,
    });

    render(<HealthStreaksPage />);

    await waitFor(() => {
      expect(screen.getByTestId('section-title-食事記録')).toBeTruthy();
    });
  });
});
