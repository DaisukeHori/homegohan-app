/**
 * failed-response.test.ts
 * サーバーに止められた応答 — 上限 (429 AI_DAILY_LIMIT。#1149) と緊急停止・メンテナンス中 (503 AI_CHAT_DISABLED /
 * MAINTENANCE_MODE。#1457) — を、生の文字列ではなく固定の文の例外にする 2 つの口が、両方の判定を通す — 回帰テスト
 *
 * 2 つの変更は同じ関数 (getApi() の withFriendlyErrors) と同じ生の fetch の分岐を書き換えていて、合わせたときに
 * 片方の判定だけが残ると、もう片方の応答で生の文字列が出る。ここでは次を確かめる。
 * 1. errorOfFailedResponse (src/lib/failed-response.ts。生の fetch の口): 429 と 503 の両方が固定の文の例外になり、
 *    ほかの応答 (レート制限の 429・同意の 403・止めている理由が分からない 503・500) は `HTTP <状態>: <本文>` のまま
 * 2. getApi() (src/lib/api.ts の withFriendlyErrors。共通クライアントの口): 全メソッドで、429 と 503 の両方が固定の文の例外になる
 * 3. stoppedByServerAlertTitleOf: Alert の見出し (緊急停止・メンテナンス中は「ご利用いただけません」、上限は「エラー」)
 */
import {
  AI_CHAT_DISABLED_CODE,
  AI_CHAT_DISABLED_MESSAGE,
  MAINTENANCE_API_CODE,
  MAINTENANCE_MESSAGE,
} from '@homegohan/shared';

