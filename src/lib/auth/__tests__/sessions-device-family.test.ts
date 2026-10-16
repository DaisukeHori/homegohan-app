/**
 * src/lib/auth/sessions/device-family.ts の単体テスト (#1190。設計 docs/design/cross/16-auth-history-sessions.md §12.1・§20.1)
 */
import { describe, expect, it } from 'vitest';
import {
  SERVER_DEVICE_FAMILY_KEY,
  UNKNOWN_DEVICE_FAMILY_KEY,
  deviceFamilyOf,
  deviceLabelOf,
} from '../sessions/device-family';

const IPHONE_SAFARI =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const ANDROID_CHROME =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';
const WINDOWS_EDGE =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0';
const MAC_FIREFOX = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14.5; rv:127.0) Gecko/20100101 Firefox/127.0';
const IOS_APP = 'homegohan/1 CFNetwork/1494.0.7 Darwin/23.4.0';
const ANDROID_APP = 'okhttp/4.12.0';

describe('deviceFamilyOf', () => {
  it('iPhone の Safari を ios/safari にする', () => {
    expect(deviceFamilyOf(IPHONE_SAFARI)).toEqual({ os: 'ios', client: 'safari', key: 'ios/safari' });
  });

  it('Android の Chrome を android/chrome にする', () => {
    expect(deviceFamilyOf(ANDROID_CHROME)).toEqual({ os: 'android', client: 'chrome', key: 'android/chrome' });
  });

  it('Windows の Edge を edge にする (Chrome より先に見る)', () => {
    expect(deviceFamilyOf(WINDOWS_EDGE)).toEqual({ os: 'windows', client: 'edge', key: 'windows/edge' });
  });

  it('Mac の Firefox を macos/firefox にする', () => {
    expect(deviceFamilyOf(MAC_FIREFOX)).toEqual({ os: 'macos', client: 'firefox', key: 'macos/firefox' });
  });

  it('CFNetwork を含む UA を ios/app にする', () => {
    expect(deviceFamilyOf(IOS_APP)).toEqual({ os: 'ios', client: 'app', key: 'ios/app' });
  });

  it('okhttp を android/app にする', () => {
    expect(deviceFamilyOf(ANDROID_APP)).toEqual({ os: 'android', client: 'app', key: 'android/app' });
  });

  it.each(['node', 'undici', 'Next.js Middleware', 'Vercel Edge Functions'])(
    'node・undici・Vercel Edge Functions を other/server にする (%s)',
    (ua) => {
      expect(deviceFamilyOf(ua)).toEqual({ os: 'other', client: 'server', key: 'other/server' });
    },
  );

  it.each([[''], [null], [undefined]] as const)('空・null を other/other にする (%s)', (ua) => {
    expect(deviceFamilyOf(ua)).toEqual({ os: 'other', client: 'other', key: 'other/other' });
  });

  it("deviceFamilyOf('node') の key は SERVER_DEVICE_FAMILY_KEY、deviceFamilyOf('') の key は UNKNOWN_DEVICE_FAMILY_KEY", () => {
    expect(SERVER_DEVICE_FAMILY_KEY).toBe('other/server');
    expect(UNKNOWN_DEVICE_FAMILY_KEY).toBe('other/other');
    expect(deviceFamilyOf('node').key).toBe(SERVER_DEVICE_FAMILY_KEY);
    expect(deviceFamilyOf('').key).toBe(UNKNOWN_DEVICE_FAMILY_KEY);
  });

  it('512 文字より後ろは見ない', () => {
    const padding = 'x'.repeat(512);
    expect(deviceFamilyOf(`${padding} iPhone Safari/604.1`).key).toBe('other/other');
    // 境界: 512 文字の中に収まれば読む
    const inside = `${'x'.repeat(512 - ' Firefox/127.0'.length)} Firefox/127.0`;
    expect(inside).toHaveLength(512);
    expect(deviceFamilyOf(inside).client).toBe('firefox');
  });
});

describe('deviceLabelOf', () => {
  it('deviceLabelOf が app・server・不明・ブラウザの 4 つの形の文言を返す', () => {
    expect(deviceLabelOf(deviceFamilyOf(ANDROID_APP))).toBe('ほめゴハンのアプリ (Android)');
    expect(deviceLabelOf(deviceFamilyOf(IOS_APP))).toBe('ほめゴハンのアプリ (iPhone・iPad)');
    expect(deviceLabelOf(deviceFamilyOf('node'))).toBe('不明な端末');
    expect(deviceLabelOf(deviceFamilyOf(''))).toBe('不明な端末');
    expect(deviceLabelOf(deviceFamilyOf(IPHONE_SAFARI))).toBe('iPhone・iPad の Safari');
    expect(deviceLabelOf(deviceFamilyOf(WINDOWS_EDGE))).toBe('Windows の Edge');
    // OS だけ分かるクライアントの不明なブラウザ
    expect(deviceLabelOf({ os: 'linux', client: 'other', key: 'linux/other' })).toBe('Linux の ブラウザ');
  });
});
