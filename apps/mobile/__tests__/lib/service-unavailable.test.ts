/**
 * service-unavailable.test.ts
 * AI 相談の緊急停止 (503 AI_CHAT_DISABLED)・メンテナンス中 (503 MAINTENANCE_MODE) を、生の文字列ではなく固定の文にする (#1457)
 * 同意の状況を読めなかった 503 (AI_CONSENT_CHECK_FAILED) も、同じく固定の文にする (#1486)
 *
 * 1. src/lib/service-unavailable.ts: API クライアント・生の fetch が作る `HTTP 503 ...: {...}` の Error から、固定の文の例外を作る
 * 2. src/lib/api-error.ts: getApiErrorMessage も、この 503 には本文の文字列ではなく固定の文を返す
 * 3. src/lib/api.ts: getApi() の全メソッドが、この 503 を ServiceUnavailableError に置き換えて投げ直す
 *    (各画面が e.message をそのまま出しても、「HTTP 503 …: {"error":…}」が出ない)
 */
import {
  AI_CHAT_DISABLED_CODE,
  AI_CHAT_DISABLED_MESSAGE,
  MAINTENANCE_API_CODE,
  MAINTENANCE_MESSAGE,
} from '@homegohan/shared';
import {
  AI_CONSENT_CHECK_FAILED_CODE,
  AI_CONSENT_CHECK_FAILED_MESSAGE,
} from '../../../../supabase/functions/_shared/ai-consent';

jest.mock('../../src/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: jest.fn().mockResolvedValue({ data: { session: null } }),
    },
  },
}));

// createHttpClient だけ差し替える (isHttpNetworkError などは本物を使う)
const mockClient = {
  get: jest.fn(),
  post: jest.fn(),
  put: jest.fn(),
  patch: jest.fn(),
  del: jest.fn(),
};
jest.mock('@homegohan/core', () => ({
  ...jest.requireActual('@homegohan/core'),
  createHttpClient: jest.fn(() => mockClient),
}));

import { getApi } from '../../src/lib/api';
import { getApiErrorMessage } from '../../src/lib/api-error';
import { errorOfFailedResponse } from '../../src/lib/failed-response';
import {
  ServiceUnavailableError,
  isServiceUnavailableError,
  serviceUnavailableErrorOf,
  serviceUnavailableMessageOf,
} from '../../src/lib/service-unavailable';

/** サーバーとは違う文を入れた本文。画面に出す文は本文の文字列ではなく、code から決めた固定の文であることを確かめる */
const SERVER_TEXT = 'サーバーが返した別の文';
const AI_CHAT_DISABLED_BODY = JSON.stringify({ error: SERVER_TEXT, code: AI_CHAT_DISABLED_CODE, retryAfter: 60 });
// サーバーのメンテナンス中の 503 の本文 (#1486 から AI 相談の緊急停止と同じ平らな形)
const MAINTENANCE_BODY = JSON.stringify({ error: SERVER_TEXT, code: MAINTENANCE_API_CODE, retryAfter: 300 });
// 同意の状況を読めなかったときの 503 の本文 (supabase/functions/_shared/ai-consent.ts の aiConsentDeniedPayload と同じ形)
const CONSENT_CHECK_FAILED_BODY = JSON.stringify({ error: SERVER_TEXT, code: AI_CONSENT_CHECK_FAILED_CODE });

