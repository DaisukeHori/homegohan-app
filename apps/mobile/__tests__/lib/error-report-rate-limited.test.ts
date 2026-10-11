/**
 * error-report-rate-limited.test.ts
 * POST /api/log が利用者ごとの回数制限 (#1493。'client-log' の枠) で 429 を返したときの、エラー境界の記録
 * (apps/mobile/src/lib/error-report.ts の reportBoundaryError) の振る舞い。
 *
 * error-report.test.ts は getApi() をモックにして「送る中身」を見る。ここでは本物の getApi() と共通の HTTP クライアント
 * (@homegohan/core の createHttpClient) を通し、fetch だけを 429 を返す偽物にして、次を確かめる。
 *  - 例外を投げない (エラー画面を壊さない)。未処理の失敗 (unhandled rejection) も残さない
 *  - 429 でも同じ送信を繰り返さない (POST は自動でやり直さない。Retry-After を待って画面を止めない)
 */

jest.mock('../../src/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: jest.fn().mockResolvedValue({ data: { session: { access_token: 'test-access-token' } } }),
    },
  },
}));

const API_BASE_URL = 'https://api.example.test';
const RATE_LIMITED_BODY = JSON.stringify({
  error: 'リクエストが多すぎます。しばらく時間をおいてからお試しください。',
  code: 'RATE_LIMITED',
  retryAfter: 42,
});

const ORIGINAL_ENV = process.env;
const originalFetch = global.fetch;
let consoleError: jest.SpyInstance;
let fetchMock: jest.Mock;

function rateLimitedResponse() {
  return {
    ok: false,
    status: 429,
    statusText: 'Too Many Requests',
    headers: { get: (name: string) => (name.toLowerCase() === 'retry-after' ? '42' : null) },
    text: async () => RATE_LIMITED_BODY,
  };
}

function trackUnhandledRejections() {
  const reasons: unknown[] = [];
  const onRejection = (reason: unknown) => reasons.push(reason);
  process.on('unhandledRejection', onRejection);
  return { reasons, stop: () => process.off('unhandledRejection', onRejection) };
}

/** fire-and-forget の送信と、その失敗の片づけが終わるまで待つ */
async function settle() {
  for (let i = 0; i < 5; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV, EXPO_PUBLIC_API_BASE_URL: API_BASE_URL };
  fetchMock = jest.fn(async () => rateLimitedResponse());
  global.fetch = fetchMock as unknown as typeof fetch;
  consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  consoleError.mockRestore();
  global.fetch = originalFetch;
  process.env = ORIGINAL_ENV;
});

describe('reportBoundaryError: /api/log が 429 (回数制限) を返したとき (#1493)', () => {
  it('例外を投げず、未処理の失敗も残さない。送信は 1 回だけで、やり直さない', async () => {
    const tracker = trackUnhandledRejections();
    try {
      let reportBoundaryError!: typeof import('../../src/lib/error-report').reportBoundaryError;
      jest.isolateModules(() => {
        ({ reportBoundaryError } = require('../../src/lib/error-report'));
      });

      expect(() => reportBoundaryError('tabs', new Error('render failed'))).not.toThrow();
      await settle();

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(`${API_BASE_URL}/api/log`);
      expect(init.method).toBe('POST');
      expect(JSON.parse(String(init.body))).toMatchObject({ level: 'error', message: 'error boundary caught: tabs' });
      expect(tracker.reasons).toEqual([]);
      // コンソールには出ている (端末の中の記録は残る)
      expect(consoleError).toHaveBeenCalledWith('[ErrorBoundary:tabs]', expect.any(Error));
    } finally {
      tracker.stop();
    }
  });

  it('続けて何度記録しても、1 回の記録につき 1 回しか送らない (429 で送信が膨らまない)', async () => {
    let reportBoundaryError!: typeof import('../../src/lib/error-report').reportBoundaryError;
    jest.isolateModules(() => {
      ({ reportBoundaryError } = require('../../src/lib/error-report'));
    });

    for (let i = 0; i < 3; i += 1) reportBoundaryError('root', new Error(`boom ${i}`));
    await settle();

    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
