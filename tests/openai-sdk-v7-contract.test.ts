// @vitest-environment node
/**
 * #1902 openai の SDK を 6 → 7 に上げたときの、このリポジトリの使い方の約束 (Dependabot #1883 の代わり)
 *
 * Node 側 (src/) は openai を src/lib/ai/fast-llm.ts の getFastLLMClient() だけで作り、
 * chat.completions.create(ボディ, { signal }) を非ストリーミングで呼ぶ。返り値は choices[0].message.content だけを読む。
 * 版を上げても、次の振る舞いが変わらないことを本物の SDK (fetch だけ差し替え) で確かめる。本物の API は呼ばない。
 * - 送る内容: POST <baseURL>/chat/completions に、渡したボディをそのまま JSON で送る (signal はボディに入らない。#1047 F2-15)
 * - クライアントの設定: タイムアウト 25 秒・リトライ 1 回・ベース URL は xAI の /v1 (fast-llm.ts の値)
 * - リトライ: 5xx は設定の回数だけ再送し、4xx は再送しない
 * - エラー: 失敗は APIError (status つき)、呼び出し側の signal での中断は APIUserAbortError、時間切れは APIConnectionTimeoutError
 *
 * route を読み込むテストは @/lib/ai/fast-llm をモックして { chat: { completions: { create } } } を返す。
 * そのモックの形 (create を await して choices[0].message.content を読む) が v7 の形と同じであることも、ここで本物の SDK の返り値で確かめる。
 */
import fs from 'node:fs';
import path from 'node:path';

import OpenAI from 'openai';
import { VERSION } from 'openai/version';
import { afterEach, describe, expect, it, vi } from 'vitest';

// getOptionalEnv の警告 (src/lib/env.ts が動的に読む db-logger) は DB に書かない
vi.mock('@/lib/db-logger', () => {
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), withUser: () => logger };
  return { createLogger: () => logger, generateRequestId: () => 'req_test' };
});

/** 取り込んだ SDK の大きな版。上げ直すときは #1902 と同じ確認 (破壊的な変更 × このリポジトリの使い方) をしてから変える */
const EXPECTED_OPENAI_MAJOR = 7;
/** src/lib/ai/fast-llm.ts がクライアントに渡している既定のタイムアウト (#1047 F2-15) */
const FAST_LLM_CLIENT_TIMEOUT_MS = 25_000;
/** src/lib/ai/fast-llm.ts がクライアントに渡しているリトライの回数 (#1047 F2-15) */
const FAST_LLM_CLIENT_MAX_RETRIES = 1;
/** xAI のベース URL (fast-llm.ts の DEFAULT_XAI_BASE_URL) */
const DEFAULT_XAI_BASE_URL = 'https://api.x.ai/v1';
/** テストのベース URL (本物の API に届かない名前) */
const TEST_BASE_URL = 'https://llm.example.test/v1';
/** テストの API キー (本物のキーではない) */
const TEST_API_KEY = 'test-key-not-real';
/** リトライの待ちを短くするため、5xx の応答に付ける retry-after-ms (SDK はこの値だけ待って再送する) */
const RETRY_AFTER_MS_FOR_TEST = '1';
/** 時間切れを確かめるときのクライアントのタイムアウト (fetch は中断されるまで返さないので、この時間で必ず切れる) */
const SHORT_TIMEOUT_MS = 50;

const HTTP_OK = 200;
const HTTP_BAD_REQUEST = 400;
const HTTP_INTERNAL_SERVER_ERROR = 500;

type RecordedCall = { url: string; method: string; body: unknown; authorization: string | null };

