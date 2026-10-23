// @vitest-environment node
/**
 * Apple の交換・失効の API と route の本文の Zod スキーマ (docs/design/mobile/08-sign-in-with-apple.md §11.3)
 */
import { describe, expect, it } from 'vitest';
import { APPLE_AUTHORIZATION_CODE_MAX_LENGTH } from '@homegohan/shared';
import {
  AppleAuthorizationBodySchema,
  AppleAuthorizationResponseSchema,
  AppleErrorResponseSchema,
  AppleTokenResponseSchema,
} from '@/lib/auth/apple/schemas';

describe('AppleAuthorizationBodySchema', () => {
  it('1 文字と APPLE_AUTHORIZATION_CODE_MAX_LENGTH 文字は通り、空・APPLE_AUTHORIZATION_CODE_MAX_LENGTH + 1 文字・authorization_code が無い・文字列でない は通らない', () => {
    expect(AppleAuthorizationBodySchema.safeParse({ authorization_code: 'a' }).success).toBe(true);
    expect(AppleAuthorizationBodySchema.safeParse({ authorization_code: 'a'.repeat(APPLE_AUTHORIZATION_CODE_MAX_LENGTH) }).success).toBe(true);
    expect(AppleAuthorizationBodySchema.safeParse({ authorization_code: '' }).success).toBe(false);
    expect(AppleAuthorizationBodySchema.safeParse({ authorization_code: 'a'.repeat(APPLE_AUTHORIZATION_CODE_MAX_LENGTH + 1) }).success).toBe(false);
    expect(AppleAuthorizationBodySchema.safeParse({}).success).toBe(false);
    expect(AppleAuthorizationBodySchema.safeParse({ authorization_code: 123 }).success).toBe(false);
    expect(AppleAuthorizationBodySchema.safeParse({ authorization_code: null }).success).toBe(false);
  });
});

describe('AppleTokenResponseSchema', () => {
  it('refresh_token が無い・空は通らない。access_token・id_token・token_type・expires_in は無くても通る', () => {
    expect(AppleTokenResponseSchema.safeParse({}).success).toBe(false);
    expect(AppleTokenResponseSchema.safeParse({ refresh_token: '' }).success).toBe(false);
    expect(AppleTokenResponseSchema.safeParse({ refresh_token: 'r' }).success).toBe(true);
    expect(
      AppleTokenResponseSchema.safeParse({ refresh_token: 'r', access_token: 'a', id_token: 'i', token_type: 'Bearer', expires_in: 3600 }).success,
    ).toBe(true);
  });
});

describe('AppleErrorResponseSchema', () => {
  it('error が無ければ通らない。error_description は無くても通る', () => {
    expect(AppleErrorResponseSchema.safeParse({}).success).toBe(false);
    expect(AppleErrorResponseSchema.safeParse({ error_description: 'x' }).success).toBe(false);
    expect(AppleErrorResponseSchema.safeParse({ error: 'invalid_grant' }).success).toBe(true);
    expect(AppleErrorResponseSchema.safeParse({ error: 'invalid_grant', error_description: 'x' }).success).toBe(true);
  });
});

describe('AppleAuthorizationResponseSchema', () => {
  it("{ stored: true } と { stored: false, reason: 'not_configured' } は通り、{ stored: false } (reason 無し)・ほかの reason は通らない", () => {
    expect(AppleAuthorizationResponseSchema.safeParse({ stored: true }).success).toBe(true);
    expect(AppleAuthorizationResponseSchema.safeParse({ stored: false, reason: 'not_configured' }).success).toBe(true);
    expect(AppleAuthorizationResponseSchema.safeParse({ stored: false }).success).toBe(false);
    expect(AppleAuthorizationResponseSchema.safeParse({ stored: false, reason: 'other' }).success).toBe(false);
  });
});
