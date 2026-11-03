/**
 * #2201 U3 応答を受け取れずに取り直した会話で、前の依頼の自動実行を見分ける決まり (packages/shared/src/consultation-reply-reload.ts)。
 * Web (src/components/AIChatBubble.tsx) とモバイル (apps/mobile/src/components/ai/AIAdvisorSheet.tsx) が共有する。
 *   1. 見分ける状態の値は、サーバーが行に書く値 (src/lib/ai/consultation-action-lifecycle.ts) と同じ
 *   2. 実行できた行があれば executed、実行中の印 (approved) の行だけなら running、それ以外・読めないなら none
 *   3. 一文と id は状態で決まる (実行中の一文は、実行できたと分かったら実行できたの一文の id に置き換える)
 *   4. モバイルの既存の名前は共有の決まりを読み直すだけ (文と値が Web と同じ)
 */
import { describe, expect, it } from 'vitest';

import {
  PREVIOUS_REQUEST_ACTION_LOG_STATUS,
  PREVIOUS_REQUEST_EXECUTED_MESSAGE,
  PREVIOUS_REQUEST_RECHECK_DELAY_MS,
  PREVIOUS_REQUEST_RUNNING_OR_DONE_MESSAGE,
  previousRequestActionStateOf,
  previousRequestNoteIdOf,
  previousRequestNoteTextOf,
  replyToSentMessageOf,
  sentMessageIndexOf,
} from '@homegohan/shared';
import { AI_ACTION_LOG_STATUS } from '@/lib/ai/consultation-action-lifecycle';

import * as mobileTimeout from '../apps/mobile/src/lib/ai-chat-timeout';

/** 手で書いた期待値 (定数の文が変わったらこのテストも直す) */
const EXECUTED_TEXT = '前の依頼は実行されました';
const RUNNING_TEXT = '前の依頼は実行中か実行済みです';

describe('#2201 U3 見分ける状態の値はサーバーの値と同じ', () => {
  it('executed・running はサーバーの AI_ACTION_LOG_STATUS.executed・running と同じ', () => {
    expect(PREVIOUS_REQUEST_ACTION_LOG_STATUS.executed).toBe(AI_ACTION_LOG_STATUS.executed);
    expect(PREVIOUS_REQUEST_ACTION_LOG_STATUS.running).toBe(AI_ACTION_LOG_STATUS.running);
  });
});

describe('#2201 U3 previousRequestActionStateOf', () => {
  it.each([
    [[{ status: 'executed' }], 'executed'],
    [[{ status: 'approved' }, { status: 'executed' }], 'executed'],
    [[{ status: 'approved' }], 'running'],
    [[{ status: 'failed' }, { status: 'approved' }], 'running'],
    [[{ status: 'pending' }], 'none'],
    [[{ status: 'failed' }], 'none'],
    [[{ status: 'rejected' }], 'none'],
    [[], 'none'],
    [null, 'none'],
    [undefined, 'none'],
    ['executed', 'none'],
    [[null, 1, 'executed', { state: 'executed' }], 'none'],
  ] as const)('%j → %s', (rows, expected) => {
    expect(previousRequestActionStateOf(rows)).toBe(expected);
  });

  it('サーバーの状態のうち executed だけが executed、approved だけが running になる', () => {
    for (const status of Object.values(AI_ACTION_LOG_STATUS)) {
      const expected =
        status === AI_ACTION_LOG_STATUS.executed ? 'executed' : status === AI_ACTION_LOG_STATUS.running ? 'running' : 'none';
      expect(previousRequestActionStateOf([{ status }]), status).toBe(expected);
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
});

describe('#2201 U3 足す一文', () => {
  it('文は状態で決まる (実行中の文は頼み直しを勧めない)', () => {
    expect(PREVIOUS_REQUEST_EXECUTED_MESSAGE).toBe(EXECUTED_TEXT);
    expect(PREVIOUS_REQUEST_RUNNING_OR_DONE_MESSAGE).toBe(RUNNING_TEXT);
    expect(previousRequestNoteTextOf('executed')).toBe(EXECUTED_TEXT);
    expect(previousRequestNoteTextOf('running')).toBe(RUNNING_TEXT);
    expect(RUNNING_TEXT).not.toContain('頼んで');
    expect(RUNNING_TEXT).not.toContain('もう一度');
  });

  it('id は状態ごとに違い、実行できたの id は自動実行の成功の一文と同じ形 (同じ返答の結果は 1 つ)', () => {
    expect(previousRequestNoteIdOf('executed', 'r1')).toBe('action-result-r1');
    expect(previousRequestNoteIdOf('running', 'r1')).toBe('action-running-r1');
  });

  it('読み直しの待ちは正の有限の値', () => {
    expect(Number.isFinite(PREVIOUS_REQUEST_RECHECK_DELAY_MS)).toBe(true);
    expect(PREVIOUS_REQUEST_RECHECK_DELAY_MS).toBeGreaterThan(0);
  });
});

describe('#2201 U3 モバイルの既存の名前は共有の決まりと同じ', () => {
  it('文・値・関数が共有のもの', () => {
    expect(mobileTimeout.PREVIOUS_REQUEST_EXECUTED_MESSAGE).toBe(PREVIOUS_REQUEST_EXECUTED_MESSAGE);
    expect(mobileTimeout.PREVIOUS_REQUEST_RUNNING_OR_DONE_MESSAGE).toBe(PREVIOUS_REQUEST_RUNNING_OR_DONE_MESSAGE);
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
