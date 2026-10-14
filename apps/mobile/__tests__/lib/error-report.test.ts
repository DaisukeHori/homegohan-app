/**
 * error-report.test.ts
 * apps/mobile/src/lib/error-report.ts の reportBoundaryError のテスト (#1207)
 *
 * ErrorBoundary が捕まえた例外を、コンソールとサーバーログ (POST /api/log) に残す。
 *  - 生の文面 (切り詰め済み) とスタックは、サーバー側でマスクされる POST /api/log の metadata に残す。
 *  - 同じ例外をまとめて数えるための指紋 (fingerprint) を、metadata に付ける。
 *  - PostHog などの外部の計測サービスには送らない (#1166)。送り先は自分たちのサーバーログだけ。
 *  - 記録の失敗でエラー画面を壊さない (この関数は例外を投げない)
 *  - 画面遷移のパスは記録しない
 */

const mockPost = jest.fn();
const mockGetApi = jest.fn();
jest.mock('../../src/lib/api', () => ({
  getApi: () => mockGetApi(),
}));

import { fingerprintOf, reportBoundaryError } from '../../src/lib/error-report';

const SECRET_MESSAGE = 'relation "user_profiles" does not exist; password=hunter2';
const SECRET_STACK = `TypeError: ${SECRET_MESSAGE}\n    at secretFunction (/var/task/secret.js:1:1)`;

const originalFetch = global.fetch;
let consoleError: jest.SpyInstance;

beforeEach(() => {
  jest.clearAllMocks();
  mockPost.mockResolvedValue({ success: true });
  mockGetApi.mockReturnValue({ post: mockPost });
  consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
  // 外部への直接の送信 (fetch) が起きていないことを確かめるために差し替える
  global.fetch = jest.fn();
});

afterEach(() => {
  consoleError.mockRestore();
  global.fetch = originalFetch;
});

function makeError(message = SECRET_MESSAGE, name = 'TypeError') {
  const error = new Error(message);
  error.name = name;
  return error;
}

/** サーバーログ (POST /api/log) に送った metadata (最初の 1 回) */
function loggedMetadata() {
  return mockPost.mock.calls[0][1].metadata;
}

