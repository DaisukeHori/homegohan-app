/**
 * home.test.tsx
 * ホーム画面 (apps/mobile/app/(tabs)/home.tsx) のユニットテスト
 *
 * テスト対象:
 *  - shopping カードの表示条件 (shoppingRemaining > 0)
 *  - shopping カードのタップが /menus/weekly へ遷移
 *  - nutritionAnalysis の suggestion 表示
 *  - executeNutritionSuggestion 呼び出し
 *  - ISO date による「今日」判定の境界 (00:00:00 / 23:59:59)
 */

import React from 'react';
import { render, fireEvent } from '@testing-library/react-native';

// ── expo-router のモック ──────────────────────────────────────────────────────
// jest.mock ファクトリ内の jest.fn() は mock プレフィックスなしでも許可されているが、
// ファクトリ外の変数を参照するとホイスティングエラーになる。
// そのため router オブジェクトをファクトリ内で直接構築し、
// 参照用の mockPush は __esModule モジュール経由で取得する。
jest.mock('expo-router', () => ({
  router: { push: jest.fn() },
  Redirect: ({ href }: { href: string }) => null,
}));

// モック後にモジュールから参照を取得
import { router as mockRouter } from 'expo-router';
const mockPush = mockRouter.push as jest.Mock;

// ── expo-linear-gradient のモック ─────────────────────────────────────────────
jest.mock('expo-linear-gradient', () => ({
  LinearGradient: ({ children }: any) => children,
}));

// ── react-native-svg のモック ─────────────────────────────────────────────────
jest.mock('react-native-svg', () => {
  const React = require('react');
  const { View } = require('react-native');
  return {
    Svg: ({ children }: any) => React.createElement(View, null, children),
    Circle: () => null,
  };
});

// ── @react-native-community/slider のモック ───────────────────────────────────
jest.mock('@react-native-community/slider', () => {
  const { View } = require('react-native');
  return ({ testID }: any) => <View testID={testID ?? 'slider'} />;
});

// ── react-native-safe-area-context のモック ───────────────────────────────────
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

// ── useAuth / useProfile のモック ──────────────────────────────────────────────
jest.mock('../../src/providers/AuthProvider', () => ({
  useAuth: () => ({ user: { id: 'user-1', email: 'test@example.com' } }),
}));

jest.mock('../../src/providers/ProfileProvider', () => ({
  useProfile: () => ({ profile: { nickname: 'テストユーザー', onboardingCompletedAt: '2024-01-01' } }),
}));

// ── UI コンポーネントのモック ─────────────────────────────────────────────────
jest.mock('../../src/components/ui', () => {
  const React = require('react');
  const { View, Text, TouchableOpacity } = require('react-native');
  return {
    Card: ({ children, onPress }: any) =>
      onPress
        ? React.createElement(TouchableOpacity, { onPress }, children)
        : React.createElement(View, null, children),
    Button: ({ children, onPress }: any) =>
      React.createElement(TouchableOpacity, { onPress, testID: 'button' }, React.createElement(Text, null, children)),
    EmptyState: ({ message }: any) => React.createElement(Text, null, message),
    LoadingState: () => React.createElement(View, { testID: 'loading' }),
    StatCard: ({ label, value, unit }: any) =>
      React.createElement(View, null,
        React.createElement(Text, null, `${label}: ${value}${unit}`)
      ),
  };
});

// ── useHomeData のモック ───────────────────────────────────────────────────────
// jest.mock ファクトリ内から参照するため mock プレフィックス変数を使用する
const mockExecuteNutritionSuggestion = jest.fn();
const mockSetSuggestion = jest.fn();

