/**
 * ai-chat.test.ts
 * src/lib/aiChat.ts のテスト (#1049 F7-18)
 *
 * 共通 API クライアント (packages/core) のエラーは name で見分けているので、
 * 本物のエラークラスを使って、名前が変わっても気付けるようにしておく。
 */

import { HttpError, HttpNetworkError, HttpParseError, HttpTimeoutError } from '@homegohan/core';

import {
  AI_CHAT_TIMEOUT_MESSAGE,
  AI_CHAT_TIMEOUT_MS,
  hasReplyAfterSend,
  isTimeoutFailure,
  isUncertainSendFailure,
} from '../../src/lib/aiChat';

function domAbortError(): Error {
  const error = new Error('The operation was aborted.');
  error.name = 'AbortError';
  return error;
}

describe('isUncertainSendFailure / isTimeoutFailure', () => {
  it('タイムアウト (HttpTimeoutError) は「届いたか分からない」失敗で、時間切れでもある', () => {
    const error = new HttpTimeoutError(75_000, 'POST', '/api/x');
    expect(isUncertainSendFailure(error)).toBe(true);
    expect(isTimeoutFailure(error)).toBe(true);
  });

  it('通信の切断 (HttpNetworkError) は「届いたか分からない」失敗だが、時間切れではない', () => {
    const error = new HttpNetworkError(new TypeError('Network request failed'));
    expect(isUncertainSendFailure(error)).toBe(true);
    expect(isTimeoutFailure(error)).toBe(false);
  });

  it('呼び出し側の中断 (AbortError) も「届いたか分からない」失敗で、時間切れ扱い', () => {
    expect(isUncertainSendFailure(domAbortError())).toBe(true);
    expect(isTimeoutFailure(domAbortError())).toBe(true);
  });

  it('HTTP のエラー応答 (HttpError) は、サーバーが処理しなかったと分かるので対象外', () => {
    const error = new HttpError({
      status: 429,
      statusText: 'Too Many Requests',
      body: '{"error":"rate limited"}',
      message: 'HTTP 429 Too Many Requests',
    });
    expect(isUncertainSendFailure(error)).toBe(false);
    expect(isTimeoutFailure(error)).toBe(false);
  });

  it('JSON でない 2xx (HttpParseError) や普通のエラー、エラーでない値は対象外', () => {
    expect(isUncertainSendFailure(new HttpParseError({ status: 200, statusText: 'OK', body: '<html>' }))).toBe(false);
    expect(isUncertainSendFailure(new Error('boom'))).toBe(false);
    expect(isUncertainSendFailure(null)).toBe(false);
    expect(isUncertainSendFailure(undefined)).toBe(false);
    expect(isUncertainSendFailure('TimeoutError')).toBe(false);
    expect(isTimeoutFailure(null)).toBe(false);
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

describe('定数', () => {
  it('タイムアウトはサーバーの最悪ケース (AI 25 秒 + 再度 25 秒 + 重要度判定 5 秒) より長い', () => {
    expect(AI_CHAT_TIMEOUT_MS).toBeGreaterThan(25_000 + 25_000 + 5_000);
  });

  it('タイムアウトの文言は秒数を書かない (2 つの画面で同じ文言を使う)', () => {
    expect(AI_CHAT_TIMEOUT_MESSAGE).toContain('タイムアウト');
    expect(AI_CHAT_TIMEOUT_MESSAGE).not.toMatch(/\d+\s*秒/);
  });
});
