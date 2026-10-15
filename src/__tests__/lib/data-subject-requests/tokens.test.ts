/**
 * #1178 本人確認リンクのトークン src/lib/data-subject-requests/tokens.ts の単体テスト (設計 cross/15 §5・§15)
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { dsrVerifyBodySchema } from '@/lib/data-subject-requests/core';
import {
  DSR_TOKEN_BYTES,
  dsrTokenMatches,
  generateDsrVerificationToken,
  hashDsrVerificationToken,
} from '@/lib/data-subject-requests/tokens';

const HEX_64 = /^[0-9a-f]{64}$/;

describe('generateDsrVerificationToken', () => {
  it('64 桁の 16 進のトークンと、その sha256 (16 進) の hash を返す', () => {
    const { token, tokenHash } = generateDsrVerificationToken();
    expect(DSR_TOKEN_BYTES).toBe(32);
    expect(token).toMatch(HEX_64);
    expect(tokenHash).toMatch(HEX_64);
    expect(tokenHash).toBe(createHash('sha256').update(token, 'utf8').digest('hex'));
    expect(tokenHash).not.toBe(token);
    // 本人確認の本文の検査 (dsrVerifyBodySchema) をそのまま通る形
    expect(dsrVerifyBodySchema.safeParse({ token }).success).toBe(true);
  });

  it('呼ぶたびに別のトークンになる', () => {
    const tokens = new Set(Array.from({ length: 20 }, () => generateDsrVerificationToken().token));
    expect(tokens.size).toBe(20);
  });
});

describe('hashDsrVerificationToken', () => {
  it('sha256 の 16 進 (既知の値)', () => {
    expect(hashDsrVerificationToken('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

describe('dsrTokenMatches', () => {
  it('作ったトークンと hash は一致する', () => {
    const { token, tokenHash } = generateDsrVerificationToken();
    expect(dsrTokenMatches(token, tokenHash)).toBe(true);
  });

  it('1 文字違うトークン・保存した hash が null・hash の長さが違うときは false', () => {
    const { token, tokenHash } = generateDsrVerificationToken();
    const last = token.slice(-1);
    const changed = `${token.slice(0, -1)}${last === '0' ? '1' : '0'}`;
    expect(dsrTokenMatches(changed, tokenHash)).toBe(false);
    expect(dsrTokenMatches(token, null)).toBe(false);
    expect(dsrTokenMatches(token, '')).toBe(false);
    expect(dsrTokenMatches(token, tokenHash.slice(0, -1))).toBe(false);
    // 生のトークンを hash として保存していても一致しない (hash どうしを比べる)
    expect(dsrTokenMatches(token, token)).toBe(false);
  });
});
