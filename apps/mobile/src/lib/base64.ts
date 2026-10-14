/**
 * base64 の文字列を ArrayBuffer にする (#1049 F7-17)。
 *
 * 端末の写真を expo-file-system で base64 として読み、Supabase Storage へ ArrayBuffer でアップロードするために使う。
 * 実行環境の atob には頼らない (React Native の実行環境の差に左右されず、Jest の Node 環境でも同じ結果にするため)。
 */

/** 標準の base64 (RFC 4648 §4) の 64 文字。並び順が 6 ビットの値 */
const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** base64 の 1 文字が表すビット数 (2^6 = 64 文字) */
const BITS_PER_BASE64_CHAR = 6;
/** 1 バイトのビット数 */
const BITS_PER_BYTE = 8;
/** 1 バイトぶんのビットの取り出し (下位 8 ビット) */
const BYTE_MASK = 0xff;
/** base64 は 4 文字で 3 バイトを表す。長さを 4 で割った余りが 1 になる文字列は、どの長さのバイト列からも作られない */
const BASE64_CHARS_PER_GROUP = 4;
const BYTES_PER_GROUP = 3;
const IMPOSSIBLE_REMAINDER = 1;

/** 文字コード → 6 ビットの値。アルファベットに無い文字は undefined */
const VALUE_OF_CHAR = new Map<number, number>(
  [...BASE64_ALPHABET].map((char, index) => [char.charCodeAt(0), index] as const),
);

export class InvalidBase64Error extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidBase64Error";
    Object.setPrototypeOf(this, InvalidBase64Error.prototype);
  }
}

/**
 * base64 の文字列を ArrayBuffer にする。
 * - 空白・改行は読み飛ばす。末尾の '=' (埋め草) は有っても無くてもよい
 * - 標準の base64 ('+' '/') だけを受け付ける。ほかの文字 (URL 用の '-' '_' など) があれば InvalidBase64Error
 * - 長さがありえない (4 で割った余りが 1) ときも InvalidBase64Error
 */
export function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const clean = base64.replace(/\s+/g, "").replace(/=+$/, "");
  if (clean.length % BASE64_CHARS_PER_GROUP === IMPOSSIBLE_REMAINDER) {
    throw new InvalidBase64Error("base64 の長さが正しくありません");
  }

  const byteLength = Math.floor((clean.length * BYTES_PER_GROUP) / BASE64_CHARS_PER_GROUP);
  const buffer = new ArrayBuffer(byteLength);
  const bytes = new Uint8Array(buffer);

  // 6 ビットずつ足していき、8 ビットたまるたびに 1 バイト取り出す
  let pending = 0;
  let pendingBits = 0;
  let written = 0;
  for (let i = 0; i < clean.length; i += 1) {
    const value = VALUE_OF_CHAR.get(clean.charCodeAt(i));
    if (value === undefined) {
      throw new InvalidBase64Error("base64 に使えない文字が含まれています");
    }
    pending = (pending << BITS_PER_BASE64_CHAR) | value;
    pendingBits += BITS_PER_BASE64_CHAR;
    if (pendingBits >= BITS_PER_BYTE) {
      pendingBits -= BITS_PER_BYTE;
      bytes[written] = (pending >> pendingBits) & BYTE_MASK;
      written += 1;
      // 取り出したビットを捨てる (pending が桁あふれしないように)
      pending &= (1 << pendingBits) - 1;
    }
  }

  return buffer;
}
