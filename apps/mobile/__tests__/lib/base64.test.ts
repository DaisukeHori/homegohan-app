/**
 * base64.test.ts
 * base64 → ArrayBuffer の変換 (src/lib/base64.ts) のテスト (#1049 F7-17)
 *
 * 冷蔵庫写真は expo-file-system で base64 として読み、ArrayBuffer にして Storage へ送る。
 * 1 バイトでもずれると画像が壊れるので、Node の Buffer による変換と突き合わせる。
 */

import { base64ToArrayBuffer } from '../../src/lib/base64';

/** 再現できる擬似乱数のバイト列 */
function pseudoRandomBytes(length: number, seed = 1): Uint8Array {
  const bytes = new Uint8Array(length);
  let state = seed;
  for (let i = 0; i < length; i++) {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    bytes[i] = state & 0xff;
  }
  return bytes;
}

function toArray(buffer: ArrayBuffer): number[] {
  return Array.from(new Uint8Array(buffer));
}

describe('base64ToArrayBuffer — 正しく変換できる', () => {
  it('空文字列は空の ArrayBuffer', () => {
    const buffer = base64ToArrayBuffer('');

    expect(buffer.byteLength).toBe(0);
  });

  it('既知の値 (Man / Ma / M) を変換できる', () => {
    expect(toArray(base64ToArrayBuffer('TWFu'))).toEqual([77, 97, 110]);
    expect(toArray(base64ToArrayBuffer('TWE='))).toEqual([77, 97]);
    expect(toArray(base64ToArrayBuffer('TQ=='))).toEqual([77]);
  });

  it('末尾の = が無くても同じ結果になる', () => {
    expect(toArray(base64ToArrayBuffer('TWE'))).toEqual([77, 97]);
    expect(toArray(base64ToArrayBuffer('TQ'))).toEqual([77]);
  });

  it('+ と / を含む値を変換できる', () => {
    // 0xFB 0xEF 0xFF -> "++//"
    expect(toArray(base64ToArrayBuffer('++//'))).toEqual([0xfb, 0xef, 0xff]);
  });

  it('JPEG の先頭 (FF D8 FF) を変換できる', () => {
    expect(toArray(base64ToArrayBuffer('/9j/'))).toEqual([0xff, 0xd8, 0xff]);
  });

  it('0 バイトから 64 バイトまで、Node の Buffer と一致する (長さの端数をすべて確かめる)', () => {
    for (let length = 0; length <= 64; length++) {
      const bytes = pseudoRandomBytes(length, length + 1);
      const encoded = Buffer.from(bytes).toString('base64');

      const decoded = base64ToArrayBuffer(encoded);

      expect(decoded.byteLength).toBe(length);
      expect(toArray(decoded)).toEqual(Array.from(bytes));
    }
  });

  it('数 MB の大きさでも一致する (写真を想定)', () => {
    const bytes = pseudoRandomBytes(3 * 1024 * 1024 + 1, 42);
    const encoded = Buffer.from(bytes).toString('base64');

    const decoded = new Uint8Array(base64ToArrayBuffer(encoded));

    expect(decoded.length).toBe(bytes.length);
    // 全要素の比較を 1 回の比較で済ませる (expect に 300 万要素を渡さない)
    expect(Buffer.compare(Buffer.from(decoded), Buffer.from(bytes))).toBe(0);
  });

  it('改行や空白が混ざっていても無視する', () => {
    const bytes = pseudoRandomBytes(100, 7);
    const encoded = Buffer.from(bytes).toString('base64');
    const wrapped = encoded.replace(/(.{20})/g, '$1\r\n') + ' \n';

    expect(toArray(base64ToArrayBuffer(wrapped))).toEqual(Array.from(bytes));
  });
});

describe('base64ToArrayBuffer — 不正な入力は例外にする', () => {
  it('base64 に使えない文字があれば例外', () => {
    expect(() => base64ToArrayBuffer('TW*u')).toThrow();
    expect(() => base64ToArrayBuffer('TWFu-')).toThrow();
    expect(() => base64ToArrayBuffer('日本語です')).toThrow();
  });

  it('途中に = があれば例外 (末尾以外の = は認めない)', () => {
    expect(() => base64ToArrayBuffer('TQ==TQ==')).toThrow();
  });

  it('長さが不正 (4 で割った余りが 1) なら例外', () => {
    expect(() => base64ToArrayBuffer('T')).toThrow();
    expect(() => base64ToArrayBuffer('TWFuT')).toThrow();
  });
});
