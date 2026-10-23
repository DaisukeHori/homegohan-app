// @vitest-environment node
/**
 * Web の Apple のボタンのロゴの画像 (docs/design/mobile/08-sign-in-with-apple.md §11.6・§14.2)。
 * Apple が画像を作り直すとバイトは変わりうるので、ハッシュではなく PNG の形と大きさを確かめる。
 */
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  APPLE_LOGO_IMAGE_SCALE,
  APPLE_LOGO_SRC,
  APPLE_SIGN_IN_BUTTON_HEIGHT_PX,
} from '@/components/auth/AppleSignInButton';

/** PNG の先頭 8 バイト (PNG の仕様の固定の署名) */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** IHDR の幅 (4 バイト・ビッグエンディアン) の位置。署名 8 + 長さ 4 + 種別 4 = 16 (PNG の仕様の固定の位置) */
const IHDR_WIDTH_OFFSET = 16;
/** IHDR の高さの位置 (幅の直後) */
const IHDR_HEIGHT_OFFSET = 20;

const logoPath = path.join(process.cwd(), 'public', APPLE_LOGO_SRC);

describe('Apple のロゴの画像 (段 B)', () => {
  it('public/auth/apple-logo-on-black.png が APPLE_LOGO_SRC の置き場にある', () => {
    expect(APPLE_LOGO_SRC).toBe('/auth/apple-logo-on-black.png');
    expect(existsSync(logoPath)).toBe(true);
  });

  it('先頭 8 バイトが PNG の署名 (89 50 4E 47 0D 0A 1A 0A)', () => {
    const bytes = readFileSync(logoPath);
    expect(bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)).toBe(true);
  });

  it('IHDR の幅と高さが APPLE_SIGN_IN_BUTTON_HEIGHT_PX × APPLE_LOGO_IMAGE_SCALE (168)', () => {
    const bytes = readFileSync(logoPath);
    const expected = APPLE_SIGN_IN_BUTTON_HEIGHT_PX * APPLE_LOGO_IMAGE_SCALE;
    expect(expected).toBe(168);
    expect(bytes.readUInt32BE(IHDR_WIDTH_OFFSET)).toBe(expected);
    expect(bytes.readUInt32BE(IHDR_HEIGHT_OFFSET)).toBe(expected);
  });
});
