/**
 * #2189 W2: AI 相談のシートが提案を実行してデータを変えたら、データを出すタブの WebView を読み込み直す
 *
 * タブは Web の画面を WebView で開いている。シートで献立の作成などを実行しても、閉じたあとのタブには古い中身が残っていた
 * (Web の AI 相談は mealPlanUpdated を投げる)。ここでは次を確かめる。
 *   1. reloadOnAiConsultationDataChange を渡した画面は、notifyAiConsultationDataChanged で今のページを読み込み直す
 *      (今の URL のまま。スクリプトは URL・トークン・code を持たない)
 *   2. スクリプトは自オリジンのページでだけ読み込み直し、外部ページ・about:blank・認証ブリッジのページでは何もしない
 *   3. 渡さない画面 (スキャンのタブ・規約の同意など) は読み込み直さない。画面が外れたら購読も外れる
 *   4. タブの配線: ホーム・献立・比較は渡し、スキャンのタブ・マイページは渡さない
 *   5. 入力の途中かもしれないページでは読み込み直さない (読み込み直すと保存していない入力が消える)。読み込み直すかはタブ単位でなく、
 *      今開いているページで決める: 読み込み直してよい一覧 (AI_CONSULTATION_RELOADABLE_PATHS) に無いページ (タブの中で移った
 *      入力の画面 '/menus/weekly/request'・編集のモーダルを持つ '/profile' など) と、入力の部品・開いているモーダルがあるとき
 *      (AI_CONSULTATION_RELOAD_BLOCKING_SELECTOR) は何もしない
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
import {
  AI_CONSULTATION_RELOADABLE_PATHS,
  AI_CONSULTATION_RELOAD_BLOCKING_SELECTOR,
  BRIDGE_PAGE_PATH,
} from '../../src/lib/webViewBridge';
import { NATIVE_APP_TABS, findNativeAppTab } from '@homegohan/shared';

async function renderScreen(element: React.ReactElement) {
  const utils = render(element);
  await waitFor(() => expect(mockWebViewProps.source?.uri).toBeDefined());
  const injectJavaScript = jest.fn();
  if (!mockWebViewProps.ref) throw new Error('WebView に ref が渡されていない');
  mockWebViewProps.ref.current = { injectJavaScript };
  return { ...utils, injectJavaScript };
}

type PageDocument = 'at-rest' | 'input-ui-shown' | 'absent';

/**
 * スクリプトを、location が origin・pathname のページ (を模した sandbox) で実行する。
 * document は、'at-rest' なら入力の部品もモーダルも無いページ、'input-ui-shown' なら読み込み直しを止める要素
 * (AI_CONSULTATION_RELOAD_BLOCKING_SELECTOR に当たる要素。編集のモーダル・開いた入力の欄など) があるページ、'absent' なら document が無い
 */
function runOnPage(script: string, origin: string, pathname: string, pageDocument: PageDocument = 'at-rest') {
  const location = { origin, pathname, reload: jest.fn(), assign: jest.fn(), replace: jest.fn() };
  const querySelector = jest.fn((selector: string) =>
    pageDocument === 'input-ui-shown' && selector === AI_CONSULTATION_RELOAD_BLOCKING_SELECTOR ? {} : null,
  );
  const pageWindow = pageDocument === 'absent' ? { location } : { location, document: { querySelector } };
  vm.runInNewContext(script, { window: pageWindow });
  return { ...location, querySelector };
}