function completionBody(content: string) {
  return {
    id: 'chatcmpl-test',
    object: 'chat.completion',
    created: 0,
    model: 'test-model',
    choices: [{ index: 0, finish_reason: 'stop', logprobs: null, message: { role: 'assistant', content, refusal: null } }],
  };
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

/** 応答を順に返す fetch。呼ばれた URL・メソッド・ボディ・Authorization を記録する */
function scriptedFetch(responses: Array<() => Response>) {
  const calls: RecordedCall[] = [];
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const rawBody = typeof init?.body === 'string' ? init.body : null;
    calls.push({
      url,
      method: String(init?.method ?? 'GET'),
      body: rawBody === null ? null : JSON.parse(rawBody),
      authorization: new Headers(init?.headers).get('authorization'),
    });
    const next = responses[calls.length - 1];
    if (!next) throw new Error(`想定より多く呼ばれた (${calls.length} 回目)`);
    return next();
  };
  return { calls, fetchImpl };
}

function testClient(fetchImpl: typeof fetch, overrides: { timeout?: number; maxRetries?: number } = {}) {
  return new OpenAI({
    apiKey: TEST_API_KEY,
    baseURL: TEST_BASE_URL,
    timeout: overrides.timeout ?? FAST_LLM_CLIENT_TIMEOUT_MS,
    maxRetries: overrides.maxRetries ?? FAST_LLM_CLIENT_MAX_RETRIES,
    fetch: fetchImpl,
  });
}

/** route と同じ形のボディ (system + user・max_completion_tokens・response_format json_object) */
const ROUTE_LIKE_PARAMS = {
  model: 'test-model',
  messages: [
    { role: 'system', content: 'JSONのみを出力してください。' },
    { role: 'user', content: '要約して' },
  ],
  max_completion_tokens: 1500,
  response_format: { type: 'json_object' },
} satisfies OpenAI.Chat.ChatCompletionCreateParamsNonStreaming;

describe('取り込んだ openai の版 (#1902)', () => {
  it(`node_modules の openai は ${EXPECTED_OPENAI_MAJOR}.x で、package.json と package-lock.json が同じ版を指す`, () => {
    expect(Number(VERSION.split('.')[0])).toBe(EXPECTED_OPENAI_MAJOR);

    const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    const lock = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package-lock.json'), 'utf8')) as {
      packages: Record<string, { version?: string; dependencies?: Record<string, string> }>;
    };
    expect(pkg.dependencies.openai).toBe(`^${VERSION}`);
    expect(lock.packages[''].dependencies?.openai).toBe(`^${VERSION}`);
    expect(lock.packages['node_modules/openai'].version).toBe(VERSION);
  });
});

describe('getFastLLMClient() の設定は版を上げても同じ (#1047 F2-15)', () => {
  const originalKey = process.env.XAI_API_KEY;
  const originalBaseUrl = process.env.XAI_BASE_URL;

  afterEach(() => {
    if (originalKey === undefined) delete process.env.XAI_API_KEY;
    else process.env.XAI_API_KEY = originalKey;
    if (originalBaseUrl === undefined) delete process.env.XAI_BASE_URL;
    else process.env.XAI_BASE_URL = originalBaseUrl;
  });

  it('タイムアウト 25 秒・リトライ 1 回・ベース URL は xAI の /v1', async () => {
    process.env.XAI_API_KEY = TEST_API_KEY;
    delete process.env.XAI_BASE_URL;
    vi.resetModules();
    const { getFastLLMClient } = await import('../src/lib/ai/fast-llm');

    const client = getFastLLMClient();
    expect(client).toBeInstanceOf(OpenAI);
    expect(client.timeout).toBe(FAST_LLM_CLIENT_TIMEOUT_MS);
    expect(client.maxRetries).toBe(FAST_LLM_CLIENT_MAX_RETRIES);
    expect(client.baseURL).toBe(DEFAULT_XAI_BASE_URL);
  });
});

