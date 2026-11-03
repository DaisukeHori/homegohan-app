/**
 * #2189 W2: AI 相談のシートが提案を実行してデータを変えたら、データを出すタブの WebView を読み込み直す
 *
 * タブは Web の画面を WebView で開いている。シートで献立の作成などを実行しても、閉じたあとのタブには古い中身が残っていた
 * (Web の AI 相談は mealPlanUpdated を投げる)。ここでは次を確かめる。
 *   1. reloadOnAiConsultationDataChange を渡した画面は、notifyAiConsultationDataChanged で今のページを読み込み直す
 *      (今の URL のまま。スクリプトは URL・トークン・code を持たない)
 *   2. スクリプトは自オリジンのページでだけ読み込み直し、外部ページ・about:blank・認証ブリッジのページでは何もしない
 *   3. 渡さない画面 (スキャンのタブ・規約の同意など) は読み込み直さない。画面が外れたら購読も外れる
 *   4. タブの配線: ホーム・献立・比較・マイページは渡し、スキャンのタブは渡さない。マイページはタブが前に出たときに読み込み直す
 *      (#2195 V3。aiConsultationReloadTiming="onFocus")
 *   5. 入力の途中かもしれないページでは読み込み直さない (読み込み直すと保存していない入力が消える)。読み込み直すかはタブ単位でなく、
 *      今開いているページで決める: 読み込み直してよい一覧 (AI_CONSULTATION_RELOADABLE_PATHS) に無いページ (タブの中で移った
 *      入力の画面 '/menus/weekly/request'・'/profile/nutrition-targets' など) と、入力の部品・開いているモーダルがあるとき
 *      (aiConsultationReloadBlockingSelectorOf。'/profile' は編集のモーダルの層も) は何もしない
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

/** 画面が navigation.addListener で購読した event の callback (最後に購読したもの) と、その解除の関数 */
function navigationListenerOf(event: string): { callback: () => void; unsubscribe: jest.Mock } | null {
  const index = mockNavigation.addListener.mock.calls.map(([name]) => name).lastIndexOf(event);
  if (index < 0) return null;
  return {
    callback: mockNavigation.addListener.mock.calls[index][1],
    unsubscribe: mockNavigation.addListener.mock.results[index].value,
  };
}
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
  AI_CONSULTATION_DEFERRED_RELOAD_OBSERVED_ATTRIBUTES,
  AI_CONSULTATION_RELOADABLE_PATHS,
  AI_CONSULTATION_RELOAD_BLOCKING_SELECTOR,
  AI_CONSULTATION_RELOAD_PAGE_BLOCKING_SELECTORS,
  BRIDGE_PAGE_PATH,
  aiConsultationReloadBlockingSelectorOf,
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

/**
 * ページの document。'at-rest' は入力の部品もモーダルも無いページ、'absent' は document が無いページ。
 * 配列は、ページにある要素に当たるセレクタの部品 (例: 'textarea'・'[role="dialog"]'・'.fixed.inset-0') の一覧
 */
type PageDocument = 'at-rest' | 'absent' | readonly string[];

/** 入力の欄が開いている (基本の要素の 1 つ、textarea がある) ページ */
const INPUT_UI_SHOWN: readonly string[] = ['textarea'];

/**
 * スクリプトを、location が origin・pathname のページ (を模した sandbox) で実行する。
 * querySelector は、渡されたセレクタを ', ' で部品に分け、ページにある要素の部品 (pageDocument) のどれかを含めば要素を返す
 * (セレクタの文字列がちょうど同じかではなく、どの要素に当たるかで決める)
 */
