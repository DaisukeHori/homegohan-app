/**
 * #1159: Web のベース URL (src/lib/webBaseUrl.ts) の単体テスト
 *
 * WebViewScreen が WebView で開く Web の URL と、download メッセージの送信元として信用するオリジン
 * (webViewDownload.ts の isTrustedDownloadSender) が、同じ既定値・同じ判定を使うことを確かめる。
 * 食い違うと、正規のエクスポートが「送信元が違う」と捨てられたり、信用するオリジンが WebView の表示と変わったりする。
 */

import { DEFAULT_WEB_URL, buildWebPageUrl, getWebBaseUrl } from '../../src/lib/webBaseUrl';

describe('getWebBaseUrl', () => {
  const originalEnv = process.env.EXPO_PUBLIC_WEB_URL;
  afterEach(() => {
    if (originalEnv === undefined) delete process.env.EXPO_PUBLIC_WEB_URL;
    else process.env.EXPO_PUBLIC_WEB_URL = originalEnv;
  });

  it('既定値は本番の Web', () => {
    expect(DEFAULT_WEB_URL).toBe('https://homegohan-app.vercel.app');
  });

  it('EXPO_PUBLIC_WEB_URL が設定されていれば、その値をそのまま返す (開発用の LAN サーバーなど)', () => {
    process.env.EXPO_PUBLIC_WEB_URL = 'http://192.168.0.10:3000';
    expect(getWebBaseUrl()).toBe('http://192.168.0.10:3000');
  });

  it('EXPO_PUBLIC_WEB_URL が未設定なら既定値', () => {
    delete process.env.EXPO_PUBLIC_WEB_URL;
    expect(getWebBaseUrl()).toBe(DEFAULT_WEB_URL);
  });

  it('EXPO_PUBLIC_WEB_URL が空文字でも既定値 (空文字のまま WebView の URL にしない)', () => {
    process.env.EXPO_PUBLIC_WEB_URL = '';
    expect(getWebBaseUrl()).toBe(DEFAULT_WEB_URL);
  });

  it('呼ぶたびに環境変数を読む (テストや設定の差し替えが反映される)', () => {
    process.env.EXPO_PUBLIC_WEB_URL = 'https://a.example';
    expect(getWebBaseUrl()).toBe('https://a.example');
    process.env.EXPO_PUBLIC_WEB_URL = 'https://b.example';
    expect(getWebBaseUrl()).toBe('https://b.example');
  });
});

describe('buildWebPageUrl (#1049 F7-19)', () => {
  const originalEnv = process.env.EXPO_PUBLIC_WEB_URL;
  const originalApiBase = process.env.EXPO_PUBLIC_API_BASE_URL;
  afterEach(() => {
    if (originalEnv === undefined) delete process.env.EXPO_PUBLIC_WEB_URL;
    else process.env.EXPO_PUBLIC_WEB_URL = originalEnv;
    if (originalApiBase === undefined) delete process.env.EXPO_PUBLIC_API_BASE_URL;
    else process.env.EXPO_PUBLIC_API_BASE_URL = originalApiBase;
  });

  it('Web のオリジンにパスをつなぐ。ベース URL の末尾のスラッシュは吸収する', () => {
    process.env.EXPO_PUBLIC_WEB_URL = 'https://web.example.com///';
    expect(buildWebPageUrl('/terms')).toBe('https://web.example.com/terms');
  });

  it('パスの先頭に "/" が無くても補う', () => {
    delete process.env.EXPO_PUBLIC_WEB_URL;
    expect(buildWebPageUrl('privacy')).toBe(`${DEFAULT_WEB_URL}/privacy`);
  });

  it('API の基点 (EXPO_PUBLIC_API_BASE_URL) は行き先に影響しない', () => {
    delete process.env.EXPO_PUBLIC_WEB_URL;
    process.env.EXPO_PUBLIC_API_BASE_URL = 'https://api.example.com';
    expect(buildWebPageUrl('/terms')).toBe(`${DEFAULT_WEB_URL}/terms`);

    process.env.EXPO_PUBLIC_WEB_URL = 'https://web.example.com';
    expect(buildWebPageUrl('/terms')).toBe('https://web.example.com/terms');
  });
});
