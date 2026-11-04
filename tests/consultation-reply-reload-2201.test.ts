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
 *   6. 取り直した返答の一文・知らせるか・読み直すか (previousRequestNotePlanOf)、読み直しの結果の当て方
 *      (previousRequestRecheckPlanOf・messagesAfterPreviousRequestRecheck) は shared の 1 か所で決まる (#2206 G2)。
 *      記録の行がまだ無いのに返答に提案があれば実行中の印と同じ・記録を読めなければ 1 回だけ読み直す。
 *      Web とモバイルの画面は判定を写さない (番兵: 画面に 'none' との比較・readFailed の直読みが現れたら赤)
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import {
  PREVIOUS_REQUEST_ACTION_LOG_STATUS,
  PREVIOUS_REQUEST_EXECUTED_MESSAGE,
  PREVIOUS_REQUEST_RECHECK_DELAY_MS,
  PREVIOUS_REQUEST_NOT_EXECUTED_MESSAGE,
  PREVIOUS_REQUEST_UNCONFIRMED_MESSAGE,
  messagesAfterPreviousRequestRecheck,
  previousRequestActionStateOf,
  previousRequestNoteIdOf,
  previousRequestNotePlanOf,
  previousRequestNoteTextOf,
  previousRequestRecheckPlanOf,
  replyHasProposalOf,
  replyProposalExecutableOf,
  replyToSentMessageOf,
  replyToUserMessageIdOf,
  sentMessageIndexOf,
  sentMessageReloadOutcomeOf,
  type PreviousRequestActionState,
  type PreviousRequestNotePlan,
  type PreviousRequestRecheckPlan,
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
    // #2206 G2: 取り直した返答の一文・読み直しの決まりも共有のもの (モバイルに判定の写しを作らない)
    expect(mobileTimeout.previousRequestNotePlanOf).toBe(previousRequestNotePlanOf);
    expect(mobileTimeout.previousRequestRecheckPlanOf).toBe(previousRequestRecheckPlanOf);
    expect(mobileTimeout.messagesAfterPreviousRequestRecheck).toBe(messagesAfterPreviousRequestRecheck);
    expect(mobileTimeout.replyHasProposalOf).toBe(replyHasProposalOf);
  });

  it('hasExecutedActionLog は実行できた行があるときだけ真 (実行中の印だけでは真にしない)', () => {
    expect(mobileTimeout.hasExecutedActionLog([{ status: 'executed' }])).toBe(true);
    expect(mobileTimeout.hasExecutedActionLog([{ status: 'approved' }])).toBe(false);
    expect(mobileTimeout.hasExecutedActionLog(null)).toBe(false);
  });
});