function runOnPage(script: string, origin: string, pathname: string, pageDocument: PageDocument = 'at-rest') {
  const location = { origin, pathname, reload: jest.fn(), assign: jest.fn(), replace: jest.fn() };
  const present: readonly string[] = Array.isArray(pageDocument) ? pageDocument : [];
  const querySelector = jest.fn((selector: string) =>
    selector.split(',').map((part) => part.trim()).some((part) => present.includes(part)) ? {} : null,
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
  // isFocused の戻り値を変えるテストがあるので、既定 (前に出ていない) に戻す
  mockNavigation.isFocused.mockReturnValue(false);
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

      expect(page.querySelector).toHaveBeenCalledWith(aiConsultationReloadBlockingSelectorOf(pathname));
      expect(page.reload).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    ['マイページの中の栄養の目標の入力の画面', '/profile', '/profile/nutrition-targets'],
    ['マイページの下のパス', '/profile', '/profile/extra'],
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

      const page = runOnPage(script, WEB_BASE_URL, pathname, INPUT_UI_SHOWN);

      expect(page.querySelector).toHaveBeenCalledWith(aiConsultationReloadBlockingSelectorOf(pathname));
      expect(page.reload).not.toHaveBeenCalled();
    },
  );

  it.each(
    AI_CONSULTATION_RELOAD_BLOCKING_SELECTOR.split(',').map((part) => [part.trim()]),
  )('基本の要素 %s が 1 つでもあれば読み込み直さない', async (part) => {
    const script = await scriptInjectedOnDataChange(<WebViewScreen path="/home" reloadOnAiConsultationDataChange />);

    expect(runOnPage(script, WEB_BASE_URL, '/home', [part]).reload).not.toHaveBeenCalled();
  });

  it('マイページ (/profile) は、role="dialog" も入力の部品も無い編集のモーダルの層 (.fixed.inset-0) がある間も読み込み直さない (#2195 V3)', async () => {
    const script = await scriptInjectedOnDataChange(<WebViewScreen path="/profile" reloadOnAiConsultationDataChange />);

    expect(runOnPage(script, WEB_BASE_URL, '/profile', ['.fixed.inset-0']).reload).not.toHaveBeenCalled();
    expect(runOnPage(script, WEB_BASE_URL, '/profile').reload).toHaveBeenCalledTimes(1);
  });

  it('ページごとに足す要素は、そのページだけに効く (ほかのページの読み込み直しの条件は変えない)', async () => {
    const script = await scriptInjectedOnDataChange(<WebViewScreen path="/menus/weekly" reloadOnAiConsultationDataChange />);

    expect(runOnPage(script, WEB_BASE_URL, '/menus/weekly', ['.fixed.inset-0']).reload).toHaveBeenCalledTimes(1);
  });

  it('ページごとに足す要素の鍵は、読み込み直してよい一覧のページ', () => {
    for (const pathname of Object.keys(AI_CONSULTATION_RELOAD_PAGE_BLOCKING_SELECTORS)) {
      expect(AI_CONSULTATION_RELOADABLE_PATHS).toContain(pathname);
    }
    expect(aiConsultationReloadBlockingSelectorOf('/profile')).toBe(`${AI_CONSULTATION_RELOAD_BLOCKING_SELECTOR}, .fixed.inset-0`);
    expect(aiConsultationReloadBlockingSelectorOf('/home')).toBe(AI_CONSULTATION_RELOAD_BLOCKING_SELECTOR);
    expect(aiConsultationReloadBlockingSelectorOf('constructor')).toBe(AI_CONSULTATION_RELOAD_BLOCKING_SELECTOR);
  });

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
      expect(passesReloadOnAiConsultationDataChange(tabSource(`${tab?.name}.tsx`))).toBe(true);
    },
  );

  it('reloadOnAiConsultationDataChange を渡すタブは、開いたときのページが一覧にある', () => {
    for (const tab of NATIVE_APP_TABS) {
      const passes = passesReloadOnAiConsultationDataChange(tabSource(`${tab.name}.tsx`));
      expect({ tab: tab.name, passes }).toEqual({
        tab: tab.name,
        passes: AI_CONSULTATION_RELOADABLE_PATHS.includes(tab.rootPath),
      });
    }
  });
});

/** タブのファイルのソース */
function tabSource(file: string): string {
  return fs.readFileSync(path.join(__dirname, '../../app/(tabs)', file), 'utf8');
}

