/**
 * #2283 終了した相談への送信の取り決めが、サーバー・Web・モバイルの写しで食い違わないこと。
 *
 * サーバー (会話の続きの POST) は 409 と `{ error: AI_CONSULTATION_SESSION_CLOSED_MESSAGE, code: AI_CONSULTATION_SESSION_CLOSED_CODE }`
 * で拒み、Web の AI 相談 (src/components/AIChatBubble.tsx) はその定数の文を出す。モバイルはルートの src/ を import できない
 * (.easignore が /src/ を除外する) ので、文・code・状態コード・status の値を apps/mobile/src/lib/ai-consultation-session-closed.ts に
 * 写して持つ。写しがずれたら (どちらかだけ変えたら) ここで赤になる。
 *   1. 文・code・状態コード・終了の status の値が同じ
 *   2. 見分け方: 409 と code の両方が合うときだけ終了した相談として扱う (Web は JSON を読んだ本文、モバイルは本文の文字列)
 *   3. 写しが使われている: 画面の部品は文を自分で書かず、定数から読む
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AI_CONSULTATION_SESSION_CLOSED_CODE, AI_CONSULTATION_SESSION_CLOSED_MESSAGE } from '@/lib/ai/ai-api-messages';
import * as web from '@/lib/ai/consultation-session-closed';
import * as mobile from '../apps/mobile/src/lib/ai-consultation-session-closed';

const ROOT = path.resolve(__dirname, '..');
const WEB_CHAT_BUBBLE_PATH = 'src/components/AIChatBubble.tsx';
const ADVISOR_SHEET_PATH = 'apps/mobile/src/components/ai/AIAdvisorSheet.tsx';
/** 409 でない失敗の状態コード (見分け方が状態コードも見ることを確かめる) */
const OTHER_FAILURE_STATUS = 400;

function source(relativePath: string): string {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

describe('#2283 終了した相談への送信の文・code・状態コードの写し', () => {
  it('モバイルの写しはサーバー・Web と同じ文・code・状態コード・status の値', () => {
    expect(mobile.CONSULTATION_SESSION_CLOSED_MESSAGE).toBe(AI_CONSULTATION_SESSION_CLOSED_MESSAGE);
    expect(mobile.CONSULTATION_SESSION_CLOSED_CODE).toBe(AI_CONSULTATION_SESSION_CLOSED_CODE);
    expect(mobile.CONSULTATION_SESSION_CLOSED_STATUS).toBe(web.CONSULTATION_SESSION_CLOSED_STATUS);
    expect(mobile.CONSULTATION_SESSION_STATUS_CLOSED).toBe(web.CONSULTATION_SESSION_STATUS_CLOSED);
  });

  it('文は『この相談は終了しています。新しい相談を始めてください』・状態コードは 409', () => {
    expect(AI_CONSULTATION_SESSION_CLOSED_MESSAGE).toBe('この相談は終了しています。新しい相談を始めてください');
    expect(web.CONSULTATION_SESSION_CLOSED_STATUS).toBe(409);
  });

  it('サーバーの応答の本文は error に文・code に code', () => {
    expect(web.consultationSessionClosedBody()).toEqual({
      error: AI_CONSULTATION_SESSION_CLOSED_MESSAGE,
      code: AI_CONSULTATION_SESSION_CLOSED_CODE,
    });
  });
});

describe('#2283 見分け方 (409 と code の両方が合うときだけ)', () => {
  const body = { error: AI_CONSULTATION_SESSION_CLOSED_MESSAGE, code: AI_CONSULTATION_SESSION_CLOSED_CODE };
  const cases: Array<{ label: string; status: number; body: unknown; expected: boolean }> = [
    { label: '409 と code', status: web.CONSULTATION_SESSION_CLOSED_STATUS, body, expected: true },
    { label: '409 で code が違う', status: web.CONSULTATION_SESSION_CLOSED_STATUS, body: { ...body, code: 'OTHER' }, expected: false },
    { label: '409 で code が無い', status: web.CONSULTATION_SESSION_CLOSED_STATUS, body: { error: body.error }, expected: false },
    { label: '409 で本文がオブジェクトでない', status: web.CONSULTATION_SESSION_CLOSED_STATUS, body: null, expected: false },
    { label: '409 でない (code は同じ)', status: OTHER_FAILURE_STATUS, body, expected: false },
  ];

  it.each(cases)('Web: $label → $expected', ({ status, body: b, expected }) => {
    expect(web.isConsultationSessionClosedFailure(status, b)).toBe(expected);
  });

  it.each(cases)('モバイル (本文の文字列): $label → $expected', ({ status, body: b, expected }) => {
    expect(mobile.isConsultationSessionClosedFailure(status, JSON.stringify(b))).toBe(expected);
  });

  it('モバイル: 本文が JSON でなければ終了した相談として扱わない', () => {
    expect(mobile.isConsultationSessionClosedFailure(web.CONSULTATION_SESSION_CLOSED_STATUS, '<html>')).toBe(false);
  });

  it('Web: 応答の本文を読むのは 409 のときだけ (ほかの状態コードでは本文に触れない)', async () => {
    let read = 0;
    const res = (status: number) => ({
      status,
      json: async () => {
        read += 1;
        return body;
      },
    });
    expect(await web.isConsultationSessionClosedResponse(res(OTHER_FAILURE_STATUS))).toBe(false);
    expect(read).toBe(0);
    expect(await web.isConsultationSessionClosedResponse(res(web.CONSULTATION_SESSION_CLOSED_STATUS))).toBe(true);
    expect(read).toBe(1);
  });

  it('終了の status の値だけを終了とみなす', () => {
    for (const isClosed of [web.isConsultationSessionStatusClosed, mobile.isConsultationSessionStatusClosed]) {
      expect(isClosed('closed')).toBe(true);
      expect(isClosed('active')).toBe(false);
      expect(isClosed(undefined)).toBe(false);
    }
  });
});

describe('#2283 写しが使われている', () => {
  it('Web の AI 相談は文を自分で書かず、サーバーと同じ定数から出す', () => {
    const text = source(WEB_CHAT_BUBBLE_PATH);
    expect(text).toContain('AI_CONSULTATION_SESSION_CLOSED_MESSAGE');
    expect(text).not.toContain(AI_CONSULTATION_SESSION_CLOSED_MESSAGE);
  });

  it('モバイルの AI 相談は文を自分で書かず、写しから出す', () => {
    const text = source(ADVISOR_SHEET_PATH);
    expect(text).toContain('CONSULTATION_SESSION_CLOSED_MESSAGE');
    expect(text).toContain('../../lib/ai-consultation-session-closed');
    expect(text).not.toContain(AI_CONSULTATION_SESSION_CLOSED_MESSAGE);
  });
});
