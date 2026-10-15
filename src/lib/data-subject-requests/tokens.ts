// src/lib/data-subject-requests/tokens.ts
// #1178 本人確認リンクのトークン。生のトークンはメールにだけ入れ、DB には sha256 (16 進) だけを置く。
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** トークンの乱数のバイト数 (16 進で 64 文字。dsrVerifyBodySchema の正規表現と対) */
export const DSR_TOKEN_BYTES = 32;

export function hashDsrVerificationToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** 新しいトークンと、DB に置く hash を作る */
export function generateDsrVerificationToken(): { token: string; tokenHash: string } {
  const token = randomBytes(DSR_TOKEN_BYTES).toString('hex');
  return { token, tokenHash: hashDsrVerificationToken(token) };
}

/** 受け取ったトークンが保存した hash と一致するか (長さが違えば false。比較は一定時間) */
export function dsrTokenMatches(token: string, storedHash: string | null): boolean {
  if (!storedHash) return false;
  const given = Buffer.from(hashDsrVerificationToken(token), 'utf8');
  const stored = Buffer.from(storedHash, 'utf8');
  if (given.length !== stored.length) return false;
  return timingSafeEqual(given, stored);
}