describe('serviceUnavailableErrorOf', () => {
  it.each([
    ['API クライアント (HTTP/1.1)', `HTTP 503 Service Unavailable: ${AI_CHAT_DISABLED_BODY}`],
    ['API クライアント (HTTP/2 で statusText が空)', `HTTP 503 : ${AI_CHAT_DISABLED_BODY}`],
    ['生の fetch', `HTTP 503: ${AI_CHAT_DISABLED_BODY}`],
  ])('AI 相談の緊急停止 (%s) は、AI 相談の固定の文', (_label, message) => {
    const result = serviceUnavailableErrorOf(new Error(message));
    expect(result).toBeInstanceOf(ServiceUnavailableError);
    expect(result?.message).toBe(AI_CHAT_DISABLED_MESSAGE);
  });

  it('メンテナンス中 ({ error, code, retryAfter }) は、メンテナンス中の固定の文', () => {
    const result = serviceUnavailableErrorOf(new Error(`HTTP 503 Service Unavailable: ${MAINTENANCE_BODY}`));
    expect(result?.message).toBe(MAINTENANCE_MESSAGE);
    expect(result?.message).not.toContain('HTTP');
  });

  it('#1486 より前のサーバーのメンテナンス中の入れ子の本文 ({ error: { code, message } }) も、メンテナンス中の固定の文', () => {
    const legacy = JSON.stringify({ error: { code: MAINTENANCE_API_CODE, message: SERVER_TEXT } });
    expect(serviceUnavailableErrorOf(new Error(`HTTP 503 Service Unavailable: ${legacy}`))?.message).toBe(MAINTENANCE_MESSAGE);
  });

  it.each([
    ['API クライアント (HTTP/1.1)', `HTTP 503 Service Unavailable: ${CONSENT_CHECK_FAILED_BODY}`],
    ['生の fetch', `HTTP 503: ${CONSENT_CHECK_FAILED_BODY}`],
  ])('#1486 同意の状況を読めなかった 503 (%s) は、生の文字列ではなく固定の文', (_label, message) => {
    const result = serviceUnavailableErrorOf(new Error(message));
    expect(result).toBeInstanceOf(ServiceUnavailableError);
    expect(result?.message).toBe(AI_CONSENT_CHECK_FAILED_MESSAGE);
    expect(result?.message).not.toContain('HTTP');
    expect(result?.message).not.toContain(SERVER_TEXT);
  });

  it.each([
    ['ほかの code の 503', `HTTP 503 Service Unavailable: ${JSON.stringify({ error: 'x', code: 'SOMETHING_ELSE' })}`],
    ['同意の状況を読めない code でも 503 以外', `HTTP 500 Internal Server Error: ${CONSENT_CHECK_FAILED_BODY}`],
    ['code の無い 503', `HTTP 503 Service Unavailable: ${JSON.stringify({ error: 'x' })}`],
    ['JSON でない 503 (ゲートウェイの HTML)', 'HTTP 503 Service Unavailable: <html>busy</html>'],
    ['同じ code でも 503 以外', `HTTP 500 Internal Server Error: ${AI_CHAT_DISABLED_BODY}`],
    ['同意が必要 (403)', `HTTP 403 Forbidden: ${JSON.stringify({ error: 'x', code: 'AI_CONSENT_REQUIRED' })}`],
    ['HTTP の形でない', 'Network request failed'],
  ])('%s は null (呼び出し側の既定の扱いに任せる)', (_label, message) => {
    expect(serviceUnavailableErrorOf(new Error(message))).toBeNull();
  });

  it('Error でない値・message の無い値は null。例外を投げない', () => {
    expect(serviceUnavailableErrorOf(null)).toBeNull();
    expect(serviceUnavailableErrorOf(undefined)).toBeNull();
    expect(serviceUnavailableErrorOf({})).toBeNull();
    expect(serviceUnavailableErrorOf('HTTP 503: {')).toBeNull();
  });

  it('すでに ServiceUnavailableError なら、そのまま返す', () => {
    const error = new ServiceUnavailableError(MAINTENANCE_MESSAGE);
    expect(serviceUnavailableErrorOf(error)).toBe(error);
    expect(isServiceUnavailableError(error)).toBe(true);
    expect(isServiceUnavailableError(new Error(MAINTENANCE_MESSAGE))).toBe(false);
  });
});

describe('errorOfFailedResponse (生の fetch の失敗)', () => {
  it('503 の緊急停止・メンテナンス中は ServiceUnavailableError (固定の文)', () => {
    expect(errorOfFailedResponse(503, AI_CHAT_DISABLED_BODY)).toEqual(new ServiceUnavailableError(AI_CHAT_DISABLED_MESSAGE));
    expect(errorOfFailedResponse(503, MAINTENANCE_BODY).message).toBe(MAINTENANCE_MESSAGE);
    expect(errorOfFailedResponse(503, CONSENT_CHECK_FAILED_BODY)).toEqual(new ServiceUnavailableError(AI_CONSENT_CHECK_FAILED_MESSAGE));
  });

  it('それ以外は、これまでどおり `HTTP <状態>: <本文>` (同意の 403 の見分けが読む形を変えない)', () => {
    const consentBody = JSON.stringify({ error: 'x', code: 'AI_CONSENT_REQUIRED' });
    const error = errorOfFailedResponse(403, consentBody);
    expect(isServiceUnavailableError(error)).toBe(false);
    expect(error.message).toBe(`HTTP 403: ${consentBody}`);
    expect(errorOfFailedResponse(503, '').message).toBe('HTTP 503: ');
  });
});

describe('serviceUnavailableMessageOf (本文を JSON として読んだあと)', () => {
  it('503 の緊急停止・メンテナンス中・同意の状況を読めなかったときだけ固定の文。ほかは null', () => {
    expect(serviceUnavailableMessageOf(503, JSON.parse(MAINTENANCE_BODY))).toBe(MAINTENANCE_MESSAGE);
    expect(serviceUnavailableMessageOf(503, JSON.parse(AI_CHAT_DISABLED_BODY))).toBe(AI_CHAT_DISABLED_MESSAGE);
    expect(serviceUnavailableMessageOf(503, JSON.parse(CONSENT_CHECK_FAILED_BODY))).toBe(AI_CONSENT_CHECK_FAILED_MESSAGE);
    expect(serviceUnavailableMessageOf(500, JSON.parse(CONSENT_CHECK_FAILED_BODY))).toBeNull();
    expect(serviceUnavailableMessageOf(500, JSON.parse(MAINTENANCE_BODY))).toBeNull();
    expect(serviceUnavailableMessageOf(503, {})).toBeNull();
    expect(serviceUnavailableMessageOf(503, null)).toBeNull();
  });
});