// デフォルト値はファクトリ外で定義し、jest.fn() 参照は mock プレフィックス経由で行う
const mockDefaultHomeData = () => ({
  loading: false,
  todayMeals: [] as any[],
  dailySummary: { totalCalories: 0, completedCount: 0, totalCount: 0, cookCount: 0, buyCount: 0, outCount: 0 },
  cookingStreak: 0,
  weeklyStats: { days: [] as any[], avgCookRate: 0, totalCookCount: 0, totalMealCount: 0 },
  monthlyStats: { cookCount: 0, totalMeals: 0, cookRate: 0 },
  healthSummary: { todayRecord: null, healthStreak: 0, weightChange: null, latestWeight: null, targetWeight: null, hasAlert: false },
  nutritionAnalysis: { score: 0, issues: [] as string[], advice: null, suggestion: null, comparison: {} as any, loading: false },
  expiringItems: [] as any[],
  shoppingRemaining: 0,
  badgeCount: 3,
  latestBadge: null,
  bestMealThisWeek: null,
  activityLevel: null,
  suggestion: null,
  performanceAnalysis: { eligible: false, eligibilityReason: null, nextAction: null, todayCheckin: null, loading: false },
  announcements: [] as any[],
  dismissAnnouncement: jest.fn(),
  toggleMealCompletion: jest.fn(),
  updateActivityLevel: jest.fn(),
  setSuggestion: mockSetSuggestion,
  executeNutritionSuggestion: mockExecuteNutritionSuggestion,
  submitPerformanceCheckin: jest.fn().mockResolvedValue({ success: true }),
  refetch: jest.fn(),
});

// テストごとに上書きできるオーバーライドストア
let mockHomeDataOverrides: Record<string, any> = {};

jest.mock('../../src/hooks/useHomeData', () => ({
  useHomeData: () => ({ ...mockDefaultHomeData(), ...mockHomeDataOverrides }),
}));

// ── @expo/vector-icons のモック ───────────────────────────────────────────────
jest.mock('@expo/vector-icons', () => ({
  Ionicons: ({ name, testID }: any) => {
    const { Text } = require('react-native');
    return <Text testID={testID ?? `icon-${name}`}>{name}</Text>;
  },
}));

// ── 対象コンポーネントのインポート ─────────────────────────────────────────────
import HomeScreen from '../../app/(tabs)/home';

// ─────────────────────────────────────────────────────────────────────────────
// helpers
// ─────────────────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  mockHomeDataOverrides = {};
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. shopping カードの表示条件
// ─────────────────────────────────────────────────────────────────────────────

