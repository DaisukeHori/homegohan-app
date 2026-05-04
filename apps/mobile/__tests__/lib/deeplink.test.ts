/**
 * deeplink.test.ts
 * src/lib/deeplink.ts の extractSupabaseLinkParams() をテストする
 */

import { extractSupabaseLinkParams } from '../../src/lib/deeplink';

describe('extractSupabaseLinkParams()', () => {
  it('フラグメント部の access_token を抽出できる', () => {
    const url = 'myapp://callback#access_token=TOKEN123&token_type=bearer';
    const result = extractSupabaseLinkParams(url);
    expect(result.access_token).toBe('TOKEN123');
  });

  it('フラグメント部の refresh_token を抽出できる', () => {
    const url = 'myapp://callback#access_token=A&refresh_token=REFRESH456';
    const result = extractSupabaseLinkParams(url);
    expect(result.refresh_token).toBe('REFRESH456');
  });

  it('クエリパラメータの code を抽出できる', () => {
    const url = 'https://example.com/auth/callback?code=AUTHCODE789';
    const result = extractSupabaseLinkParams(url);
    expect(result.code).toBe('AUTHCODE789');
  });

  it('フラグメントがクエリより優先される', () => {
    const url = 'https://example.com/auth?access_token=QUERY#access_token=FRAGMENT';
    const result = extractSupabaseLinkParams(url);
    expect(result.access_token).toBe('FRAGMENT');
  });

  it('error と error_description を抽出できる', () => {
    const url = 'myapp://callback#error=access_denied&error_description=User+denied';
    const result = extractSupabaseLinkParams(url);
    expect(result.error).toBe('access_denied');
    expect(result.error_description).toBe('User denied');
  });

  it('type フィールドを抽出できる', () => {
    const url = 'myapp://callback#type=recovery&token_hash=HASH';
    const result = extractSupabaseLinkParams(url);
    expect(result.type).toBe('recovery');
    expect(result.token_hash).toBe('HASH');
  });

  it('パラメータがない場合は undefined を返す', () => {
    const result = extractSupabaseLinkParams('myapp://callback');
    expect(result.access_token).toBeUndefined();
    expect(result.code).toBeUndefined();
    expect(result.error).toBeUndefined();
  });
});
