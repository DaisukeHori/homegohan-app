// @vitest-environment node
/**
 * 表 apple_sign_in_tokens の読み書き (docs/design/mobile/08-sign-in-with-apple.md §11.3)。表は from の偽物。
 */
import { describe, expect, it, vi } from 'vitest';
import { listAppleRefreshTokens, storeAppleRefreshToken, type AppleTokenStore } from '@/lib/auth/apple/tokens';

const USER = '11111111-1111-4111-8111-111111111111';
const CLIENT_ID = 'com.homegohan.app';
const FIXED_NOW = new Date('2026-10-24T01:02:03.000Z');

describe('storeAppleRefreshToken', () => {
  it('upsert の onConflict は user_id,client_id。行の中身は user_id・client_id・refresh_token・updated_at', async () => {
    const upsert = vi.fn(async () => ({ error: null }));
    const from = vi.fn(() => ({ upsert }));
    const admin = { from } as unknown as AppleTokenStore;

    await storeAppleRefreshToken(admin, { userId: USER, clientId: CLIENT_ID, refreshToken: 'rt-1', now: () => FIXED_NOW });

    expect(from).toHaveBeenCalledWith('apple_sign_in_tokens');
    expect(upsert).toHaveBeenCalledWith(
      { user_id: USER, client_id: CLIENT_ID, refresh_token: 'rt-1', updated_at: FIXED_NOW.toISOString() },
      { onConflict: 'user_id,client_id' },
    );
  });

  it('error は投げる (呼ぶ側が段階に応じて受け止める)', async () => {
    const failure = { message: 'boom', code: '42P01' };
    const admin = { from: () => ({ upsert: async () => ({ error: failure }) }) } as unknown as AppleTokenStore;
    await expect(storeAppleRefreshToken(admin, { userId: USER, clientId: CLIENT_ID, refreshToken: 'rt-1' })).rejects.toBe(failure);
  });
});

describe('listAppleRefreshTokens', () => {
  it('user_id で絞って client_id と refresh_token を返す', async () => {
    const eq = vi.fn(async () => ({ data: [{ client_id: CLIENT_ID, refresh_token: 'rt-1' }], error: null }));
    const select = vi.fn(() => ({ eq }));
    const from = vi.fn(() => ({ select }));
    const admin = { from } as unknown as AppleTokenStore;

    const rows = await listAppleRefreshTokens(admin, USER);

    expect(from).toHaveBeenCalledWith('apple_sign_in_tokens');
    expect(select).toHaveBeenCalledWith('client_id, refresh_token');
    expect(eq).toHaveBeenCalledWith('user_id', USER);
    expect(rows).toEqual([{ client_id: CLIENT_ID, refresh_token: 'rt-1' }]);
  });

  it('data が null なら空の配列。error は投げる', async () => {
    const empty = { from: () => ({ select: () => ({ eq: async () => ({ data: null, error: null }) }) }) } as unknown as AppleTokenStore;
    expect(await listAppleRefreshTokens(empty, USER)).toEqual([]);

    const failure = { message: 'relation does not exist', code: '42P01' };
    const failing = { from: () => ({ select: () => ({ eq: async () => ({ data: null, error: failure }) }) }) } as unknown as AppleTokenStore;
    await expect(listAppleRefreshTokens(failing, USER)).rejects.toBe(failure);
  });
});
