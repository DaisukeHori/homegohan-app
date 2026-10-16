import { describe, it, expect, afterEach, vi } from 'vitest';

// next.config.mjs は import 時に process.env を読むため、テストごとに
// クエリ文字列付きで動的 import してフレッシュな評価を行う。
async function loadNextConfig() {
  vi.resetModules();
  const mod = await import(/* @vite-ignore */ `../../../next.config.mjs?t=${Date.now()}-${Math.random()}`);
  return mod.default;
}

/** next.config.mjs の headers() の 1 群 (source と headers) */
interface HeaderGroup {
  source: string;
  headers: Array<{ key: string; value: string }>;
}

/** headers() の群と、全パス ('/(.*)') に当てる群 (CSP は #1169 で middleware へ移したので、ここでは探さない) */
async function getSecurityHeaders(config: { headers: () => Promise<HeaderGroup[]> }) {
  const headerGroups = await config.headers();
  const securityGroup = headerGroups.find((group) => group.source === '/(.*)');
  if (securityGroup === undefined) throw new Error("next.config.mjs の headers() に '/(.*)' の群が無い");
  return { headerGroups, securityGroup };
}

describe('next.config.mjs headers (#1044)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // #1169: CSP は src/proxy.ts が毎リクエスト nonce つきで付ける (src/lib/security/csp.ts)。
  // headers() にも書くと応答に 2 つ並び、ブラウザは両方を満たすものしか通さないので、nonce の無い方が nonce つきのスクリプトを止める。
  // 方針の中身 (#1166 PostHog・F6-09 の許可済みドメイン・Supabase の origin) の検査は src/__tests__/lib/security/csp.test.ts にある
  it('headers() に Content-Security-Policy が無い (CSP は middleware が付ける。二重に付けない)', async () => {
    const config = await loadNextConfig();
    const { headerGroups } = await getSecurityHeaders(config);

    for (const group of headerGroups) {
      const keys = group.headers.map((header) => header.key.toLowerCase());
      expect(keys, group.source).not.toContain('content-security-policy');
      expect(keys, group.source).not.toContain('content-security-policy-report-only');
    }
  });

  it('X-Frame-Options・X-Content-Type-Options・X-XSS-Protection・HSTS は残る', async () => {
    const config = await loadNextConfig();
    const { securityGroup } = await getSecurityHeaders(config);
    const valueOf = (key: string) => securityGroup.headers.find((header) => header.key === key)?.value;

    expect(valueOf('X-Frame-Options')).toBe('DENY');
    expect(valueOf('X-Content-Type-Options')).toBe('nosniff');
    expect(valueOf('X-XSS-Protection')).toBe('1; mode=block');
    expect(valueOf('Strict-Transport-Security')).toBe('max-age=63072000; includeSubDomains; preload');
  });

  it('F6-08: 長期キャッシュ設定は静的アセット (sample-meal.webp) のみを対象にする', async () => {
    const config = await loadNextConfig();
    const { headerGroups } = await getSecurityHeaders(config);

    const cacheRule = headerGroups.find((group) => group.headers.some((header) => header.key === 'Cache-Control'));
    if (cacheRule === undefined) throw new Error('Cache-Control の群が無い');

    expect(cacheRule.source).toBe('/handson-tour/sample-meal.webp');
    // ワイルドカードパターンでないこと (認証必須ページにマッチしないことの確認)
    expect(cacheRule.source).not.toBe('/handson-tour/(.*)');
    expect(cacheRule.source).not.toMatch(/\(.*\)/);

    const cacheControl = cacheRule.headers.find((header) => header.key === 'Cache-Control')?.value;
    expect(cacheControl).toContain('immutable');
  });
});
