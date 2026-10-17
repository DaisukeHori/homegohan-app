/**
 * packages/shared/src/password-policy.ts の 72 バイトの上限 (#1864)。
 * GoTrue (bcrypt) は 72 バイトを超えるパスワードを新規登録・更新で断る (tests/integration/security/password-max-bytes.test.ts が実物で確かめる)。
 * 上限は文字数ではなく UTF-8 のバイト数なので、日本語 (3 バイト)・絵文字 (4 バイト) を含む境目もここで固定する。
 * 長さ・英字・数字の既存の規則は src/lib/auth/__tests__/validate-password.test.ts が見る。
 */
import { describe, expect, it } from 'vitest';
import {
  PASSWORD_MAX_BYTES,
  PASSWORD_MIN_LENGTH,
  PASSWORD_TOO_LONG_MESSAGE,
  utf8ByteLength,
  validatePassword,
} from './password-policy';

/** 英字と数字の規則を満たす先頭 (どの境目のテストでも、長さ以外の規則で止まらないようにする) */
const VALID_HEAD = 'a1';
const ASCII_FILL = 'x';
/** UTF-8 で 2・3・4 バイトになる文字 (é = U+00E9・あ = U+3042・😀 = U+1F600) */
const TWO_BYTE_CHAR = 'é';
const JAPANESE_CHAR = 'あ';
const EMOJI_CHAR = '😀';
const TWO_BYTES = 2;
const THREE_BYTES = 3;
const FOUR_BYTES = 4;

/** 先頭 VALID_HEAD の後ろに char を並べて、ちょうど bytes バイト以下で最大の文字列にする */
function fillTo(char: string, charBytes: number, bytes: number): string {
  const count = Math.floor((bytes - VALID_HEAD.length) / charBytes);
  return VALID_HEAD + char.repeat(count);
}

describe('PASSWORD_MAX_BYTES (#1864)', () => {
  it('GoTrue の MaxPasswordLength (bcrypt が使う先頭のバイト数) と同じ 72', () => {
    expect(PASSWORD_MAX_BYTES).toBe(72);
  });

  it('文言は半角の文字数 (= バイト数) と、日本語の概数 (3 バイトで割った数) を言う', () => {
    expect(PASSWORD_TOO_LONG_MESSAGE).toBe(
      'パスワードが長すぎます。半角で72文字 (日本語なら約24文字) 以内にしてください',
    );
  });
});

describe('utf8ByteLength', () => {
  it.each([
    ['空', ''],
    ['半角', 'Password1'],
    ['2 バイトの文字', `caf${TWO_BYTE_CHAR}1`],
    ['日本語', 'パスワード1a'],
    ['絵文字 (サロゲートペア)', `pass${EMOJI_CHAR}1`],
    ['結合文字 (が = か + 濁点)', 'がa1'],
    ['異体字セレクタつきの絵文字', '❤️a1'],
    ['3 バイトの最大 (U+FFFF の手前の私用領域)', 'a1'],
  ])('%s は Node の Buffer.byteLength (UTF-8) と同じ数になる', (_label, text) => {
    expect(utf8ByteLength(text)).toBe(Buffer.byteLength(text, 'utf8'));
  });

  it('1・2・3・4 バイトの境目のコードポイント (U+007F / U+0080・U+07FF / U+0800・U+FFFF / U+10000) を正しく数える', () => {
    expect(utf8ByteLength('\u007f')).toBe(1);
    expect(utf8ByteLength('\u0080')).toBe(TWO_BYTES);
    expect(utf8ByteLength('߿')).toBe(TWO_BYTES);
    expect(utf8ByteLength('ࠀ')).toBe(THREE_BYTES);
    expect(utf8ByteLength('￿')).toBe(THREE_BYTES);
    expect(utf8ByteLength(String.fromCodePoint(0x10000))).toBe(FOUR_BYTES);
    expect(utf8ByteLength(EMOJI_CHAR)).toBe(FOUR_BYTES);
  });

  it('対になっていないサロゲートは、TextEncoder と同じく置換文字 (3 バイト) として数える', () => {
    const lone = '\ud800a1';
    expect(utf8ByteLength(lone)).toBe(new TextEncoder().encode(lone).length);
    expect(utf8ByteLength(lone)).toBe(THREE_BYTES + VALID_HEAD.length);
  });
});

describe('validatePassword の 72 バイトの上限 (#1864)', () => {
  it('半角だけ: 72 バイト (72 文字) は通り、73 バイトは長すぎると止める', () => {
    const exact = VALID_HEAD + ASCII_FILL.repeat(PASSWORD_MAX_BYTES - VALID_HEAD.length);
    expect(utf8ByteLength(exact)).toBe(PASSWORD_MAX_BYTES);
    expect(validatePassword(exact)).toBeNull();
    expect(validatePassword(`${exact}${ASCII_FILL}`)).toBe(PASSWORD_TOO_LONG_MESSAGE);
  });

  it('日本語: 72 文字よりずっと手前 (26 文字・74 バイト) で止める。日本語 23 文字 + 英数字 2 文字 (71 バイト) は通る', () => {
    const fits = fillTo(JAPANESE_CHAR, THREE_BYTES, PASSWORD_MAX_BYTES);
    expect(utf8ByteLength(fits)).toBe(71);
    expect(validatePassword(fits)).toBeNull();
    const over = `${fits}${JAPANESE_CHAR}`;
    expect(over.length).toBe(26);
    expect(utf8ByteLength(over)).toBe(74);
    expect(validatePassword(over)).toBe(PASSWORD_TOO_LONG_MESSAGE);
  });

  it('2 バイトの文字: 72 バイトちょうどは通り、1 バイト足すと止める', () => {
    const exact = fillTo(TWO_BYTE_CHAR, TWO_BYTES, PASSWORD_MAX_BYTES);
    expect(utf8ByteLength(exact)).toBe(PASSWORD_MAX_BYTES);
    expect(validatePassword(exact)).toBeNull();
    expect(validatePassword(`${exact}${ASCII_FILL}`)).toBe(PASSWORD_TOO_LONG_MESSAGE);
  });

  it('絵文字: 文字列の length (UTF-16) ではなくバイト数で数える (70 バイトは通り、74 バイトは止める)', () => {
    const fits = fillTo(EMOJI_CHAR, FOUR_BYTES, PASSWORD_MAX_BYTES);
    expect(utf8ByteLength(fits)).toBe(70);
    expect(validatePassword(fits)).toBeNull();
    const over = `${fits}${EMOJI_CHAR}`;
    expect(over.length).toBeLessThan(PASSWORD_MAX_BYTES);
    expect(validatePassword(over)).toBe(PASSWORD_TOO_LONG_MESSAGE);
  });

  it('長すぎるときは、英字・数字が無くても長さの文言を先に出す (直すべきことを 1 つに絞る)', () => {
    const japaneseOnly = JAPANESE_CHAR.repeat(PASSWORD_MAX_BYTES);
    expect(validatePassword(japaneseOnly)).toBe(PASSWORD_TOO_LONG_MESSAGE);
  });

  it('短すぎるときは、今までどおり最小の長さの文言 (上限の判定より先)', () => {
    const short = EMOJI_CHAR.repeat(PASSWORD_MIN_LENGTH / TWO_BYTES - 1);
    expect(validatePassword(short)).toBe(`パスワードは${PASSWORD_MIN_LENGTH}文字以上で入力してください`);
  });
});
