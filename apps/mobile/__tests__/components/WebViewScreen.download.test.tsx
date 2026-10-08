/**
 * #1159: WebView の `download` メッセージ (Web → ネイティブの postMessage) の安全性テスト
 *
 * Web の設定画面は、iOS の WebView で <a download> が動かないため、CSV の本文を postMessage で渡してくる。
 * filename / content / mimeType と、メッセージを送ってきたページは WebView 内の JS が自由に作れる。
 * そのためネイティブは何も信用せず、端末への書き込みを次の範囲に閉じる:
 *   - 送信元は自アプリの Web オリジンのページだけ
 *   - 保存先は cacheDirectory の専用フォルダの中だけ (documentDirectory や、その外への ../ には書かない)
 *   - ファイル名は無害化され、本文は文字列で上限以下のものだけ
 *
 * 関数単体の網羅テストは __tests__/lib/webViewDownload.test.ts にある。
 * ここでは WebViewScreen の onMessage を通して、実際の入口から効いていることを確かめる。
 */

import React from 'react';
import { render, waitFor } from '@testing-library/react-native';

// ── 環境変数 ──────────────────────────────────────────────────────────────────
const WEB_BASE_URL = 'https://homegohan-app.vercel.app';
process.env.EXPO_PUBLIC_WEB_URL = WEB_BASE_URL;

// ── expo-router モック ────────────────────────────────────────────────────────
jest.mock('expo-router', () => ({
  useNavigation: () => ({
    addListener: jest.fn(() => jest.fn()),
    isFocused: jest.fn(() => false),
  }),
  useRouter: () => ({
    push: jest.fn(),
    back: jest.fn(),
    canGoBack: jest.fn(() => false),
  }),
  useLocalSearchParams: () => ({}),
}));

// ── react-native-safe-area-context モック ─────────────────────────────────────
jest.mock('react-native-safe-area-context', () => ({
  SafeAreaView: ({ children }: any) => children,
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

// ── react-native-webview モック ───────────────────────────────────────────────
// 渡された props (onMessage など) をテスト側から呼べるように保持する
const mockWebViewProps: Record<string, any> = {};
jest.mock('react-native-webview', () => ({
  WebView: (props: any) => {
    Object.assign(mockWebViewProps, props);
    const { View } = require('react-native');
    return <View testID={props.testID ?? 'webview'} />;
  },
}));

// ── expo-file-system / expo-sharing モック ────────────────────────────────────
// documentDirectory と cacheDirectory を別の値にして、どちらに書いたかを区別できるようにする
jest.mock('expo-file-system', () => ({
  __esModule: true,
  documentDirectory: 'file:///data/app/Documents/',
  cacheDirectory: 'file:///data/app/Library/Caches/',
  writeAsStringAsync: jest.fn(),
  makeDirectoryAsync: jest.fn(),
  readDirectoryAsync: jest.fn(),
  getInfoAsync: jest.fn(),
  deleteAsync: jest.fn(),
  EncodingType: { UTF8: 'utf8' },
}));
jest.mock('expo-sharing', () => ({
  isAvailableAsync: jest.fn(),
  shareAsync: jest.fn(),
}));

// ── supabase モック ───────────────────────────────────────────────────────────
jest.mock('../../src/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: jest.fn(),
    },
  },
}));

import * as FileSystem from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { supabase as mockSupabase } from '../../src/lib/supabase';

const mockGetSession = mockSupabase.auth.getSession as jest.Mock;
const mockWriteAsString = FileSystem.writeAsStringAsync as jest.Mock;
const mockMakeDirectory = FileSystem.makeDirectoryAsync as jest.Mock;
const mockReadDirectory = FileSystem.readDirectoryAsync as jest.Mock;
const mockShareAsync = Sharing.shareAsync as jest.Mock;
const mockIsSharingAvailable = Sharing.isAvailableAsync as jest.Mock;

// ── テーマモック ──────────────────────────────────────────────────────────────
jest.mock('../../src/theme/colors', () => ({
  colors: { accent: '#FF6B35' },
}));

import { WebViewScreen } from '../../src/components/web/WebViewScreen';

