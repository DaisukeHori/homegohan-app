// @vitest-environment node
/**
 * src/lib/push-token-install-secret.ts (端末の秘密の値の発行とハッシュ。#1636) のテスト
 *   - 発行する値は取り決めの形 (packages/shared の isPushInstallSecret) で、毎回違う
 *   - ハッシュは SHA-256 の 16 進の小文字 64 文字 (migration の CHECK と同じ形) で、同じ値なら同じ・違う値なら違う
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { isPushInstallSecret } from '@homegohan/shared';
import {
  PUSH_INSTALL_SECRET_HASH_PATTERN,
  generatePushInstallSecret,
  hashPushInstallSecret,
} from '@/lib/push-token-install-secret';

/** 発行を繰り返す回数 (重複が無いこと・形が崩れないことを見る) */
const SAMPLE_COUNT = 100;

describe('generatePushInstallSecret', () => {
  it('取り決めの形の値を作り、毎回違う', () => {
    const values = Array.from({ length: SAMPLE_COUNT }, () => generatePushInstallSecret());
    for (const value of values) expect(isPushInstallSecret(value), value).toBe(true);
    expect(new Set(values).size).toBe(SAMPLE_COUNT);
  });
});

describe('hashPushInstallSecret', () => {
  it('SHA-256 の 16 進の小文字 64 文字 (migration の CHECK の形)', () => {
    const secret = generatePushInstallSecret();
    const hash = hashPushInstallSecret(secret);
    expect(hash).toMatch(PUSH_INSTALL_SECRET_HASH_PATTERN);
    expect(PUSH_INSTALL_SECRET_HASH_PATTERN.source).toBe('^[0-9a-f]{64}$');
    expect(hash).toBe(createHash('sha256').update(secret, 'utf8').digest('hex'));
  });

  it('同じ値なら同じハッシュ、違う値なら違うハッシュ (値そのものは含まない)', () => {
    const a = generatePushInstallSecret();
    const b = generatePushInstallSecret();
    expect(hashPushInstallSecret(a)).toBe(hashPushInstallSecret(a));
    expect(hashPushInstallSecret(a)).not.toBe(hashPushInstallSecret(b));
    expect(hashPushInstallSecret(a)).not.toContain(a);
  });
});
