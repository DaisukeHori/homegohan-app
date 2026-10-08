/**
 * error-report.test.ts
 * apps/mobile/src/lib/error-report.ts の reportBoundaryError のテスト (#1207)
 *
 * ErrorBoundary が捕まえた例外を、コンソール・PostHog・サーバーログ (POST /api/log) に残す。
 *  - PostHog は外部の計測サービスで、イベントはユーザー ID に紐づく。captureEvent の PII フィルタは
 *    キー名でしか除かず、値の中身は見ないので、例外の文面・スタックは渡さない (operator/07 §15.7)。
 *    送るのは「境界・OS・例外の種類 (識別子の形のときだけ)・文面の指紋 (元に戻せないハッシュ)」だけ。
 *  - 生の文面 (切り詰め済み) とスタックは、サーバー側でマスクされる POST /api/log の metadata にだけ残す。
 *  - 記録の失敗でエラー画面を壊さない (この関数は例外を投げない)
 *  - 画面遷移のパスは記録しない
 */

const mockCaptureEvent = jest.fn();
jest.mock('../../src/lib/posthog', () => ({
  captureEvent: (...args: unknown[]) => mockCaptureEvent(...args),
}));

const mockPost = jest.fn();
const mockGetApi = jest.fn();
jest.mock('../../src/lib/api', () => ({
  getApi: () => mockGetApi(),
}));

import { fingerprintOf, reportBoundaryError } from '../../src/lib/error-report';

const SECRET_MESSAGE = 'relation "user_profiles" does not exist; password=hunter2';
const SECRET_STACK = `TypeError: ${SECRET_MESSAGE}\n    at secretFunction (/var/task/secret.js:1:1)`;

let consoleError: jest.SpyInstance;

beforeEach(() => {
  jest.clearAllMocks();
  mockPost.mockResolvedValue({ success: true });
  mockGetApi.mockReturnValue({ post: mockPost });
  consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  consoleError.mockRestore();
});

function makeError(message = SECRET_MESSAGE, name = 'TypeError') {
  const error = new Error(message);
  error.name = name;
  return error;
}

/** PostHog に渡った引数 (イベント名とプロパティ) の全体を JSON にしたもの。外部に出る内容そのもの */
function postHogPayload(): string {
  return JSON.stringify(mockCaptureEvent.mock.calls);
}

