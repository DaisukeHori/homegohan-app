/**
 * ai-chat.test.ts
 * src/lib/aiChat.ts のテスト (#1049 F7-18)
 *
 * 共通 API クライアント (packages/core) のエラーは isHttpNetworkError() / kind で見分けているので、
 * モックではなく本物のエラークラス・本物のクライアントを使って、仕様が変わったときに気付けるようにしておく。
 */

import { createHttpClient, HttpNetworkError, HttpParseError } from '@homegohan/core';

import {
  AI_CHAT_TIMEOUT_MESSAGE,
  AI_CHAT_TIMEOUT_MS,
  countPersistedMessages,
  hasReplyAfterSend,
  isLocalOnlyMessage,
  isTimeoutFailure,
  isUncertainSendFailure,
} from '../../src/lib/aiChat';

function domAbortError(): Error {
  const error = new Error('The operation was aborted.');
  error.name = 'AbortError';
  return error;
}

describe('isUncertainSendFailure / isTimeoutFailure', () => {
  it('待ち時間切れ (HttpNetworkError の kind: timeout) は「届いたか分からない」失敗で、時間切れでもある', () => {
    const error = new HttpNetworkError('timeout', 'Request timed out after 75000ms', { timeoutMs: 75_000 });
    expect(isUncertainSendFailure(error)).toBe(true);
    expect(isTimeoutFailure(error)).toBe(true);
  });

  it('通信の切断 (HttpNetworkError の kind: offline) は「届いたか分からない」失敗だが、時間切れではない', () => {
    const error = new HttpNetworkError('offline', 'Network request failed', { cause: new TypeError('Network request failed') });
    expect(isUncertainSendFailure(error)).toBe(true);
    expect(isTimeoutFailure(error)).toBe(false);
  });

  it('呼び出し側の中断 (AbortError) も「届いたか分からない」失敗で、時間切れ扱い', () => {
    expect(isUncertainSendFailure(domAbortError())).toBe(true);
    expect(isTimeoutFailure(domAbortError())).toBe(true);
  });

  it('HTTP のエラー応答 (429 など) は、サーバーが処理しなかったと分かるので対象外', () => {
    const error = new Error('HTTP 429 Too Many Requests: {"error":"rate limited"}');
    expect(isUncertainSendFailure(error)).toBe(false);
    expect(isTimeoutFailure(error)).toBe(false);
  });

  it('成功なのに JSON でない応答 (HttpParseError) は、サーバーが処理を終えたか分からない失敗だが、時間切れではない', () => {
    const error = new HttpParseError('x', { status: 200 });
    expect(isUncertainSendFailure(error)).toBe(true);
    expect(isTimeoutFailure(error)).toBe(false);
  });

  it('普通のエラー、エラーでない値は対象外', () => {
    expect(isUncertainSendFailure(new Error('boom'))).toBe(false);
    expect(isUncertainSendFailure(null)).toBe(false);
    expect(isUncertainSendFailure(undefined)).toBe(false);
    expect(isUncertainSendFailure('TimeoutError')).toBe(false);
    expect(isTimeoutFailure(null)).toBe(false);
  });
});

describe('isUncertainSendFailure / isTimeoutFailure — 本物の共通クライアントが投げるエラー', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
    try {
      await promise;
    } catch (e) {
      return e;
    }
    throw new Error('rejected されませんでした');
  }

  function respondWith(status: number, statusText: string, body: string) {
    global.fetch = jest.fn().mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      statusText,
      text: async () => body,
    }) as unknown as typeof fetch;
  }

  const client = (timeoutMs?: number) => createHttpClient({ baseUrl: 'https://api.example.com', retry: false, timeoutMs });

  it('待ち時間を過ぎたら、届いたか分からない失敗かつ時間切れ', async () => {
    // abort されたら AbortError で失敗する、本物の fetch と同じ動きの fetch (応答は返さない)
    global.fetch = jest.fn((_url: string, init?: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(domAbortError()));
      });
    }) as unknown as typeof fetch;

    const error = await rejectionOf(client(20).post('/api/ai/consultation/sessions/s1/messages', { message: 'こんにちは' }));

    expect(isUncertainSendFailure(error)).toBe(true);
    expect(isTimeoutFailure(error)).toBe(true);
  });

  it('通信が切れたら、届いたか分からない失敗だが時間切れではない', async () => {
    global.fetch = jest.fn().mockRejectedValue(new TypeError('Network request failed')) as unknown as typeof fetch;

    const error = await rejectionOf(client().post('/api/ai/consultation/sessions/s1/messages', { message: 'こんにちは' }));

    expect(isUncertainSendFailure(error)).toBe(true);
    expect(isTimeoutFailure(error)).toBe(false);
  });

  it('レート制限 (429) のようなエラー応答は、どちらでもない (サーバーが受け取って断った)', async () => {
    respondWith(429, 'Too Many Requests', JSON.stringify({ error: 'リクエストが多すぎます。' }));

    const error = await rejectionOf(client().post('/api/ai/consultation/sessions/s1/messages', { message: 'こんにちは' }));

    expect(isUncertainSendFailure(error)).toBe(false);
    expect(isTimeoutFailure(error)).toBe(false);
  });

  it('200 なのに JSON でない応答 (HttpParseError) は、届いたか分からない失敗だが、時間切れではない', async () => {
    respondWith(200, 'OK', '<html>Wi-Fi ログイン</html>');

    const error = await rejectionOf(client().post('/api/ai/consultation/sessions/s1/messages', { message: 'こんにちは' }));

    expect(error).toBeInstanceOf(HttpParseError);
    expect(isUncertainSendFailure(error)).toBe(true);
    expect(isTimeoutFailure(error)).toBe(false);
  });
});

