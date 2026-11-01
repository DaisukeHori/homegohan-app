/**
 * #2189 W2: AI 相談のシートが提案を実行してデータを変えたら、データを出すタブの WebView を読み込み直す
 *
 * タブは Web の画面を WebView で開いている。シートで献立の作成などを実行しても、閉じたあとのタブには古い中身が残っていた
 * (Web の AI 相談は mealPlanUpdated を投げる)。ここでは次を確かめる。
 *   1. reloadOnAiConsultationDataChange を渡した画面は、notifyAiConsultationDataChanged で今のページを読み込み直す
 *      (今の URL のまま。スクリプトは URL・トークン・code を持たない)
 *   2. スクリプトは自オリジンのページでだけ読み込み直し、外部ページ・about:blank・認証ブリッジのページでは何もしない
 *   3. 渡さない画面 (スキャンのタブ・規約の同意など) は読み込み直さない。画面が外れたら購読も外れる
 *   4. タブの配線: ホーム・献立・比較・マイページは渡し、スキャンのタブは渡さない
 */

import fs from 'fs';
import path from 'path';
import React from 'react';
import * as vm from 'vm';
import { render, waitFor } from '@testing-library/react-native';

const WEB_BASE_URL = 'https://homegohan-app.vercel.app';
process.env.EXPO_PUBLIC_WEB_URL = WEB_BASE_URL;

const mockNavigation = {
  addListener: jest.fn((_event: string, _cb: () => void) => jest.fn()),
  isFocused: jest.fn(() => false),
};
jest.mock('expo-router', () => ({
  useNavigation: () => mockNavigation,
  useRouter: () => ({ push: jest.fn(), back: jest.fn(), replace: jest.fn(), canGoBack: jest.fn(() => false) }),
  useLocalSearchParams: () => ({}),
}));

jest.mock('react-native-safe-area-context', () => ({
  SafeAreaView: ({ children }: { children?: React.ReactNode }) => children,
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

// WebView の props (ref を含む) を捕まえる
type CapturedWebViewProps = {
  source?: { uri?: string };
  ref?: { current: { injectJavaScript: (script: string) => void } | null };
  testID?: string;
};
const mockWebViewProps: CapturedWebViewProps = {};
jest.mock('react-native-webview', () => ({
  WebView: (props: CapturedWebViewProps) => {
    Object.assign(mockWebViewProps, props);
    const { View } = require('react-native');
    return <View testID={props.testID ?? 'webview'} />;
  },
}));

jest.mock('expo-file-system/legacy', () => ({
  cacheDirectory: '/tmp/cache/',
  documentDirectory: '/tmp/',
  writeAsStringAsync: jest.fn(() => Promise.resolve()),
  makeDirectoryAsync: jest.fn(() => Promise.resolve()),
  readDirectoryAsync: jest.fn(() => Promise.resolve([])),
  getInfoAsync: jest.fn(() => Promise.resolve({ exists: false })),
  deleteAsync: jest.fn(() => Promise.resolve()),
  EncodingType: { UTF8: 'utf8' },
}));
jest.mock('expo-sharing', () => ({
  isAvailableAsync: jest.fn(() => Promise.resolve(false)),
  shareAsync: jest.fn(),
}));

// セッションが無い (トークンを含まない直接 URL で開く)。読み込み直しの配線だけを見る
jest.mock('../../src/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: jest.fn(() => Promise.resolve({ data: { session: null } })),
      refreshSession: jest.fn(() => Promise.resolve({ data: { session: null }, error: null })),
    },
  },
}));

jest.mock('../../src/theme/colors', () => ({
  colors: { accent: '#FF6B35' },
}));

import { WebViewScreen } from '../../src/components/web/WebViewScreen';
import {
  notifyAiConsultationDataChanged,
  resetAiConsultationDataChangedListenersForTests,
} from '../../src/lib/ai-consultation-data-changed';
import { BRIDGE_PAGE_PATH } from '../../src/lib/webViewBridge';

