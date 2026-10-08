// @vitest-environment node
/**
 * 共有 HTTP クライアント (createHttpClient) のテスト (#1049 F7-12)
 *
 * 直したこと:
 *  - 502 / 504 の HTML エラーページで JSON.parse が SyntaxError を投げていた → HTTP エラーとして扱う
 *  - タイムアウトが無く、回線が不安定だと永久に待っていた → GET 30 秒 / 書き込み 60 秒で打ち切る
 *  - 一時的な通信エラーでも即失敗していた → GET だけ軽く再試行する
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  HttpError,
  HttpNetworkError,
  HttpParseError,
  HttpTimeoutError,
  createHttpClient,
} from './httpClient';

type FetchInit = RequestInit & { signal: AbortSignal };

/** fetch の Response 相当 (ok / status / statusText / text だけ使う) */
function fakeResponse(status: number, body: string, statusText = ''): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    text: () => Promise.resolve(body),
  } as unknown as Response;
}

function abortError(): Error {
  const error = new Error('The operation was aborted.');
  error.name = 'AbortError';
  return error;
}

/** signal が abort されるまで返らない fetch。abort されたら AbortError で reject する */
function hangingFetch() {
  return vi.fn((_url: string, init: FetchInit) => {
    return new Promise<Response>((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(abortError()));
    });
  });
}

