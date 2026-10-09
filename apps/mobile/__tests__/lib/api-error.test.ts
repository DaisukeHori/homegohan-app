/**
 * api-error.test.ts
 * src/lib/api-error.ts の getApiErrorMessage() のテスト (#1137, #1168)
 *
 * エラーは、モバイルが実際に使う @homegohan/core の createHttpClient (fetch だけ差し替え) から作る。
 * createHttpClient のエラー文面 ("HTTP <status> <statusText>: <本文>") が変わったときに、ここで気付ける。
 */
import { createHttpClient, HttpNetworkError, HttpParseError } from '@homegohan/core';

import { getApiErrorMessage, INVALID_RESPONSE_MESSAGE, NETWORK_ERROR_MESSAGES } from '../../src/lib/api-error';

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
});

/** 指定の応答を返す fetch で動く、本物の HTTP クライアントを作る */
function clientRespondingWith(status: number, statusText: string, bodyText: string) {
  global.fetch = jest.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    statusText,
    text: async () => bodyText,
  }) as unknown as typeof fetch;
  // ここで見るのはエラー文面の取り出しだけなので、5xx のやり直し (待ち時間が入る) はしない
  return createHttpClient({ baseUrl: 'https://api.example.com', retry: false });
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (e) {
    return e;
  }
  throw new Error('rejected されませんでした');
}

describe('getApiErrorMessage — サーバーのエラー本文 ({ error: { code, message } })', () => {
  it('403 の { error: { code, message } } から message だけを取り出す', async () => {
    const api = clientRespondingWith(
      403,
      'Forbidden',
      JSON.stringify({ error: { code: 'FORBIDDEN', message: '権限がありません' } }),
    );
    const error = await rejectionOf(api.get('/api/super-admin/flags'));

    // 取り出す前は、画面に出すには長い生の文字列
    expect((error as Error).message).toContain('HTTP 403 Forbidden:');
    expect(getApiErrorMessage(error, '取得に失敗しました。')).toBe('権限がありません');
  });

  it('404 (フラグが見つからない) の message を取り出す', async () => {
    const api = clientRespondingWith(
      404,
      'Not Found',
      JSON.stringify({ error: { code: 'OP_FEATURE_FLAG_NOT_FOUND', message: '指定されたフラグが見つかりません' } }),
    );
    const error = await rejectionOf(api.patch('/api/super-admin/flags/x', { enabled: true }));

    expect(getApiErrorMessage(error, '更新に失敗しました。')).toBe('指定されたフラグが見つかりません');
  });

  it('入力値エラー (details 付き) でも message を取り出す', async () => {
    const api = clientRespondingWith(
      400,
      'Bad Request',
      JSON.stringify({
        error: { code: 'VALIDATION_ERROR', message: '入力値が不正です', details: { formErrors: [], fieldErrors: { enabled: ['Required'] } } },
      }),
    );
    const error = await rejectionOf(api.patch('/api/super-admin/flags/x', {}));

    expect(getApiErrorMessage(error, '更新に失敗しました。')).toBe('入力値が不正です');
  });

  it('statusText が空 (HTTP/2) でも message を取り出す', async () => {
    const api = clientRespondingWith(
      403,
      '',
      JSON.stringify({ error: { code: 'OP_SELF_MODIFY', message: '自分自身のロールは変更できません' } }),
    );
    const error = await rejectionOf(api.put('/api/admin/users/me/role', { roles: ['user'] }));

    expect((error as Error).message).toMatch(/^HTTP 403 : /);
    expect(getApiErrorMessage(error, '更新に失敗しました。')).toBe('自分自身のロールは変更できません');
  });

  it('error が文字列の本文 ({ error: "..." }) はその文字列を返す', async () => {
    const api = clientRespondingWith(400, 'Bad Request', JSON.stringify({ error: 'リクエストが不正です' }));
    const error = await rejectionOf(api.get('/api/x'));

    expect(getApiErrorMessage(error, 'fallback')).toBe('リクエストが不正です');
  });

  it('トップレベルの message ({ message: "..." }) も取り出す', async () => {
    const api = clientRespondingWith(500, 'Internal Server Error', JSON.stringify({ message: 'サーバーエラーです' }));
    const error = await rejectionOf(api.get('/api/x'));

    expect(getApiErrorMessage(error, 'fallback')).toBe('サーバーエラーです');
  });
});

