/**
 * #1179: Vercel Speed Insights (表示速度の計測) の導入
 *
 * Sentry / Better Stack は採用せず、性能の計測は Speed Insights だけにする (docs/design/00-architecture.md)。
 * ここでは次を確かめる。
 *
 *   1. ルートレイアウト (src/app/layout.tsx) が描画でき、<SpeedInsights /> が <body> の中に 1 つだけある。
 *      既存のスキップリンク・#main-content・子要素は変わらない。
 *   2. 本番で @vercel/speed-insights が読み込むスクリプトは、同じオリジンの /_vercel/speed-insights/script.js。
 *   3. next.config.mjs の CSP は、script-src と connect-src に 'self' を持つ。
 *
 * 2 と 3 がそろっているので、Speed Insights のために CSP を変える必要がない (next.config.mjs は変えていない)。
 * パッケージを上げて読み込み先が別のオリジンに変わったり、CSP から 'self' が消えたりしたら、ここで落ちる。
 *
 * 計測値の送信先 (/_vercel/speed-insights/vitals) は、Vercel が配るスクリプトの側で決まるため、ここでは検査できない。
 * プレビューのデプロイで、ブラウザのコンソールに CSP 違反が出ていないことを確かめる。
 *
 * このリポジトリには @testing-library/react が無いため、react-dom/server で直接描画する
 * (tests/admin-finance-refund-dialog.test.tsx などと同じ流儀)。
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { injectSpeedInsights } from '@vercel/speed-insights';
import { afterEach, describe, expect, it, vi } from 'vitest';

// next/font/google は Next.js のビルド時にだけ使える (テストで呼ぶと失敗する) ので、フォント変数だけ返す偽物にする
vi.mock('next/font/google', () => ({
  Noto_Sans_JP: () => ({ variable: 'font-sans-test' }),
  Noto_Serif_JP: () => ({ variable: 'font-serif-test' }),
}));

// PostHog は初期化しない。子要素をそのまま描画する
vi.mock('@/components/PostHogProvider', async () => {
  const React = await import('react');
  return {
    PostHogProvider: ({ children }: { children: React.ReactNode }) =>
      React.createElement(React.Fragment, null, children),
  };
});

// Speed Insights 本体は、どこに置かれたかが分かる目印に差し替える
// (レイアウトが '@vercel/speed-insights/next' 以外から読み込んでいたら、目印が出ずにテストが落ちる)
const MARKER = 'data-mock="speed-insights"';
vi.mock('@vercel/speed-insights/next', async () => {
  const React = await import('react');
  return {
    SpeedInsights: () => React.createElement('span', { 'data-mock': 'speed-insights' }),
  };
});

const { default: RootLayout } = await import('@/app/layout');

function renderLayout(): string {
  return renderToStaticMarkup(
    <RootLayout>
      <p>ここに画面が入る</p>
    </RootLayout>,
  );
}

describe('#1179 ルートレイアウト (src/app/layout.tsx)', () => {
  it('描画でき、<html lang="ja"> のまま', () => {
    const markup = renderLayout();

    expect(markup.startsWith('<html lang="ja"')).toBe(true);
    expect(markup).toContain('font-sans-test');
    expect(markup).toContain('font-serif-test');
  });

  it('<SpeedInsights /> が <body> の中に 1 つだけある (<head> には置かない)', () => {
    const markup = renderLayout();

    const occurrences = markup.split(MARKER).length - 1;
    expect(occurrences).toBe(1);

    const bodyStart = markup.indexOf('<body');
    const bodyEnd = markup.indexOf('</body>');
    const marker = markup.indexOf(MARKER);
    expect(bodyStart).toBeGreaterThan(-1);
    expect(marker).toBeGreaterThan(bodyStart);
    expect(marker).toBeLessThan(bodyEnd);
  });

  it('スキップリンクと #main-content、その中の子要素は変わらない', () => {
    const markup = renderLayout();

    expect(markup).toContain('<a href="#main-content" class="skip-link">');
    expect(markup).toContain('<div id="main-content"><p>ここに画面が入る</p></div>');
    // 計測は画面の外に置く (子要素の外側、#main-content の後ろ)
    expect(markup.indexOf(MARKER)).toBeGreaterThan(markup.indexOf('</div>'));
  });
});

describe('#1179 Speed Insights のスクリプトの読み込み先と CSP', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    document.head.querySelectorAll('script').forEach((script) => script.remove());
    delete window.si;
    delete window.siq;
  });

  /** next.config.mjs は import 時に process.env を読むので、フレッシュに評価して CSP の値を取り出す */
  async function loadCsp(): Promise<string> {
    vi.resetModules();
    const mod = await import(/* @vite-ignore */ `../next.config.mjs?t=${Date.now()}-${Math.random()}`);
    const headerGroups = await mod.default.headers();
    const securityGroup = headerGroups.find((g: { source: string }) => g.source === '/(.*)');
    return securityGroup.headers.find((h: { key: string }) => h.key === 'Content-Security-Policy').value as string;
  }

  function sourcesOf(csp: string, directive: string): string[] {
    const found = csp.split('; ').find((d) => d.startsWith(`${directive} `));
    expect(found, `CSP に ${directive} が無い`).toBeDefined();
    return found!.split(' ').slice(1);
  }

  it("本番では、同じオリジンの /_vercel/speed-insights/script.js を読み込む (外部ホストではない)", () => {
    vi.stubEnv('NODE_ENV', 'production');

    injectSpeedInsights({ framework: 'next' });

    const script = document.head.querySelector('script[data-sdkn^="@vercel/speed-insights"]');
    expect(script, 'スクリプトが <head> に入っていない').not.toBeNull();
    expect(script!.getAttribute('src')).toBe('/_vercel/speed-insights/script.js');
  });

  it("CSP は script-src と connect-src に 'self' を持つ (Speed Insights のために外部ホストを足していない)", async () => {
    const csp = await loadCsp();

    expect(sourcesOf(csp, 'script-src')).toContain("'self'");
    expect(sourcesOf(csp, 'connect-src')).toContain("'self'");
    // 計測のために Vercel の計測用ホストを CSP へ足していない (同じオリジンで足りるため)
    expect(csp).not.toContain('vitals.vercel-insights.com');
    expect(csp).not.toContain('vitals.vercel-analytics.com');
  });
});