async function renderScreen(element: React.ReactElement) {
  const utils = render(element);
  await waitFor(() => expect(mockWebViewProps.source?.uri).toBeDefined());
  const injectJavaScript = jest.fn();
  if (!mockWebViewProps.ref) throw new Error('WebView に ref が渡されていない');
  mockWebViewProps.ref.current = { injectJavaScript };
  return { ...utils, injectJavaScript };
}

/** スクリプトを、location が origin・pathname のページ (を模した sandbox) で実行する */
function runOnPage(script: string, origin: string, pathname: string) {
  const location = { origin, pathname, reload: jest.fn(), assign: jest.fn(), replace: jest.fn() };
  vm.runInNewContext(script, { window: { location } });
  return location;
}

beforeEach(() => {
  jest.clearAllMocks();
  delete mockWebViewProps.source;
  delete mockWebViewProps.ref;
  delete mockWebViewProps.testID;
  resetAiConsultationDataChangedListenersForTests();
});

afterEach(() => {
  resetAiConsultationDataChangedListenersForTests();
});

describe('WebViewScreen — AI 相談の提案の実行で読み込み直す (#2189 W2)', () => {
  it('reloadOnAiConsultationDataChange を渡した画面は、知らせを受けるたびに今のページを読み込み直す', async () => {
    const { injectJavaScript } = await renderScreen(<WebViewScreen path="/menus/weekly" reloadOnAiConsultationDataChange />);

    notifyAiConsultationDataChanged();
    expect(injectJavaScript).toHaveBeenCalledTimes(1);
    const script: string = injectJavaScript.mock.calls[0][0];
    // 今の URL のまま読み込み直す (URL・トークン・code を持たない)
    const page = runOnPage(script, WEB_BASE_URL, '/menus/weekly');
    expect(page.reload).toHaveBeenCalledTimes(1);
    expect(page.assign).not.toHaveBeenCalled();
    expect(page.replace).not.toHaveBeenCalled();
    for (const forbidden of ['/menus/weekly', 'code=', 'access_token', 'refresh_token']) {
      expect(script).not.toContain(forbidden);
    }

    notifyAiConsultationDataChanged();
    expect(injectJavaScript).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['外部ページ', 'https://evil.example', '/'],
    ['読み込みに失敗して残った about:blank (opaque origin)', 'null', 'blank'],
    ['認証ブリッジのページ (code は一度しか使えない)', WEB_BASE_URL, BRIDGE_PAGE_PATH],
  ])('%s の上では読み込み直さない', async (_label, origin, pathname) => {
    const { injectJavaScript } = await renderScreen(<WebViewScreen path="/home" reloadOnAiConsultationDataChange />);

    notifyAiConsultationDataChanged();

    const page = runOnPage(injectJavaScript.mock.calls[0][0], origin, pathname);
    expect(page.reload).not.toHaveBeenCalled();
  });

  it('渡さない画面は読み込み直さない', async () => {
    const { injectJavaScript } = await renderScreen(<WebViewScreen path="/meals/new" />);

    notifyAiConsultationDataChanged();

    expect(injectJavaScript).not.toHaveBeenCalled();
  });

  it('画面が外れたら購読も外れる', async () => {
    const { injectJavaScript, unmount } = await renderScreen(<WebViewScreen path="/home" reloadOnAiConsultationDataChange />);
    unmount();

    notifyAiConsultationDataChanged();

    expect(injectJavaScript).not.toHaveBeenCalled();
  });
});

describe('タブの配線 (#2189 W2)', () => {
  const tabSource = (file: string) => fs.readFileSync(path.join(__dirname, '../../app/(tabs)', file), 'utf8');

  it.each(['home.tsx', 'menus.tsx', 'comparison.tsx', 'profile.tsx'])(
    '%s (AI 相談の提案が変えるデータを出すタブ) は reloadOnAiConsultationDataChange を渡す',
    (file) => {
      expect(tabSource(file)).toMatch(/<WebViewScreen[\s\S]*?\breloadOnAiConsultationDataChange\b[\s\S]*?\/>/);
    },
  );

  it('スキャンのタブ (入力の途中の画面) は渡さない (読み込み直すと入力が消える)', () => {
    expect(tabSource('meals.tsx')).not.toMatch(/<WebViewScreen[^>]*reloadOnAiConsultationDataChange/);
  });
});
