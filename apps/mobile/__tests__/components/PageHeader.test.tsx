/**
 * PageHeader.test.tsx
 * src/components/ui/PageHeader.tsx のレンダリングと戻るボタン動作を検証する
 */

import React from 'react';
import { render, fireEvent } from '@testing-library/react-native';

// ── expo-router モック ────────────────────────────────────────────────────────
jest.mock('expo-router', () => ({
  router: { back: jest.fn(), push: jest.fn() },
}));

import { router as mockRouter } from 'expo-router';
const mockBack = mockRouter.back as jest.Mock;

// ── @expo/vector-icons モック ─────────────────────────────────────────────────
jest.mock('@expo/vector-icons', () => ({
  Ionicons: 'Ionicons',
}));

// ── react-native-safe-area-context モック ─────────────────────────────────────
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

import { PageHeader } from '../../src/components/ui/PageHeader';

beforeEach(() => {
  mockBack.mockClear();
});

describe('PageHeader', () => {
  it('title テキストをレンダリングする', () => {
    const { getByText } = render(<PageHeader title="テストページ" />);
    expect(getByText('テストページ')).toBeTruthy();
  });

  it('subtitle が渡されたとき表示される', () => {
    const { getByText } = render(<PageHeader title="タイトル" subtitle="サブタイトル" />);
    expect(getByText('サブタイトル')).toBeTruthy();
  });

  it('subtitle が省略されたとき表示されない', () => {
    const { queryByText } = render(<PageHeader title="タイトル" />);
    expect(queryByText('サブタイトル')).toBeNull();
  });

  it('showBack=true (デフォルト) のとき戻るボタンが存在し、タップで router.back() が呼ばれる', () => {
    const { UNSAFE_getAllByType } = render(<PageHeader title="タイトル" />);
    // Pressable が複数ある可能性があるので最初の Pressable をタップ
    const { Pressable } = require('react-native');
    const pressables = UNSAFE_getAllByType(Pressable);
    // 最初の Pressable が戻るボタン
    fireEvent.press(pressables[0]);
    expect(mockBack).toHaveBeenCalledTimes(1);
  });

  it('showBack=false のとき戻るボタンが表示されない', () => {
    const { UNSAFE_queryAllByType } = render(<PageHeader title="タイトル" showBack={false} />);
    const { Pressable } = require('react-native');
    const pressables = UNSAFE_queryAllByType(Pressable);
    expect(pressables).toHaveLength(0);
  });

  it('right スロットがレンダリングされる', () => {
    const { Text } = require('react-native');
    const { getByText } = render(
      <PageHeader title="タイトル" right={<Text>rightContent</Text>} />,
    );
    expect(getByText('rightContent')).toBeTruthy();
  });
});
