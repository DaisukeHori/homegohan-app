/**
 * safe-nickname.test.ts
 * ハンズオンツアーの呼びかけに出す名前 (apps/mobile/src/handson-tour/safe-nickname.ts。#1635)
 *
 * 確かめること:
 *   - 名前が無いときにアプリが入れる仮置きの 'Guest' (前後の空白を除いて厳密一致) は「Guest さん」と呼ばず 'あなた' にする
 *   - 空・空白だけ・null も 'あなた'
 *   - 'guest'・'ゲスト' などは本人が付けた名前としてそのまま出す (Web・プロフィール画面と同じ @homegohan/shared の判定)
 *   - 30 文字を超える名前は 30 文字で切って「…」を付ける (設計書 02-step0-welcome.md §7.2)
 */
import fs from 'fs';
import path from 'path';

import { normalizeProfileName } from '@homegohan/shared';

import {
  HANDSON_TOUR_NICKNAME_FALLBACK,
  HANDSON_TOUR_NICKNAME_MAX_LENGTH,
  safeNickname,
} from '../../src/handson-tour/safe-nickname';

describe('safeNickname (#1635)', () => {
  it("名前が無いときの呼びかけは 'あなた'・最大の文字数は 30 (設計書 §7.2)", () => {
    expect(HANDSON_TOUR_NICKNAME_FALLBACK).toBe('あなた');
    expect(HANDSON_TOUR_NICKNAME_MAX_LENGTH).toBe(30);
  });

  it.each(['Guest', ' Guest', 'Guest ', '  Guest\t'])("仮置き '%s' は 'あなた' にする", (raw) => {
    expect(safeNickname(raw)).toBe('あなた');
  });

  it.each([null, undefined, '', '   '])('名前が無い (%j) ときは あなた', (raw) => {
    expect(safeNickname(raw)).toBe('あなた');
  });

  it.each(['guest', 'GUEST', 'ゲスト', 'Guest太郎', '太郎'])("'%s' は本人が付けた名前としてそのまま出す", (raw) => {
    expect(safeNickname(raw)).toBe(raw);
  });

  it('前後の空白は除いて出す', () => {
    expect(safeNickname('  太郎 ')).toBe('太郎');
  });

  it('30 文字ちょうどはそのまま、31 文字は 30 文字で切って … を付ける', () => {
    const exact = 'あ'.repeat(30);
    expect(safeNickname(exact)).toBe(exact);
    expect(safeNickname(`${'い'.repeat(30)}う`)).toBe(`${'い'.repeat(30)}…`);
    // 前後の空白を除いてから数える
    expect(safeNickname(`  ${exact}  `)).toBe(exact);
  });

  it('名前が無いかどうかは @homegohan/shared の normalizeProfileName と同じ判定', () => {
    for (const raw of ['Guest', ' Guest ', '', '  ', 'guest', 'ゲスト', '太郎']) {
      expect(safeNickname(raw) === 'あなた').toBe(normalizeProfileName(raw) === null);
    }
  });
});

describe('ハンズオンツアーの 5 つの画面が同じ safeNickname を使う (#1635)', () => {
  const SCREENS = ['index', 'photo', 'menu', 'badges', 'graduate'];

  it.each(SCREENS)('app/handson-tour/%s.tsx は src/handson-tour/safe-nickname の safeNickname を使い、自分では持たない', (screen) => {
    const source = fs.readFileSync(path.join(__dirname, '../../app/handson-tour', `${screen}.tsx`), 'utf8');
    expect(source).toContain("import { safeNickname } from '../../src/handson-tour/safe-nickname';");
    expect(source).not.toMatch(/function\s+safeNickname\s*\(/);
    expect(source).toContain('safeNickname(profile?.nickname)');
  });
});