describe('getApiErrorMessage — 通信できないとき (#1168)', () => {
  it('圏外・機内モードなど、応答を受け取れない通信エラーは「通信できません」と案内する', async () => {
    global.fetch = jest.fn().mockRejectedValue(new TypeError('Network request failed')) as unknown as typeof fetch;
    const api = createHttpClient({ baseUrl: 'https://api.example.com', retry: false });
    const error = await rejectionOf(api.get('/api/x'));

    expect(error).toBeInstanceOf(HttpNetworkError);
    expect((error as HttpNetworkError).kind).toBe('offline');
    // 英語の技術的な文面 (Network request failed) ではなく、画面に出せる文面を返す
    expect(getApiErrorMessage(error, 'fallback')).toBe(NETWORK_ERROR_MESSAGES.offline);
    expect(NETWORK_ERROR_MESSAGES.offline).toContain('通信できません');
  });

  it('待ち時間切れも「通信できません」と案内する', async () => {
    // abort されたら AbortError で失敗する、本物の fetch と同じ動きの fetch (応答は返さない)
    global.fetch = jest.fn((_url: string, init?: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('Aborted'), { name: 'AbortError' })));
      });
    }) as unknown as typeof fetch;
    const api = createHttpClient({ baseUrl: 'https://api.example.com', timeoutMs: 20 });
    const error = await rejectionOf(api.get('/api/x'));

    expect(error).toBeInstanceOf(HttpNetworkError);
    expect((error as HttpNetworkError).kind).toBe('timeout');
    expect(getApiErrorMessage(error, 'fallback')).toBe(NETWORK_ERROR_MESSAGES.timeout);
    expect(NETWORK_ERROR_MESSAGES.timeout).toContain('通信できません');
  });

  it('getApi() と同じように networkErrorMessages を渡すと、e.message をそのまま出す画面でも「通信できません」になる', async () => {
    global.fetch = jest.fn().mockRejectedValue(new TypeError('Network request failed')) as unknown as typeof fetch;
    const api = createHttpClient({
      baseUrl: 'https://api.example.com',
      retry: false,
      networkErrorMessages: NETWORK_ERROR_MESSAGES,
    });
    const error = await rejectionOf(api.get('/api/x'));

    expect((error as Error).message).toBe(NETWORK_ERROR_MESSAGES.offline);
    expect(getApiErrorMessage(error, 'fallback')).toBe(NETWORK_ERROR_MESSAGES.offline);
  });

  it('サーバーが返したエラー (503 など) は「通信できません」にしない', async () => {
    const api = clientRespondingWith(
      503,
      'Service Unavailable',
      JSON.stringify({ error: { code: 'MAINTENANCE', message: 'メンテナンス中です' } }),
    );
    const error = await rejectionOf(api.get('/api/x'));

    expect(error).not.toBeInstanceOf(HttpNetworkError);
    expect(getApiErrorMessage(error, 'fallback')).toBe('メンテナンス中です');
  });
});

