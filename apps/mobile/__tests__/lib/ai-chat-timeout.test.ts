/**
 * #1049 F7-18: AI 相談の送信が時間切れになったあとの扱い (src/lib/ai-chat-timeout.ts)。
 * AIAdvisorSheet と全画面の AI 相談 (app/ai/[sessionId].tsx) が同じ関数を使う。
 *   - 取り直した会話から、送った文が届いていたか・返答があるかを見分ける
 *   - 時間切れのときは送った文を入力欄に戻す (別の文が入っていれば残す)
 *   - 届いていたら、戻した文のままの入力欄を消す (二重に送らないため。書き換えていれば残す)
 */

import fs from 'fs';
import path from 'path';

import {
  clearInputIfDelivered,
  restoreInputAfterTimeout,
  timeoutReloadOutcomeOf,
  type TimedOutSend,
} from '../../src/lib/ai-chat-timeout';

const SENT: TimedOutSend = {
  sessionId: 'session-1',
  text: '鶏むね肉の使い方は?',
  knownMessageIds: ['m1', 'm2'],
  delivered: false,
};

const OLD = [
  { id: 'm1', role: 'user', content: '夕飯の相談です' },
  { id: 'm2', role: 'assistant', content: '野菜を足しましょう' },
];

describe('timeoutReloadOutcomeOf (#1049 F7-18)', () => {
  it('送った文が新しい user のメッセージとして保存され、その後ろに返答があれば replied', () => {
    expect(
      timeoutReloadOutcomeOf(SENT, [
        ...OLD,
        { id: 'm3', role: 'user', content: SENT.text },
        { id: 'm4', role: 'assistant', content: '低温調理がおすすめです' },
      ]),
    ).toBe('replied');
  });

  it('送った文は保存されているが、返答がまだ無ければ delivered-no-reply', () => {
    expect(timeoutReloadOutcomeOf(SENT, [...OLD, { id: 'm3', role: 'user', content: SENT.text }])).toBe('delivered-no-reply');
  });

  it('送った文が無ければ not-delivered (前からある返答を、今回の返答と取り違えない)', () => {
    expect(timeoutReloadOutcomeOf(SENT, OLD)).toBe('not-delivered');
  });

  it('前から同じ文があっても (送る前に出ていた id)、今回のものとは数えない', () => {
    const sentAgain: TimedOutSend = { ...SENT, text: '夕飯の相談です' };
    expect(timeoutReloadOutcomeOf(sentAgain, OLD)).toBe('not-delivered');
  });

  it('同じ文でも assistant のメッセージは、送った文として数えない', () => {
    expect(timeoutReloadOutcomeOf(SENT, [...OLD, { id: 'm3', role: 'assistant', content: SENT.text }])).toBe('not-delivered');
  });

  it('返答が送った文より前にしか無ければ、返答とは数えない', () => {
    expect(
      timeoutReloadOutcomeOf(SENT, [
        { id: 'm0', role: 'assistant', content: '前の返答' },
        ...OLD,
        { id: 'm3', role: 'user', content: SENT.text },
      ]),
    ).toBe('delivered-no-reply');
  });

  it('サーバーは前後の空白を除いて保存するので、保存された本文の空白は見ない', () => {
    expect(timeoutReloadOutcomeOf(SENT, [...OLD, { id: 'm3', role: 'user', content: ` ${SENT.text}\n` }])).toBe(
      'delivered-no-reply',
    );
  });
});

describe('restoreInputAfterTimeout (#1049 F7-18)', () => {
  it('入力欄が空なら、送った文を戻す', () => {
    expect(restoreInputAfterTimeout('', SENT.text)).toBe(SENT.text);
    expect(restoreInputAfterTimeout('  ', SENT.text)).toBe(SENT.text);
  });

  it('待っている間に別の文を書いていれば、それを消さない', () => {
    expect(restoreInputAfterTimeout('次の質問', SENT.text)).toBe('次の質問');
  });
});

describe('clearInputIfDelivered (#1049 F7-18)', () => {
  it('入力欄が戻した文のままなら消す (そのまま送ると二重に届く)', () => {
    expect(clearInputIfDelivered(SENT.text, SENT.text)).toBe('');
    expect(clearInputIfDelivered(`${SENT.text} `, SENT.text)).toBe('');
  });

  it('書き換えていれば (新しい相談) 残す', () => {
    expect(clearInputIfDelivered(`${SENT.text}と、ささみは?`, SENT.text)).toBe(`${SENT.text}と、ささみは?`);
    expect(clearInputIfDelivered('', SENT.text)).toBe('');
  });
});

describe('2 つの相談画面が同じ扱いを使う (#1049 F7-18。写さない)', () => {
  it.each(['src/components/ai/AIAdvisorSheet.tsx', 'app/ai/[sessionId].tsx'])('%s', (file) => {
    const source = fs.readFileSync(path.join(__dirname, '../..', file), 'utf8');
    for (const name of [
      'timeoutReloadOutcomeOf',
      'restoreInputAfterTimeout',
      'clearInputIfDelivered',
      'TIMEOUT_NOTICE_MESSAGE',
      'TIMEOUT_RELOAD_LABEL',
      'TIMEOUT_DELIVERED_NO_REPLY_MESSAGE',
      'TIMEOUT_NOT_DELIVERED_MESSAGE',
    ]) {
      expect(source).toContain(name);
    }
    // 案内の文を画面ごとに書かない
    expect(source).not.toMatch(/応答に時間がかかっています|応答がタイムアウトしました/);
  });
});