describe('chat.completions.create の送る内容と返り値 (v7)', () => {
  it('POST <baseURL>/chat/completions に、渡したボディをそのまま送る。signal はボディに入らない', async () => {
    const { calls, fetchImpl } = scriptedFetch([() => jsonResponse(HTTP_OK, completionBody('{"summary":"ok"}'))]);
    const client = testClient(fetchImpl);

    const completion = await client.chat.completions.create(ROUTE_LIKE_PARAMS, {
      signal: new AbortController().signal,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${TEST_BASE_URL}/chat/completions`);
    expect(calls[0].method).toBe('POST');
    expect(calls[0].authorization).toBe(`Bearer ${TEST_API_KEY}`);
    expect(calls[0].body).toEqual(ROUTE_LIKE_PARAMS);
    // route とモックが読む形: choices[0].message.content
    expect(completion.choices[0]?.message?.content).toBe('{"summary":"ok"}');
  });
});

describe('リトライとエラーの扱い (v7)', () => {
  it('5xx は設定の回数 (1 回) だけ再送し、それでも失敗なら status つきの APIError を投げる', async () => {
    const serverError = () =>
      jsonResponse(HTTP_INTERNAL_SERVER_ERROR, { error: { message: 'boom' } }, { 'retry-after-ms': RETRY_AFTER_MS_FOR_TEST });
    const { calls, fetchImpl } = scriptedFetch([serverError, serverError]);
    const client = testClient(fetchImpl);

    const error = await client.chat.completions.create(ROUTE_LIKE_PARAMS).then(
      () => null,
      (e: unknown) => e,
    );

    expect(calls).toHaveLength(FAST_LLM_CLIENT_MAX_RETRIES + 1);
    expect(calls[1].body).toEqual(ROUTE_LIKE_PARAMS);
    expect(error).toBeInstanceOf(OpenAI.InternalServerError);
    expect(error).toBeInstanceOf(OpenAI.APIError);
    expect((error as InstanceType<typeof OpenAI.APIError>).status).toBe(HTTP_INTERNAL_SERVER_ERROR);
  });

  it('5xx のあとに成功すれば、その結果を返す', async () => {
    const { calls, fetchImpl } = scriptedFetch([
      () => jsonResponse(HTTP_INTERNAL_SERVER_ERROR, { error: { message: 'boom' } }, { 'retry-after-ms': RETRY_AFTER_MS_FOR_TEST }),
      () => jsonResponse(HTTP_OK, completionBody('retried')),
    ]);
    const client = testClient(fetchImpl);

    const completion = await client.chat.completions.create(ROUTE_LIKE_PARAMS);

    expect(calls).toHaveLength(2);
    expect(completion.choices[0]?.message?.content).toBe('retried');
  });

  it('4xx は再送せず、status つきの BadRequestError を投げる', async () => {
    const { calls, fetchImpl } = scriptedFetch([() => jsonResponse(HTTP_BAD_REQUEST, { error: { message: 'bad' } })]);
    const client = testClient(fetchImpl);

    const error = await client.chat.completions.create(ROUTE_LIKE_PARAMS).then(
      () => null,
      (e: unknown) => e,
    );

    expect(calls).toHaveLength(1);
    expect(error).toBeInstanceOf(OpenAI.BadRequestError);
    expect((error as InstanceType<typeof OpenAI.APIError>).status).toBe(HTTP_BAD_REQUEST);
  });

  it('呼び出し側の signal が先に中断されていれば、送らずに APIUserAbortError を投げる', async () => {
    const { calls, fetchImpl } = scriptedFetch([() => jsonResponse(HTTP_OK, completionBody('unused'))]);
    const client = testClient(fetchImpl);
    const controller = new AbortController();
    controller.abort();

    const error = await client.chat.completions.create(ROUTE_LIKE_PARAMS, { signal: controller.signal }).then(
      () => null,
      (e: unknown) => e,
    );

    expect(calls).toHaveLength(0);
    expect(error).toBeInstanceOf(OpenAI.APIUserAbortError);
  });

  it('クライアントのタイムアウトで切れたら APIConnectionTimeoutError を投げる (リトライ 0 回のとき 1 回だけ送る)', async () => {
    let fetchCount = 0;
    const hangingFetch = (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      fetchCount += 1;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
      });
    };
    const client = testClient(hangingFetch, { timeout: SHORT_TIMEOUT_MS, maxRetries: 0 });

    const error = await client.chat.completions.create(ROUTE_LIKE_PARAMS).then(
      () => null,
      (e: unknown) => e,
    );

    expect(fetchCount).toBe(1);
    expect(error).toBeInstanceOf(OpenAI.APIConnectionTimeoutError);
  });
});
