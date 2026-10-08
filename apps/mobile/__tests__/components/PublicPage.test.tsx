/**
 * PublicPage.test.tsx
 * src/components/PublicPage.tsx の「Web版を開く」リンクのテスト (#1049 F7-19)
 *
 * 以前は API の基点 (EXPO_PUBLIC_API_BASE_URL) を Web 版のオリジンとして流用していた。
 * 今は Web 版のオリジン (EXPO_PUBLIC_WEB_URL。未設定なら本番の Web) を使う。
 */

import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react-native';

const mockOpenURL = jest.fn();
jest.mock('expo-linking', () => ({
  openURL: (...args: unknown[]) => mockOpenURL(...args),
}));

jest.mock('expo-router', () => ({
  router: { back: jest.fn() },
}));

jest.mock('@expo/vector-icons', () => ({
  Ionicons: 'Ionicons',
}));

import { PublicPage } from '../../src/components/PublicPage';

// babel-preset-expo は `process.env.EXPO_PUBLIC_*` を `expo/virtual/env` 経由の参照に置き換える。
// その module は最初に読み込まれた process.env オブジェクトを握るので、
// process.env 自体を差し替えず、同じオブジェクトのプロパティを書き換えて検証する。
const ENV_KEYS = ['EXPO_PUBLIC_WEB_URL', 'EXPO_PUBLIC_API_BASE_URL'] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  jest.clearAllMocks();
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe('PublicPage — 「Web版を開く」リンク', () => {
  it('Web 版のオリジン (EXPO_PUBLIC_WEB_URL) + webPath を開く', () => {
    process.env.EXPO_PUBLIC_WEB_URL = 'https://web.example.com/';
    process.env.EXPO_PUBLIC_API_BASE_URL = 'https://api.example.com';

    render(<PublicPage title="利用規約" webPath="/terms" />);
    fireEvent.press(screen.getByText('Web版を開く'));

    expect(mockOpenURL).toHaveBeenCalledWith('https://web.example.com/terms');
  });

  it('API の基点 (EXPO_PUBLIC_API_BASE_URL) は Web 版リンクに流用しない', () => {
    process.env.EXPO_PUBLIC_API_BASE_URL = 'https://api.example.com';

    render(<PublicPage title="利用規約" webPath="/terms" />);
    fireEvent.press(screen.getByText('Web版を開く'));

    const opened = String(mockOpenURL.mock.calls[0][0]);
    expect(opened).not.toContain('api.example.com');
    // EXPO_PUBLIC_WEB_URL 未設定なら本番の Web を開く
    expect(opened).toBe('https://homegohan-app.vercel.app/terms');
  });

  it('EXPO_PUBLIC_WEB_URL だけ設定されていても (API の基点が無くても) リンクが出る', () => {
    process.env.EXPO_PUBLIC_WEB_URL = 'https://web.example.com';

    render(<PublicPage title="料金" webPath="/pricing" />);

    expect(screen.getByText('Web版を開く')).toBeTruthy();
  });

  it('webPath が無いページにはリンクを出さない', () => {
    render(<PublicPage title="お知らせ" />);

    expect(screen.queryByText('Web版を開く')).toBeNull();
  });
});