const BASE = 'https://api.example.com';

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('レスポンスの読み取り', () => {
  it('JSON を読んで返す', async () => {
    fetchMock.mockResolvedValueOnce(fakeResponse(200, '{"ok":true,"items":[1,2]}'));
    const api = createHttpClient({ baseUrl: BASE });

    await expect(api.get<{ ok: boolean; items: number[] }>('/api/x')).resolves.toEqual({ ok: true, items: [1, 2] });
  });

  it('本文が空 (204 など) なら null を返す', async () => {
    fetchMock.mockResolvedValueOnce(fakeResponse(204, ''));
    const api = createHttpClient({ baseUrl: BASE });

    await expect(api.del('/api/x')).resolves.toBeNull();
  });

  it('502 の HTML エラーページは SyntaxError ではなく HttpError (HTTP 502) になる', async () => {
    fetchMock.mockResolvedValueOnce(fakeResponse(502, '<html><body><h1>502 Bad Gateway</h1></body></html>', 'Bad Gateway'));
    // POST は再試行しないので 1 回で結果が出る
    const api = createHttpClient({ baseUrl: BASE });

    const error = await api.post('/api/x', {}).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(HttpError);
    expect(error).not.toBeInstanceOf(SyntaxError);
    const httpError = error as HttpError;
    expect(httpError.status).toBe(502);
    expect(httpError.message).toBe('HTTP 502 Bad Gateway');
    // HTML をそのまま画面に出さないよう、メッセージには載せない。生の本文は body に残る
    expect(httpError.message).not.toContain('<html>');
    expect(httpError.body).toContain('502 Bad Gateway');
  });

  it('エラー本文が JSON で error / message を持つなら、従来どおり JSON をメッセージに載せる', async () => {
    fetchMock.mockResolvedValueOnce(fakeResponse(400, '{"error":"invalid date"}', 'Bad Request'));
    const api = createHttpClient({ baseUrl: BASE });

    const error = (await api.post('/api/x', {}).catch((e: unknown) => e)) as HttpError;

    expect(error).toBeInstanceOf(HttpError);
    expect(error.message).toBe('HTTP 400 Bad Request: {"error":"invalid date"}');
    expect(error.json).toEqual({ error: 'invalid date' });
  });

  it('statusText が空 (HTTP/2) でも、従来どおり "HTTP 403 : <本文>" の形にする (api-error.ts がこの形を前提にしている)', async () => {
    fetchMock.mockResolvedValueOnce(fakeResponse(403, '{"error":{"code":"FORBIDDEN","message":"権限がありません"}}', ''));
    const api = createHttpClient({ baseUrl: BASE });

    const error = (await api.post('/api/x', {}).catch((e: unknown) => e)) as HttpError;

    expect(error.message).toBe('HTTP 403 : {"error":{"code":"FORBIDDEN","message":"権限がありません"}}');
  });

  it('エラー本文が短いプレーンテキストならメッセージに載せ、長い本文は切り詰める', async () => {
    const api = createHttpClient({ baseUrl: BASE });

    fetchMock.mockResolvedValueOnce(fakeResponse(500, 'Internal Server Error', 'Internal Server Error'));
    const short = (await api.post('/api/x', {}).catch((e: unknown) => e)) as HttpError;
    expect(short.message).toBe('HTTP 500 Internal Server Error: Internal Server Error');

    fetchMock.mockResolvedValueOnce(fakeResponse(500, 'x'.repeat(1000), 'Internal Server Error'));
    const long = (await api.post('/api/x', {}).catch((e: unknown) => e)) as HttpError;
    expect(long.message.length).toBeLessThan(300);
    expect(long.body.length).toBe(1000);
  });

  it('2xx なのに JSON でない本文 (キャプティブポータルの HTML など) は HttpParseError', async () => {
    fetchMock.mockResolvedValueOnce(fakeResponse(200, '<html>login to wifi</html>', 'OK'));
    const api = createHttpClient({ baseUrl: BASE });

    const error = await api.get('/api/x', { retries: 0 }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(HttpParseError);
    expect(error).not.toBeInstanceOf(SyntaxError);
    expect((error as HttpParseError).status).toBe(200);
  });
});

describe('リクエストの組み立て', () => {
  it('base URL とパスを連結し、Content-Type と Authorization を付ける', async () => {
    fetchMock.mockResolvedValueOnce(fakeResponse(200, '{}'));
    const api = createHttpClient({ baseUrl: `${BASE}/`, getAccessToken: () => 'tok-1' });

    await api.post('api/things', { a: 1 });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.example.com/api/things');
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{"a":1}');
    const headers = init.headers as Headers;
    expect(headers.get('Content-Type')).toBe('application/json');
    expect(headers.get('Authorization')).toBe('Bearer tok-1');
  });

  it('呼び出し側が指定した Authorization は上書きしない', async () => {
    fetchMock.mockResolvedValueOnce(fakeResponse(200, '{}'));
    const api = createHttpClient({ baseUrl: BASE, getAccessToken: () => 'tok-1' });

    await api.get('/api/x', { headers: { Authorization: 'Bearer other' } });

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect((init.headers as Headers).get('Authorization')).toBe('Bearer other');
  });

  it('timeoutMs / retries は fetch に渡さない', async () => {
    fetchMock.mockResolvedValueOnce(fakeResponse(200, '{}'));
    const api = createHttpClient({ baseUrl: BASE });

    await api.get('/api/x', { timeoutMs: 1234, retries: 0 });

    const init = fetchMock.mock.calls[0][1] as Record<string, unknown>;
    expect(init).not.toHaveProperty('timeoutMs');
    expect(init).not.toHaveProperty('retries');
  });
});

describe('タイムアウト', () => {
  it('GET の既定は 30 秒: 29.999 秒では待ち続け、30 秒で HttpTimeoutError', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(hangingFetch());
    const api = createHttpClient({ baseUrl: BASE, retries: 0 });

    const settled = vi.fn();
    const promise = api.get('/api/x').catch((e: unknown) => {
      settled(e);
      return e;
    });

    await vi.advanceTimersByTimeAsync(29_999);
    expect(settled).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    const error = await promise;
    expect(error).toBeInstanceOf(HttpTimeoutError);
    expect((error as HttpTimeoutError).timeoutMs).toBe(30_000);
    // どのリクエストだったかはプロパティで分かる
    expect((error as HttpTimeoutError).method).toBe('GET');
    expect((error as HttpTimeoutError).path).toBe('/api/x');
  });

  it('message は利用者に読める日本語で、API のパスや英語の定型文を含まない (多くの画面が e.message をそのまま出すため)', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(hangingFetch());
    const api = createHttpClient({ baseUrl: BASE, retries: 0 });

    const promise = api.get('/api/secret-path?token=abc').catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(30_000);

    const error = (await promise) as HttpTimeoutError;
    expect(error).toBeInstanceOf(HttpTimeoutError);
    expect(error.message).toContain('タイムアウト');
    expect(error.message).not.toContain('/api/');
    expect(error.message).not.toContain('token');
    expect(error.message).not.toMatch(/timed out|GET|POST/i);
    expect(error.name).toBe('TimeoutError');
  });

  it('書き込み (POST) の message は、サーバーの処理が終わっていることがあるので、確かめてからやり直すよう案内する', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(hangingFetch());
    const api = createHttpClient({ baseUrl: BASE });

    const promise = api.post('/api/secret-path?token=abc', {}).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(60_000);

    const error = (await promise) as HttpTimeoutError;
    expect(error).toBeInstanceOf(HttpTimeoutError);
    expect(error.method).toBe('POST');
    expect(error.message).toContain('タイムアウト');
    expect(error.message).toContain('処理が終わっている場合がある');
    expect(error.message).not.toContain('/api/');
    expect(error.message).not.toMatch(/timed out|GET|POST/i);
  });

  it('書き込み系 (POST) の既定は 60 秒: 30 秒を過ぎても待ち、60 秒で打ち切る', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(hangingFetch());
    const api = createHttpClient({ baseUrl: BASE });

    const settled = vi.fn();
    const promise = api.post('/api/ai/analyze', {}).catch((e: unknown) => {
      settled(e);
      return e;
    });

    await vi.advanceTimersByTimeAsync(30_000);
    expect(settled).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(29_999);
    expect(settled).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(await promise).toBeInstanceOf(HttpTimeoutError);
  });

  it('リクエストごとの timeoutMs が既定より優先される', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(hangingFetch());
    const api = createHttpClient({ baseUrl: BASE, retries: 0 });

    const promise = api.get('/api/x', { timeoutMs: 500 }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(500);

    const error = await promise;
    expect(error).toBeInstanceOf(HttpTimeoutError);
    expect((error as HttpTimeoutError).timeoutMs).toBe(500);
  });

  it('timeoutMs: 0 ならタイムアウトを付けない', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(hangingFetch());
    const api = createHttpClient({ baseUrl: BASE });

    const settled = vi.fn();
    void api.post('/api/x', {}, { timeoutMs: 0 }).catch(settled);

    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(settled).not.toHaveBeenCalled();
  });

  it('応答ヘッダーが届いても、本文を読み終えるまでがタイムアウトの対象', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation((_url: string, init: FetchInit) =>
      Promise.resolve({
        ok: true,
        status: 200,
        statusText: 'OK',
        // 本文の読み取りが止まったまま。abort されたら AbortError で reject する (実機の fetch と同じ)
        text: () =>
          new Promise<string>((_resolve, reject) => {
            init.signal.addEventListener('abort', () => reject(abortError()));
          }),
      } as unknown as Response),
    );
    const api = createHttpClient({ baseUrl: BASE, retries: 0, timeoutMs: 1000 });

    const promise = api.get('/api/x').catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(1000);

    expect(await promise).toBeInstanceOf(HttpTimeoutError);
  });

  it('終わったリクエストのタイマーは残らない', async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValueOnce(fakeResponse(200, '{}'));
    const api = createHttpClient({ baseUrl: BASE });

    await api.get('/api/x');

    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('呼び出し側の中断 (signal)', () => {
  it('呼び出し側が abort したら AbortError のまま投げ、タイムアウトや再試行にはしない', async () => {
    fetchMock.mockImplementation(hangingFetch());
    const api = createHttpClient({ baseUrl: BASE, retryDelayMs: 0 });
    const controller = new AbortController();

    const promise = api.get('/api/x', { signal: controller.signal }).catch((e: unknown) => e);
    // fetch が呼ばれてから中断する
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    controller.abort();

    const error = (await promise) as Error;
    expect(error.name).toBe('AbortError');
    expect(error).not.toBeInstanceOf(HttpTimeoutError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('最初から abort 済みの signal なら fetch を呼ばずに AbortError', async () => {
    const api = createHttpClient({ baseUrl: BASE });
    const controller = new AbortController();
    controller.abort();

    const error = (await api.get('/api/x', { signal: controller.signal }).catch((e: unknown) => e)) as Error;

    expect(error.name).toBe('AbortError');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('再試行の待ち時間の間に中断されたら、待たずに AbortError', async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValue(fakeResponse(503, 'unavailable', 'Service Unavailable'));
    const api = createHttpClient({ baseUrl: BASE, retryDelayMs: 10_000 });
    const controller = new AbortController();

    const promise = api.get('/api/x', { signal: controller.signal }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(0); // 1 回目の 503 が返り、再試行の待ちに入る
    controller.abort();

    const error = (await promise) as Error;
    expect(error.name).toBe('AbortError');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('GET の再試行', () => {
  it('502 / 503 / 504 は再試行して、成功した結果を返す', async () => {
    for (const status of [502, 503, 504]) {
      fetchMock.mockReset();
      fetchMock
        .mockResolvedValueOnce(fakeResponse(status, '<html>gateway</html>'))
        .mockResolvedValueOnce(fakeResponse(200, '{"ok":true}'));
      const api = createHttpClient({ baseUrl: BASE, retryDelayMs: 0 });

      await expect(api.get('/api/x')).resolves.toEqual({ ok: true });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    }
  });

  it('通信エラー (オフラインなど) も再試行する', async () => {
    fetchMock
      .mockRejectedValueOnce(new TypeError('Network request failed'))
      .mockResolvedValueOnce(fakeResponse(200, '{"ok":true}'));
    const api = createHttpClient({ baseUrl: BASE, retryDelayMs: 0 });

    await expect(api.get('/api/x')).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('再試行しても直らなければ、最後の失敗を投げる (既定は 1 + 2 回)', async () => {
    fetchMock.mockResolvedValue(fakeResponse(503, 'unavailable', 'Service Unavailable'));
    const api = createHttpClient({ baseUrl: BASE, retryDelayMs: 0 });

    const error = await api.get('/api/x').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).status).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('通信エラーが続いたときは HttpNetworkError (メッセージは元のまま)', async () => {
    fetchMock.mockRejectedValue(new TypeError('Network request failed'));
    const api = createHttpClient({ baseUrl: BASE, retryDelayMs: 0 });

    const error = await api.get('/api/x').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(HttpNetworkError);
    expect((error as HttpNetworkError).message).toBe('Network request failed');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('待ち時間は 1 回目 400ms / 2 回目 800ms と倍々に増える', async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValue(fakeResponse(503, '', 'Service Unavailable'));
    const api = createHttpClient({ baseUrl: BASE });

    const promise = api.get('/api/x').catch((e: unknown) => e);

    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(399);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(799);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);

    expect(await promise).toBeInstanceOf(HttpError);
  });

  it('再試行しないもの: 500 / 404 などのエラー応答、JSON でない 2xx', async () => {
    const api = createHttpClient({ baseUrl: BASE, retryDelayMs: 0 });

    for (const status of [400, 401, 404, 500]) {
      fetchMock.mockReset();
      fetchMock.mockResolvedValue(fakeResponse(status, '{"error":"x"}'));
      await expect(api.get('/api/x')).rejects.toBeInstanceOf(HttpError);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }

    fetchMock.mockReset();
    fetchMock.mockResolvedValue(fakeResponse(200, 'not json'));
    await expect(api.get('/api/x')).rejects.toBeInstanceOf(HttpParseError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('タイムアウトは再試行しない (待ち時間が倍々に伸びるのを避ける)', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(hangingFetch());
    const api = createHttpClient({ baseUrl: BASE, timeoutMs: 1000 });

    const promise = api.get('/api/x').catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(1000);

    expect(await promise).toBeInstanceOf(HttpTimeoutError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('書き込み系 (POST / PUT / PATCH / DELETE) は 503 や通信エラーでも再試行しない', async () => {
    const api = createHttpClient({ baseUrl: BASE, retryDelayMs: 0 });
    const calls: Array<() => Promise<unknown>> = [
      () => api.post('/api/x', {}),
      () => api.put('/api/x', {}),
      () => api.patch('/api/x', {}),
      () => api.del('/api/x'),
    ];

    for (const call of calls) {
      fetchMock.mockReset();
      fetchMock.mockResolvedValue(fakeResponse(503, '', 'Service Unavailable'));
      await expect(call()).rejects.toBeInstanceOf(HttpError);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      fetchMock.mockReset();
      fetchMock.mockRejectedValue(new TypeError('Network request failed'));
      await expect(call()).rejects.toBeInstanceOf(HttpNetworkError);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  });

  it('retries: 0 で再試行を止められ、retries: N で回数を変えられる', async () => {
    fetchMock.mockResolvedValue(fakeResponse(503, '', 'Service Unavailable'));
    const api = createHttpClient({ baseUrl: BASE, retryDelayMs: 0 });

    await expect(api.get('/api/x', { retries: 0 })).rejects.toBeInstanceOf(HttpError);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock.mockClear();
    await expect(api.get('/api/x', { retries: 4 })).rejects.toBeInstanceOf(HttpError);
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it('設定の retries で全体の既定を変えられる', async () => {
    fetchMock.mockResolvedValue(fakeResponse(503, '', 'Service Unavailable'));
    const api = createHttpClient({ baseUrl: BASE, retries: 1, retryDelayMs: 0 });

    await expect(api.get('/api/x')).rejects.toBeInstanceOf(HttpError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
