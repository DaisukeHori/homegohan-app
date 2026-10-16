/**
 * #1049 F7-19: 公開ページ (src/components/PublicPage.tsx) の「Web版を開く」が開く URL。
 *
 * 以前は API のオリジン (EXPO_PUBLIC_API_BASE_URL) で Web の /terms /faq などを開いていた。
 * 利用規約・プライバシーポリシー (src/lib/siteConfig.ts の getTermsUrl / getPrivacyUrl) は Web のオリジン
 * (EXPO_PUBLIC_WEB_URL、無ければ既定の Web) を使うので、API と Web が別のオリジンのビルドでは、
 * 同じ「利用規約」が設定画面と公開ページで別のサーバーを開いていた。
 * ここでは、公開ページの URL が siteConfig と同じオリジンになること、API のオリジンに左右されないこと、
 * app/(public) の画面がすべて PublicPage を通っていること (自前で URL を組み立てていないこと) を確かめる。
 */

import fs from 'fs';
import path from 'path';
import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';

jest.mock('expo-router', () => ({
  router: { back: jest.fn(), push: jest.fn(), replace: jest.fn(), canGoBack: jest.fn() },
}));

jest.mock('@expo/vector-icons', () => ({
  Ionicons: 'Ionicons',
}));

jest.mock('expo-linking', () => ({
  openURL: jest.fn(() => Promise.resolve(true)),
}));

import * as Linking from 'expo-linking';
import { router } from 'expo-router';

import { PublicPage } from '../../src/components/PublicPage';
import { getPrivacyUrl, getTermsUrl } from '../../src/lib/siteConfig';
import { DEFAULT_WEB_URL } from '../../src/lib/webBaseUrl';

const mockOpenURL = Linking.openURL as jest.Mock;
const mockBack = router.back as jest.Mock;
const mockReplace = router.replace as jest.Mock;
const mockCanGoBack = router.canGoBack as jest.Mock;

const ENV_NAMES = ['EXPO_PUBLIC_WEB_URL', 'EXPO_PUBLIC_API_BASE_URL'] as const;
const PUBLIC_DIR = path.resolve(__dirname, '../../app/(public)');

/** 「Web版を開く」を押して、開いた URL を返す */
function openedUrlOf(webPath: string): string {
  const view = render(<PublicPage title="公開ページ" webPath={webPath} />);
  fireEvent.press(view.getByText('Web版を開く'));
  expect(mockOpenURL).toHaveBeenCalledTimes(1);
  return mockOpenURL.mock.calls[0][0] as string;
}

