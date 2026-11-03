/**
 * #2201 U3 応答を受け取れずに取り直した会話で、前の依頼の自動実行を見分ける決まり (packages/shared/src/consultation-reply-reload.ts)。
 * Web (src/components/AIChatBubble.tsx) とモバイル (apps/mobile/src/components/ai/AIAdvisorSheet.tsx) が共有する。
 *   1. 見分ける状態の値は、サーバーが行に書く値 (src/lib/ai/consultation-action-lifecycle.ts) と同じ
 *   2. 実行できた行があれば executed、実行中の印 (approved) の行があれば running、実行を待つ・失敗した行だけなら notExecuted
 *      (#2206 G2)、それ以外・読めないなら none
 *   3. 一文と id は状態で決まる (実行中の一文は、読み直して分かったらその状態の一文の id に置き換える)。
 *      実行中の一文は『実行済み』と読めない文 (#2206 G2)
 *   5. 送った文は、送る前に無かった id の一致のうちいちばん後ろ (同じ文を送り直したとき、前の送信と取り違えない。#2206 G2)
 *   4. モバイルの既存の名前は共有の決まりを読み直すだけ (文と値が Web と同じ)
 */
import { describe, expect, it } from 'vitest';

import {
  PREVIOUS_REQUEST_ACTION_LOG_STATUS,
  PREVIOUS_REQUEST_EXECUTED_MESSAGE,
  PREVIOUS_REQUEST_RECHECK_DELAY_MS,
  PREVIOUS_REQUEST_NOT_EXECUTED_MESSAGE,
  PREVIOUS_REQUEST_UNCONFIRMED_MESSAGE,
  previousRequestActionStateOf,
  previousRequestNoteIdOf,
  previousRequestNoteTextOf,
  replyToSentMessageOf,
  replyToUserMessageIdOf,
  sentMessageIndexOf,
  sentMessageReloadOutcomeOf,
} from '@homegohan/shared';
import { AI_ACTION_LOG_STATUS } from '@/lib/ai/consultation-action-lifecycle';

import * as mobileTimeout from '../apps/mobile/src/lib/ai-chat-timeout';

/** 手で書いた期待値 (定数の文が変わったらこのテストも直す) */
const EXECUTED_TEXT = '前の依頼は実行されました';
const RUNNING_TEXT = '前の依頼の結果をまだ確かめられません。しばらくしてから相談を開き直してください。';
const NOT_EXECUTED_TEXT = '前の依頼は実行できませんでした';

describe('#2201 U3 見分ける状態の値はサーバーの値と同じ', () => {
  it('executed・running・pending・failed はサーバーの AI_ACTION_LOG_STATUS と同じ', () => {
    expect(PREVIOUS_REQUEST_ACTION_LOG_STATUS.executed).toBe(AI_ACTION_LOG_STATUS.executed);
    expect(PREVIOUS_REQUEST_ACTION_LOG_STATUS.running).toBe(AI_ACTION_LOG_STATUS.running);
    expect(PREVIOUS_REQUEST_ACTION_LOG_STATUS.pending).toBe(AI_ACTION_LOG_STATUS.pending);
    expect(PREVIOUS_REQUEST_ACTION_LOG_STATUS.failed).toBe(AI_ACTION_LOG_STATUS.failed);
  });
});

describe('#2201 U3 previousRequestActionStateOf', () => {
  it.each([
    [[{ status: 'executed' }], 'executed'],
    [[{ status: 'approved' }, { status: 'executed' }], 'executed'],
    [[{ status: 'approved' }], 'running'],
    [[{ status: 'failed' }, { status: 'approved' }], 'running'],
    [[{ status: 'pending' }], 'notExecuted'],
    [[{ status: 'failed' }], 'notExecuted'],
    [[{ status: 'pending' }, { status: 'executed' }], 'executed'],
    [[{ status: 'rejected' }], 'none'],
    [[], 'none'],
    [null, 'none'],
    [undefined, 'none'],
    ['executed', 'none'],
    [[null, 1, 'executed', { state: 'executed' }], 'none'],
  ] as const)('%j → %s', (rows, expected) => {
    expect(previousRequestActionStateOf(rows)).toBe(expected);
  });

  it('サーバーの状態のうち executed は executed、approved は running、pending・failed は notExecuted、rejected は none になる', () => {
    const expectedOf: Record<string, string> = {
      [AI_ACTION_LOG_STATUS.executed]: 'executed',
      [AI_ACTION_LOG_STATUS.running]: 'running',
      [AI_ACTION_LOG_STATUS.pending]: 'notExecuted',
      [AI_ACTION_LOG_STATUS.failed]: 'notExecuted',
      [AI_ACTION_LOG_STATUS.rejected]: 'none',
    };
    for (const status of Object.values(AI_ACTION_LOG_STATUS)) {
      expect(previousRequestActionStateOf([{ status }]), status).toBe(expectedOf[status]);
    }
  });
});