jest.mock('../../src/lib/supabase', () => ({
  supabase: { auth: { getSession: jest.fn().mockResolvedValue({ data: { session: null } }) } },
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
import { isAiConsentRequiredError } from '../../src/lib/ai-consent';
import { AiDailyLimitError, aiDailyLimitMessage } from '../../src/lib/ai-daily-limit';
import { errorOfFailedResponse, isStoppedByServerError, stoppedByServerAlertTitleOf } from '../../src/lib/failed-response';
import { ServiceUnavailableError } from '../../src/lib/service-unavailable';

/** サーバーとは違う文を入れた本文。画面に出す文は本文の文字列ではなく、code (と limit) から決めた固定の文であることを確かめる */
const SERVER_TEXT = 'サーバーが返した別の文';
/** 上限の回数 (本文の limit)。固定の文はこの値から作る */
const LIMIT = 7;

const HTTP_TOO_MANY_REQUESTS = 429;
const HTTP_SERVICE_UNAVAILABLE = 503;

const LIMIT_BODY = JSON.stringify({ error: SERVER_TEXT, code: 'AI_DAILY_LIMIT', limit: LIMIT, retryAfter: 3600 });
const AI_CHAT_DISABLED_BODY = JSON.stringify({ error: SERVER_TEXT, code: AI_CHAT_DISABLED_CODE, retryAfter: 60 });
// サーバーのメンテナンス中の 503 の本文 (#1486 から AI 相談の緊急停止と同じ平らな形)
const MAINTENANCE_BODY = JSON.stringify({ error: SERVER_TEXT, code: MAINTENANCE_API_CODE, retryAfter: 300 });

/** [ラベル, 状態, 共通クライアントの statusText, 本文, 例外のクラス, 固定の文, Alert の見出し] */
const STOPPED_CASES = [
  ['上限 (429 AI_DAILY_LIMIT)', HTTP_TOO_MANY_REQUESTS, 'Too Many Requests', LIMIT_BODY, AiDailyLimitError, aiDailyLimitMessage(LIMIT), 'エラー'],
  [
    'AI 相談の緊急停止 (503 AI_CHAT_DISABLED)',
    HTTP_SERVICE_UNAVAILABLE,
    'Service Unavailable',
    AI_CHAT_DISABLED_BODY,
    ServiceUnavailableError,
    AI_CHAT_DISABLED_MESSAGE,
    'ご利用いただけません',
  ],
  [
    'メンテナンス中 (503 MAINTENANCE_MODE)',
    HTTP_SERVICE_UNAVAILABLE,
    'Service Unavailable',
    MAINTENANCE_BODY,
    ServiceUnavailableError,
    MAINTENANCE_MESSAGE,
    'ご利用いただけません',
  ],
] as const;

describe('errorOfFailedResponse (生の fetch の失敗の応答)', () => {
  it.each(STOPPED_CASES)('%s: 固定の文の例外 (生の本文を含まない)', (_label, status, _statusText, body, ErrorClass, expected, title) => {
    const error = errorOfFailedResponse(status, body);
    expect(error).toBeInstanceOf(ErrorClass);
    expect(error.message).toBe(expected);
    expect(error.message).not.toContain('HTTP');
    expect(error.message).not.toContain(SERVER_TEXT);
    expect(isStoppedByServerError(error)).toBe(true);
    if (isStoppedByServerError(error)) expect(stoppedByServerAlertTitleOf(error)).toBe(title);
  });

  it('ほかの応答は、これまでどおり `HTTP <状態>: <本文>` (止められた例外にしない)。同意の 403 は見分けられる', () => {
    const rateLimitedBody = JSON.stringify({ code: 'RATE_LIMITED' });
    const rateLimited = errorOfFailedResponse(HTTP_TOO_MANY_REQUESTS, rateLimitedBody);
    expect(isStoppedByServerError(rateLimited)).toBe(false);
    expect(rateLimited.message).toBe(`HTTP 429: ${rateLimitedBody}`);

    const consentBody = JSON.stringify({ error: '同意が必要です', code: 'AI_CONSENT_REQUIRED' });
    const consent = errorOfFailedResponse(403, consentBody);
    expect(isStoppedByServerError(consent)).toBe(false);
    expect(isAiConsentRequiredError(consent)).toBe(true);
    expect(consent.message).toBe(`HTTP 403: ${consentBody}`);

    // 503 でも、止めている理由が分からない本文は置き換えない
    const otherUnavailableBody = JSON.stringify({ error: 'x', code: 'SOMETHING_ELSE' });
    const otherUnavailable = errorOfFailedResponse(HTTP_SERVICE_UNAVAILABLE, otherUnavailableBody);
    expect(isStoppedByServerError(otherUnavailable)).toBe(false);
    expect(otherUnavailable.message).toBe(`HTTP 503: ${otherUnavailableBody}`);

    // #1486: 同意の状況を読めなかった 503 (AI_CONSENT_CHECK_FAILED) は、緊急停止・メンテナンス中と同じく固定の文
    const consentCheckFailed = errorOfFailedResponse(
      HTTP_SERVICE_UNAVAILABLE,
      JSON.stringify({ error: SERVER_TEXT, code: 'AI_CONSENT_CHECK_FAILED' }),
    );
    expect(isStoppedByServerError(consentCheckFailed)).toBe(true);
    expect(consentCheckFailed.message).not.toContain('HTTP');
    expect(consentCheckFailed.message).not.toContain(SERVER_TEXT);

    // 上限の本文でも状態が 503 なら、503 の判定 (止めている理由が分からない) だけになる。逆も同じ
    expect(isStoppedByServerError(errorOfFailedResponse(HTTP_SERVICE_UNAVAILABLE, LIMIT_BODY))).toBe(false);
    expect(isStoppedByServerError(errorOfFailedResponse(HTTP_TOO_MANY_REQUESTS, MAINTENANCE_BODY))).toBe(false);

    expect(errorOfFailedResponse(500, '').message).toBe('HTTP 500: ');
  });
});

describe('getApi() — 全メソッドが、上限と緊急停止・メンテナンス中の両方を固定の文の例外に置き換える', () => {
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

  const METHODS = ['get', 'post', 'put', 'patch', 'del'] as const;
  type Method = (typeof METHODS)[number];

  function call(method: Method): Promise<unknown> {
    // getApi() は 1 つのクライアントを使い回す。差し替えた createHttpClient はいつも同じ mockClient を返すので、使い回しでよい
    const api = getApi();
    return method === 'get' || method === 'del' ? api[method]('/api/ai/x') : api[method]('/api/ai/x', {});
  }

  const matrix = METHODS.flatMap((method) => STOPPED_CASES.map((c) => [method, ...c] as const));

  it.each(matrix)(
    '%s / %s: 固定の文の例外で投げる',
    async (method, _label, status, statusText, body, ErrorClass, expected) => {
      // 本物の createHttpClient が投げる Error と同じ形
      mockClient[method].mockRejectedValue(new Error(`HTTP ${status} ${statusText}: ${body}`));
      const error = await call(method).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ErrorClass);
      expect((error as Error).message).toBe(expected);
    },
  );

  it('HTTP/2 で statusText が空の形 (`HTTP 503 : {...}` / `HTTP 429 : {...}`) も置き換える', async () => {
    mockClient.get.mockRejectedValueOnce(new Error(`HTTP 503 : ${MAINTENANCE_BODY}`));
    await expect(call('get')).rejects.toEqual(new ServiceUnavailableError(MAINTENANCE_MESSAGE));
    mockClient.get.mockRejectedValueOnce(new Error(`HTTP 429 : ${LIMIT_BODY}`));
    await expect(call('get')).rejects.toEqual(new AiDailyLimitError(aiDailyLimitMessage(LIMIT)));
  });

  it('ほかのエラー (同意の 403) は、同じ例外をそのまま投げる', async () => {
    const original = new Error(`HTTP 403 Forbidden: ${JSON.stringify({ error: 'x', code: 'AI_CONSENT_REQUIRED' })}`);
    mockClient.post.mockRejectedValue(original);
    await expect(call('post')).rejects.toBe(original);
  });
});