describe('hasReplyAfterSend', () => {
  const user = { role: 'user' };
  const assistant = { role: 'assistant' };

  it('送信前より 2 件以上増えていて、最後が AI の返信なら true', () => {
    expect(hasReplyAfterSend([user, assistant, user, assistant], 2)).toBe(true);
    // 送信前が 0 件 (新しいセッション)
    expect(hasReplyAfterSend([user, assistant], 0)).toBe(true);
  });

  it('ユーザーのメッセージだけ保存されていて返信が無ければ false', () => {
    expect(hasReplyAfterSend([user, assistant, user], 2)).toBe(false);
  });

  it('何も増えていなければ false (以前に同じ文面のやり取りがあっても取り違えない)', () => {
    expect(hasReplyAfterSend([user, assistant], 2)).toBe(false);
    expect(hasReplyAfterSend([], 0)).toBe(false);
  });

  it('件数が増えていても最後が AI の返信でなければ false', () => {
    expect(hasReplyAfterSend([user, assistant, assistant, user], 2)).toBe(false);
  });
});

describe('isLocalOnlyMessage / countPersistedMessages', () => {
  it('ウェルカム・送信中の仮メッセージ・要約の表示は、画面だけのメッセージ', () => {
    expect(isLocalOnlyMessage({ id: 'welcome' })).toBe(true);
    expect(isLocalOnlyMessage({ id: 'local-1767225600000' })).toBe(true);
    expect(isLocalOnlyMessage({ id: 'summary-1767225600000' })).toBe(true);
  });

  it('サーバーが付けた id (UUID) のメッセージは、画面だけのメッセージではない', () => {
    expect(isLocalOnlyMessage({ id: '3f2b6c1e-7a52-4c1a-9d0e-5b8f0a1c2d3e' })).toBe(false);
    expect(isLocalOnlyMessage({ id: 'm-1' })).toBe(false);
  });

  it('返信の id が応答に無いときに付ける ai-… は、サーバーに保存済みの返信なので、画面だけのメッセージに含めない', () => {
    expect(isLocalOnlyMessage({ id: 'ai-1767225600000' })).toBe(false);
  });

  it('送信前に確定していたメッセージだけを数える', () => {
    const messages = [
      { id: 'welcome' },
      { id: 'm-1' },
      { id: 'm-2' },
      { id: 'summary-1767225600000' },
      { id: 'local-1767225600001' },
      { id: 'ai-1767225600002' },
    ];

    // m-1, m-2 と ai-…
    expect(countPersistedMessages(messages)).toBe(3);
    expect(countPersistedMessages([])).toBe(0);
    expect(countPersistedMessages([{ id: 'welcome' }])).toBe(0);
  });

  it('要約を数えると、届いている返信を「届いていない」と取り違える (要約を数えない)', () => {
    const screenMessages = [{ id: 'm-1' }, { id: 'm-2' }, { id: 'summary-1767225600000' }];
    const serverHistory = [
      { id: 'm-1', role: 'user' },
      { id: 'm-2', role: 'assistant' },
      { id: 'm-3', role: 'user' },
      { id: 'm-4', role: 'assistant' },
    ];

    expect(hasReplyAfterSend(serverHistory, countPersistedMessages(screenMessages))).toBe(true);
    // 参考: 画面の全件 (要約を含む) を数えると、3 + 2 = 5 件に届かず false になる
    expect(hasReplyAfterSend(serverHistory, screenMessages.length)).toBe(false);
  });
});

describe('定数', () => {
  it('タイムアウトはサーバーの最悪ケース (AI 25 秒 + 再度 25 秒 + 重要度判定 5 秒) より長い', () => {
    expect(AI_CHAT_TIMEOUT_MS).toBeGreaterThan(25_000 + 25_000 + 5_000);
  });

  it('タイムアウトの文言は秒数を書かない (2 つの画面で同じ文言を使う)', () => {
    expect(AI_CHAT_TIMEOUT_MESSAGE).toContain('タイムアウト');
    expect(AI_CHAT_TIMEOUT_MESSAGE).not.toMatch(/\d+\s*秒/);
  });
});