describe('#2201 U3 送った文と返答の見分け', () => {
  const sent = { text: '1食作って', knownMessageIds: ['m1', 'm2'] };
  const old = [
    { id: 'm1', role: 'user', content: '1食作って' },
    { id: 'm2', role: 'assistant', content: '前の返答' },
  ];

  it('送る前に無かった id の user のメッセージで、本文が送った文と同じものが送った文', () => {
    expect(sentMessageIndexOf(sent, old)).toBe(-1);
    expect(sentMessageIndexOf(sent, [...old, { id: 'm3', role: 'user', content: '  1食作って ' }])).toBe(old.length);
  });

  it('返答は送った文のすぐ後ろの assistant。別の user のメッセージを挟んだら返答と見なさない', () => {
    const reply = { id: 'm4', role: 'assistant', content: '作りますね' };
    expect(replyToSentMessageOf(sent, [...old, { id: 'm3', role: 'user', content: '1食作って' }, reply])).toBe(reply);
    expect(replyToSentMessageOf(sent, [...old, { id: 'm3', role: 'user', content: '1食作って' }])).toBeNull();
    expect(
      replyToSentMessageOf(sent, [
        ...old,
        { id: 'm3', role: 'user', content: '1食作って' },
        { id: 'm5', role: 'user', content: '別の依頼' },
        reply,
      ]),
    ).toBeNull();
    expect(replyToSentMessageOf(sent, old)).toBeNull();
  });

  it('同じ文を送り直したとき (前の送信の保存行の id を画面が知らない)、いちばん後ろの一致を今回の送信と見なす (#2206 G2)', () => {
    // 前の送信は時間切れで会話を取り直せず、画面には保存行の id が無い (送る前に無かった id に入る)
    const earlierSend = [
      { id: 'm3', role: 'user', content: '1食作って' },
      { id: 'm4', role: 'assistant', content: '前の返答' },
    ];
    const thisSend = { id: 'm5', role: 'user', content: '1食作って' };
    const thisReply = { id: 'm6', role: 'assistant', content: '今回の返答' };
    const loaded = [...old, ...earlierSend, thisSend, thisReply];

    expect(sentMessageIndexOf(sent, loaded)).toBe(loaded.indexOf(thisSend));
    expect(replyToSentMessageOf(sent, loaded)).toBe(thisReply);
    // 今回の返答がまだ無い: 前の送信の返答を今回の返答と見なさない
    expect(replyToSentMessageOf(sent, [...old, ...earlierSend, thisSend])).toBeNull();
    expect(sentMessageReloadOutcomeOf(sent, [...old, ...earlierSend, thisSend])).toBe('delivered-no-reply');
  });

  it('replyToUserMessageIdOf: 保存行の id のすぐ後ろの assistant。同じ文を後から送り直しても、後の送信の返答と取り違えない (#2206 G2)', () => {
    // 前の送信 (m3) は届いているが返答がまだ無いと分かったあと、待つ間に同じ文 (m5) を送り直し、両方の返答が保存された
    const earlierUser = { id: 'm3', role: 'user', content: '1食作って' };
    const earlierReply = { id: 'm4', role: 'assistant', content: '前の返答' };
    const laterUser = { id: 'm5', role: 'user', content: '1食作って' };
    const laterReply = { id: 'm6', role: 'assistant', content: '後の返答' };
    const loaded = [...old, earlierUser, earlierReply, laterUser, laterReply];

    expect(replyToUserMessageIdOf('m3', loaded)).toBe(earlierReply);
    expect(replyToUserMessageIdOf('m5', loaded)).toBe(laterReply);
    // 本文の一致 (いちばん後ろ) で探すと後の送信の返答になる (前の送信の読み直しでは使わない)
    expect(replyToSentMessageOf(sent, loaded)).toBe(laterReply);
    // 前の送信の返答がまだ無く、後の送信が続く: 後の送信の返答を前の送信の返答と見なさない
    expect(replyToUserMessageIdOf('m3', [...old, earlierUser, laterUser, laterReply])).toBeNull();
    // 保存行が無い・返答がまだ無い・id が assistant のもの
    expect(replyToUserMessageIdOf('m9', loaded)).toBeNull();
    expect(replyToUserMessageIdOf('m3', [...old, earlierUser])).toBeNull();
    expect(replyToUserMessageIdOf('m4', loaded)).toBeNull();
  });

  it('sentMessageReloadOutcomeOf: 届いていない・届いて返答がまだ無い・返答がある', () => {
    const user = { id: 'm3', role: 'user', content: '1食作って' };
    const reply = { id: 'm4', role: 'assistant', content: '作りますね' };
    expect(sentMessageReloadOutcomeOf(sent, old)).toBe('not-delivered');
    expect(sentMessageReloadOutcomeOf(sent, [...old, user])).toBe('delivered-no-reply');
    expect(sentMessageReloadOutcomeOf(sent, [...old, user, reply])).toBe('replied');
    // 返答の前に別の user のメッセージを挟んだら、返答と見なさない (replyToSentMessageOf と同じ)
    expect(sentMessageReloadOutcomeOf(sent, [...old, user, { id: 'm5', role: 'user', content: '別の依頼' }, reply])).toBe(
      'delivered-no-reply',
    );
  });
});