// ─────────────────────────────────────────────────────────────────────────────
// ヘルパー
// ─────────────────────────────────────────────────────────────────────────────
const DOCUMENT_DIR = 'file:///data/app/Documents/';
const SAFE_DIR = 'file:///data/app/Library/Caches/webview-downloads/';
const SETTINGS_URL = `${WEB_BASE_URL}/settings?mode=app`;
const CSV_BODY = 'date,meal_type,dish_name\r\n2026-10-08,dinner,カレー';
// 本文の上限 (文字数)。webViewDownload.ts の MAX_DOWNLOAD_CONTENT_LENGTH と同じ値。
// このテストは新しいモジュールを import せず挙動だけを見る (上限の値そのものは単体テスト側で確認)
const MAX_CONTENT_LENGTH = 10 * 1024 * 1024;

/** WebView を描画して、onMessage が渡されるまで待つ */
async function renderWebView() {
  mockGetSession.mockResolvedValue({ data: { session: null } });
  render(<WebViewScreen path="/profile" />);
  await waitFor(() => {
    expect(typeof mockWebViewProps.onMessage).toBe('function');
  });
}

/**
 * Web から `download` メッセージが届いたことにする。
 * options.url を渡すと送信元ページの URL を差し替えられる (undefined を渡せば url が無い状態にもできる)
 */
function sendDownload(payload: Record<string, unknown>, options: { url?: unknown } = {}) {
  mockWebViewProps.onMessage({
    nativeEvent: {
      data: JSON.stringify({ type: 'download', ...payload }),
      url: 'url' in options ? options.url : SETTINGS_URL,
    },
  });
}

/** download の処理は待たずに投げっぱなしなので、積まれた Promise が全部片付くまで待つ */
const flushPromises = () => new Promise<void>((resolve) => setImmediate(resolve));

/** 書き込み先 URI を全部集める */
const writtenUris = (): string[] => mockWriteAsString.mock.calls.map((call) => call[0] as string);

let warnSpy: jest.SpyInstance;
let errorSpy: jest.SpyInstance;

beforeEach(() => {
  jest.clearAllMocks();
  Object.keys(mockWebViewProps).forEach((k) => delete mockWebViewProps[k]);
  mockWriteAsString.mockResolvedValue(undefined);
  mockMakeDirectory.mockResolvedValue(undefined);
  mockReadDirectory.mockResolvedValue([]);
  mockIsSharingAvailable.mockResolvedValue(true);
  mockShareAsync.mockResolvedValue(undefined);
  // 検証で弾いたときの警告ログがテスト出力を埋めないようにする
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  warnSpy.mockRestore();
  errorSpy.mockRestore();
});

