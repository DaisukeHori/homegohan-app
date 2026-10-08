/**
 * api-error.test.ts
 * src/lib/api-error.ts の getApiErrorMessage() のテスト (#1137)
 *
 * エラーは、モバイルが実際に使う @homegohan/core の createHttpClient (fetch だけ差し替え) から作る。
 * createHttpClient のエラー文面 ("HTTP <status> <statusText>: <本文>") が変わったときに、ここで気付ける。
 */
import { createHttpClient } from '@homegohan/core';

import { getApiErrorMessage } from '../../src/lib/api-error';

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
  return createHttpClient({ baseUrl: 'https://api.example.com' });
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

  it('JSON ではない応答 (存在しないパスの HTML など) は、パースエラーの message をそのまま返す', async () => {
    const api = clientRespondingWith(404, 'Not Found', '<!DOCTYPE html><html><body>404</body></html>');
    const error = await rejectionOf(api.get('/api/super-admin/feature-flags'));

    expect(error).toBeInstanceOf(Error);
    expect(getApiErrorMessage(error, 'fallback')).toBe((error as Error).message);
  });

  it('通信エラーは Error の message をそのまま返す', async () => {
    global.fetch = jest.fn().mockRejectedValue(new TypeError('Network request failed')) as unknown as typeof fetch;
    const api = createHttpClient({ baseUrl: 'https://api.example.com' });
    const error = await rejectionOf(api.get('/api/x'));

    expect(getApiErrorMessage(error, 'fallback')).toBe('Network request failed');
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
