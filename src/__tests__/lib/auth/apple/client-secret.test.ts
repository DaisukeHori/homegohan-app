// @vitest-environment node
/**
 * Apple の client_secret (ES256 の JWT) の作成 (docs/design/mobile/08-sign-in-with-apple.md §11.2)
 * 鍵はテストの中で作った P-256 の使い捨て (本物の Apple の鍵ではない)。
 */
import { generateKeyPairSync, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createAppleClientSecret } from '@/lib/auth/apple/client-secret';
import { APPLE_CLIENT_SECRET_AUDIENCE, APPLE_CLIENT_SECRET_TTL_SECONDS } from '@/lib/auth/apple/config';

/** Apple が許す client_secret の最長の有効期間 (6 か月 = 15,777,000 秒。設計書 F-14) */
const APPLE_CLIENT_SECRET_MAX_TTL_SECONDS = 15_777_000;
const ISSUED_AT_SECONDS = 1_800_000_000;
const TEAM_ID = 'TEAMID1234';
const KEY_ID = 'KEYID12345';
const CLIENT_ID = 'com.homegohan.app';

const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const PRIVATE_KEY_PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

function make(overrides: Partial<Parameters<typeof createAppleClientSecret>[0]> = {}): string {
  return createAppleClientSecret({
    teamId: TEAM_ID,
    keyId: KEY_ID,
    privateKeyPem: PRIVATE_KEY_PEM,
    clientId: CLIENT_ID,
    issuedAtSeconds: ISSUED_AT_SECONDS,
    ttlSeconds: APPLE_CLIENT_SECRET_TTL_SECONDS,
    ...overrides,
  });
}

function decode(part: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>;
}

describe('createAppleClientSecret', () => {
  it('ES256 の JWT: header は { alg: ES256, kid }、payload は iss / iat / exp = iat + ttl / aud / sub', () => {
    const [header, payload, signature] = make().split('.');
    expect(decode(header)).toEqual({ alg: 'ES256', kid: KEY_ID });
    expect(decode(payload)).toEqual({
      iss: TEAM_ID,
      iat: ISSUED_AT_SECONDS,
      exp: ISSUED_AT_SECONDS + APPLE_CLIENT_SECRET_TTL_SECONDS,
      aud: APPLE_CLIENT_SECRET_AUDIENCE,
      sub: CLIENT_ID,
    });
    expect(signature).toBeTruthy();
  });

  it('sub は渡した client_id (Web の Services ID でも同じ形)', () => {
    const [, payload] = make({ clientId: 'com.example.services' }).split('.');
    expect(decode(payload).sub).toBe('com.example.services');
  });

  it('署名は node:crypto の verify (ieee-p1363) で検証でき、生の 64 バイトで、別の入力では検証できない', () => {
    const [header, payload, signature] = make().split('.');
    const raw = Buffer.from(signature, 'base64url');
    expect(raw.length).toBe(64);
    const verifyKey = publicKey;
    expect(verify('sha256', Buffer.from(`${header}.${payload}`), { key: verifyKey, dsaEncoding: 'ieee-p1363' }, raw)).toBe(true);
    expect(verify('sha256', Buffer.from(`${header}.${payload}x`), { key: verifyKey, dsaEncoding: 'ieee-p1363' }, raw)).toBe(false);
  });

  it('exp - iat が 6 か月 (15,777,000 秒) を超えない (APPLE_CLIENT_SECRET_TTL_SECONDS)', () => {
    const [, payload] = make().split('.');
    const claims = decode(payload) as { iat: number; exp: number };
    expect(claims.exp - claims.iat).toBe(APPLE_CLIENT_SECRET_TTL_SECONDS);
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(APPLE_CLIENT_SECRET_MAX_TTL_SECONDS);
  });

  it('壊れた秘密鍵は投げる (呼ぶ側 registerAppleAuthorization / revocation が受け止める)。PEM の中身は例外の文に出ない', () => {
    expect(() => make({ privateKeyPem: 'broken-pem-SECRET_PEM_BODY' })).toThrow();
    try {
      make({ privateKeyPem: 'broken-pem-SECRET_PEM_BODY' });
    } catch (error) {
      expect(String(error)).not.toContain('SECRET_PEM_BODY');
    }
  });
});