async function scriptInjectedOnDataChange(element: React.ReactElement): Promise<string> {
  const { injectJavaScript } = await renderScreen(element);
  notifyAiConsultationDataChanged();
  expect(injectJavaScript).toHaveBeenCalledTimes(1);
  return injectJavaScript.mock.calls[0][0];
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
    // 今の URL のまま読み込み直す (URL・トークン・code を持たない。持つパスは読み込み直してよいページの一覧だけ)
    const page = runOnPage(script, WEB_BASE_URL, '/menus/weekly');
    expect(page.reload).toHaveBeenCalledTimes(1);
    expect(page.assign).not.toHaveBeenCalled();
    expect(page.replace).not.toHaveBeenCalled();
    for (const forbidden of [`${WEB_BASE_URL}/`, 'mode=app', 'code=', 'access_token', 'refresh_token']) {
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

describe('入力の途中かもしれないページでは読み込み直さない (#2189 W2 R1)', () => {
  it.each(AI_CONSULTATION_RELOADABLE_PATHS.map((pathname) => [pathname]))(
    '読み込み直してよい一覧のページ %s は、入力の部品もモーダルも無ければ読み込み直す',
    async (pathname) => {
      const tab = findNativeAppTab(pathname);
      if (!tab) throw new Error(`${pathname} はどのタブのページでもない`);
      const script = await scriptInjectedOnDataChange(<WebViewScreen path={tab.rootPath} reloadOnAiConsultationDataChange />);

      const page = runOnPage(script, WEB_BASE_URL, pathname);

      expect(page.querySelector).toHaveBeenCalledWith(AI_CONSULTATION_RELOAD_BLOCKING_SELECTOR);
      expect(page.reload).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    ['マイページ (編集のモーダルの入力は保存するまで React の state にしか無い)', '/profile', '/profile'],
    ['マイページの中の栄養の目標の入力の画面', '/profile', '/profile/nutrition-targets'],
    ['献立のタブの中で移った献立の依頼の入力の画面 (手順と入力はどこにも保存されない)', '/menus/weekly', '/menus/weekly/request'],
    ['献立のタブの一覧に無いページ', '/menus/weekly', '/menus'],
    ['一覧のページの下のパス', '/home', '/home/extra'],
    ['一覧のページに末尾の / が付いたパス', '/comparison', '/comparison/'],
    ['スキャンのタブのページ', '/home', '/meals/new'],
    ['タブの外のページ', '/home', '/settings'],
  ])('%s (%s のタブで %s を開いているとき) では読み込み直さない', async (_label, tabRootPath, pathname) => {
    const script = await scriptInjectedOnDataChange(<WebViewScreen path={tabRootPath} reloadOnAiConsultationDataChange />);

    const page = runOnPage(script, WEB_BASE_URL, pathname);

    expect(page.reload).not.toHaveBeenCalled();
    expect(page.assign).not.toHaveBeenCalled();
    expect(page.replace).not.toHaveBeenCalled();
  });

  it.each(AI_CONSULTATION_RELOADABLE_PATHS.map((pathname) => [pathname]))(
    '一覧のページ %s でも、入力の部品・開いているモーダルがある間 (編集の途中) は読み込み直さない',
    async (pathname) => {
      const script = await scriptInjectedOnDataChange(<WebViewScreen path="/home" reloadOnAiConsultationDataChange />);

      const page = runOnPage(script, WEB_BASE_URL, pathname, 'input-ui-shown');

      expect(page.querySelector).toHaveBeenCalledWith(AI_CONSULTATION_RELOAD_BLOCKING_SELECTOR);
      expect(page.reload).not.toHaveBeenCalled();
    },
  );

  it('ページの中身 (document) を確かめられないときは読み込み直さない', async () => {
    const script = await scriptInjectedOnDataChange(<WebViewScreen path="/home" reloadOnAiConsultationDataChange />);

    const page = runOnPage(script, WEB_BASE_URL, '/home', 'absent');

    expect(page.reload).not.toHaveBeenCalled();
  });

  it('読み込み直しを止める要素は、入力の部品 (hidden を除く) と開いているモーダル', () => {
    const parts = AI_CONSULTATION_RELOAD_BLOCKING_SELECTOR.split(',').map((part) => part.trim());
    expect(parts).toEqual([
      'input:not([type="hidden"])',
      'textarea',
      'select',
      '[contenteditable]:not([contenteditable="false"])',
      '[role="dialog"]',
      '[aria-modal="true"]',
      'dialog[open]',
    ]);
  });

  it.each(AI_CONSULTATION_RELOADABLE_PATHS.map((pathname) => [pathname]))(
    '一覧のページ %s は Web に実在し、reloadOnAiConsultationDataChange を渡すタブのページ',
    (pathname) => {
      const webPage = path.join(__dirname, '../../../../src/app/(main)', pathname, 'page.tsx');
      expect(fs.existsSync(webPage)).toBe(true);
      const tab = findNativeAppTab(pathname);
      expect(tab).not.toBeNull();
      const tabFile = fs.readFileSync(path.join(__dirname, '../../app/(tabs)', `${tab?.name}.tsx`), 'utf8');
      expect(tabFile).toMatch(/<WebViewScreen[\s\S]*?\breloadOnAiConsultationDataChange\b[\s\S]*?\/>/);
    },
  );

  it('reloadOnAiConsultationDataChange を渡すタブは、開いたときのページが一覧にある', () => {
    for (const tab of NATIVE_APP_TABS) {
      const tabFile = fs.readFileSync(path.join(__dirname, '../../app/(tabs)', `${tab.name}.tsx`), 'utf8');
      const passes = /<WebViewScreen[^>]*\breloadOnAiConsultationDataChange\b/.test(tabFile);
      expect({ tab: tab.name, passes }).toEqual({
        tab: tab.name,
        passes: AI_CONSULTATION_RELOADABLE_PATHS.includes(tab.rootPath),
      });
    }
  });
});

describe('タブの配線 (#2189 W2)', () => {
  const tabSource = (file: string) => fs.readFileSync(path.join(__dirname, '../../app/(tabs)', file), 'utf8');

  it.each(['home.tsx', 'menus.tsx', 'comparison.tsx'])(
    '%s (AI 相談の提案が変えるデータを出すタブ) は reloadOnAiConsultationDataChange を渡す',
    (file) => {
      expect(tabSource(file)).toMatch(/<WebViewScreen[\s\S]*?\breloadOnAiConsultationDataChange\b[\s\S]*?\/>/);
    },
  );

  it.each([
    ['meals.tsx', 'スキャンのタブ (入力の途中の画面)'],
    ['profile.tsx', 'マイページ (編集のモーダル・入力の画面)'],
  ])('%s (%s) は渡さない (読み込み直すと入力が消える)', (file) => {
    expect(tabSource(file)).not.toMatch(/<WebViewScreen[^>]*reloadOnAiConsultationDataChange/);
  });
});