/** ブロックコメントと行コメントを除く (説明のコメントに語が出ても数えない) */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/**
 * ソースの最初の <WebViewScreen …> の要素の文字列 (props の { } の中の > や /> では止まらない)。無ければ null。
 * 以前の /<WebViewScreen[^>]*…/ は、header={<ProfileSettingsHeader />} の中の > で止まり、その後ろの props を見なかった (#2195 V3)
 */
function webViewScreenElementOf(source: string): string | null {
  const code = stripComments(source);
  const start = code.indexOf('<WebViewScreen');
  if (start < 0) return null;
  let braceDepth = 0;
  for (let index = start + 1; index < code.length; index += 1) {
    const char = code[index];
    if (char === '{') braceDepth += 1;
    else if (char === '}') braceDepth -= 1;
    else if (char === '>' && braceDepth === 0) return code.slice(start, index + 1);
  }
  return null;
}

/** <WebViewScreen> に reloadOnAiConsultationDataChange を (false でなく) 渡しているか */
function passesReloadOnAiConsultationDataChange(source: string): boolean {
  const element = webViewScreenElementOf(source);
  if (element === null) throw new Error('<WebViewScreen> が見つからない');
  return /\breloadOnAiConsultationDataChange\b(?!\s*=\s*\{\s*false\s*\})/.test(element);
}

describe('タブの配線 (#2189 W2・#2195 V3)', () => {
  it.each(['home.tsx', 'menus.tsx', 'comparison.tsx', 'profile.tsx'])(
    '%s (AI 相談の提案が変えるデータを出すタブ) は reloadOnAiConsultationDataChange を渡す',
    (file) => {
      expect(passesReloadOnAiConsultationDataChange(tabSource(file))).toBe(true);
    },
  );

  it('meals.tsx (スキャンのタブ。入力の途中の画面) は渡さない (読み込み直すと入力が消える)', () => {
    expect(passesReloadOnAiConsultationDataChange(tabSource('meals.tsx'))).toBe(false);
  });

  it('マイページ (profile.tsx) だけが、タブが前に出たときに読み込み直す (aiConsultationReloadTiming="onFocus")', () => {
    for (const tab of NATIVE_APP_TABS) {
      const element = webViewScreenElementOf(tabSource(`${tab.name}.tsx`)) ?? '';
      expect({ tab: tab.name, onFocus: /\baiConsultationReloadTiming="onFocus"/.test(element) }).toEqual({
        tab: tab.name,
        onFocus: tab.name === 'profile',
      });
    }
  });

  it('要素の読み取りは、props の中の JSX (header={<… />}) の > で止まらない (見張りの自己検査)', () => {
    const withHeader = '<WebViewScreen path="/profile" header={<ProfileSettingsHeader />} reloadOnAiConsultationDataChange />';
    expect(passesReloadOnAiConsultationDataChange(withHeader)).toBe(true);
    // 以前の書き方は、この形の props を見落としていた
    expect(/<WebViewScreen[^>]*reloadOnAiConsultationDataChange/.test(withHeader)).toBe(false);
    expect(passesReloadOnAiConsultationDataChange('<WebViewScreen path="/meals/new" header={<X />} />')).toBe(false);
    expect(passesReloadOnAiConsultationDataChange('<WebViewScreen path="/home" reloadOnAiConsultationDataChange={false} />')).toBe(false);
    expect(
      passesReloadOnAiConsultationDataChange('// reloadOnAiConsultationDataChange を渡さない\n<WebViewScreen path="/meals/new" />'),
    ).toBe(false);
    // 要素の後ろのコメントの語は数えない
    expect(passesReloadOnAiConsultationDataChange('<WebViewScreen path="/meals/new" />\nconst note = 1; // reloadOnAiConsultationDataChange')).toBe(
      false,
    );
  });
});

