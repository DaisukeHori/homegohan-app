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

  // #1166: 利用状況の計測 (PostHog) はやめた。CSP が PostHog への送信を許していると、
  // 後から SDK を入れ直したときに黙って送信できてしまうので、許可の復活を止める。
  it('#1166: connect-src に PostHog のホストを含まない', async () => {
    const config = await loadNextConfig();
    const { csp } = await getSecurityHeaders(config);

    expect(csp).toContain('connect-src');
    expect(csp.toLowerCase()).not.toContain('posthog');
  });

  it('#1166: NEXT_PUBLIC_POSTHOG_HOST が環境に残っていても、そのホストを CSP に出さない', async () => {
    vi.stubEnv('NEXT_PUBLIC_POSTHOG_HOST', 'https://eu.i.posthog.com');
    const config = await loadNextConfig();
    const { csp } = await getSecurityHeaders(config);

    expect(csp).not.toContain('eu.i.posthog.com');
    expect(csp.toLowerCase()).not.toContain('posthog');
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

  it('本番の Supabase (*.supabase.co) では CSP に個別の origin を加えない', async () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://flmeolcfutuwwbjmzyoz.supabase.co');
    const config = await loadNextConfig();
    const { csp } = await getSecurityHeaders(config);

    expect(csp).toContain(
      "img-src 'self' data: blob: *.supabase.co images.unsplash.com;",
    );
    expect(csp).toContain(
      "connect-src 'self' *.supabase.co *.vercel.app wss://*.supabase.co;",
    );
  });

  it('ローカルの Supabase (http://127.0.0.1:54321) は connect-src (http / ws) と img-src に加える', async () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'http://127.0.0.1:54321');
    const config = await loadNextConfig();
    const { csp } = await getSecurityHeaders(config);

    const connectSrc = csp.split('; ').find((d) => d.startsWith('connect-src')) ?? '';
    const imgSrc = csp.split('; ').find((d) => d.startsWith('img-src')) ?? '';
    expect(connectSrc).toContain('http://127.0.0.1:54321');
    expect(connectSrc).toContain('ws://127.0.0.1:54321');
    expect(imgSrc).toContain('http://127.0.0.1:54321');
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
