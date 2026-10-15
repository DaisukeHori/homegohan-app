/**
 * src/lib/api/null-character.ts (#1622)
 *
 * 本文 (JSON) のどこかの文字列に NULL 文字 (U+0000) があるかを、文字列・配列の要素・オブジェクトのキーと値をたどって見つける。
 * Postgres の text / jsonb は U+0000 を受け付けないので、route はこれで見つけて DB に渡す前に 400 にする。
 */
import { describe, expect, it } from 'vitest';
import { containsNullCharacter } from '@/lib/api/null-character';

const NUL = '\u0000';

describe('containsNullCharacter', () => {
  it.each([
    ['文字列そのもの', `a${NUL}b`],
    ['先頭の NULL 文字', `${NUL}abc`],
    ['NULL 文字だけ', NUL],
    ['配列の要素', ['ok', `ng${NUL}`]],
    ['オブジェクトの値', { note: `x${NUL}` }],
    ['オブジェクトのキー', { [`k${NUL}`]: 'v' }],
    ['入れ子の配列の中のオブジェクトの値', { a: [{ b: [1, { c: `${NUL}` }] }] }],
  ])('%s にあれば true', (_name, value) => {
    expect(containsNullCharacter(value)).toBe(true);
  });

  it.each([
    ['普通の文字列', 'こんにちは'],
    ['NULL 以外の制御文字', 'test\u0001\u0002\u001B[31m'],
    ['「\\0」と書いた 2 文字 (バックスラッシュと 0)', 'a\\0b'],
    ['「\\u0000」と書いた 6 文字', 'a\\u0000b'],
    ['数', 0],
    ['真偽値', false],
    ['null', null],
    ['undefined', undefined],
    ['空のオブジェクト', {}],
    ['空の配列', []],
    ['入れ子の普通の値', { a: [{ b: [1, { c: 'ok' }] }], d: null }],
  ])('%s なら false', (_name, value) => {
    expect(containsNullCharacter(value)).toBe(false);
  });

  it('JSON の文字列の \\u0000 を JSON.parse した値でも見つける (route が受け取る形)', () => {
    const body: unknown = JSON.parse('{"startDate":"2026-07-06","note":"test\\u0000injection"}');
    expect(containsNullCharacter(body)).toBe(true);
  });

  it('深く入れ子にした値でもスタックを溢れさせずにたどる', () => {
    // 再帰でたどるとスタックが溢れる深さ
    const depth = 100_000;
    let nested: unknown = `deep${NUL}`;
    for (let i = 0; i < depth; i++) nested = [nested];
    expect(containsNullCharacter(nested)).toBe(true);

    let clean: unknown = 'deep';
    for (let i = 0; i < depth; i++) clean = { child: clean };
    expect(containsNullCharacter(clean)).toBe(false);
  });

  it('循環した値でも止まる', () => {
    const cyclic: Record<string, unknown> = { a: 'ok' };
    cyclic.self = cyclic;
    expect(containsNullCharacter(cyclic)).toBe(false);
    cyclic.b = `ng${NUL}`;
    expect(containsNullCharacter(cyclic)).toBe(true);
  });
});