describe('マイページの読み込み直しの時機 (aiConsultationReloadTiming="onFocus"。#2195 V3)', () => {
  it('知らせを受けたときにタブが前に出ていなければ読み込み直さず、次にタブが前に出たときに 1 回だけ読み込み直す', async () => {
    mockNavigation.isFocused.mockReturnValue(false);
    const { injectJavaScript } = await renderScreen(
      <WebViewScreen path="/profile" reloadOnAiConsultationDataChange aiConsultationReloadTiming="onFocus" />,
    );
    const focus = navigationListenerOf('focus');
    if (!focus) throw new Error('focus を購読していない');

    notifyAiConsultationDataChanged();
    notifyAiConsultationDataChanged();
    expect(injectJavaScript).not.toHaveBeenCalled();

    focus.callback();
    expect(injectJavaScript).toHaveBeenCalledTimes(1);
    const page = runOnPage(injectJavaScript.mock.calls[0][0], WEB_BASE_URL, '/profile');
    expect(page.querySelector).toHaveBeenCalledWith(aiConsultationReloadBlockingSelectorOf('/profile'));
    expect(page.reload).toHaveBeenCalledTimes(1);

    // 知らせが無いまま前に出ても読み込み直さない
    focus.callback();
    expect(injectJavaScript).toHaveBeenCalledTimes(1);
  });

  it('知らせを受けたときにタブが前に出ていれば、すぐ読み込み直す (その後に前に出ても二度は読み込み直さない)', async () => {
    mockNavigation.isFocused.mockReturnValue(true);
    const { injectJavaScript } = await renderScreen(
      <WebViewScreen path="/profile" reloadOnAiConsultationDataChange aiConsultationReloadTiming="onFocus" />,
    );

    notifyAiConsultationDataChanged();
    expect(injectJavaScript).toHaveBeenCalledTimes(1);

    navigationListenerOf('focus')?.callback();
    expect(injectJavaScript).toHaveBeenCalledTimes(1);
  });

  it('時機を渡さない画面 (既定) は focus を購読せず、知らせを受けたときに読み込み直す', async () => {
    mockNavigation.isFocused.mockReturnValue(false);
    const { injectJavaScript } = await renderScreen(<WebViewScreen path="/home" reloadOnAiConsultationDataChange />);

    expect(navigationListenerOf('focus')).toBeNull();
    notifyAiConsultationDataChanged();
    expect(injectJavaScript).toHaveBeenCalledTimes(1);
  });

  it('reloadOnAiConsultationDataChange を渡さなければ、時機を渡しても何もしない', async () => {
    const { injectJavaScript } = await renderScreen(<WebViewScreen path="/profile" aiConsultationReloadTiming="onFocus" />);

    expect(navigationListenerOf('focus')).toBeNull();
    notifyAiConsultationDataChanged();
    expect(injectJavaScript).not.toHaveBeenCalled();
  });

  it('画面が外れたら、知らせと focus の購読を両方外す', async () => {
    mockNavigation.isFocused.mockReturnValue(false);
    const { injectJavaScript, unmount } = await renderScreen(
      <WebViewScreen path="/profile" reloadOnAiConsultationDataChange aiConsultationReloadTiming="onFocus" />,
    );
    const focus = navigationListenerOf('focus');
    if (!focus) throw new Error('focus を購読していない');
    unmount();

    expect(focus.unsubscribe).toHaveBeenCalledTimes(1);
    notifyAiConsultationDataChanged();
    expect(injectJavaScript).not.toHaveBeenCalled();
  });
});