describe('reportBoundaryError', () => {
  it('コンソールに出す', () => {
    const error = makeError();

    reportBoundaryError('tabs', error);

    expect(consoleError).toHaveBeenCalledWith('[ErrorBoundary:tabs]', error);
  });

  describe('PostHog (外部の計測サービス) には、例外の文面もスタックも送らない', () => {
    it('app_error_boundary を、境界・OS・種類・指紋だけで送る', () => {
      reportBoundaryError('tabs', makeError());

      expect(mockCaptureEvent).toHaveBeenCalledTimes(1);
      const [eventName, props] = mockCaptureEvent.mock.calls[0];
      expect(eventName).toBe('app_error_boundary');
      expect(props).toMatchObject({ boundary: 'tabs', error_name: 'TypeError' });
      expect(typeof props.platform).toBe('string');
      // 外に出てよいキーの許可リスト。ここに足すときは、値が PII を含まないことを確かめてから
      expect(Object.keys(props).sort()).toEqual(['boundary', 'error_fingerprint', 'error_name', 'platform']);
    });

    it('例外の文面・スタックは、引数全体を JSON にしても含まれない', () => {
      const error = makeError();
      error.stack = SECRET_STACK;

      reportBoundaryError('tabs', error);

      const payload = postHogPayload();
      expect(payload).not.toContain(SECRET_MESSAGE);
      expect(payload).not.toContain('hunter2');
      expect(payload).not.toContain('user_profiles');
      expect(payload).not.toContain('secretFunction');
      expect(payload).not.toContain('secret.js');
      const props = mockCaptureEvent.mock.calls[0][1];
      expect(Object.keys(props)).not.toEqual(
        expect.arrayContaining(['error_message', 'message', 'stack', 'error_stack']),
      );
    });

    it('文面の長さに関わらず、送る内容の大きさは変わらない (自由な文字列を通さない)', () => {
      reportBoundaryError('tabs', makeError('x'));
      const shortPayload = postHogPayload();
      mockCaptureEvent.mockClear();

      const longError = makeError('m'.repeat(5000));
      longError.stack = 's'.repeat(10000);
      reportBoundaryError('tabs', longError);

      expect(postHogPayload().length).toBe(shortPayload.length);
    });

    describe('error_name は、識別子の形をしているときだけ送る', () => {
      it.each(['TypeError', 'ReferenceError', 'AxiosError', 'PostgrestError', 'My.Custom$Error_2', 'E', 'a'.repeat(64)])(
        '%s はそのまま送る',
        (name) => {
          reportBoundaryError('tabs', makeError('boom', name));

          expect(mockCaptureEvent.mock.calls[0][1].error_name).toBe(name);
        },
      );

      it.each([
        ['password=hunter2 を含む名前', 'password=hunter2'],
        ['空白を含む名前', 'Invariant Violation'],
        ['文面が入った名前', 'Error: relation "user_profiles" does not exist'],
        ['日本語の名前', '山田太郎'],
        ['改行を含む名前', 'TypeError\nsecret'],
        ['末尾に改行がある名前', 'TypeError\n'],
        ['65 文字の名前', 'a'.repeat(65)],
        ['空の名前', ''],
      ])('%s は送らない', (_label, name) => {
        reportBoundaryError('tabs', makeError('boom', name));

        const props = mockCaptureEvent.mock.calls[0][1];
        expect(Object.keys(props)).not.toContain('error_name');
        // JSON にすると改行や引用符はエスケープされるので、エスケープ後の形で探す
        if (name) expect(postHogPayload()).not.toContain(JSON.stringify(name).slice(1, -1));
        // 種類が送れなくても、境界と指紋は送る (件数は追える)
        expect(props).toMatchObject({ boundary: 'tabs' });
        expect(props.error_fingerprint).toMatch(/^[0-9a-f]{8}$/);
      });

      it('文字列でない名前 (数値・オブジェクト) は送らない', () => {
        reportBoundaryError('tabs', { name: 12345, message: 'boom' });
        reportBoundaryError('tabs', { name: { toString: () => 'password=hunter2' }, message: 'boom' });

        for (const [, props] of mockCaptureEvent.mock.calls) {
          expect(Object.keys(props)).not.toContain('error_name');
        }
        expect(postHogPayload()).not.toContain('hunter2');
      });
    });

    describe('error_fingerprint (同じ例外を数えるための、元に戻せないハッシュ)', () => {
      function fingerprintFor(error: unknown): string | undefined {
        mockCaptureEvent.mockClear();
        reportBoundaryError('tabs', error);
        return mockCaptureEvent.mock.calls[0][1].error_fingerprint;
      }

      it('16 進 8 桁の固定長で、文面そのものではない', () => {
        const value = fingerprintFor(makeError());

        expect(value).toMatch(/^[0-9a-f]{8}$/);
        expect(SECRET_MESSAGE).not.toContain(value as string);
      });

      it('同じ種類・同じ文面の例外は、いつでも同じ値になる (アプリを更新しても数え続けられる)', () => {
        expect(fingerprintFor(makeError('boom'))).toBe(fingerprintFor(makeError('boom')));
        // 値そのものを固定する。変えると、PostHog 上の過去の件数と数えがつながらなくなる
        expect(fingerprintFor(makeError('boom'))).toBe('b1efa4a6');
      });

      it('文面または種類が違えば、別の値になる', () => {
        const base = fingerprintFor(makeError('boom'));

        expect(fingerprintFor(makeError('bang'))).not.toBe(base);
        expect(fingerprintFor(makeError('boom', 'RangeError'))).not.toBe(base);
      });

      it('Error 以外 (文字列) が投げられていても付く。中身は外に出ない', () => {
        const value = fingerprintFor('password=hunter2 thrown as a string');

        expect(value).toMatch(/^[0-9a-f]{8}$/);
        expect(postHogPayload()).not.toContain('hunter2');
      });

      it('文面が無い例外 (空の message・message の無いオブジェクト) には付けない', () => {
        expect(fingerprintFor(makeError(''))).toBeUndefined();
        expect(fingerprintFor({ code: 'E_SOMETHING' })).toBeUndefined();
        expect(Object.keys(mockCaptureEvent.mock.calls[0][1])).not.toContain('error_fingerprint');
      });

      it('サーバーログ (app_logs) の metadata にも同じ値を残す。件数 (PostHog) から生の文面 (app_logs) を引ける', () => {
        reportBoundaryError('org', makeError());

        const posthogValue = mockCaptureEvent.mock.calls[0][1].error_fingerprint;
        expect(posthogValue).toMatch(/^[0-9a-f]{8}$/);
        expect(mockPost.mock.calls[0][1].metadata.fingerprint).toBe(posthogValue);
      });
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

      expect(mockPost.mock.calls[0][1].metadata.name).toBe('Invariant Violation');
    });
  });

  it('画面遷移のパス・URL は記録しない', () => {
    reportBoundaryError('tabs', makeError());

    const keys = Object.keys(mockPost.mock.calls[0][1].metadata);
    expect(keys).not.toEqual(expect.arrayContaining(['url', 'path', 'pathname', 'href', 'route']));
    expect(Object.keys(mockCaptureEvent.mock.calls[0][1])).not.toEqual(
      expect.arrayContaining(['url', 'path', 'pathname', 'href', 'route']),
    );
  });

  it('長い文面・スタックは、サーバーログへ送る前に切り詰める', () => {
    const error = makeError('m'.repeat(5000));
    error.stack = 's'.repeat(10000);

    reportBoundaryError('tabs', error);

    const metadata = mockPost.mock.calls[0][1].metadata;
    expect(metadata.message.length).toBeLessThanOrEqual(301);
    expect(metadata.stack.length).toBeLessThanOrEqual(1501);
  });

  it('Error 以外 (文字列・null・undefined) が投げられていても例外を投げない', () => {
    expect(() => reportBoundaryError('root', 'plain string thrown')).not.toThrow();
    expect(() => reportBoundaryError('root', null)).not.toThrow();
    expect(() => reportBoundaryError('root', undefined)).not.toThrow();

    expect(mockCaptureEvent).toHaveBeenCalledTimes(3);
    // 文字列そのものは PostHog に出ない。サーバーログ (マスクされる側) にだけ残る
    expect(postHogPayload()).not.toContain('plain string thrown');
    expect(mockPost.mock.calls[0][1].metadata.message).toBe('plain string thrown');
  });

  describe('記録の失敗でエラー画面を壊さない', () => {
    it('PostHog が例外を投げても、サーバーログへは送る', () => {
      mockCaptureEvent.mockImplementationOnce(() => {
        throw new Error('posthog exploded');
      });

      expect(() => reportBoundaryError('tabs', makeError())).not.toThrow();
      expect(mockPost).toHaveBeenCalledTimes(1);
    });

    it('getApi() が例外を投げても (EXPO_PUBLIC_API_BASE_URL が無いなど)、PostHog への送信は済んでいる', () => {
      mockGetApi.mockImplementationOnce(() => {
        throw new Error('[mobile] Missing env: EXPO_PUBLIC_API_BASE_URL');
      });

      expect(() => reportBoundaryError('tabs', makeError())).not.toThrow();
      expect(mockCaptureEvent).toHaveBeenCalledTimes(1);
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

    it('console.error が例外を投げても、PostHog とサーバーログへ送る', () => {
      consoleError.mockImplementationOnce(() => {
        throw new Error('console exploded');
      });

      expect(() => reportBoundaryError('tabs', makeError())).not.toThrow();
      expect(mockCaptureEvent).toHaveBeenCalledTimes(1);
      expect(mockPost).toHaveBeenCalledTimes(1);
    });
  });
});
