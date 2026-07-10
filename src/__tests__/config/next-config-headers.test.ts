import { describe, it, expect, afterEach, vi } from 'vitest';

// next.config.mjs は import 時に process.env を読むため、テストごとに
// クエリ文字列付きで動的 import してフレッシュな評価を行う。
async function loadNextConfig() {
  vi.resetModules();
  const mod = await import(/* @vite-ignore */ `../../../next.config.mjs?t=${Date.now()}-${Math.random()}`);
  return mod.default;
}

async function getSecurityHeaders(config: any) {
  const headerGroups = await config.headers();
  const securityGroup = headerGroups.find((g: any) => g.source === '/(.*)');
  const csp = securityGroup.headers.find((h: any) => h.key === 'Content-Security-Policy').value as string;
  return { headerGroups, csp };
}

describe('next.config.mjs headers (#1044)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('F6-09: connect-src にデフォルトの PostHog ホストを含む', async () => {
    const config = await loadNextConfig();
    const { csp } = await getSecurityHeaders(config);

    expect(csp).toContain('connect-src');
    expect(csp).toContain('https://us.i.posthog.com');
  });

  it('F6-09: NEXT_PUBLIC_POSTHOG_HOST が設定されている場合はそのホストを使う', async () => {
    vi.stubEnv('NEXT_PUBLIC_POSTHOG_HOST', 'https://eu.i.posthog.com');
    const config = await loadNextConfig();
    const { csp } = await getSecurityHeaders(config);

    expect(csp).toContain('https://eu.i.posthog.com');
  });

  it('F6-09: 既存の許可済みドメイン (supabase/vercel) は壊れていない', async () => {
    const config = await loadNextConfig();
    const { csp } = await getSecurityHeaders(config);

    expect(csp).toContain('*.supabase.co');
    expect(csp).toContain('*.vercel.app');
    expect(csp).toContain("wss://*.supabase.co");
    expect(csp).toContain("script-src 'self' 'unsafe-inline'");
    expect(csp).toContain('*.vercel-scripts.com');
    expect(csp).toContain("style-src 'self' 'unsafe-inline'");
    expect(csp).toContain('img-src');
    expect(csp).toContain('images.unsplash.com');
    expect(csp).toContain("font-src 'self'");
  });

  it('F6-08: 長期キャッシュ設定は静的アセット (sample-meal.webp) のみを対象にする', async () => {
    const config = await loadNextConfig();
    const { headerGroups } = await getSecurityHeaders(config);

    const cacheRule = headerGroups.find((g: any) =>
      g.headers.some((h: any) => h.key === 'Cache-Control'),
    );

    expect(cacheRule.source).toBe('/handson-tour/sample-meal.webp');
    // ワイルドカードパターンでないこと (認証必須ページにマッチしないことの確認)
    expect(cacheRule.source).not.toBe('/handson-tour/(.*)');
    expect(cacheRule.source).not.toMatch(/\(.*\)/);

    const cacheControl = cacheRule.headers.find((h: any) => h.key === 'Cache-Control').value;
    expect(cacheControl).toContain('immutable');
  });
});
