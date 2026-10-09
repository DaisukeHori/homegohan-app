/**
 * 運営コンソール (お知らせ管理・組織管理) の画面で共通に使う小さな関数のテスト
 *   - extractApiErrorMessage: 管理 API の失敗の本文から、画面に出すメッセージを取り出す
 *   - formatJstDateTime     : 一覧に出す日時を日本時間の「年/月/日 時:分」にする
 */
import { describe, expect, it } from 'vitest';
import { extractApiErrorMessage } from '@/lib/admin/api-error-message';
import { formatJstDateTime } from '@/lib/admin/format-datetime';

describe('extractApiErrorMessage', () => {
  it('お知らせ API の形 ({ error: "文字列" }) からメッセージを取り出す', () => {
    expect(extractApiErrorMessage({ error: 'title and content are required' })).toBe('title and content are required');
  });

  it('管理系 API の形 ({ error: { code, message } }) からメッセージを取り出す。details などほかの項目は見ない', () => {
    expect(
      extractApiErrorMessage({
        error: {
          code: 'OWNER_ALREADY_IN_ORG',
          message: '指定した owner は既に別の組織に所属しています',
          details: { fieldErrors: { owner_id: ['Invalid UUID'] } },
        },
      }),
    ).toBe('指定した owner は既に別の組織に所属しています');
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['文字列', 'Bad Request'],
    ['数値', 400],
    ['配列', ['error']],
    ['error が無い', { message: 'x' }],
    ['error が null', { error: null }],
    ['error が空文字', { error: '' }],
    ['error が空白だけ', { error: '   ' }],
    ['error が数値', { error: 500 }],
    ['error.message が無い', { error: { code: 'X' } }],
    ['error.message が空', { error: { code: 'X', message: '' } }],
    ['error.message が空白だけ', { error: { code: 'X', message: '  ' } }],
    ['error.message が文字列でない', { error: { code: 'X', message: { text: 'x' } } }],
  ])('メッセージが読み取れない形 (%s) は null を返す (呼び出し側が汎用の文言を出す)', (_label, body) => {
    expect(extractApiErrorMessage(body)).toBeNull();
  });
});

describe('formatJstDateTime', () => {
  it('UTC の日時を日本時間 (+9 時間) の「年/月/日 時:分」にする。日付をまたぐ場合も正しい', () => {
    expect(formatJstDateTime('2026-10-08T05:00:00.000Z')).toBe('2026/10/08 14:00');
    expect(formatJstDateTime('2026-10-07T15:30:00.000Z')).toBe('2026/10/08 00:30');
    expect(formatJstDateTime('2026-12-31T15:00:00+00:00')).toBe('2027/01/01 00:00');
  });

  it('+09:00 など時差つきの表記でも同じ時刻になる。24 時表記 (24:00) にならない', () => {
    expect(formatJstDateTime('2026-10-08T14:00:00+09:00')).toBe('2026/10/08 14:00');
    expect(formatJstDateTime('2026-10-08T00:00:00+09:00')).toBe('2026/10/08 00:00');
  });

  it('秒より下は出さない (分まで)', () => {
    expect(formatJstDateTime('2026-10-08T05:00:59.999Z')).toBe('2026/10/08 14:00');
  });

  it.each([null, undefined, ''])('値が無いとき (%s) は「-」を返す', (value) => {
    expect(formatJstDateTime(value)).toBe('-');
  });

  it('日時として読めない文字列は、そのまま返す (一覧の表示を崩さない)', () => {
    expect(formatJstDateTime('not-a-date')).toBe('not-a-date');
  });
});
