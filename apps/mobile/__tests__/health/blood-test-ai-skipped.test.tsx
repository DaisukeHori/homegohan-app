/**
 * blood-test-ai-skipped.test.tsx
 * RNTL tests for apps/mobile/app/health/blood-tests.tsx — 同意が無くて AI の分析を省いたときの表示 (T15 / #1154)
 *
 * サーバー (POST /api/health/blood-tests) は、同意が無ければ記録だけを保存し、AI の分析を省いて aiSkipped で知らせる。
 * 画面は「AI分析を実行できませんでした」(事実と違う失敗の表示) の代わりに、同意が必要な旨と同意画面へのボタンを出す。
 */

import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Alert } from 'react-native';

// ---- Mocks ----

const mockGet = jest.fn();
const mockPost = jest.fn();

jest.mock('../../src/lib/api', () => ({
  getApi: () => ({
    get: mockGet,
    post: mockPost,
  }),
}));

const mockRouterPush = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ back: jest.fn(), push: jest.fn() }),
  // AI の分析を省いたときの案内 (AiSkippedNotice) の「同意画面を開く」が使う
  router: { push: (...args: unknown[]) => mockRouterPush(...args) },
}));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

jest.mock('@expo/vector-icons', () => ({
  Ionicons: () => null,
}));

// expo-image-picker mock
const mockRequestMediaLibraryPermissionsAsync = jest.fn();
const mockLaunchImageLibraryAsync = jest.fn();

jest.mock('expo-image-picker', () => ({
  requestCameraPermissionsAsync: jest.fn().mockResolvedValue({ granted: false }),
  requestMediaLibraryPermissionsAsync: (...args: any[]) =>
    mockRequestMediaLibraryPermissionsAsync(...args),
  launchCameraAsync: jest.fn(),
  launchImageLibraryAsync: (...args: any[]) =>
    mockLaunchImageLibraryAsync(...args),
}));

jest.mock('../../src/theme', () => ({
  colors: {
    bg: '#fff',
    card: '#fafafa',
    accent: '#4f46e5',
    accentLight: '#eef2ff',
    text: '#111',
    textLight: '#555',
    textMuted: '#999',
    purple: '#7c3aed',
    purpleLight: '#f5f3ff',
    warning: '#d97706',
    warningLight: '#fffbeb',
    success: '#16a34a',
    successLight: '#f0fdf4',
    error: '#dc2626',
    errorLight: '#fef2f2',
    border: '#e5e7eb',
    blue: '#2563eb',
    blueLight: '#dbeafe',
    streak: '#f97316',
  },
  spacing: { xs: 4, sm: 8, md: 16, lg: 24, xl: 32 },
  radius: { sm: 4, md: 8, lg: 12, xl: 16, full: 9999 },
  shadows: { sm: {} },
}));

jest.mock('../../src/components/ui', () => {
  const React = require('react');
  const { Text, TouchableOpacity, View, ActivityIndicator } = require('react-native');
  return {
    Button: ({ children, onPress, loading, disabled }: any) => (
      <TouchableOpacity onPress={onPress} disabled={disabled || loading} testID="save-btn">
        <Text>{loading ? '保存中...' : children}</Text>
      </TouchableOpacity>
    ),
    EmptyState: ({ message, actionLabel, onAction }: any) => (
      <View>
        <Text>{message}</Text>
        {actionLabel && <TouchableOpacity onPress={onAction}><Text>{actionLabel}</Text></TouchableOpacity>}
      </View>
    ),
    LoadingState: ({ message }: any) => <Text>{message ?? '読み込み中...'}</Text>,
  };
});

import BloodTestsPage from '../../app/health/blood-tests';
import {
  AI_CONSENT_CHECK_FAILED_SKIPPED_NOTE,
  AI_CONSENT_SKIPPED_NOTE,
} from '../../src/lib/ai-consent';

jest.spyOn(Alert, 'alert').mockImplementation(() => {});

beforeEach(() => {
  jest.clearAllMocks();
  mockGet.mockResolvedValue({ results: [], longitudinalReview: null });
});

afterEach(() => {
  cleanup();
});

/** 一覧 (空) から「記録を追加」でフォームへ移り、そのまま保存する (検査日は今日が入っている) */
async function saveFromEmptyList() {
  render(<BloodTestsPage />);
  fireEvent.press(await screen.findByText('記録を追加'));
  const save = await screen.findByText('保存してAI分析を実行');
  await act(async () => {
    fireEvent.press(save);
  });
  await waitFor(() => {
    expect(mockPost).toHaveBeenCalledWith('/api/health/blood-tests', expect.objectContaining({ test_date: expect.any(String) }));
  });
}

describe('BloodTestsPage — AI の分析を省いたときの表示 (T15 / #1154)', () => {
  it('同意が無い (aiSkipped: AI_CONSENT_REQUIRED): 同意が必要な旨と同意画面へのボタン。「実行できませんでした」は出さない', async () => {
    mockPost.mockResolvedValueOnce({ result: { id: 'b-1', ai_review: null }, longitudinalReview: null, aiSkipped: 'AI_CONSENT_REQUIRED' });

    await saveFromEmptyList();

    expect(await screen.findByText(AI_CONSENT_SKIPPED_NOTE)).toBeTruthy();
    expect(screen.queryByText('AI分析を実行できませんでした')).toBeNull();
    fireEvent.press(screen.getByText('同意画面を開く'));
    expect(mockRouterPush).toHaveBeenCalledWith('/settings/ai-consent');
  });

  it('同意の状況を読めない (aiSkipped: AI_CONSENT_CHECK_FAILED): 「一時的に」の一文だけ', async () => {
    mockPost.mockResolvedValueOnce({ result: { id: 'b-2', ai_review: null }, longitudinalReview: null, aiSkipped: 'AI_CONSENT_CHECK_FAILED' });

    await saveFromEmptyList();

    expect(await screen.findByText(AI_CONSENT_CHECK_FAILED_SKIPPED_NOTE)).toBeTruthy();
    expect(screen.queryByText('同意画面を開く')).toBeNull();
  });

  it('aiSkipped が無くレビューも無い (AI の失敗): 従来どおり「AI分析を実行できませんでした」', async () => {
    mockPost.mockResolvedValueOnce({ result: { id: 'b-3', ai_review: null }, longitudinalReview: null });

    await saveFromEmptyList();

    expect(await screen.findByText('AI分析を実行できませんでした')).toBeTruthy();
    expect(screen.queryByText('同意画面を開く')).toBeNull();
  });
});