describe('#2201 U3 足す一文', () => {
  it('文は状態で決まる (実行中の文・実行していない文は頼み直しを勧めない)', () => {
    expect(PREVIOUS_REQUEST_EXECUTED_MESSAGE).toBe(EXECUTED_TEXT);
    expect(PREVIOUS_REQUEST_UNCONFIRMED_MESSAGE).toBe(RUNNING_TEXT);
    expect(PREVIOUS_REQUEST_NOT_EXECUTED_MESSAGE).toBe(NOT_EXECUTED_TEXT);
    expect(previousRequestNoteTextOf('executed')).toBe(EXECUTED_TEXT);
    expect(previousRequestNoteTextOf('running')).toBe(RUNNING_TEXT);
    expect(previousRequestNoteTextOf('notExecuted')).toBe(NOT_EXECUTED_TEXT);
    for (const note of [RUNNING_TEXT, NOT_EXECUTED_TEXT]) {
      expect(note).not.toContain('頼んで');
      expect(note).not.toContain('もう一度');
    }
  });

  it('実行中の印の一文は『実行済み』と読めない (失敗・今日の上限で実行しなかった場合もある。#2206 G2)', () => {
    expect(RUNNING_TEXT).not.toContain('実行済み');
    expect(RUNNING_TEXT).not.toContain('実行されました');
  });

  it('id は状態ごとに違い、実行できた・実行していないの id は自動実行の結果の一文と同じ形 (同じ返答の結果は 1 つ)', () => {
    expect(previousRequestNoteIdOf('executed', 'r1')).toBe('action-result-r1');
    expect(previousRequestNoteIdOf('running', 'r1')).toBe('action-running-r1');
    expect(previousRequestNoteIdOf('notExecuted', 'r1')).toBe('action-failed-r1');
  });

  it('読み直しの待ちは正の有限の値', () => {
    expect(Number.isFinite(PREVIOUS_REQUEST_RECHECK_DELAY_MS)).toBe(true);
    expect(PREVIOUS_REQUEST_RECHECK_DELAY_MS).toBeGreaterThan(0);
  });
});

describe('#2201 U3 モバイルの既存の名前は共有の決まりと同じ', () => {
  it('文・値・関数が共有のもの', () => {
    expect(mobileTimeout.PREVIOUS_REQUEST_EXECUTED_MESSAGE).toBe(PREVIOUS_REQUEST_EXECUTED_MESSAGE);
    expect(mobileTimeout.PREVIOUS_REQUEST_UNCONFIRMED_MESSAGE).toBe(PREVIOUS_REQUEST_UNCONFIRMED_MESSAGE);
    expect(mobileTimeout.PREVIOUS_REQUEST_NOT_EXECUTED_MESSAGE).toBe(PREVIOUS_REQUEST_NOT_EXECUTED_MESSAGE);
    expect(mobileTimeout.PREVIOUS_REQUEST_RECHECK_DELAY_MS).toBe(PREVIOUS_REQUEST_RECHECK_DELAY_MS);
    expect(mobileTimeout.AI_ACTION_LOG_STATUS_EXECUTED).toBe(PREVIOUS_REQUEST_ACTION_LOG_STATUS.executed);
    expect(mobileTimeout.replyToSentMessageOf).toBe(replyToSentMessageOf);
    expect(mobileTimeout.previousRequestActionStateOf).toBe(previousRequestActionStateOf);
  });

  it('hasExecutedActionLog は実行できた行があるときだけ真 (実行中の印だけでは真にしない)', () => {
    expect(mobileTimeout.hasExecutedActionLog([{ status: 'executed' }])).toBe(true);
    expect(mobileTimeout.hasExecutedActionLog([{ status: 'approved' }])).toBe(false);
    expect(mobileTimeout.hasExecutedActionLog(null)).toBe(false);
  });
});
