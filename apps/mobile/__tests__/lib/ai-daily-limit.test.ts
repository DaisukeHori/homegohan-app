/**
 * #1149 (T40) アプリ: AI の API に「今日の AI の利用回数の上限に達しました」(429 AI_DAILY_LIMIT) で止められたとき、
 * 生の文字列 (`HTTP 429 Too Many Requests: {...}`) を画面に出さず、固定の文を出す
 *
 *   - aiDailyLimitErrorOf: 共通クライアントが投げた Error のうち、429 + AI_DAILY_LIMIT だけを AiDailyLimitError (message が固定の文) にする。
 *     レート制限の 429・ほかの状態・JSON でない本文は null
 *   - getApi(): どのメソッドでも、この Error を AiDailyLimitError に置き換えて投げ直す (各画面が e.message をそのまま出しても固定の文になる)。
 *     ほかのエラー (同意の 403・通信できない) はそのまま投げる (同意の案内などの見分けを変えない)
 *   - getApiErrorMessage(e) も固定の文を返す
 */

jest.mock('../../src/lib/supabase', () => ({
  supabase: { auth: { getSession: jest.fn().mockResolvedValue({ data: { session: null } }) } },
}));

jest.mock('@homegohan/core', () => ({
  ...jest.requireActual('@homegohan/core'),
  createHttpClient: jest.fn(() => ({
    get: jest.fn(),
    post: jest.fn(),
    put: jest.fn(),
    patch: jest.fn(),
    del: jest.fn(),
  })),
}));

import { AiDailyLimitError, aiDailyLimitErrorOf, isAiDailyLimitError } from '../../src/lib/ai-daily-limit';
import { getApiErrorMessage } from '../../src/lib/api-error';

const LIMIT_MESSAGE = '今日の AI の利用回数の上限 (10 回) に達しました。明日 0 時から使えます。';
const limitError = () =>
  new Error(
    `HTTP 429 Too Many Requests: ${JSON.stringify({ error: '本文の文', code: 'AI_DAILY_LIMIT', limit: 10, retryAfter: 3600 })}`,
  );

describe('aiDailyLimitErrorOf', () => {
  it('429 + AI_DAILY_LIMIT: 固定の文 (limit から作る) の AiDailyLimitError', () => {
    const converted = aiDailyLimitErrorOf(limitError());
    expect(converted).toBeInstanceOf(AiDailyLimitError);
    expect(converted?.message).toBe(LIMIT_MESSAGE);
    expect(isAiDailyLimitError(converted)).toBe(true);
  });

  it('HTTP/2 で statusText が空の形 ("HTTP 429 : {...}") も見分ける', () => {
    const error = new Error(`HTTP 429 : ${JSON.stringify({ code: 'AI_DAILY_LIMIT', limit: 3 })}`);
    expect(aiDailyLimitErrorOf(error)?.message).toBe('今日の AI の利用回数の上限 (3 回) に達しました。明日 0 時から使えます。');
  });

  it('レート制限の 429・同意の 403・JSON でない本文・Error でない値は null', () => {
    expect(aiDailyLimitErrorOf(new Error(`HTTP 429 Too Many Requests: ${JSON.stringify({ code: 'RATE_LIMITED', retryAfter: 30 })}`))).toBeNull();
    expect(aiDailyLimitErrorOf(new Error(`HTTP 403 Forbidden: ${JSON.stringify({ code: 'AI_CONSENT_REQUIRED' })}`))).toBeNull();
    expect(aiDailyLimitErrorOf(new Error('HTTP 429 Too Many Requests: Too Many Requests'))).toBeNull();
    expect(aiDailyLimitErrorOf(null)).toBeNull();
    expect(aiDailyLimitErrorOf('HTTP 429')).toBeNull();
  });

  it('getApiErrorMessage は、置き換えた Error の固定の文をそのまま返す (生の文字列を出さない)', () => {
    const converted = aiDailyLimitErrorOf(limitError())!;
    expect(getApiErrorMessage(converted, '失敗しました')).toBe(LIMIT_MESSAGE);
    expect(getApiErrorMessage(converted, '失敗しました')).not.toContain('HTTP 429');
  });
});

describe('getApi(): 上限の Error を固定の文に置き換えて投げ直す', () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV, EXPO_PUBLIC_API_BASE_URL: 'https://api.example.com' };
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  function loadApi() {
    let result: { api: any; inner: any } | undefined;
    jest.isolateModules(() => {
      const { createHttpClient } = require('@homegohan/core');
      const { getApi } = require('../../src/lib/api');
      const api = getApi();
      // isolateModules をまたいでも createHttpClient のモックは同じなので、いま作ったクライアント (最後の呼び出し) を取る
      const { results } = (createHttpClient as jest.Mock).mock;
      result = { api, inner: results[results.length - 1].value };
    });
    return result!;
  }

  it.each(['get', 'post', 'put', 'patch', 'del'] as const)('%s: 429 AI_DAILY_LIMIT は AiDailyLimitError (固定の文) で投げる', async (method) => {
    const { api, inner } = loadApi();
    inner[method].mockRejectedValue(limitError());

    const call = method === 'get' || method === 'del' ? api[method]('/api/ai/x') : api[method]('/api/ai/x', {});
    // isolateModules で読み直したモジュールのクラスなので、instanceof ではなく名前と文で見る
    await expect(call).rejects.toMatchObject({ name: 'AiDailyLimitError', message: LIMIT_MESSAGE });
  });

  it('ほかのエラー (同意の 403・通信できない) は、そのままの Error を投げる (同意の案内などの見分けを変えない)', async () => {
    const { api, inner } = loadApi();
    const consent = new Error(`HTTP 403 Forbidden: ${JSON.stringify({ error: '同意が必要です', code: 'AI_CONSENT_REQUIRED' })}`);
    inner.post.mockRejectedValueOnce(consent);
    await expect(api.post('/api/ai/analyze-fridge', {})).rejects.toBe(consent);

    const offline = Object.assign(new Error('通信できません'), { kind: 'offline' });
    inner.get.mockRejectedValueOnce(offline);
    await expect(api.get('/api/meals')).rejects.toBe(offline);
  });

  it('成功した応答は、そのまま返す', async () => {
    const { api, inner } = loadApi();
    inner.post.mockResolvedValue({ ok: true });
    await expect(api.post('/api/ai/x', {})).resolves.toEqual({ ok: true });
  });
});
