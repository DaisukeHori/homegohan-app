/**
 * #2227 H1 AI 相談の取り直しの共有の決まり (packages/shared/src/consultation-reply-reload.ts) の追加分。
 *   1. 取り直しの上限と失敗の文は Web とモバイルで同じ値 (以前はモバイルの取り直しの GET が 120 秒待った)
 *   2. settleWithin は上限までに終わらなければ fallback で終える (記録の直読みの上限)
 *   3. 入力欄の戻し方・消し方は Web とモバイルで同じ決まり (Web は届いていたと分かっても消さなかった)
 *   4. resolveUnconfirmedSends: 確かめられなかった前の送信の保存行を、今回の送信と取り違えない
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CONSULTATION_REPLY_FAILED_MESSAGE,
  CONSULTATION_REPLY_RELOAD_TIMEOUT_MS,
  clearInputIfDelivered,
  resolveUnconfirmedSends,
  restoreInputAfterUndelivered,
  sentMessageIndexOf,
  settleWithin,
  type ReloadedMessage,
  type UnconfirmedSend,
} from '@homegohan/shared';
import { AI_CHAT_RELOAD_TIMEOUT_MS as WEB_RELOAD_TIMEOUT_MS, AI_CHAT_REPLY_FAILED_MESSAGE } from '@/lib/ai/consultation-reply-reload';

import * as mobileTimeout from '../apps/mobile/src/lib/ai-chat-timeout';

/** 手で書いた期待値 (定数が変わったらこのテストも直す) */
const RELOAD_TIMEOUT_MS = 10_000;
const REPLY_FAILED_TEXT = '応答に失敗しました。再試行してください。';

afterEach(() => {
  vi.useRealTimers();
});

describe('#2227 H1 取り直しの上限と失敗の文は Web とモバイルで同じ', () => {
  it('上限は 10 秒で、Web とモバイルの名前は共有の値', () => {
    expect(CONSULTATION_REPLY_RELOAD_TIMEOUT_MS).toBe(RELOAD_TIMEOUT_MS);
    expect(WEB_RELOAD_TIMEOUT_MS).toBe(CONSULTATION_REPLY_RELOAD_TIMEOUT_MS);
    expect(mobileTimeout.AI_CHAT_RELOAD_TIMEOUT_MS).toBe(CONSULTATION_REPLY_RELOAD_TIMEOUT_MS);
    // 送信の待ち (モバイル 26 秒) より短い (取り直しは送信中に待つ)
    expect(mobileTimeout.AI_CHAT_RELOAD_TIMEOUT_MS).toBeLessThan(mobileTimeout.AI_CHAT_STREAM_TIMEOUT_MS);
  });

  it('失敗の文は Web の以前からの文で、モバイルも同じ文', () => {
    expect(CONSULTATION_REPLY_FAILED_MESSAGE).toBe(REPLY_FAILED_TEXT);
    expect(AI_CHAT_REPLY_FAILED_MESSAGE).toBe(REPLY_FAILED_TEXT);
    expect(mobileTimeout.REPLY_FAILED_MESSAGE).toBe(REPLY_FAILED_TEXT);
  });

  it('入力欄の戻し方・消し方はモバイルの既存の名前も共有の決まり', () => {
    expect(mobileTimeout.restoreInputAfterTimeout('', '送った文')).toBe(restoreInputAfterUndelivered('', '送った文'));
    expect(mobileTimeout.clearInputIfDelivered('送った文', '送った文')).toBe(clearInputIfDelivered('送った文', '送った文'));
    expect(mobileTimeout.resolveUnconfirmedSends).toBe(resolveUnconfirmedSends);
    expect(mobileTimeout.settleWithin).toBe(settleWithin);
  });
});

describe('#2227 H1 settleWithin', () => {
  it('上限までに終われば、その値で終える', async () => {
    await expect(settleWithin(Promise.resolve('読めた'), RELOAD_TIMEOUT_MS, '上限')).resolves.toBe('読めた');
  });

  it('上限までに終わらなければ fallback で終える (1 ms 前はまだ終えない)', async () => {
    vi.useFakeTimers();
    let settledWith: string | null = null;
    void settleWithin(new Promise<string>(() => {}), RELOAD_TIMEOUT_MS, '上限').then((value) => {
      settledWith = value;
    });
    await vi.advanceTimersByTimeAsync(RELOAD_TIMEOUT_MS - 1);
    expect(settledWith).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(settledWith).toBe('上限');
  });

  it('reject はそのまま reject する', async () => {
    await expect(settleWithin(Promise.reject(new Error('失敗')), RELOAD_TIMEOUT_MS, '上限')).rejects.toThrow('失敗');
  });
});

