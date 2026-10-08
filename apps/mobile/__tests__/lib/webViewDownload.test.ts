/**
 * #1159: WebView の `download` メッセージの検証と保存 (src/lib/webViewDownload.ts) の単体テスト
 *
 * カバレッジ:
 *   1. sanitizeDownloadFilename: パス区切り・'..'・制御文字・長さ・拡張子・代わりの名前
 *   2. mimeTypeForFilename
 *   3. isTrustedDownloadSender: 自アプリの Web オリジンだけを信用する
 *   4. handleWebViewDownload: 検証 → cacheDirectory への保存 → 共有 → 古いファイルの掃除
 *   5. getDownloadFailureNotice: 正規の書き出しが失敗したときに、利用者へ知らせる文面
 *
 * WebViewScreen の onMessage を通した入口からのテストは
 * __tests__/components/WebViewScreen.download.test.tsx にある。
 */

// ── expo-file-system / expo-sharing モック ────────────────────────────────────
// cacheDirectory が無い (null) 場合も試すため、getter 経由で差し替えられるようにする
const mockDirs: { cache: string | null } = { cache: 'file:///data/app/Library/Caches/' };
jest.mock('expo-file-system', () => ({
  __esModule: true,
  get cacheDirectory() {
    return mockDirs.cache;
  },
  documentDirectory: 'file:///data/app/Documents/',
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

import * as FileSystem from 'expo-file-system';
import * as Sharing from 'expo-sharing';

import {
  DOWNLOAD_DIRECTORY_NAME,
  MAX_DOWNLOAD_CONTENT_LENGTH,
  MAX_DOWNLOAD_FILENAME_LENGTH,
  STALE_DOWNLOAD_MS,
  getDownloadFailureNotice,
  handleWebViewDownload,
  isTrustedDownloadSender,
  mimeTypeForFilename,
  sanitizeDownloadFilename,
} from '../../src/lib/webViewDownload';

const mockWrite = FileSystem.writeAsStringAsync as jest.Mock;
const mockMakeDirectory = FileSystem.makeDirectoryAsync as jest.Mock;
const mockReadDirectory = FileSystem.readDirectoryAsync as jest.Mock;
const mockGetInfo = FileSystem.getInfoAsync as jest.Mock;
const mockDelete = FileSystem.deleteAsync as jest.Mock;
const mockIsSharingAvailable = Sharing.isAvailableAsync as jest.Mock;
const mockShare = Sharing.shareAsync as jest.Mock;

const WEB_URL = 'https://homegohan-app.vercel.app';
const CACHE_DIR = 'file:///data/app/Library/Caches/';
const SAFE_DIR = `${CACHE_DIR}${DOWNLOAD_DIRECTORY_NAME}`;
const CSV_BODY = 'date,meal_type,dish_name\r\n2026-10-08,dinner,カレー';

// 安全な名前の条件: 許可文字だけ・許可された拡張子・先頭が '.' でない・'..' を含まない・長さ内・英数字を含む本体
const SAFE_NAME_PATTERN = /^[A-Za-z0-9._-]+\.(csv|json|txt)$/;
/** 安全な名前でなければ、その理由を返す (総当たりテストで expect を大量に呼ばないよう、判定だけの関数にしてある) */
function findNameViolation(name: string): string | null {
  if (!SAFE_NAME_PATTERN.test(name)) return 'pattern';
  if (name.startsWith('.')) return 'leading-dot';
  if (name.includes('..')) return 'double-dot';
  if (name.length > MAX_DOWNLOAD_FILENAME_LENGTH) return 'too-long';
  if (!/[A-Za-z0-9]/.test(name.slice(0, name.lastIndexOf('.')))) return 'no-alnum-stem';
  return null;
}
function expectSafeName(name: string) {
  expect({ name, violation: findNameViolation(name) }).toEqual({ name, violation: null });
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. sanitizeDownloadFilename
// ─────────────────────────────────────────────────────────────────────────────
describe('sanitizeDownloadFilename', () => {
  describe('正規の名前はそのまま通す', () => {
    it.each([
      'homegohan-meals-2026-10-08.csv',
      'export.json',
      'notes.txt',
      'a_b-c.1.csv',
      'A1.csv',
    ])('%s', (name) => {
      expect(sanitizeDownloadFilename(name, 'text/csv')).toBe(name);
    });

    it('拡張子の大文字小文字は小文字にそろえる', () => {
      expect(sanitizeDownloadFilename('Report.CSV')).toBe('Report.csv');
    });
  });

  describe('ディレクトリ区切りより前は捨てる', () => {
    it.each([
      ['../x.csv', 'x.csv'],
      ['../../Library/Preferences/evil.csv', 'evil.csv'],
      ['..\\..\\x.csv', 'x.csv'],
      ['/var/mobile/Containers/evil.csv', 'evil.csv'],
      ['C:\\Users\\me\\evil.csv', 'evil.csv'],
      ['a/b\\c/d.csv', 'd.csv'],
      ['file:///var/mobile/evil.csv', 'evil.csv'],
    ])('%j → %s', (input, expected) => {
      expect(sanitizeDownloadFilename(input, 'text/csv')).toBe(expected);
    });

    it('区切りで終わる名前 (ベース名が空) は代わりの名前になる', () => {
      expect(sanitizeDownloadFilename('a/b/', 'text/csv')).toBe('homegohan-export.csv');
      expect(sanitizeDownloadFilename('../', 'application/json')).toBe('homegohan-export.json');
    });
  });

  describe('パーセントエンコードを ../ に戻さない', () => {
    it.each([
      ['%2e%2e%2fx.csv', '_2e_2e_2fx.csv'],
      ['%2E%2E%5Cx.csv', '_2E_2E_5Cx.csv'],
      ['%252e%252e%252fx.csv', '_252e_252e_252fx.csv'],
      ['..%2f..%2fx.csv', '_2f._2fx.csv'],
    ])('%j → %s', (input, expected) => {
      const result = sanitizeDownloadFilename(input, 'text/csv');
      expect(result).toBe(expected);
      // '%' が残らない = ネイティブ側でデコードされても '..' や '/' にならない
      expect(result).not.toContain('%');
    });
  });

  describe("'..' と '.' の扱い", () => {
    it.each([
      ['..', 'text/csv', 'homegohan-export.csv'],
      ['.', 'text/csv', 'homegohan-export.csv'],
      ['....', 'application/json', 'homegohan-export.json'],
      ['a..b...c.csv', undefined, 'a.b.c.csv'],
      ['.hidden.csv', undefined, 'hidden.csv'],
      ['trailing.', undefined, 'trailing.txt'],
      ['evil.csv..', undefined, 'evil.csv'],
    ])('%j (%s) → %s', (input, mimeType, expected) => {
      expect(sanitizeDownloadFilename(input, mimeType)).toBe(expected);
    });
  });

  describe('制御文字・空白・日本語・記号は _ にする', () => {
    it.each([
      ['a\u0000b.csv', 'a_b.csv'],
      ['a\r\nb.csv', 'a__b.csv'],
      ['a\tb.csv', 'a_b.csv'],
      ['my report.csv', 'my_report.csv'],
      ['a\u202ecsv.exe.csv', 'a_csv.exe.csv'],
      ['献立2026.csv', '__2026.csv'],
      ['a~$:*?"<>|b.csv', 'a_________b.csv'],
      ['\u{1F600}memo.csv', '__memo.csv'],
    ])('%j → %s', (input, expected) => {
      expect(sanitizeDownloadFilename(input, 'text/csv')).toBe(expected);
    });

    it('英数字が 1 文字も残らない名前 (日本語だけなど) は代わりの名前になる', () => {
      expect(sanitizeDownloadFilename('献立.csv', 'text/csv')).toBe('homegohan-export.csv');
      expect(sanitizeDownloadFilename('___-_.csv', 'text/csv')).toBe('homegohan-export.csv');
      expect(sanitizeDownloadFilename('\u0000\u0001.json')).toBe('homegohan-export.json');
    });
  });

  describe('拡張子は csv / json / txt だけ', () => {
    it.each([
      ['evil.html', 'text/html', 'evil.txt'],
      ['run.sh', undefined, 'run.txt'],
      ['payload.plist', 'application/octet-stream', 'payload.txt'],
      ['x.csv.exe', undefined, 'x.csv.txt'],
      ['archive.tar.gz', undefined, 'archive.tar.txt'],
      ['photo.png', 'image/png', 'photo.txt'],
    ])('許可外の %j は %s に直す (mimeType: %s)', (input, mimeType, expected) => {
      expect(sanitizeDownloadFilename(input, mimeType)).toBe(expected);
    });

    it('拡張子が無い・許可外のときは mimeType から決める', () => {
      expect(sanitizeDownloadFilename('export', 'text/csv')).toBe('export.csv');
      expect(sanitizeDownloadFilename('export', 'application/json')).toBe('export.json');
      expect(sanitizeDownloadFilename('export', 'text/plain')).toBe('export.txt');
      expect(sanitizeDownloadFilename('export', 'text/csv; charset=utf-8')).toBe('export.csv');
      expect(sanitizeDownloadFilename('export', 'TEXT/CSV')).toBe('export.csv');
      expect(sanitizeDownloadFilename('report.pdf', 'application/json')).toBe('report.json');
    });

    it('mimeType が許可リストに無い・文字列でないときは txt', () => {
      expect(sanitizeDownloadFilename('export', 'application/x-msdownload')).toBe('export.txt');
      expect(sanitizeDownloadFilename('export', 'text/csv-evil')).toBe('export.txt');
      expect(sanitizeDownloadFilename('export', 42)).toBe('export.txt');
      expect(sanitizeDownloadFilename('export', null)).toBe('export.txt');
      expect(sanitizeDownloadFilename('export')).toBe('export.txt');
    });

    it('拡張子が許可されていれば、mimeType が食い違っていても拡張子を優先する', () => {
      expect(sanitizeDownloadFilename('a.csv', 'application/json')).toBe('a.csv');
    });

    it("Object のプロパティ名 ('constructor' など) を拡張子として扱わない", () => {
      expect(sanitizeDownloadFilename('a.constructor')).toBe('a.txt');
      expect(sanitizeDownloadFilename('a.__proto__')).toBe('a.txt');
      expect(sanitizeDownloadFilename('a.toString')).toBe('a.txt');
    });
  });

  describe('文字列でない入力は代わりの名前になる', () => {
    it.each([
      ['undefined', undefined],
      ['null', null],
      ['数値', 12345],
      ['真偽値', true],
      ['オブジェクト', { toString: () => '../evil.csv' }],
      ['配列', ['../evil.csv']],
      ['空文字', ''],
    ])('%s', (_label, input) => {
      expect(sanitizeDownloadFilename(input, 'text/csv')).toBe('homegohan-export.csv');
    });
  });

  describe('長さの上限', () => {
    it('長すぎる名前は切り詰め、拡張子は残す', () => {
      const result = sanitizeDownloadFilename(`${'a'.repeat(500)}.csv`);
      expect(result).toHaveLength(MAX_DOWNLOAD_FILENAME_LENGTH);
      expect(result.endsWith('.csv')).toBe(true);
    });

    it('拡張子が無い長い名前も、mimeType で決めた拡張子を付けて上限内に収める', () => {
      const result = sanitizeDownloadFilename('b'.repeat(500), 'application/json');
      expect(result).toHaveLength(MAX_DOWNLOAD_FILENAME_LENGTH);
      expect(result.endsWith('.json')).toBe(true);
    });

    it('切り詰めた位置が "." でも ".." にならない', () => {
      // 96 文字目の直後に '.' が来る位置で切られても、末尾の '.' は落とす
      const stem = `${'a'.repeat(95)}.${'b'.repeat(10)}`;
      const result = sanitizeDownloadFilename(`${stem}.csv`);
      expectSafeName(result);
    });

    it('極端に長い入力 (数 MB) でも一瞬で終わり、上限内に収まる', () => {
      const start = Date.now();
      const result = sanitizeDownloadFilename(`${'../'.repeat(1_000_000)}${'z'.repeat(1_000_000)}.csv`);
      expect(Date.now() - start).toBeLessThan(2000);
      expectSafeName(result);
    });
  });

  describe('どんな入力でも安全な名前になる (組み合わせ総当たり)', () => {
    const FRAGMENTS = [
      '..', '.', '/', '\\', '%2e', '%2f', '%00', '\u0000', '\n', '\r', '\t', ' ', 'a', 'Z', '9', '_', '-',
      '~', '$', ':', '*', '?', '"', '<', '>', '|', '\u202e', '\u3042', '\u{1F600}', '.csv', '.json', '.txt',
      '.exe', 'CON', 'x'.repeat(60),
    ];
    const MIME_TYPES: unknown[] = [undefined, 'text/csv', 'application/json', 'text/html', 42];

    it('3 個までの断片をつなげた全ての組み合わせ', () => {
      let checked = 0;
      const violations: Array<{ input: string; output: string; violation: string }> = [];
      for (const a of FRAGMENTS) {
        for (const b of ['', ...FRAGMENTS]) {
          for (const c of ['', ...FRAGMENTS]) {
            for (const mimeType of MIME_TYPES) {
              const input = `${a}${b}${c}`;
              const output = sanitizeDownloadFilename(input, mimeType);
              const violation = findNameViolation(output);
              if (violation && violations.length < 10) violations.push({ input, output, violation });
              checked++;
            }
          }
        }
      }
      expect(violations).toEqual([]);
      expect(checked).toBeGreaterThan(100_000);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. mimeTypeForFilename
// ─────────────────────────────────────────────────────────────────────────────
describe('mimeTypeForFilename', () => {
  it('拡張子から MIME タイプを決める', () => {
    expect(mimeTypeForFilename('a.csv')).toBe('text/csv');
    expect(mimeTypeForFilename('a.json')).toBe('application/json');
    expect(mimeTypeForFilename('a.txt')).toBe('text/plain');
    expect(mimeTypeForFilename('A.CSV')).toBe('text/csv');
  });

  it('許可外・拡張子なしは text/plain', () => {
    expect(mimeTypeForFilename('a.html')).toBe('text/plain');
    expect(mimeTypeForFilename('noext')).toBe('text/plain');
    expect(mimeTypeForFilename('')).toBe('text/plain');
  });

  it('sanitizeDownloadFilename の結果とは常に整合する', () => {
    expect(mimeTypeForFilename(sanitizeDownloadFilename('x', 'application/json'))).toBe('application/json');
    expect(mimeTypeForFilename(sanitizeDownloadFilename('x.csv', 'application/json'))).toBe('text/csv');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. isTrustedDownloadSender
// ─────────────────────────────────────────────────────────────────────────────
describe('isTrustedDownloadSender', () => {
  const originalEnv = process.env.EXPO_PUBLIC_WEB_URL;
  beforeEach(() => {
    process.env.EXPO_PUBLIC_WEB_URL = WEB_URL;
  });
  afterAll(() => {
    if (originalEnv === undefined) delete process.env.EXPO_PUBLIC_WEB_URL;
    else process.env.EXPO_PUBLIC_WEB_URL = originalEnv;
  });

  it.each([
    [WEB_URL, 'Android の WebMessageListener (パス無しのオリジン)'],
    [`${WEB_URL}/`, '末尾スラッシュ'],
    [`${WEB_URL}/settings`, 'iOS (パス付きのフレーム URL)'],
    [`${WEB_URL}/settings?mode=app#export`, 'クエリとハッシュ付き'],
    ['HTTPS://HOMEGOHAN-APP.VERCEL.APP/settings', '大文字小文字の違い'],
  ])('信用する: %s (%s)', (url) => {
    expect(isTrustedDownloadSender(url)).toBe(true);
  });

  it.each([
    ['https://evil.example/settings', '別サイト'],
    ['https://homegohan-app.vercel.app.evil.example/settings', 'ホスト名の後ろに続けた偽装'],
    ['https://homegohan-app.vercel.app.evil.example', 'ホスト名の後ろに続けた偽装 (パス無し)'],
    ['https://evil-homegohan-app.vercel.app/', 'ホスト名の前に付けた偽装'],
    ['https://homegohan-app.vercel.app@evil.example/', '認証情報部分での偽装'],
    ['https://user:pass@homegohan-app.vercel.app/', '認証情報つき'],
    ['https://evil.example\\@homegohan-app.vercel.app/', 'バックスラッシュでの偽装'],
    ['https://homegohan-app.vercel.app\\.evil.example/', 'バックスラッシュでの偽装 (2)'],
    ['https://evil.example/?u=https://homegohan-app.vercel.app', 'クエリに含めただけ'],
    ['https://evil.example/#@homegohan-app.vercel.app', 'ハッシュに含めただけ'],
    ['http://homegohan-app.vercel.app/settings', 'スキームが違う'],
    ['https://homegohan-app.vercel.app:8443/settings', 'ポートが違う'],
    ['https://homegohan-app.vercel.app:443/settings', 'ポートの明示 (文字列として別物)'],
    ['https://homegohan-app.vercel.app\t.evil.example/', 'タブ文字'],
    [' https://homegohan-app.vercel.app/', '先頭の空白'],
    ['//homegohan-app.vercel.app/', 'スキーム無し'],
    ['/settings', '相対パス'],
    ['about:blank', 'about:blank'],
    ['data:text/html,<h1>x</h1>', 'data: URL'],
    ['javascript:alert(1)', 'javascript: URL'],
    ['file:///var/mobile/x.html', 'file: URL'],
    ['', '空文字'],
  ])('信用しない: %s (%s)', (url) => {
    expect(isTrustedDownloadSender(url)).toBe(false);
  });

  it.each([undefined, null, 42, true, {}, [], [WEB_URL]])('文字列でない (%j) は信用しない', (value) => {
    expect(isTrustedDownloadSender(value)).toBe(false);
  });

  it('EXPO_PUBLIC_WEB_URL を別の値にしたら、そのオリジンだけを信用する (開発用の LAN サーバーなど)', () => {
    process.env.EXPO_PUBLIC_WEB_URL = 'http://192.168.0.10:3000';
    expect(isTrustedDownloadSender('http://192.168.0.10:3000/settings')).toBe(true);
    expect(isTrustedDownloadSender('http://192.168.0.10:3001/settings')).toBe(false);
    expect(isTrustedDownloadSender(`${WEB_URL}/settings`)).toBe(false);
  });

  it('EXPO_PUBLIC_WEB_URL にパスや末尾スラッシュがあってもオリジンだけで比べる', () => {
    process.env.EXPO_PUBLIC_WEB_URL = `${WEB_URL}/`;
    expect(isTrustedDownloadSender(`${WEB_URL}/settings`)).toBe(true);
  });

  it('EXPO_PUBLIC_WEB_URL が無いときは既定のオリジン (WebViewScreen の既定値と同じ)', () => {
    delete process.env.EXPO_PUBLIC_WEB_URL;
    expect(isTrustedDownloadSender(`${WEB_URL}/settings`)).toBe(true);
    expect(isTrustedDownloadSender('https://evil.example/')).toBe(false);
  });

  it('EXPO_PUBLIC_WEB_URL が空文字のときも既定のオリジン (WebViewScreen が開くオリジンと同じ判定)', () => {
    // 空文字を「設定あり」と見ると、WebView が開く URL と、download で信用するオリジンが食い違う
    process.env.EXPO_PUBLIC_WEB_URL = '';
    expect(isTrustedDownloadSender(`${WEB_URL}/settings`)).toBe(true);
    expect(isTrustedDownloadSender('https://evil.example/')).toBe(false);
  });

  it('EXPO_PUBLIC_WEB_URL が解釈できない値のときは、WebView が実際に開く既定のオリジンだけを信用する (#1036)', () => {
    // 解釈できない設定値のとき、WebViewScreen は webViewBridge の getWebOrigin() で既定のオリジンを開く。
    // 送信元の確認も同じ getWebOrigin() から決めるので、既定のオリジンだけを信用し、ほかは信用しない
    process.env.EXPO_PUBLIC_WEB_URL = 'not a url';
    expect(isTrustedDownloadSender(`${WEB_URL}/settings`)).toBe(true);
    expect(isTrustedDownloadSender('https://evil.example/')).toBe(false);
    expect(isTrustedDownloadSender('not a url')).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. handleWebViewDownload
// ─────────────────────────────────────────────────────────────────────────────
describe('handleWebViewDownload', () => {
  const SENDER = `${WEB_URL}/settings?mode=app`;
  const VALID_MESSAGE = {
    type: 'download',
    filename: 'homegohan-meals-2026-10-08.csv',
    content: CSV_BODY,
    mimeType: 'text/csv',
  };

  let warnSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.EXPO_PUBLIC_WEB_URL = WEB_URL;
    mockDirs.cache = CACHE_DIR;
    mockWrite.mockResolvedValue(undefined);
    mockMakeDirectory.mockResolvedValue(undefined);
    mockReadDirectory.mockResolvedValue([]);
    mockGetInfo.mockResolvedValue({ exists: false, isDirectory: false });
    mockDelete.mockResolvedValue(undefined);
    mockIsSharingAvailable.mockResolvedValue(true);
    mockShare.mockResolvedValue(undefined);
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  /** 何も書かず・共有もしていないこと */
  function expectNothingWritten() {
    expect(mockMakeDirectory).not.toHaveBeenCalled();
    expect(mockWrite.mock.calls.length).toBe(0);
    expect(mockShare).not.toHaveBeenCalled();
  }

  describe('正常系', () => {
    it('専用フォルダを作り、同じ名前で書いて、共有シートを開く', async () => {
      const result = await handleWebViewDownload(VALID_MESSAGE, SENDER);

      const uri = `${SAFE_DIR}homegohan-meals-2026-10-08.csv`;
      expect(result).toEqual({ ok: true, uri, shared: true });
      expect(mockMakeDirectory).toHaveBeenCalledWith(SAFE_DIR, { intermediates: true });
      expect(mockWrite).toHaveBeenCalledWith(uri, CSV_BODY, { encoding: 'utf8' });
      expect(mockShare).toHaveBeenCalledWith(uri, {
        mimeType: 'text/csv',
        dialogTitle: 'homegohan-meals-2026-10-08.csv',
      });
    });

    it('フォルダ作成 → 掃除 → 書き込み → 共有の順に進む', async () => {
      const order: string[] = [];
      mockMakeDirectory.mockImplementation(async () => void order.push('mkdir'));
      mockReadDirectory.mockImplementation(async () => {
        order.push('prune');
        return [];
      });
      mockWrite.mockImplementation(async () => void order.push('write'));
      mockShare.mockImplementation(async () => void order.push('share'));

      await handleWebViewDownload(VALID_MESSAGE, SENDER);

      expect(order).toEqual(['mkdir', 'prune', 'write', 'share']);
    });

    it('cacheDirectory が末尾スラッシュ無しでも、専用フォルダの区切りを補う', async () => {
      mockDirs.cache = 'file:///data/app/Library/Caches';

      const result = await handleWebViewDownload(VALID_MESSAGE, SENDER);

      expect(result).toMatchObject({ ok: true, uri: `${SAFE_DIR}homegohan-meals-2026-10-08.csv` });
    });

    it('共有が使えない端末では、書くだけで共有はしない', async () => {
      mockIsSharingAvailable.mockResolvedValue(false);

      const result = await handleWebViewDownload(VALID_MESSAGE, SENDER);

      expect(result).toMatchObject({ ok: true, shared: false });
      expect(mockWrite).toHaveBeenCalledTimes(1);
      expect(mockShare).not.toHaveBeenCalled();
    });

    it('message に余計なプロパティがあっても無視する', async () => {
      const result = await handleWebViewDownload(
        { ...VALID_MESSAGE, path: '/etc', directory: '../..', uri: 'file:///etc/passwd' },
        SENDER,
      );

      expect(result).toMatchObject({ ok: true, uri: `${SAFE_DIR}homegohan-meals-2026-10-08.csv` });
    });

    describe('個人データエクスポート (設定画面の「データをエクスポート」の JSON)', () => {
      const EXPORT_FILENAME = 'homegohan-export-2026-10-08.json';
      const EXPORT_URI = `${SAFE_DIR}${EXPORT_FILENAME}`;

      it('以前の上限 (10MiB) を超える本文でも、同じ名前で書いて、application/json で共有する', async () => {
        // データの多いアカウントの個人データ JSON の大きさに見立てる (12,000,000 文字は 10,485,760 を超える)
        const content = JSON.stringify({ data: { padding: 'x'.repeat(12_000_000) } });
        expect(content.length).toBeGreaterThan(10 * 1024 * 1024);

        const result = await handleWebViewDownload(
          { type: 'download', filename: EXPORT_FILENAME, content, mimeType: 'application/json' },
          SENDER,
        );

        expect(result).toEqual({ ok: true, uri: EXPORT_URI, shared: true });
        // 失敗したときに 12MB の本文がテスト出力に載らないよう、本文は真偽値で比べる
        expect(mockWrite.mock.calls.length).toBe(1);
        expect(mockWrite.mock.calls[0][0]).toBe(EXPORT_URI);
        expect(mockWrite.mock.calls[0][1] === content).toBe(true);
        expect(mockShare).toHaveBeenCalledWith(EXPORT_URI, {
          mimeType: 'application/json',
          dialogTitle: EXPORT_FILENAME,
        });
      });

      it('全部 ASCII で 50MiB ちょうどの出力 (API が返しうる最大) でも書く', async () => {
        // 全部 ASCII なら 1 文字 1 バイトなので、50MiB の出力は 50MiB 文字。日本語などはもっと文字数が少ない
        const content = 'x'.repeat(50 * 1024 * 1024);

        const result = await handleWebViewDownload(
          { type: 'download', filename: EXPORT_FILENAME, content, mimeType: 'application/json' },
          SENDER,
        );

        expect(result).toEqual({ ok: true, uri: EXPORT_URI, shared: true });
        expect(mockWrite.mock.calls.length).toBe(1);
      });
    });
  });

  describe('危険なファイル名は保存先フォルダの外に出られない', () => {
    it.each([
      '../../Library/Preferences/evil.csv',
      '..\\..\\evil.csv',
      '/etc/passwd',
      '%2e%2e%2f%2e%2e%2fevil.csv',
      'evil.csv\u0000.png',
      '..',
      '',
    ])('%j', async (filename) => {
      const result = await handleWebViewDownload({ ...VALID_MESSAGE, filename }, SENDER);

      expect(result.ok).toBe(true);
      const uri = mockWrite.mock.calls[0][0] as string;
      expect(uri.startsWith(SAFE_DIR)).toBe(true);
      expectSafeName(uri.slice(SAFE_DIR.length));
      expect(mockShare.mock.calls[0][0]).toBe(uri);
    });

    it('どの呼び出しも documentDirectory を使わない', async () => {
      await handleWebViewDownload({ ...VALID_MESSAGE, filename: '../../x.csv' }, SENDER);

      const allUris = [
        ...mockMakeDirectory.mock.calls.map((c) => c[0]),
        ...mockWrite.mock.calls.map((c) => c[0]),
        ...mockShare.mock.calls.map((c) => c[0]),
      ] as string[];
      expect(allUris.length).toBeGreaterThan(0);
      for (const uri of allUris) {
        expect(uri.startsWith('file:///data/app/Documents/')).toBe(false);
        expect(uri.startsWith(SAFE_DIR)).toBe(true);
      }
    });

    it('共有シートに渡す MIME タイプは、送られてきた値ではなく拡張子から決める', async () => {
      await handleWebViewDownload(
        { ...VALID_MESSAGE, filename: 'a.json', mimeType: 'application/vnd.android.package-archive' },
        SENDER,
      );

      expect(mockShare.mock.calls[0][1]).toEqual({ mimeType: 'application/json', dialogTitle: 'a.json' });
    });
  });

  describe('弾くもの (何も書かない)', () => {
    it.each([
      ['別のサイト', 'https://evil.example/settings'],
      ['ホスト名の偽装', 'https://homegohan-app.vercel.app.evil.example/'],
      ['認証情報での偽装', 'https://homegohan-app.vercel.app@evil.example/'],
      ['about:blank', 'about:blank'],
      ['空文字', ''],
      ['undefined', undefined],
      ['null', null],
    ])('送信元が自アプリでない: %s', async (_label, senderUrl) => {
      const result = await handleWebViewDownload(VALID_MESSAGE, senderUrl);

      expect(result).toEqual({ ok: false, reason: 'untrusted-sender' });
      expectNothingWritten();
    });

    it.each([
      ['数値', 123],
      ['オブジェクト', { a: 1 }],
      ['配列', ['a,b']],
      ['null', null],
      ['undefined', undefined],
      ['真偽値', true],
    ])('本文が文字列でない: %s', async (_label, content) => {
      const result = await handleWebViewDownload({ ...VALID_MESSAGE, content }, SENDER);

      expect(result).toEqual({ ok: false, reason: 'invalid-payload' });
      expectNothingWritten();
    });

    it.each([null, undefined, 'download', 42, true, []])('message がオブジェクトでない (%j)', async (message) => {
      const result = await handleWebViewDownload(message, SENDER);

      expect(result).toEqual({ ok: false, reason: 'invalid-payload' });
      expectNothingWritten();
    });

    it('本文が上限を超える', async () => {
      const result = await handleWebViewDownload(
        { ...VALID_MESSAGE, content: 'x'.repeat(MAX_DOWNLOAD_CONTENT_LENGTH + 1) },
        SENDER,
      );

      expect(result).toEqual({ ok: false, reason: 'too-large' });
      expectNothingWritten();
    });

    it('上限は、個人データエクスポート API が返しうる最大 (50MiB) 以上で、極端に大きくもない', () => {
      // 設定画面の「データをエクスポート」(GET /api/account/export) の出力は、UTF-8 で最大 50MiB
      // (src/lib/account-export.ts の DEFAULT_EXPORT_LIMITS.maxTotalBytes)。
      // JS の文字列の長さ (UTF-16 の単位数) は UTF-8 のバイト数以下なので、50MiB 以上あれば API が出すエクスポートは必ず通る。
      // API の値とのずれは、ルートの tests/webview-download-export-limit-contract.test.ts が見張る
      expect(MAX_DOWNLOAD_CONTENT_LENGTH).toBeGreaterThanOrEqual(50 * 1024 * 1024);
      expect(MAX_DOWNLOAD_CONTENT_LENGTH).toBeLessThanOrEqual(100 * 1024 * 1024);
    });

    it('本文が上限ちょうどなら書く', async () => {
      const result = await handleWebViewDownload(
        { ...VALID_MESSAGE, content: 'x'.repeat(MAX_DOWNLOAD_CONTENT_LENGTH) },
        SENDER,
      );

      expect(result.ok).toBe(true);
      expect(mockWrite.mock.calls.length).toBe(1);
    });

    it('cacheDirectory が無い (null) 環境', async () => {
      mockDirs.cache = null;

      const result = await handleWebViewDownload(VALID_MESSAGE, SENDER);

      expect(result).toEqual({ ok: false, reason: 'no-cache-directory' });
      expectNothingWritten();
    });

    it('弾いた理由は警告ログに出すが、ファイル名や本文はログに出さない', async () => {
      await handleWebViewDownload(
        { ...VALID_MESSAGE, filename: 'secret-name.csv', content: 'secret-body' },
        'https://evil.example/',
      );

      expect(warnSpy).toHaveBeenCalledTimes(1);
      const logged = JSON.stringify(warnSpy.mock.calls);
      expect(logged).toContain('untrusted-sender');
      expect(logged).not.toContain('secret-name');
      expect(logged).not.toContain('secret-body');
    });
  });

  describe('古い書き出しファイルの掃除', () => {
    const nowSeconds = () => Date.now() / 1000;

    it('STALE_DOWNLOAD_MS より古いファイルだけを消す', async () => {
      mockReadDirectory.mockResolvedValue(['old.csv', 'fresh.csv', 'ghost.csv']);
      mockGetInfo.mockImplementation(async (uri: string) => {
        if (uri.endsWith('old.csv')) {
          return { exists: true, isDirectory: false, uri, size: 1, modificationTime: nowSeconds() - (STALE_DOWNLOAD_MS / 1000) * 2 };
        }
        if (uri.endsWith('fresh.csv')) {
          return { exists: true, isDirectory: false, uri, size: 1, modificationTime: nowSeconds() - 60 };
        }
        return { exists: false, isDirectory: false, uri };
      });

      const result = await handleWebViewDownload(VALID_MESSAGE, SENDER);

      expect(result.ok).toBe(true);
      expect(mockReadDirectory).toHaveBeenCalledWith(SAFE_DIR);
      expect(mockDelete).toHaveBeenCalledTimes(1);
      expect(mockDelete).toHaveBeenCalledWith(`${SAFE_DIR}old.csv`, { idempotent: true });
    });

    it('掃除は、今回書くファイルより前に終わる (今回のファイルを消さない)', async () => {
      // 今回と同じ名前の古いファイルが残っていても、掃除は書き込みの前なので、書いたファイルは消えない
      mockReadDirectory.mockResolvedValue(['homegohan-meals-2026-10-08.csv']);
      mockGetInfo.mockImplementation(async (uri: string) => ({
        exists: true,
        isDirectory: false,
        uri,
        size: 1,
        modificationTime: nowSeconds() - (STALE_DOWNLOAD_MS / 1000) * 10,
      }));
      const order: string[] = [];
      mockDelete.mockImplementation(async () => void order.push('delete'));
      mockWrite.mockImplementation(async () => void order.push('write'));

      await handleWebViewDownload(VALID_MESSAGE, SENDER);

      expect(order).toEqual(['delete', 'write']);
    });

    it('フォルダの一覧が取れなくても、書き込みと共有は続ける', async () => {
      mockReadDirectory.mockRejectedValue(new Error('readDirectory failed'));

      const result = await handleWebViewDownload(VALID_MESSAGE, SENDER);

      expect(result.ok).toBe(true);
      expect(mockWrite).toHaveBeenCalledTimes(1);
      expect(mockShare).toHaveBeenCalledTimes(1);
    });

    it('1 件の情報取得・削除に失敗しても、残りの掃除と書き込みは続ける', async () => {
      mockReadDirectory.mockResolvedValue(['bad-info.csv', 'bad-delete.csv', 'old.csv']);
      const oldInfo = (uri: string) => ({
        exists: true,
        isDirectory: false,
        uri,
        size: 1,
        modificationTime: nowSeconds() - (STALE_DOWNLOAD_MS / 1000) * 2,
      });
      mockGetInfo.mockImplementation(async (uri: string) => {
        if (uri.endsWith('bad-info.csv')) throw new Error('getInfo failed');
        return oldInfo(uri);
      });
      mockDelete.mockImplementation(async (uri: string) => {
        if (uri.endsWith('bad-delete.csv')) throw new Error('delete failed');
      });

      const result = await handleWebViewDownload(VALID_MESSAGE, SENDER);

      expect(result.ok).toBe(true);
      expect(mockDelete).toHaveBeenCalledWith(`${SAFE_DIR}old.csv`, { idempotent: true });
      expect(mockWrite).toHaveBeenCalledTimes(1);
      expect(mockShare).toHaveBeenCalledTimes(1);
    });

    it('弾いたメッセージでは掃除もしない', async () => {
      await handleWebViewDownload(VALID_MESSAGE, 'https://evil.example/');

      expect(mockReadDirectory).not.toHaveBeenCalled();
      expect(mockDelete).not.toHaveBeenCalled();
    });
  });

  describe('失敗しても例外を投げない', () => {
    it('フォルダを作れない', async () => {
      mockMakeDirectory.mockRejectedValue(new Error('mkdir failed'));

      const result = await handleWebViewDownload(VALID_MESSAGE, SENDER);

      expect(result).toEqual({ ok: false, reason: 'failed' });
      expect(mockWrite).not.toHaveBeenCalled();
      expect(mockShare).not.toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalledTimes(1);
    });

    it('書き込みに失敗したら共有しない', async () => {
      mockWrite.mockRejectedValue(new Error('disk full'));

      const result = await handleWebViewDownload(VALID_MESSAGE, SENDER);

      expect(result).toEqual({ ok: false, reason: 'failed' });
      expect(mockShare).not.toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalledTimes(1);
    });

    it('共有に失敗 (Android で別の共有が処理中など) しても例外にしない', async () => {
      mockShare.mockRejectedValue(new Error('Another share request is being processed now.'));

      const result = await handleWebViewDownload(VALID_MESSAGE, SENDER);

      expect(result).toEqual({ ok: false, reason: 'failed' });
      expect(errorSpy).toHaveBeenCalledTimes(1);
    });

    it('共有が使えるかの確認に失敗しても例外にしない', async () => {
      mockIsSharingAvailable.mockRejectedValue(new Error('unavailable'));

      const result = await handleWebViewDownload(VALID_MESSAGE, SENDER);

      expect(result).toEqual({ ok: false, reason: 'failed' });
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. getDownloadFailureNotice
// ─────────────────────────────────────────────────────────────────────────────
describe('getDownloadFailureNotice', () => {
  it('書き出しに成功したときは、何も知らせない', () => {
    expect(getDownloadFailureNotice({ ok: true, uri: `${SAFE_DIR}a.csv`, shared: true })).toBeNull();
    // 共有が使えない端末で、書いただけのときも失敗ではない
    expect(getDownloadFailureNotice({ ok: true, uri: `${SAFE_DIR}a.csv`, shared: false })).toBeNull();
  });

  it('送信元が自アプリでないときは、何も知らせない (正規のエクスポートではない。ログだけ)', () => {
    expect(getDownloadFailureNotice({ ok: false, reason: 'untrusted-sender' })).toBeNull();
  });

  it('本文が大きすぎるときは、大きすぎることを知らせる', () => {
    const notice = getDownloadFailureNotice({ ok: false, reason: 'too-large' });

    expect(notice).not.toBeNull();
    expect(notice?.title).toBe('エクスポートに失敗しました');
    expect(notice?.message).toContain('大きすぎ');
  });

  it.each(['failed', 'invalid-payload', 'no-cache-directory'] as const)(
    '%s のときは、書き出せなかったことと、空き容量の確認・再試行を知らせる',
    (reason) => {
      const notice = getDownloadFailureNotice({ ok: false, reason });

      expect(notice).not.toBeNull();
      expect(notice?.title).toBe('エクスポートに失敗しました');
      expect(notice?.message).toContain('書き出せませんでした');
      expect(notice?.message).toContain('空き容量');
    },
  );

  it('知らせる文面は、どの理由でも空でない固定の文字列', () => {
    for (const reason of ['too-large', 'failed', 'invalid-payload', 'no-cache-directory'] as const) {
      const notice = getDownloadFailureNotice({ ok: false, reason });
      expect(notice).toEqual({ title: expect.any(String), message: expect.any(String) });
      expect(notice?.title.length).toBeGreaterThan(0);
      expect(notice?.message.length).toBeGreaterThan(0);
    }
  });
});
