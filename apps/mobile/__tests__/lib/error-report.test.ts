/**
 * error-report.test.ts
 * apps/mobile/src/lib/error-report.ts の reportBoundaryError のテスト (#1207)
 *
 * ErrorBoundary が捕まえた例外を、コンソール・PostHog・サーバーログ (POST /api/log) に残す。
 *  - 記録の失敗でエラー画面を壊さない (この関数は例外を投げない)
 *  - 例外の文面は切り詰め、画面遷移のパスは記録しない
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

import { reportBoundaryError } from '../../src/lib/error-report';

const SECRET_MESSAGE = 'relation "user_profiles" does not exist; password=hunter2';

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

function makeError(message = SECRET_MESSAGE) {
  const error = new Error(message);
  error.name = 'TypeError';
  return error;
}

describe('reportBoundaryError', () => {
  it('コンソールに出す', () => {
    const error = makeError();

    reportBoundaryError('tabs', error);

    expect(consoleError).toHaveBeenCalledWith('[ErrorBoundary:tabs]', error);
  });

  it('PostHog に app_error_boundary を送る (境界・種類・文面)', () => {
    reportBoundaryError('tabs', makeError());

    expect(mockCaptureEvent).toHaveBeenCalledTimes(1);
    const [eventName, props] = mockCaptureEvent.mock.calls[0];
    expect(eventName).toBe('app_error_boundary');
    expect(props).toMatchObject({
      boundary: 'tabs',
      error_name: 'TypeError',
      error_message: SECRET_MESSAGE,
    });
    expect(typeof props.platform).toBe('string');
  });

  it('サーバーログ (POST /api/log) に level=error で送る', () => {
    reportBoundaryError('org', makeError());

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
    expect(typeof body.metadata.stack).toBe('string');
  });

  it('画面遷移のパス・URL は記録しない', () => {
    reportBoundaryError('tabs', makeError());

    const keys = Object.keys(mockPost.mock.calls[0][1].metadata);
    expect(keys).not.toEqual(expect.arrayContaining(['url', 'path', 'pathname', 'href', 'route']));
    expect(Object.keys(mockCaptureEvent.mock.calls[0][1])).not.toEqual(
      expect.arrayContaining(['url', 'path', 'pathname', 'href', 'route']),
    );
  });

  it('長い文面・スタックは切り詰める', () => {
    const error = makeError('m'.repeat(5000));
    error.stack = 's'.repeat(10000);

    reportBoundaryError('tabs', error);

    expect(mockCaptureEvent.mock.calls[0][1].error_message.length).toBeLessThanOrEqual(301);
    const metadata = mockPost.mock.calls[0][1].metadata;
    expect(metadata.message.length).toBeLessThanOrEqual(301);
    expect(metadata.stack.length).toBeLessThanOrEqual(1501);
  });

  it('Error 以外 (文字列・null・undefined) が投げられていても例外を投げない', () => {
    expect(() => reportBoundaryError('root', 'plain string thrown')).not.toThrow();
    expect(() => reportBoundaryError('root', null)).not.toThrow();
    expect(() => reportBoundaryError('root', undefined)).not.toThrow();

    expect(mockCaptureEvent).toHaveBeenCalledTimes(3);
    expect(mockCaptureEvent.mock.calls[0][1].error_message).toBe('plain string thrown');
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