describe('reportBoundaryError', () => {
  it('コンソールに出す', () => {
    const error = makeError();

    reportBoundaryError('tabs', error);

    expect(consoleError).toHaveBeenCalledWith('[ErrorBoundary:tabs]', error);
  });

  describe('サーバーログ (POST /api/log。サーバー側でマスクされて app_logs に残る)', () => {
    it('level=error で、生の文面 (切り詰め済み) とスタックを送る', () => {
      const error = makeError();
      error.stack = SECRET_STACK;

      reportBoundaryError('org', error);

      expect(mockPost).toHaveBeenCalledTimes(1);
      const [path, body] = mockPost.mock.calls[0];
      expect(path).toBe('/api/log');
      expect(body.level).toBe('error');
      expect(body.message).toBe('error boundary caught: org');
      expect(body.metadata).toMatchObject({
        app: 'mobile',
        boundary: 'org',
        name: 'TypeError',
        message: SECRET_MESSAGE,
      });
      expect(body.metadata.stack).toBe(SECRET_STACK);
    });

    it('識別子の形をしていない名前も、デバッグのためにそのまま送る (マスクはサーバー側)', () => {
      reportBoundaryError('org', makeError('boom', 'Invariant Violation'));

      expect(loggedMetadata().name).toBe('Invariant Violation');
    });
  });

  describe('外部の計測サービス (PostHog など) には送らない (#1166)', () => {
    // 限界: このテストだけでは、PostHog への送信が戻ったことは検出できない。
    //   PostHog の SDK を戻して captureEvent を呼んでも、テストでは PostHog のクライアントが初期化されず何もしない
    //   (fetch も呼ばれない) ので、ここは通ってしまう。モバイルで PostHog が戻るのを止めているのは、
    //   tests/posthog-not-adopted-contract.test.ts の import の検査 (PostHog の package・モジュールを import するソースが落とす)。
    //   ここで確かめるのは、サーバーログ以外へ fetch で直接送っていないことと、送り先がサーバーログの 1 回だけであること。
    it('送るのは、サーバーログ (POST /api/log) への 1 回だけ。fetch で外部へ直接送らない', () => {
      reportBoundaryError('tabs', makeError());

      expect(mockPost).toHaveBeenCalledTimes(1);
      expect(mockPost.mock.calls[0][0]).toBe('/api/log');
      expect(global.fetch).not.toHaveBeenCalled();
    });
  });

  describe('metadata.fingerprint (同じ例外をまとめて数えるための、元に戻せないハッシュ)', () => {
    function fingerprintFor(error: unknown): string | undefined {
      mockPost.mockClear();
      reportBoundaryError('tabs', error);
      return loggedMetadata().fingerprint;
    }

    it('16 進 8 桁の固定長で、文面そのものではない', () => {
      const value = fingerprintFor(makeError());

      expect(value).toMatch(/^[0-9a-f]{8}$/);
      expect(SECRET_MESSAGE).not.toContain(value as string);
    });

    it('同じ種類・同じ文面の例外は、いつでも同じ値になる (アプリを更新しても数え続けられる)', () => {
      expect(fingerprintFor(makeError('boom'))).toBe(fingerprintFor(makeError('boom')));
      // 値そのものを固定する。変えると、app_logs に残っている過去の件数と数えがつながらなくなる
      expect(fingerprintFor(makeError('boom'))).toBe('b1efa4a6');
    });

    it('文面または種類が違えば、別の値になる', () => {
      const base = fingerprintFor(makeError('boom'));

      expect(fingerprintFor(makeError('bang'))).not.toBe(base);
      expect(fingerprintFor(makeError('boom', 'RangeError'))).not.toBe(base);
    });

    it('Error 以外 (文字列) が投げられていても付く', () => {
      const value = fingerprintFor('password=hunter2 thrown as a string');

      expect(value).toMatch(/^[0-9a-f]{8}$/);
    });

    it('文面が無い例外 (空の message・message の無いオブジェクト) には付けない', () => {
      expect(fingerprintFor(makeError(''))).toBeUndefined();
      expect(fingerprintFor({ code: 'E_SOMETHING' })).toBeUndefined();
    });
  });

  describe('fingerprintOf', () => {
    // 32 bit の FNV-1a の標準的なテストベクタ
    it.each([
      ['', '811c9dc5'],
      ['a', 'e40c292c'],
      ['foobar', 'bf9cf968'],
    ])('%j -> %s', (text, expected) => {
      expect(fingerprintOf(text)).toBe(expected);
    });

    it('常に 16 進 8 桁 (先頭が 0 でも桁を落とさない)', () => {
      for (const text of ['', 'a', 'boom', 'あいうえお', '😀', 'x'.repeat(10000)]) {
        expect(fingerprintOf(text)).toMatch(/^[0-9a-f]{8}$/);
      }
      // 先頭が 0 になる値 (桁を 0 で埋めないと 7 桁・6 桁になる)
      expect(fingerprintOf('err0')).toBe('0e6a3514');
      expect(fingerprintOf('e525')).toBe('00b965f6');
    });
  });

  it('画面遷移のパス・URL は記録しない', () => {
    reportBoundaryError('tabs', makeError());

    const keys = Object.keys(loggedMetadata());
    expect(keys).not.toEqual(expect.arrayContaining(['url', 'path', 'pathname', 'href', 'route']));
  });

  it('長い文面・スタックは、サーバーログへ送る前に切り詰める', () => {
    const error = makeError('m'.repeat(5000));
    error.stack = 's'.repeat(10000);

    reportBoundaryError('tabs', error);

    const metadata = loggedMetadata();
    expect(metadata.message.length).toBeLessThanOrEqual(301);
    expect(metadata.stack.length).toBeLessThanOrEqual(1501);
  });

  it('Error 以外 (文字列・null・undefined) が投げられていても例外を投げない', () => {
    expect(() => reportBoundaryError('root', 'plain string thrown')).not.toThrow();
    expect(() => reportBoundaryError('root', null)).not.toThrow();
    expect(() => reportBoundaryError('root', undefined)).not.toThrow();

    expect(mockPost).toHaveBeenCalledTimes(3);
    // 文字列そのものは、サーバーログ (サーバー側でマスクされる) に残る
    expect(mockPost.mock.calls[0][1].metadata.message).toBe('plain string thrown');
  });

  describe('記録の失敗でエラー画面を壊さない', () => {
    it('getApi() が例外を投げても (EXPO_PUBLIC_API_BASE_URL が無いなど)、伝えない。コンソールには出ている', () => {
      mockGetApi.mockImplementationOnce(() => {
        throw new Error('[mobile] Missing env: EXPO_PUBLIC_API_BASE_URL');
      });
      const error = makeError();

      expect(() => reportBoundaryError('tabs', error)).not.toThrow();
      expect(consoleError).toHaveBeenCalledWith('[ErrorBoundary:tabs]', error);
    });

    it('post が同期的に例外を投げても、拒否されても (オフライン・401 など) 伝えない', async () => {
      mockPost.mockImplementationOnce(() => {
        throw new Error('sync boom');
      });
      expect(() => reportBoundaryError('tabs', makeError())).not.toThrow();

      mockPost.mockRejectedValueOnce(new Error('HTTP 401 Unauthorized'));
      expect(() => reportBoundaryError('tabs', makeError())).not.toThrow();
      // 拒否が未処理のまま残らない (unhandled rejection でテストが落ちない)
      await new Promise((resolve) => setImmediate(resolve));
    });

    it('console.error が例外を投げても、サーバーログへ送る', () => {
      consoleError.mockImplementationOnce(() => {
        throw new Error('console exploded');
      });

      expect(() => reportBoundaryError('tabs', makeError())).not.toThrow();
      expect(mockPost).toHaveBeenCalledTimes(1);
    });
  });
});