describe('#2206 G2 取り直した返答の一文・知らせるか・読み直すか (previousRequestNotePlanOf)', () => {
  // 状態 4 × 読めなかったか 2 × 返答に提案があるか 2 の全部の組み合わせ (手で書いた期待値)
  const EXECUTED_PLAN: PreviousRequestNotePlan = { state: 'executed', noteState: 'executed', notifyDataChanged: true, recheck: false };
  const RUNNING_PLAN: PreviousRequestNotePlan = { state: 'running', noteState: 'running', notifyDataChanged: false, recheck: true };
  const NOT_EXECUTED_PLAN: PreviousRequestNotePlan = {
    state: 'notExecuted',
    noteState: 'notExecuted',
    notifyDataChanged: false,
    recheck: false,
  };
  const NOTHING_PLAN: PreviousRequestNotePlan = { state: 'none', noteState: null, notifyDataChanged: false, recheck: false };
  const RECHECK_ONLY_PLAN: PreviousRequestNotePlan = { state: 'none', noteState: null, notifyDataChanged: false, recheck: true };

  // 行がある状態 (executed・running・notExecuted) は、読めなかったか・提案があるか・GET が「実行する」を出すとしたかによらない
  const ALL_FLAGS: Array<[boolean, boolean, boolean]> = [
    [false, false, false],
    [false, false, true],
    [false, true, false],
    [false, true, true],
    [true, false, false],
    [true, false, true],
    [true, true, false],
    [true, true, true],
  ];
  it.each<[PreviousRequestActionState, PreviousRequestNotePlan]>([
    ['executed', EXECUTED_PLAN],
    ['running', RUNNING_PLAN],
    ['notExecuted', NOT_EXECUTED_PLAN],
  ])('状態 %s は残りの印によらない', (actionState, expected) => {
    for (const [readFailed, replyHasProposal, replyProposalExecutable] of ALL_FLAGS) {
      expect(previousRequestNotePlanOf({ actionState, readFailed, replyHasProposal, replyProposalExecutable })).toEqual(expected);
    }
  });

  it.each<[boolean, boolean, boolean, PreviousRequestNotePlan]>([
    // 行が無い・断った (読めた) で提案も無い
    [false, false, false, NOTHING_PLAN],
    [false, false, true, NOTHING_PLAN],
    // 返答を保存してから行を作るまでの間に取り直しが当たった: 実行中の印と同じく一文を出して読み直す
    // (記録を読めたなら GET の「実行する」は見ない)
    [false, true, false, RUNNING_PLAN],
    [false, true, true, RUNNING_PLAN],
    // 提案が無く記録を読めない: 一文は出さずに 1 回だけ読み直す (GET は実行できた提案を出さない)
    [true, false, false, RECHECK_ONLY_PLAN],
    [true, false, true, RECHECK_ONLY_PLAN],
    // 記録を読めず、GET は「実行する」を出さないとした (実行中の印・失敗・行が無いのどれか): 実行中の印と同じ
    [true, true, false, RUNNING_PLAN],
    // #2227 H1: 記録を読めず、GET は「実行する」を出すとした (GET が読んだ行は pending): 実行していない
    [true, true, true, NOT_EXECUTED_PLAN],
  ])('状態 none・読めなかった %s・提案がある %s・GET が実行できるとした %s', (readFailed, replyHasProposal, replyProposalExecutable, expected) => {
    expect(previousRequestNotePlanOf({ actionState: 'none', readFailed, replyHasProposal, replyProposalExecutable })).toEqual(expected);
  });

  it('#2227 H1 GET が「実行する」を出すとしたかは proposedActionExecutable が true のときだけ', () => {
    expect(replyProposalExecutableOf({ proposedActionExecutable: true })).toBe(true);
    expect(replyProposalExecutableOf({ proposedActionExecutable: false })).toBe(false);
    expect(replyProposalExecutableOf({ proposedActionExecutable: 'true' })).toBe(false);
    expect(replyProposalExecutableOf({})).toBe(false);
  });

  it('返答に提案があるかは会話の GET の proposedActions で読む (null・無い → 無い)', () => {
    expect(replyHasProposalOf({ proposedActions: { type: 'generate_single_meal', params: {} } })).toBe(true);
    expect(replyHasProposalOf({ proposedActions: null })).toBe(false);
    expect(replyHasProposalOf({})).toBe(false);
  });
});

