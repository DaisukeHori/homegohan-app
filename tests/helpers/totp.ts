/**
 * テストの道具: TOTP (RFC 6238 / SHA-1 / 30 秒 / 6 桁) の 6 桁を作る (#1176。docs/design/cross/12-operator-mfa.md §22.4)
 *
 * Supabase の factor の secret (base32) から、認証アプリと同じ 6 桁を作る。依存なし (node:crypto だけ)。
 * 結合テスト (段 B の tests/integration/helpers/mfa.ts) が使う。e2e は同じ内容の素の JavaScript (tests/e2e/helpers/totp.mjs)。
 * 2 つが同じ値を出すことは tests/totp-helper.test.ts が RFC 6238 Appendix B で確かめる。
 */
import { createHmac } from 'node:crypto';

/** 1 つのコードが使える時間 (秒。RFC 6238 の既定・Supabase の TOTP) */
export const TOTP_STEP_SECONDS = 30;
/** コードの桁数 (Supabase の TOTP) */
export const TOTP_DIGITS = 6;

/** base32 (RFC 4648) の字母 */
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
/** base32 の 1 文字が持つビット数 */
const BASE32_BITS_PER_CHAR = 5;
/** 1 バイトのビット数 */
const BITS_PER_BYTE = 8;
/** 1 バイトの最大値 (下位 8 ビットを取り出すマスク) */
const BYTE_MASK = 0xff;
/** HOTP の counter のバイト数 (RFC 4226: 8 バイトのビッグエンディアン) */
const HOTP_COUNTER_BYTES = 8;
/** HOTP の dynamic truncation の offset を取り出すマスク (最後のバイトの下位 4 ビット) */
const HOTP_OFFSET_MASK = 0x0f;
/** HOTP の dynamic truncation で取り出す 31 ビットのマスク (最上位ビットを落とす) */
const HOTP_BINARY_MASK = 0x7fffffff;
/** 10 進の桁を数で取り出す底 */
const DECIMAL_BASE = 10;
/** ミリ秒を秒にする */
const MILLISECONDS_PER_SECOND = 1000;

/** base32 の secret をバイト列にする (空白・= の詰め物・小文字を許す)。字母の外の文字があれば例外 */
export function decodeBase32(secret: string): Buffer {
  const normalized = secret.replace(/[\s=]/g, '').toUpperCase();
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const ch of normalized) {
    const value = BASE32_ALPHABET.indexOf(ch);
    if (value < 0) throw new Error('base32 の secret に使えない文字があります');
    buffer = (buffer << BASE32_BITS_PER_CHAR) | value;
    bits += BASE32_BITS_PER_CHAR;
    if (bits >= BITS_PER_BYTE) {
      bits -= BITS_PER_BYTE;
      bytes.push((buffer >> bits) & BYTE_MASK);
    }
  }
  return Buffer.from(bytes);
}

/** その時刻 (秒。省略すると今) の 6 桁 (先頭の 0 を保つ文字列) */
export function generateTotp(secret: string, atUnixSeconds: number = Date.now() / MILLISECONDS_PER_SECOND): string {
  const key = decodeBase32(secret);
  let counter = Math.floor(atUnixSeconds / TOTP_STEP_SECONDS);
  const counterBytes = Buffer.alloc(HOTP_COUNTER_BYTES);
  for (let i = HOTP_COUNTER_BYTES - 1; i >= 0; i -= 1) {
    counterBytes[i] = counter & BYTE_MASK;
    counter = Math.floor(counter / (BYTE_MASK + 1));
  }
  const digest = createHmac('sha1', key).update(counterBytes).digest();
  const offset = digest[digest.length - 1] & HOTP_OFFSET_MASK;
  const binary = digest.readUInt32BE(offset) & HOTP_BINARY_MASK;
  return String(binary % DECIMAL_BASE ** TOTP_DIGITS).padStart(TOTP_DIGITS, '0');
}
