/**
 * #1179: Vercel Speed Insights (表示速度の計測) の導入
 *
 * Sentry / Better Stack は採用せず、性能の計測は Speed Insights だけにする (docs/design/00-architecture.md)。
 * ここでは次を確かめる。
 *
 *   1. ルートレイアウト (src/app/layout.tsx) が描画でき、Speed Insights が <body> の中に 1 つだけある。
 *      既存のスキップリンク・#main-content・子要素は変わらない。
 *      Speed Insights には、送る URL から ? 以降と招待トークンを消す beforeSend (scrubSpeedInsightsEvent) が渡っていて、
 *      その参照は描画のたびに変わらない (変わると、パッケージが beforeSend を登録し直す)。
 *   2. スクリプトの読み込み先は、同じオリジンのパス。設定が無いときの既定値は /_vercel/speed-insights/script.js。
 *      Vercel は、有効にしたプロジェクトのビルドに設定 (NEXT_PUBLIC_VERCEL_OBSERVABILITY_CLIENT_CONFIG) を渡し、
 *      その中の読み込み先・送信先 (/<固有のパス>/script.js、/<固有のパス>/vitals) が優先される。これも同じオリジンのパス。
 *   3. next.config.mjs の CSP は、script-src と connect-src に 'self' を持つ。
 *
 * 2 と 3 がそろっているので、Speed Insights のために CSP を変える必要がない (next.config.mjs は変えていない)。
 * パッケージを上げて読み込み先が別のオリジンに変わったり、CSP から 'self' が消えたりしたら、ここで落ちる。
 *
 * 注意: 2 で動かしているのは '@vercel/speed-insights' 本体 (dist/index.mjs) の injectSpeedInsights で、
 * レイアウトが使う '@vercel/speed-insights/next' の入口 (dist/next/index.mjs) ではない。同じ処理が別々にバンドルされている。
 * 入口が違っても読み込み先の決め方は同じで、パッケージを上げたときの検知としては働くが、レイアウトの実物を動かしているわけではない。
 *
 * 計測値の送信先 (既定は /_vercel/speed-insights/vitals) は、Vercel が配るスクリプトの側で決まるため、ここでは検査できない。
 * デプロイ後に、ブラウザのコンソールに CSP 違反が出ていないこと、実際の script[data-sdkn] の src と計測値の送信先が
 * 未ログインでも 2xx になることを確かめる。
 *
 * このリポジトリには @testing-library/react が無いため、react-dom/server で直接描画する
 * (tests/policy-pages-public.test.tsx と同じ流儀)。
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { injectSpeedInsights } from '@vercel/speed-insights';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { scrubSpeedInsightsEvent } from '@/lib/speed-insights-scrub';

// next/font/google は Next.js のビルド時にだけ使える (テストで呼ぶと失敗する) ので、フォント変数だけ返す偽物にする
vi.mock('next/font/google', () => ({
  Noto_Sans_JP: () => ({ variable: 'font-sans-test' }),
  Noto_Serif_JP: () => ({ variable: 'font-serif-test' }),
}));

// Speed Insights 本体は、どこに置かれたかが分かる目印に差し替え、渡された props を控える
// (レイアウトが SpeedInsightsClient 経由で '@vercel/speed-insights/next' 以外から読み込んでいたら、目印が出ずにテストが落ちる)
const MARKER = 'data-mock="speed-insights"';
const { speedInsightsProps } = vi.hoisted(() => ({ speedInsightsProps: [] as Array<Record<string, unknown>> }));
vi.mock('@vercel/speed-insights/next', async () => {
  const React = await import('react');
  return {
    SpeedInsights: (props: Record<string, unknown>) => {
      speedInsightsProps.push(props);
      return React.createElement('span', { 'data-mock': 'speed-insights' });
    },
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
  afterEach(() => {
    speedInsightsProps.length = 0;
  });

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

  it('Speed Insights には、URL を直す beforeSend (scrubSpeedInsightsEvent) が渡る', () => {
    renderLayout();

    expect(speedInsightsProps).toHaveLength(1);
    expect(speedInsightsProps[0]?.beforeSend).toBe(scrubSpeedInsightsEvent);
  });

  it('beforeSend の参照は、描画のたびに変わらない (変わると、パッケージが登録し直す)', () => {
    renderLayout();
    renderLayout();

    expect(speedInsightsProps).toHaveLength(2);
    expect(speedInsightsProps[1]?.beforeSend).toBe(speedInsightsProps[0]?.beforeSend);
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

  function injectedScript(): HTMLScriptElement {
    const script = document.head.querySelector<HTMLScriptElement>('script[data-sdkn^="@vercel/speed-insights"]');
    expect(script, 'スクリプトが <head> に入っていない').not.toBeNull();
    return script!;
  }

  it('設定が無いときの既定値は、同じオリジンの /_vercel/speed-insights/script.js (外部ホストではない)', () => {
    vi.stubEnv('NODE_ENV', 'production');

    injectSpeedInsights({ framework: 'next' });

    expect(injectedScript().getAttribute('src')).toBe('/_vercel/speed-insights/script.js');
  });

  it('Vercel がビルドに渡す設定があれば、その読み込み先と送信先が使われる。どちらも同じオリジンのパス', () => {
    vi.stubEnv('NODE_ENV', 'production');
    // NEXT_PUBLIC_VERCEL_OBSERVABILITY_CLIENT_CONFIG の中身 (有効にしたプロジェクトのビルドで渡る)
    const clientConfig = JSON.stringify({
      speedInsights: { scriptSrc: '/ab12cd34ef56/script.js', endpoint: '/ab12cd34ef56/vitals' },
    });

    injectSpeedInsights({ framework: 'next' }, clientConfig);

    const script = injectedScript();
    expect(script.getAttribute('src')).toBe('/ab12cd34ef56/script.js');
    expect(script.dataset.endpoint).toBe('/ab12cd34ef56/vitals');
    // 「/」で始まるパスは、読み込んだページと同じオリジン。CSP の 'self' で足りる
    expect(script.getAttribute('src')).toMatch(/^\/[^/]/);
    expect(script.dataset.endpoint).toMatch(/^\/[^/]/);
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