describe('getApiErrorMessage', () => {
  it('503 の緊急停止・メンテナンス中は、本文の文字列ではなく固定の文', () => {
    expect(getApiErrorMessage(new Error(`HTTP 503 Service Unavailable: ${MAINTENANCE_BODY}`), 'fallback')).toBe(MAINTENANCE_MESSAGE);
    expect(getApiErrorMessage(new Error(`HTTP 503: ${AI_CHAT_DISABLED_BODY}`), 'fallback')).toBe(AI_CHAT_DISABLED_MESSAGE);
    expect(getApiErrorMessage(new Error(`HTTP 503: ${CONSENT_CHECK_FAILED_BODY}`), 'fallback')).toBe(AI_CONSENT_CHECK_FAILED_MESSAGE);
  });

  it('ほかのエラーは、これまでどおり本文の message', () => {
    const body = JSON.stringify({ error: { code: 'FORBIDDEN', message: '権限がありません' } });
    expect(getApiErrorMessage(new Error(`HTTP 403 Forbidden: ${body}`), 'fallback')).toBe('権限がありません');
  });
});

describe('getApi() — 全メソッドが 503 を固定の文の例外に置き換える', () => {
  const ORIGINAL_BASE_URL = process.env.EXPO_PUBLIC_API_BASE_URL;

  beforeEach(() => {
    // expo/virtual/env が読み込み時の process.env を握るので、差し替えずに同じオブジェクトを書き換える
    process.env.EXPO_PUBLIC_API_BASE_URL = 'https://api.example.com';
    for (const fn of Object.values(mockClient)) fn.mockReset();
  });

  afterEach(() => {
    if (ORIGINAL_BASE_URL === undefined) delete process.env.EXPO_PUBLIC_API_BASE_URL;
    else process.env.EXPO_PUBLIC_API_BASE_URL = ORIGINAL_BASE_URL;
  });

  // getApi() は 1 つのクライアントを使い回す。差し替えた createHttpClient はいつも同じ mockClient を返すので、使い回しでよい
  // (jest.isolateModules で読み直すと、ServiceUnavailableError のクラスが別物になり、instanceof で比べられない)
  function freshApi() {
    return getApi();
  }

  const calls: Array<[string, (api: ReturnType<typeof freshApi>) => Promise<unknown>]> = [
    ['get', (api) => api.get('/api/ai/consultation/sessions')],
    ['post', (api) => api.post('/api/ai/consultation/sessions', {})],
    ['put', (api) => api.put('/api/x', {})],
    ['patch', (api) => api.patch('/api/x', {})],
    ['del', (api) => api.del('/api/x')],
  ];

  it.each(calls)('%s: メンテナンス中の 503 は、メンテナンス中の固定の文の ServiceUnavailableError', async (method, call) => {
    mockClient[method as keyof typeof mockClient].mockRejectedValue(new Error(`HTTP 503 Service Unavailable: ${MAINTENANCE_BODY}`));
    const error = await call(freshApi()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ServiceUnavailableError);
    expect((error as Error).message).toBe(MAINTENANCE_MESSAGE);
  });

  it('#1486 同意の状況を読めなかった 503 は、固定の文の ServiceUnavailableError (「HTTP 503: {...}」の生の文字列を出さない)', async () => {
    mockClient.post.mockRejectedValue(new Error(`HTTP 503 Service Unavailable: ${CONSENT_CHECK_FAILED_BODY}`));
    const error = await freshApi().post('/api/ai/health/insights', {}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ServiceUnavailableError);
    expect((error as Error).message).toBe(AI_CONSENT_CHECK_FAILED_MESSAGE);
  });

  it('ほかのエラーは、そのまま (同じ例外を) 投げる', async () => {
    const original = new Error(`HTTP 403 Forbidden: ${JSON.stringify({ error: 'x', code: 'AI_CONSENT_REQUIRED' })}`);
    mockClient.post.mockRejectedValue(original);
    await expect(freshApi().post('/api/ai/consultation/sessions', {})).rejects.toBe(original);
  });

  it('成功はそのまま返す', async () => {
    mockClient.get.mockResolvedValue({ sessions: [] });
    await expect(freshApi().get('/api/ai/consultation/sessions')).resolves.toEqual({ sessions: [] });
  });
});
