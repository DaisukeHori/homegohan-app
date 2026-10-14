/**
 * tests/api/handson-tour-replay-route.test.ts
 *
 * Issue #1045 (F6-05): /handson-tour/layout.tsx は Next.js の仕様上 searchParams を
 * 受け取れないため、?force=1 の判定を専用ルート (Cookie 発行) に切り出した。
 * この route が Cookie を発行しつつ /handson-tour へリダイレクトすることを検証する。
 */

import { describe, expect, it } from 'vitest';
import { GET } from '../../src/app/handson-tour/replay/route';
import { HANDSON_TOUR_FORCE_COOKIE } from '../../src/lib/handson-tour/force-cookie';

function makeRequest(baseUrl = 'https://homegohan-app.vercel.app') {
  return new Request(new URL('/handson-tour/replay', baseUrl).toString());
}

describe('#1045 F6-05: /handson-tour/replay', () => {
  it('/handson-tour へリダイレクトする', async () => {
    const res = await GET(makeRequest());
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toContain('/handson-tour');
  });

  it('force Cookie (httpOnly) を発行する', async () => {
    const res = await GET(makeRequest());
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain(`${HANDSON_TOUR_FORCE_COOKIE}=1`);
    expect(setCookie.toLowerCase()).toContain('httponly');
  });

  it('リダイレクト先は同一オリジンの /handson-tour である (別オリジンに飛ばない)', async () => {
    const res = await GET(makeRequest('https://homegohan-app.vercel.app'));
    const location = res.headers.get('location')!;
    expect(new URL(location).origin).toBe('https://homegohan-app.vercel.app');
    expect(new URL(location).pathname).toBe('/handson-tour');
  });
});
