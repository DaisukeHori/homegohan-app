/**
 * handson-tour-nickname (ハンズオンツアーの呼びかけに出す名前。Web・モバイル共通。#1635・#1649) のユニットテスト
 *
 * 確かめること:
 *   - 名前が無いときにアプリが入れる仮置きの 'Guest' (前後の空白を除いて厳密一致) は「Guest さん」と呼ばず 'あなた' にする
 *   - 空・空白だけ・null・undefined も 'あなた'
 *   - 'guest'・'ゲスト' などは本人が付けた名前としてそのまま出す (normalizeProfileName と同じ判定)
 *   - 前後の空白は除く
 *   - 30 文字を超える名前は 30 文字で切って「…」を付ける (設計書 02-step0-welcome.md §7.2)。ちょうど 30 文字は切らない
 *   - パッケージの入口 (index) から読める (Web とモバイルは '@homegohan/shared' から import する)
 */
import { describe, expect, it } from 'vitest';
import {
  HANDSON_TOUR_NICKNAME_FALLBACK,
  HANDSON_TOUR_NICKNAME_MAX_LENGTH,
  handsonTourNickname,
} from './handson-tour-nickname';
import { normalizeProfileName } from './profile-name';
import * as shared from './index';

describe('handsonTourNickname (#1649)', () => {
  it("名前が無いときの呼びかけは 'あなた'・最大の文字数は 30 (設計書 §7.2)", () => {
    expect(HANDSON_TOUR_NICKNAME_FALLBACK).toBe('あなた');
    expect(HANDSON_TOUR_NICKNAME_MAX_LENGTH).toBe(30);
  });

  it.each(['Guest', ' Guest ', ' Guest', 'Guest ', '  Guest\t'])("仮置き '%s' は 'あなた' にする", (raw) => {
    expect(handsonTourNickname(raw)).toBe('あなた');
  });

  it.each(['', '   ', '\t\n', null, undefined])("空・空白だけ・null・undefined (%j) は 'あなた' にする", (raw) => {
    expect(handsonTourNickname(raw)).toBe('あなた');
  });

  it.each(['guest', 'GUEST', 'ゲスト', 'Guest太郎', 'はなこ'])("'%s' は本人が付けた名前としてそのまま出す", (raw) => {
    expect(handsonTourNickname(raw)).toBe(raw);
  });

  it('実名は前後の空白を除いて出す', () => {
    expect(handsonTourNickname('  太郎 ')).toBe('太郎');
  });

  it('30 文字ちょうどは切らず、31 文字以上は 30 文字で切って「…」を付ける (前後の空白は数えない)', () => {
    const exact = 'あ'.repeat(HANDSON_TOUR_NICKNAME_MAX_LENGTH);
    expect(handsonTourNickname(exact)).toBe(exact);
    expect(handsonTourNickname(`  ${exact}  `)).toBe(exact);
    expect(handsonTourNickname(`${'い'.repeat(HANDSON_TOUR_NICKNAME_MAX_LENGTH)}う`)).toBe(
      `${'い'.repeat(HANDSON_TOUR_NICKNAME_MAX_LENGTH)}…`,
    );
  });

  it("'あなた' になるのは normalizeProfileName が「名前が無い」とするときだけ", () => {
    for (const raw of ['Guest', ' Guest ', '', '  ', null, undefined, 'guest', 'ゲスト', '太郎']) {
      expect(handsonTourNickname(raw) === 'あなた').toBe(normalizeProfileName(raw) === null);
    }
  });

  it('パッケージの入口 (index) から同じものを読める', () => {
    expect(shared.handsonTourNickname).toBe(handsonTourNickname);
    expect(shared.HANDSON_TOUR_NICKNAME_FALLBACK).toBe(HANDSON_TOUR_NICKNAME_FALLBACK);
    expect(shared.HANDSON_TOUR_NICKNAME_MAX_LENGTH).toBe(HANDSON_TOUR_NICKNAME_MAX_LENGTH);
  });
});
