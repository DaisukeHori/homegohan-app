/**
 * #1049 F7-12: 共通の HTTP クライアント (@homegohan/core の createHttpClient) が、成功 (2xx) の応答の本文が
 * JSON として読めないとき (公衆 Wi-Fi のログインページ・プロキシが 200 で返す HTML、途中で切れた本文など) に、
 * SyntaxError ではなく、エラー応答と同じ `HTTP <status> <statusText>: <本文>` の Error を投げることを、モバイルの実行環境で確かめる。
 *
 * モバイルの画面は getApi() 経由でこのクライアントを使い、エラーの文は getApiErrorMessage() で取り出す。
 * SyntaxError のままだと「JSON Parse error: Unexpected character: <」のような文が画面に出ていた。
 */

import { createHttpClient, isHttpNetworkError } from '@homegohan/core';

const BASE_URL = 'https://api.example.com';

function textResponse(status: number, statusText: string, body: string) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    headers: { get: () => null },
    text: async () => body,
  };
}

describe('共通の HTTP クライアント: 成功の応答の本文が JSON として読めないとき (#1049 F7-12)', () => {
  const originalFetch = global.fetch;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('200 の HTML は、SyntaxError ではなく `HTTP 200 OK: <本文>` の Error になり、やり直さない', async () => {
    fetchMock.mockResolvedValue(textResponse(200, 'OK', '<html><body>Wi-Fi login</body></html>'));
    const api = createHttpClient({ baseUrl: BASE_URL });

    let thrown: unknown;
    try {
      await api.get('/api/pantry');
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(SyntaxError);
    expect(isHttpNetworkError(thrown)).toBe(false);
    expect((thrown as Error).message).toBe('HTTP 200 OK: <html><body>Wi-Fi login</body></html>');
    expect((thrown as Error & { cause?: unknown }).cause).toBeInstanceOf(SyntaxError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('JSON として読める本文は、従来どおり値を返す。本文が空なら null', async () => {
    fetchMock.mockResolvedValueOnce(textResponse(200, 'OK', '{"items":[1]}'));
    fetchMock.mockResolvedValueOnce(textResponse(204, 'No Content', ''));
    const api = createHttpClient({ baseUrl: BASE_URL });

    await expect(api.get('/api/x')).resolves.toEqual({ items: [1] });
    await expect(api.post('/api/y', {})).resolves.toBeNull();
  });
});