describe('shopping カード表示条件', () => {
  it('shoppingRemaining === 0 のとき買い物リストカードが表示されない', () => {
    mockHomeDataOverrides = { shoppingRemaining: 0 };
    const { queryByText } = render(<HomeScreen />);
    expect(queryByText('買い物リスト')).toBeNull();
  });

  it('shoppingRemaining > 0 のとき買い物リストカードが表示される', () => {
    mockHomeDataOverrides = { shoppingRemaining: 5 };
    const { getByText } = render(<HomeScreen />);
    expect(getByText('買い物リスト')).toBeTruthy();
    expect(getByText('残り5件')).toBeTruthy();
  });

  it('shoppingRemaining === 1 のとき「残り1件」と表示される', () => {
    mockHomeDataOverrides = { shoppingRemaining: 1 };
    const { getByText } = render(<HomeScreen />);
    expect(getByText('残り1件')).toBeTruthy();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. shopping カードのタップが /menus/weekly へ遷移
// ─────────────────────────────────────────────────────────────────────────────

describe('shopping カード タップ → /menus/weekly 遷移', () => {
  it('買い物リストカードをタップすると router.push("/menus/weekly") が呼ばれる', () => {
    mockHomeDataOverrides = { shoppingRemaining: 3 };
    const { getByText } = render(<HomeScreen />);
    // RNTL の fireEvent.press は Pressable の onPress バブルを自動的にたどる
    fireEvent.press(getByText('買い物リスト'));
    expect(mockPush).toHaveBeenCalledWith('/menus/weekly');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. nutritionAnalysis の suggestion 表示
// ─────────────────────────────────────────────────────────────────────────────

describe('nutritionAnalysis.suggestion 表示', () => {
  it('suggestion が null のとき「献立表でAI変更する」ボタンが表示されない', () => {
    mockHomeDataOverrides = {
      suggestion: '今日のアドバイステキスト',
      nutritionAnalysis: { score: 0, issues: [], advice: null, suggestion: null, comparison: {}, loading: false },
    };
    const { queryByText } = render(<HomeScreen />);
    // AIサジェストバナー自体は表示される
    expect(queryByText('今日のアドバイステキスト')).toBeTruthy();
    // だが「献立表でAI変更する」は非表示
    expect(queryByText('献立表でAI変更する')).toBeNull();
  });

  it('nutritionAnalysis.suggestion が存在するとき「献立表でAI変更する」が表示される', () => {
    mockHomeDataOverrides = {
      suggestion: 'タンパク質が不足しています',
      nutritionAnalysis: {
        score: 0, issues: [], advice: null, comparison: {}, loading: false,
        suggestion: { targetDate: '2026-05-01', targetMeal: 'dinner', suggestedDishes: [], currentIssue: 'タンパク質不足' },
      },
    };
    const { getByText } = render(<HomeScreen />);
    expect(getByText('献立表でAI変更する')).toBeTruthy();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. executeNutritionSuggestion 呼び出し
// ─────────────────────────────────────────────────────────────────────────────

describe('executeNutritionSuggestion 呼び出し', () => {
  it('「献立表でAI変更する」をタップすると executeNutritionSuggestion が呼ばれる', () => {
    mockHomeDataOverrides = {
      suggestion: 'タンパク質が不足しています',
      nutritionAnalysis: {
        score: 0, issues: [], advice: null, comparison: {}, loading: false,
        suggestion: { targetDate: '2026-05-01', targetMeal: 'dinner', suggestedDishes: [], currentIssue: 'タンパク質不足' },
      },
    };
    const { getByText } = render(<HomeScreen />);
    fireEvent.press(getByText('献立表でAI変更する'));
    expect(mockExecuteNutritionSuggestion).toHaveBeenCalledTimes(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. ISO date による「今日」判定の境界
//    home.tsx の週間グラフは `day.date === new Date().toISOString().slice(0, 10)`
//    で「今日」を判定する。UTC 基準の境界値を純粋な日付計算で検証する。
// ─────────────────────────────────────────────────────────────────────────────

// モック外で RealDate を保持 (jest.spyOn で上書き前の参照)
const RealDate = Date;

describe('ISO date による「今日」判定の境界', () => {
  afterEach(() => {
    // Date が spyOn されていればリストア
    jest.restoreAllMocks();
  });

  it('UTC 00:00:00 (= JST 09:00:00) のとき toISOString().slice(0,10) が正しく今日の日付を返す', () => {
    // 2026-05-01T00:00:00.000Z = UTC 深夜0時 = JST 09:00
    const d = new RealDate('2026-05-01T00:00:00.000Z');
    expect(d.toISOString().slice(0, 10)).toBe('2026-05-01');
  });

  it('UTC 23:59:59 (= JST 翌08:59:59) のとき toISOString().slice(0,10) が今日(UTC)を返す', () => {
    // 2026-05-01T23:59:59.999Z = UTC 当日終端
    const d = new RealDate('2026-05-01T23:59:59.999Z');
    expect(d.toISOString().slice(0, 10)).toBe('2026-05-01');
  });

  it('JST 00:00:00 (= UTC 前日 15:00:00) のとき toISOString().slice(0,10) は前日(UTC)になる', () => {
    // 2026-05-01T00:00:00+09:00 = 2026-04-30T15:00:00Z
    // → UTC 基準では「前日」扱いになることを文書化するテスト
    const d = new RealDate('2026-04-30T15:00:00.000Z');
    expect(d.toISOString().slice(0, 10)).toBe('2026-04-30');
  });

  it('JST 23:59:59 (= UTC 同日 14:59:59) のとき toISOString().slice(0,10) は今日(UTC)になる', () => {
    // 2026-05-01T23:59:59+09:00 = 2026-05-01T14:59:59Z
    const d = new RealDate('2026-05-01T14:59:59.000Z');
    expect(d.toISOString().slice(0, 10)).toBe('2026-05-01');
  });

  it('Date のモックで new Date() が引数なしのとき固定日時を返すスパイが動作する', () => {
    const fixedDate = new RealDate('2026-05-01T10:00:00.000Z');
    jest.spyOn(global, 'Date').mockImplementation(
      (...args: any[]) => args.length === 0 ? fixedDate as any : new RealDate(...args as [any]),
    );

    // 引数なし → 固定日時
    const now = new Date();
    expect(now.toISOString().slice(0, 10)).toBe('2026-05-01');

    // 引数あり → 実際の Date を使う
    const specified = new Date('2020-01-15T00:00:00.000Z');
    expect(specified.toISOString().slice(0, 10)).toBe('2020-01-15');
  });
});