describe('#2206 G2 読み直しの結果の当て方 (previousRequestRecheckPlanOf・messagesAfterPreviousRequestRecheck)', () => {
  const EXECUTED_RECHECK: PreviousRequestRecheckPlan = { noteState: 'executed', addNoteIfMissing: true, notifyDataChanged: true };
  const NOT_EXECUTED_RECHECK: PreviousRequestRecheckPlan = { noteState: 'notExecuted', addNoteIfMissing: false, notifyDataChanged: false };
  const NOTHING_RECHECK: PreviousRequestRecheckPlan = { noteState: null, addNoteIfMissing: false, notifyDataChanged: false };
  it.each<[PreviousRequestActionState, boolean, boolean, PreviousRequestRecheckPlan]>([
    ['executed', false, false, EXECUTED_RECHECK],
    ['executed', false, true, EXECUTED_RECHECK],
    ['notExecuted', false, false, NOT_EXECUTED_RECHECK],
    ['notExecuted', false, true, NOT_EXECUTED_RECHECK],
    ['running', false, false, NOTHING_RECHECK],
    ['running', false, true, NOTHING_RECHECK],
    ['none', false, false, NOTHING_RECHECK],
    // #2227 H1: 読めたのに行がまだ無く、返答に提案がある (サーバーは行を作れずに実行しなかった): 実行していない
    ['none', false, true, NOT_EXECUTED_RECHECK],
    // 読めなかった: 行が無いとは言えないので何もしない
    ['none', true, false, NOTHING_RECHECK],
    ['none', true, true, NOTHING_RECHECK],
  ])('読み直した状態 %s・読めなかった %s・提案がある %s', (state, readFailed, replyHasProposal, expected) => {
    expect(previousRequestRecheckPlanOf({ state, readFailed }, replyHasProposal)).toEqual(expected);
  });

  type Row = { id: string; content: string; updated?: boolean };
  const REPLY_ID = 'r1';
  const user: Row = { id: 'u1', content: '1食作って' };
  const reply: Row = { id: REPLY_ID, content: '作りますね' };
  const later: Row = { id: 'u2', content: '別の相談' };
  const runningNote: Row = { id: previousRequestNoteIdOf('running', REPLY_ID), content: RUNNING_TEXT };
  const noteOf = (state: 'executed' | 'notExecuted'): Row => ({
    id: previousRequestNoteIdOf(state, REPLY_ID),
    content: previousRequestNoteTextOf(state),
  });
  const updateReply = (m: Row): Row => ({ ...m, updated: true });
  const apply = (messages: Row[], state: PreviousRequestActionState) =>
    messagesAfterPreviousRequestRecheck(messages, {
      replyId: REPLY_ID,
      plan: previousRequestRecheckPlanOf({ state, readFailed: false }, false),
      noteOf,
      updateReply,
    });

  it('実行できた: 実行中の一文を置き換え、返答に updateReply を当てる', () => {
    expect(apply([user, reply, runningNote, later], 'executed')).toEqual([
      user,
      { ...reply, updated: true },
      noteOf('executed'),
      later,
    ]);
  });

  it('実行できた: 実行中の一文が無ければ (記録を読めずに一文を出さなかった) 返答のすぐ後に足す。同じ一文があれば足さない', () => {
    expect(apply([user, reply, later], 'executed')).toEqual([user, { ...reply, updated: true }, noteOf('executed'), later]);
    expect(apply([user, reply, noteOf('executed')], 'executed')).toEqual([user, { ...reply, updated: true }, noteOf('executed')]);
  });

  it('実行を待つ・失敗: 実行中の一文を置き換える。実行中の一文が無ければ一覧をそのまま返す (足さない)', () => {
    expect(apply([user, reply, runningNote], 'notExecuted')).toEqual([user, { ...reply, updated: true }, noteOf('notExecuted')]);
    const withoutNote = [user, reply];
    expect(apply(withoutNote, 'notExecuted')).toBe(withoutNote);
  });

  it('まだ実行中の印・行が無い・読めない: 一覧をそのまま返す (一文はそのまま)', () => {
    const messages = [user, reply, runningNote];
    expect(apply(messages, 'running')).toBe(messages);
    expect(apply(messages, 'none')).toBe(messages);
  });

  it('別の相談に切り替えた (一文も返答も今の会話に無い): 一覧をそのまま返す', () => {
    const otherSession = [{ id: 'x1', content: '別の相談の文' }];
    expect(apply(otherSession, 'executed')).toBe(otherSession);
    expect(apply(otherSession, 'notExecuted')).toBe(otherSession);
  });

  it('updateReply を渡さなければ返答はそのまま (モバイル)', () => {
    const messages = [user, reply, runningNote];
    expect(
      messagesAfterPreviousRequestRecheck(messages, {
        replyId: REPLY_ID,
        plan: previousRequestRecheckPlanOf({ state: 'executed', readFailed: false }, false),
        noteOf,
      }),
    ).toEqual([user, reply, noteOf('executed')]);
  });
});