describe('PublicPage の「Web版を開く」(#1049 F7-19)', () => {
  const originalEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    mockOpenURL.mockClear();
    for (const name of ENV_NAMES) {
      originalEnv[name] = process.env[name];
      delete process.env[name];
    }
  });

  afterEach(() => {
    for (const name of ENV_NAMES) {
      if (originalEnv[name] === undefined) delete process.env[name];
      else process.env[name] = originalEnv[name];
    }
  });

  it('API と Web が別のオリジンでも、Web のオリジン (EXPO_PUBLIC_WEB_URL) のページを開く。利用規約と同じオリジン', () => {
    process.env.EXPO_PUBLIC_API_BASE_URL = 'https://api.example.com';
    process.env.EXPO_PUBLIC_WEB_URL = 'https://web.example.com';

    const url = openedUrlOf('/faq');

    expect(url).toBe('https://web.example.com/faq');
    expect(new URL(url).origin).toBe(new URL(getTermsUrl()).origin);
    expect(new URL(url).origin).toBe(new URL(getPrivacyUrl()).origin);
  });

  it('/terms と /privacy は、siteConfig の getTermsUrl / getPrivacyUrl と同じ URL を開く', () => {
    process.env.EXPO_PUBLIC_API_BASE_URL = 'https://api.example.com';
    process.env.EXPO_PUBLIC_WEB_URL = 'https://web.example.com/';

    expect(openedUrlOf('/terms')).toBe(getTermsUrl());
    mockOpenURL.mockClear();
    expect(openedUrlOf('/privacy')).toBe(getPrivacyUrl());
  });

  it('EXPO_PUBLIC_WEB_URL が無ければ既定の Web を開く (API のオリジンを流用しない)', () => {
    process.env.EXPO_PUBLIC_API_BASE_URL = 'https://api.example.com';

    const url = openedUrlOf('/about');

    expect(url).toBe(`${DEFAULT_WEB_URL}/about`);
    expect(url).not.toContain('api.example.com');
  });

  it('API のオリジンが無いビルドでも「Web版を開く」を出す (以前は API のオリジンが無いとボタンが消えた)', () => {
    process.env.EXPO_PUBLIC_WEB_URL = 'https://web.example.com';

    expect(openedUrlOf('/contact')).toBe('https://web.example.com/contact');
  });

  it('webPath が無ければ「Web版を開く」は出さない', () => {
    const view = render(<PublicPage title="公開ページ" />);
    expect(view.queryByText('Web版を開く')).toBeNull();
  });

  it('PublicPage は環境変数を自分で読まない (Web のオリジンは siteConfig の webPageUrl だけから決める)', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../../src/components/PublicPage.tsx'), 'utf8');
    expect(source).not.toMatch(/process\.env|getApiBaseUrl/);
    expect(source).toMatch(/import \{ webPageUrl \} from "\.\.\/lib\/siteConfig"/);
  });
});

describe('PublicPage の自前のヘッダ (#1822)', () => {
  // app/(public)/_layout.tsx は native-stack のヘッダを出さない (__tests__/app/navigator-font-styles.test.tsx)。
  // 見出しと戻る操作は、この自前のヘッダだけが受け持つ。

  beforeEach(() => {
    mockBack.mockClear();
    mockReplace.mockClear();
    mockCanGoBack.mockReset();
  });

  it('日本語の見出しを描く', () => {
    const view = render(<PublicPage title="利用規約" />);
    expect(view.getByText('利用規約')).toBeTruthy();
  });

  it('戻れる履歴があれば、戻るで 1 つ前の画面へ戻る (入口へは移らない)', () => {
    mockCanGoBack.mockReturnValue(true);
    const view = render(<PublicPage title="利用規約" />);
    fireEvent.press(view.getByLabelText('戻る'));
    expect(mockBack).toHaveBeenCalledTimes(1);
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('戻れる履歴が無ければ (直接開いた・リンクから開いた)、戻るで入口 (/) へ移る (行き止まりにしない)', () => {
    mockCanGoBack.mockReturnValue(false);
    const view = render(<PublicPage title="利用規約" />);
    fireEvent.press(view.getByLabelText('戻る'));
    expect(mockReplace).toHaveBeenCalledTimes(1);
    expect(mockReplace).toHaveBeenCalledWith('/');
    expect(mockBack).not.toHaveBeenCalled();
  });
});

describe('app/(public) の画面は、すべて PublicPage を通る (#1049 F7-19)', () => {
  const screens = fs
    .readdirSync(PUBLIC_DIR)
    .filter((name) => /\.tsx?$/.test(name) && !name.startsWith('_'))
    .sort();

  it('画面を拾えている (拾い方が壊れて 0 件で通らないように)', () => {
    expect(screens).toEqual([
      // company / contact / faq / guide / legal / news は、どこからも開かれない画面として消した (#1598)
      'about.tsx',
      'privacy.tsx',
      'terms.tsx',
    ]);
  });

  it.each(screens)('%s は PublicPage に webPath を渡し、自分では URL を組み立てない', (name) => {
    const source = fs.readFileSync(path.join(PUBLIC_DIR, name), 'utf8');
    expect(source).toMatch(/<PublicPage\b[^>]*\bwebPath="\/[a-z-]+"/);
    expect(source).not.toMatch(/EXPO_PUBLIC_|Linking\.openURL|https?:\/\//);
  });
});