// ─────────────────────────────────────────────────────────────────────────────
// 正規の経路 (Web の設定画面の CSV エクスポート) は今までどおり動く
// ─────────────────────────────────────────────────────────────────────────────
describe('正規のエクスポート (設定画面の CSV)', () => {
  it('cacheDirectory の専用フォルダに同じ名前で書き、共有シートに渡す', async () => {
    await renderWebView();

    sendDownload({
      filename: 'homegohan-meals-2026-10-08.csv',
      content: CSV_BODY,
      mimeType: 'text/csv',
    });
    await flushPromises();

    const expectedUri = `${SAFE_DIR}homegohan-meals-2026-10-08.csv`;
    expect(mockMakeDirectory).toHaveBeenCalledWith(SAFE_DIR, { intermediates: true });
    expect(mockWriteAsString).toHaveBeenCalledTimes(1);
    expect(mockWriteAsString).toHaveBeenCalledWith(expectedUri, CSV_BODY, { encoding: 'utf8' });
    expect(mockShareAsync).toHaveBeenCalledTimes(1);
    expect(mockShareAsync).toHaveBeenCalledWith(expectedUri, {
      mimeType: 'text/csv',
      dialogTitle: 'homegohan-meals-2026-10-08.csv',
    });
  });

  it('documentDirectory には書かない (iCloud バックアップや永続領域に個人データを残さない)', async () => {
    await renderWebView();

    sendDownload({ filename: 'homegohan-meals-2026-10-08.csv', content: CSV_BODY, mimeType: 'text/csv' });
    await flushPromises();

    expect(writtenUris().length).toBeGreaterThan(0);
    for (const uri of writtenUris()) {
      expect(uri.startsWith(DOCUMENT_DIR)).toBe(false);
    }
  });

  it('Android の送信元 (パス無しのオリジン表記) でも受け付ける', async () => {
    await renderWebView();

    sendDownload({ filename: 'a.csv', content: CSV_BODY, mimeType: 'text/csv' }, { url: WEB_BASE_URL });
    await flushPromises();

    expect(mockWriteAsString).toHaveBeenCalledTimes(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ファイル名: パストラバーサルの本体 (#1159)
// ─────────────────────────────────────────────────────────────────────────────
describe('危険なファイル名は保存先の外に出られない', () => {
  const DANGEROUS_FILENAMES: Array<[string, unknown]> = [
    ['親ディレクトリへの相対パス', '../../Library/Preferences/evil.csv'],
    ['1 つ上の ../', '../x.csv'],
    ['バックスラッシュ区切り', '..\\..\\evil.csv'],
    ['絶対パス', '/etc/passwd'],
    ['file:// の URL', 'file:///var/mobile/evil.csv'],
    ['パーセントエンコードされた ../', '%2e%2e%2f%2e%2e%2fevil.csv'],
    ['二重にエンコードされた ../', '%252e%252e%252fevil.csv'],
    ['ドットとエンコードの混在', '..%2f..%2fevil.csv'],
    ['NUL 文字での切り詰め', 'evil.csv\u0000.png'],
    ['改行を含む名前', 'a\r\nb.csv'],
    ['"." と ".." だけ', '..'],
    ['空文字', ''],
    ['文字列ではない (数値)', 12345],
    ['文字列ではない (オブジェクト)', { toString: () => '../evil.csv' }],
    ['ファイル名が無い', undefined],
  ];

  it.each(DANGEROUS_FILENAMES)('%s', async (_label, filename) => {
    await renderWebView();

    sendDownload({ filename, content: CSV_BODY, mimeType: 'text/csv' });
    await flushPromises();

    // 弾くのではなく、安全な名前に直して書く
    expect(mockWriteAsString).toHaveBeenCalledTimes(1);
    const uri = writtenUris()[0];
    expect(uri.startsWith(SAFE_DIR)).toBe(true);
    const name = uri.slice(SAFE_DIR.length);
    expect(name).toMatch(/^[A-Za-z0-9._-]+\.(csv|json|txt)$/);
    expect(name).not.toContain('..');
    expect(name.startsWith('.')).toBe(false);
    // 共有シートにも同じ安全なパスを渡す
    expect(mockShareAsync.mock.calls[0][0]).toBe(uri);
  });

  it('../ を含む名前は、末尾の名前だけが残る', async () => {
    await renderWebView();

    sendDownload({ filename: '../x.csv', content: CSV_BODY, mimeType: 'text/csv' });
    await flushPromises();

    expect(writtenUris()).toEqual([`${SAFE_DIR}x.csv`]);
  });

  it('長すぎる名前は切り詰める', async () => {
    await renderWebView();

    sendDownload({ filename: `${'a'.repeat(5000)}.csv`, content: CSV_BODY, mimeType: 'text/csv' });
    await flushPromises();

    const name = writtenUris()[0].slice(SAFE_DIR.length);
    expect(name.length).toBeLessThanOrEqual(100);
    expect(name.endsWith('.csv')).toBe(true);
  });

  it('許可されていない拡張子 (.html / .sh など) は、許可された拡張子 (csv / json / txt) に直して書く', async () => {
    await renderWebView();

    for (const filename of ['evil.html', 'run.sh', 'x.csv.exe', 'payload.plist']) {
      mockWriteAsString.mockClear();
      sendDownload({ filename, content: 'x', mimeType: 'application/octet-stream' });
      await flushPromises();

      const name = writtenUris()[0].slice(SAFE_DIR.length);
      expect(name).toMatch(/\.(csv|json|txt)$/);
    }
  });

  it('共有シートに渡す MIME タイプは、送られてきた値ではなく拡張子から決める', async () => {
    await renderWebView();

    sendDownload({ filename: 'a.csv', content: CSV_BODY, mimeType: 'application/vnd.android.package-archive' });
    await flushPromises();

    expect(mockShareAsync.mock.calls[0][1]).toEqual({ mimeType: 'text/csv', dialogTitle: 'a.csv' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 送信元: 自アプリの Web ページ以外からは受け付けない
// ─────────────────────────────────────────────────────────────────────────────
describe('自アプリ以外のページからの download は処理しない', () => {
  const UNTRUSTED_SENDERS: Array<[string, unknown]> = [
    ['別のサイト', 'https://evil.example/settings'],
    ['ホスト名の後ろに続けた偽装', 'https://homegohan-app.vercel.app.evil.example/settings'],
    ['認証情報部分を使った偽装', 'https://homegohan-app.vercel.app@evil.example/settings'],
    ['バックスラッシュを使った偽装', 'https://evil.example\\@homegohan-app.vercel.app/'],
    ['http (スキームが違う)', 'http://homegohan-app.vercel.app/settings'],
    ['ポートが違う', 'https://homegohan-app.vercel.app:8443/settings'],
    ['about:blank', 'about:blank'],
    ['data: URL', 'data:text/html,<h1>x</h1>'],
    ['javascript: URL', 'javascript:alert(1)'],
    ['空文字', ''],
    ['url が無い', undefined],
    ['null', null],
    ['文字列ではない', 42],
  ];

  it.each(UNTRUSTED_SENDERS)('%s', async (_label, senderUrl) => {
    await renderWebView();

    sendDownload({ filename: 'homegohan-meals-2026-10-08.csv', content: CSV_BODY, mimeType: 'text/csv' }, { url: senderUrl });
    await flushPromises();

    expect(mockMakeDirectory).not.toHaveBeenCalled();
    expect(mockWriteAsString).not.toHaveBeenCalled();
    expect(mockShareAsync).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 本文: 文字列で、上限以下のものだけ
// ─────────────────────────────────────────────────────────────────────────────
describe('本文 (content) の検証', () => {
  it.each([
    ['文字列ではない (数値)', 123],
    ['文字列ではない (オブジェクト)', { a: 1 }],
    ['文字列ではない (配列)', ['a,b']],
    ['null', null],
    ['無い', undefined],
  ])('%s は書かない', async (_label, content) => {
    await renderWebView();

    sendDownload({ filename: 'a.csv', content, mimeType: 'text/csv' });
    await flushPromises();

    expect(mockWriteAsString).not.toHaveBeenCalled();
    expect(mockShareAsync).not.toHaveBeenCalled();
  });

  // 失敗したときに 5MB の本文がテスト出力に載らないよう、巨大本文のテストは呼び出し回数だけで検証する
  it('巨大な本文 (上限超え) は書かない', async () => {
    await renderWebView();

    sendDownload({ filename: 'a.csv', content: 'x'.repeat(MAX_CONTENT_LENGTH + 1), mimeType: 'text/csv' });
    await flushPromises();

    expect(mockWriteAsString.mock.calls.length).toBe(0);
    expect(mockShareAsync.mock.calls.length).toBe(0);
  });

  it('上限ちょうどの本文は書く', async () => {
    await renderWebView();

    sendDownload({ filename: 'a.csv', content: 'x'.repeat(MAX_CONTENT_LENGTH), mimeType: 'text/csv' });
    await flushPromises();

    expect(mockWriteAsString.mock.calls.length).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 他のメッセージには影響しない
// ─────────────────────────────────────────────────────────────────────────────
describe('download 以外のメッセージ', () => {
  it('download 以外のメッセージや壊れた JSON は、ファイルに何も書かない', async () => {
    await renderWebView();

    mockWebViewProps.onMessage({
      nativeEvent: { data: JSON.stringify({ type: 'navigate-back' }), url: SETTINGS_URL },
    });
    mockWebViewProps.onMessage({ nativeEvent: { data: 'not json', url: SETTINGS_URL } });
    await flushPromises();

    expect(mockWriteAsString).not.toHaveBeenCalled();
  });
});