describe('#2206 G2 Web とモバイルの画面は、前の依頼の一文・読み直しの判定を写さない (番兵)', () => {
  // 以前は Web (AIChatBubble) とモバイル (AIAdvisorSheet) にそれぞれ判定の写しがあり、Web にだけ足した決まり
  // (行がまだ無いのに提案がある返答を実行中の印と同じに扱う・記録を読めないときに 1 回読み直す) がモバイルに無かった。
  // 判定は shared の previousRequestNotePlanOf・previousRequestRecheckPlanOf・messagesAfterPreviousRequestRecheck の 1 か所で決める
  const SCREENS = ['src/components/AIChatBubble.tsx', 'apps/mobile/src/components/ai/AIAdvisorSheet.tsx'];
  const SHARED_DECISIONS = ['previousRequestNotePlanOf', 'previousRequestRecheckPlanOf', 'messagesAfterPreviousRequestRecheck'];
  const EQUALITY_OPERATORS = new Set([
    ts.SyntaxKind.EqualsEqualsEqualsToken,
    ts.SyntaxKind.ExclamationEqualsEqualsToken,
    ts.SyntaxKind.EqualsEqualsToken,
    ts.SyntaxKind.ExclamationEqualsToken,
  ]);

  function sourceOf(file: string): ts.SourceFile {
    return ts.createSourceFile(file, readFileSync(join(process.cwd(), file), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  }

  function visitAll(node: ts.Node, visit: (node: ts.Node) => void) {
    visit(node);
    ts.forEachChild(node, (child) => visitAll(child, visit));
  }

  const isNoneLiteral = (node: ts.Node) => ts.isStringLiteralLike(node) && node.text === 'none';

  /** node が name の関数の呼び出しの引数の中にあるか */
  function isInsideCallOf(node: ts.Node, name: string): boolean {
    for (let cur: ts.Node | undefined = node.parent; cur; cur = cur.parent) {
      if (ts.isCallExpression(cur) && ts.isIdentifier(cur.expression) && cur.expression.text === name) return true;
    }
    return false;
  }

  it.each(SCREENS)('%s: 前の依頼の状態を \'none\' と比べない (一文を出すかは plan.noteState・読み直すかは plan.recheck で読む)', (file) => {
    const found: string[] = [];
    visitAll(sourceOf(file), (node) => {
      if (ts.isBinaryExpression(node) && EQUALITY_OPERATORS.has(node.operatorToken.kind) && (isNoneLiteral(node.left) || isNoneLiteral(node.right))) {
        found.push(node.getText());
      }
      if (ts.isCaseClause(node) && isNoneLiteral(node.expression)) found.push(node.getText());
    });
    expect(found).toEqual([]);
  });

  it.each(SCREENS)('%s: 記録を読めなかったか (readFailed) は shared の previousRequestNotePlanOf に渡すだけ', (file) => {
    const outside: string[] = [];
    visitAll(sourceOf(file), (node) => {
      if (ts.isPropertyAccessExpression(node) && node.name.text === 'readFailed' && !isInsideCallOf(node, 'previousRequestNotePlanOf')) {
        outside.push(node.getText());
      }
    });
    expect(outside).toEqual([]);
  });

  it.each(SCREENS)('%s: 一文と読み直しは shared の決まりを呼んで決める', (file) => {
    const called = new Set<string>();
    visitAll(sourceOf(file), (node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) called.add(node.expression.text);
    });
    for (const name of SHARED_DECISIONS) expect(called.has(name), name).toBe(true);
  });
});