describe('#2227 H1 入力欄の戻し方・消し方', () => {
  it('戻す: 空なら送った文、別の文があれば残す', () => {
    expect(restoreInputAfterUndelivered('', '送った文')).toBe('送った文');
    expect(restoreInputAfterUndelivered('  ', '送った文')).toBe('送った文');
    expect(restoreInputAfterUndelivered('書きかけ', '送った文')).toBe('書きかけ');
  });

  it('消す: 戻した文のまま (前後の空白は見ない) なら消し、書き換えていれば残す', () => {
    expect(clearInputIfDelivered('送った文', '送った文')).toBe('');
    expect(clearInputIfDelivered(' 送った文 ', '送った文')).toBe('');
    expect(clearInputIfDelivered('送った文。追記', '送った文')).toBe('送った文。追記');
    expect(clearInputIfDelivered('', '送った文')).toBe('');
  });
});

describe('#2227 H1 resolveUnconfirmedSends', () => {
  const SESSION = 's1';
  const TEXT = '今夜の夕食を1食作って';
  const old: ReloadedMessage[] = [
    { id: 'u0', role: 'user', content: '夕飯の相談です' },
    { id: 'a0', role: 'assistant', content: '野菜を足しましょう' },
  ];
  const earlier: UnconfirmedSend = { sessionId: SESSION, text: TEXT, knownMessageIds: ['u0'] };
  const current = { text: TEXT, knownMessageIds: ['u0'] };
  const row1: ReloadedMessage = { id: 'u1', role: 'user', content: TEXT };
  const reply1: ReloadedMessage = { id: 'a1', role: 'assistant', content: '前の返答' };
  const row2: ReloadedMessage = { id: 'u2', role: 'user', content: TEXT };
  const reply2: ReloadedMessage = { id: 'a2', role: 'assistant', content: '今回の返答' };

  function resolve(loaded: ReloadedMessage[], params: { accepted?: boolean; claimed?: string[]; unconfirmed?: UnconfirmedSend[] } = {}) {
    return resolveUnconfirmedSends({
      sessionId: SESSION,
      loaded,
      unconfirmed: params.unconfirmed ?? [earlier],
      previousClaimedIds: params.claimed ?? [],
      current,
      currentAccepted: params.accepted ?? false,
    });
  }

  it('前の送信と今回の送信の保存行が両方あれば、前の送信は前の行に当て、今回の送信はいちばん後ろの行になる', () => {
    const loaded = [...old, row1, reply1, row2, reply2];
    const result = resolve(loaded);
    expect(result).toEqual({ resolved: [earlier], remaining: [], claimedIds: ['u1'] });
    expect(loaded[sentMessageIndexOf({ text: TEXT, knownMessageIds: [...current.knownMessageIds, ...result.claimedIds] }, loaded)].id).toBe('u2');
  });

  it('保存行が 1 つで、今回の送信が受け付けられていない: 前の送信に当てる (今回の送信は見つからない)', () => {
    const loaded = [...old, row1, reply1];
    const result = resolve(loaded);
    expect(result.claimedIds).toEqual(['u1']);
    expect(sentMessageIndexOf({ text: TEXT, knownMessageIds: [...current.knownMessageIds, ...result.claimedIds] }, loaded)).toBe(-1);
  });

  it('保存行が 1 つで、今回の送信が受け付けられていた (今回の保存行は必ずある): 前の送信に当てない', () => {
    const loaded = [...old, row2, reply2];
    expect(resolve(loaded, { accepted: true })).toEqual({ resolved: [], remaining: [earlier], claimedIds: [] });
  });

  it('前から当てた行・前の送信の前にあった行・本文の違う行・別の相談の送信は当てない', () => {
    const other: UnconfirmedSend = { sessionId: 's2', text: TEXT, knownMessageIds: [] };
    const loaded = [...old, { id: 'u-other', role: 'user', content: '別の文' }, row1];
    const result = resolve(loaded, { claimed: ['u1'], unconfirmed: [other, earlier] });
    expect(result).toEqual({ resolved: [], remaining: [other, earlier], claimedIds: ['u1'] });
    const withKnown = resolve([...old, row1], { unconfirmed: [{ ...earlier, knownMessageIds: ['u0', 'u1'] }] });
    expect(withKnown.resolved).toEqual([]);
  });

  it('前の送信が 2 つあれば、古い送信から順に前の行に当てる', () => {
    const first: UnconfirmedSend = { ...earlier };
    const second: UnconfirmedSend = { ...earlier, knownMessageIds: ['u0'] };
    const loaded = [...old, row1, reply1, row2, reply2];
    const result = resolve(loaded, { unconfirmed: [first, second], accepted: false });
    expect(result.claimedIds).toEqual(['u1', 'u2']);
    expect(result.resolved).toEqual([first, second]);
  });
});