describe('入力の部品・モーダルで止めた読み込み直しは、止めている要素が無くなったときに 1 回だけ読み込み直す (#2201 U2)', () => {
  /** モーダル (止めている要素の 1 つ) */
  const MODAL_SHOWN: readonly string[] = ['[role="dialog"]'];

  interface FakeObserver {
    callback: () => void;
    options: unknown;
    disconnected: boolean;
  }

  /**
   * runOnPage と同じページに、MutationObserver (知らせはテストが mutate で起こす) を足したもの。
   * ページにある要素 (elements) と pathname はあとから変えられる
   */
  function runOnWatchablePage(script: string, pathname: string, present: readonly string[]) {
    const location = { origin: WEB_BASE_URL, pathname, reload: jest.fn(), assign: jest.fn(), replace: jest.fn() };
    const elements = [...present];
    const querySelector = jest.fn((selector: string) =>
      selector.split(',').map((part) => part.trim()).some((part) => elements.includes(part)) ? {} : null,
    );
    const observers: FakeObserver[] = [];
    class FakeMutationObserver {
      private entry: FakeObserver;
      constructor(callback: () => void) {
        this.entry = { callback, options: null, disconnected: false };
        observers.push(this.entry);
      }
      observe(_target: unknown, options: unknown) {
        this.entry.options = options;
      }
      disconnect() {
        this.entry.disconnected = true;
      }
    }
    const pageWindow: Record<string, unknown> = {
      location,
      document: { querySelector, documentElement: {} },
      MutationObserver: FakeMutationObserver,
    };
    const run = () => vm.runInNewContext(script, { window: pageWindow });
    run();
    const mutate = () => {
      for (const observer of observers.filter((o) => !o.disconnected)) observer.callback();
    };
    return { location, elements, observers, run, mutate };
  }

  it('モーダルを閉じたら 1 回だけ読み込み直し、見張りをやめる', async () => {
    const script = await scriptInjectedOnDataChange(<WebViewScreen path="/profile" reloadOnAiConsultationDataChange />);
    const page = runOnWatchablePage(script, '/profile', MODAL_SHOWN);
    expect(page.location.reload).not.toHaveBeenCalled();
    expect(page.observers).toHaveLength(1);

    // モーダルが出ている間の DOM の変化では読み込み直さない
    page.mutate();
    expect(page.location.reload).not.toHaveBeenCalled();

    page.elements.length = 0;
    page.mutate();
    expect(page.location.reload).toHaveBeenCalledTimes(1);
    expect(page.observers[0].disconnected).toBe(true);
    page.mutate();
    expect(page.location.reload).toHaveBeenCalledTimes(1);
  });

  it('止めている間に何回知らせが来ても、見張りは 1 つで、読み込み直しは 1 回', async () => {
    const script = await scriptInjectedOnDataChange(<WebViewScreen path="/home" reloadOnAiConsultationDataChange />);
    const page = runOnWatchablePage(script, '/home', INPUT_UI_SHOWN);
    page.run();
    page.run();
    expect(page.observers).toHaveLength(1);

    page.elements.length = 0;
    page.mutate();
    expect(page.location.reload).toHaveBeenCalledTimes(1);

    // 外れたあとの知らせは、これまでどおりすぐ読み込み直す
    page.run();
    expect(page.location.reload).toHaveBeenCalledTimes(2);
  });

  it('見張りの間に別のページへ移ったら、読み込み直さずに見張りをやめる', async () => {
    const script = await scriptInjectedOnDataChange(<WebViewScreen path="/profile" reloadOnAiConsultationDataChange />);
    const page = runOnWatchablePage(script, '/profile', MODAL_SHOWN);
    page.location.pathname = '/profile/nutrition-targets';
    page.elements.length = 0;
    page.mutate();
    expect(page.location.reload).not.toHaveBeenCalled();
    expect(page.observers[0].disconnected).toBe(true);
  });

  it('止めている要素の当たり外れを変えうる属性 (モーダルの role・ページごとに足す要素の class など) の変化も見張る', async () => {
    const script = await scriptInjectedOnDataChange(<WebViewScreen path="/profile" reloadOnAiConsultationDataChange />);
    const page = runOnWatchablePage(script, '/profile', MODAL_SHOWN);
    expect(page.observers[0].options).toEqual({
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: [...AI_CONSULTATION_DEFERRED_RELOAD_OBSERVED_ATTRIBUTES],
    });
    expect(AI_CONSULTATION_DEFERRED_RELOAD_OBSERVED_ATTRIBUTES).toEqual(
      expect.arrayContaining(['role', 'aria-modal', 'open', 'contenteditable', 'type', 'class']),
    );
  });
});