describe('getApiErrorMessage — 成功なのに本文が JSON でないとき (#1049 F7-12)', () => {
  it('公衆 Wi-Fi のログイン画面 (200 の HTML) は、JSON Parse error ではなく読める文面を返す', async () => {
    const api = clientRespondingWith(200, 'OK', '<html><body>Wi-Fi にログインしてください</body></html>');
    const error = await rejectionOf(api.get('/api/x'));

    expect(error).toBeInstanceOf(HttpParseError);
    expect(error).not.toBeInstanceOf(SyntaxError);
    // 英語の技術的な文面 (JSON Parse error: ...) や本文の HTML を、画面に出さない
    expect(getApiErrorMessage(error, 'fallback')).toBe(INVALID_RESPONSE_MESSAGE);
    expect(INVALID_RESPONSE_MESSAGE).not.toMatch(/JSON|<html>|HTTP [0-9]{3}/);
  });

  it('getApi() と同じように invalidResponseMessage を渡すと、e.message をそのまま出す画面でも読める文面になる', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => '<html></html>',
    }) as unknown as typeof fetch;
    const api = createHttpClient({
      baseUrl: 'https://api.example.com',
      retry: false,
      invalidResponseMessage: INVALID_RESPONSE_MESSAGE,
    });
    const error = await rejectionOf(api.post('/api/x', { a: 1 }));

    expect((error as Error).message).toBe(INVALID_RESPONSE_MESSAGE);
    expect(getApiErrorMessage(error, 'fallback')).toBe(INVALID_RESPONSE_MESSAGE);
  });

  it('書き込みの成功応答が読めなかったときは、確かめてからやり直すよう案内する (サーバーでは処理が終わっていることがある)', () => {
    expect(INVALID_RESPONSE_MESSAGE).toContain('画面を開き直して');
    expect(INVALID_RESPONSE_MESSAGE).toContain('もう一度お試しください');
  });

  it('エラー応答 (502 の HTML) は HttpParseError にしない (従来どおりステータス付きの message)', async () => {
    const api = clientRespondingWith(502, 'Bad Gateway', '<html>Bad Gateway</html>');
    const error = await rejectionOf(api.get('/api/x'));

    expect(error).not.toBeInstanceOf(HttpParseError);
    expect(getApiErrorMessage(error, 'fallback')).toBe('HTTP 502 Bad Gateway: <html>Bad Gateway</html>');
  });
});

describe('getApiErrorMessage — 取り出せないとき', () => {
  it('本文に message が無ければ Error の message をそのまま返す', async () => {
    const api = clientRespondingWith(500, 'Internal Server Error', JSON.stringify({ error: { code: 'INTERNAL_ERROR' } }));
    const error = await rejectionOf(api.get('/api/x'));

    expect(getApiErrorMessage(error, 'fallback')).toBe((error as Error).message);
    expect(getApiErrorMessage(error, 'fallback')).toContain('HTTP 500 Internal Server Error:');
  });

  it('message が空文字なら Error の message をそのまま返す', async () => {
    const api = clientRespondingWith(500, 'Internal Server Error', JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: '' } }));
    const error = await rejectionOf(api.get('/api/x'));

    expect(getApiErrorMessage(error, 'fallback')).toBe((error as Error).message);
  });

  it('JSON ではない応答 (存在しないパスの HTML など) は、ステータス付きの message をそのまま返す', async () => {
    const api = clientRespondingWith(404, 'Not Found', '<!DOCTYPE html><html><body>404</body></html>');
    const error = await rejectionOf(api.get('/api/super-admin/feature-flags'));

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('HTTP 404 Not Found: <!DOCTYPE html><html><body>404</body></html>');
    expect(getApiErrorMessage(error, 'fallback')).toBe((error as Error).message);
  });

  it('本文が JSON として読めない "HTTP ..." 形式の message は、そのまま返す', () => {
    expect(getApiErrorMessage(new Error('HTTP 502 Bad Gateway: upstream timeout'), 'fallback')).toBe(
      'HTTP 502 Bad Gateway: upstream timeout',
    );
  });

  it('文字列や message を持つオブジェクトが投げられても扱える', () => {
    expect(getApiErrorMessage('plain string', 'fallback')).toBe('plain string');
    expect(getApiErrorMessage({ message: 'object with message' }, 'fallback')).toBe('object with message');
  });

  it('message が無い・空のときは fallback を返す', () => {
    expect(getApiErrorMessage(undefined, 'fallback')).toBe('fallback');
    expect(getApiErrorMessage(null, 'fallback')).toBe('fallback');
    expect(getApiErrorMessage({}, 'fallback')).toBe('fallback');
    expect(getApiErrorMessage(new Error(''), 'fallback')).toBe('fallback');
    expect(getApiErrorMessage('   ', 'fallback')).toBe('fallback');
    expect(getApiErrorMessage({ message: 42 }, 'fallback')).toBe('fallback');
  });
});
