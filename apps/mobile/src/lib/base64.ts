/**
 * base64 文字列のデコード。
 *
 * ファイルを base64 で読み (expo-file-system)、Storage へ ArrayBuffer としてアップロードするために使う。
 * 実行環境の atob には頼らず、ここで完結させている (atob が無い環境でも、Jest の Node 環境でも同じ結果になる)。
 */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const INVALID = 255;

// 文字コード → 6 ビットの値。ASCII 以外と、アルファベット外の文字は INVALID。
const LOOKUP = new Uint8Array(128).fill(INVALID);
for (let i = 0; i < ALPHABET.length; i++) {
  LOOKUP[ALPHABET.charCodeAt(i)] = i;
}

/**
 * base64 文字列を ArrayBuffer にする。
 *
 * - 空白・改行は無視する。末尾の `=` は有っても無くてもよい。
 * - 標準の base64 (`+` `/`) だけを受け付ける。それ以外の文字があれば例外を投げる。
 * - 長さが不正 (4 で割った余りが 1) な場合も例外を投げる。
 */
export function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const clean = base64.replace(/\s+/g, '').replace(/=+$/, '');
  if (clean.length % 4 === 1) {
    throw new Error('base64 の長さが正しくありません');
  }

  const buffer = new ArrayBuffer(Math.floor((clean.length * 3) / 4));
  const bytes = new Uint8Array(buffer);

  let accumulator = 0;
  let bits = 0;
  let out = 0;
  for (let i = 0; i < clean.length; i++) {
    const code = clean.charCodeAt(i);
    const value = code < 128 ? LOOKUP[code] : INVALID;
    if (value === INVALID) {
      throw new Error('base64 に使えない文字が含まれています');
    }
    accumulator = (accumulator << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[out++] = (accumulator >> bits) & 0xff;
      // 取り出した分を捨てる (桁あふれを避ける)
      accumulator &= (1 << bits) - 1;
    }
  }

  return buffer;
}
