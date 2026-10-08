// @vitest-environment node
/**
 * tests/speed-insights-middleware-1179.test.ts
 *
 * #1179: /_vercel/ 以下は Vercel が扱うパス (Speed Insights のスクリプト /_vercel/speed-insights/script.js など) で、
 * アプリのページではない。認証ミドルウェア (Supabase のセッション処理) に通すと、未ログインの訪問者は /login へ、
 * ログイン済みでも初期設定の途中の人はオンボーディングへ送られ、スクリプトのはずの応答が HTML にすり替わる。
 *
 * ただし、Vercel 上で有効にした機能のパスは、Vercel がミドルウェアより前に応答する (本番で確認: script.js は 200)。
 * なので、この除外が Vercel 上の計測を守っているわけではない。効くのは、Vercel が応答しないとき
 * (有効にしていない機能、存在しないパス、next start で Vercel の外に置いたとき)。害は無いので残している。
 *
 * src/middleware.ts の matcher は、/_vercel/ 以下をミドルウェアの対象から外す。
 * それ以外のパスの扱いは変えない (tests/health-middleware-exemption.test.ts の除外もそのまま)。
 */

import { describe, expect, it } from 'vitest';
import { config } from '@/middleware';

/**
 * Next.js は matcher を path-to-regexp で正規表現に変換する。この matcher は
 * `/(<否定先読みつきの正規表現>)` の 1 グループだけなので、前後を ^ $ で挟めば同じ判定になる
 * (tests/health-middleware-exemption.test.ts と同じ方法)。
 */
function runsMiddleware(pathname: string): boolean {
  const [matcher] = config.matcher;
  return new RegExp(`^${matcher}$`).test(pathname);
}

describe('src/middleware.ts の matcher (#1179)', () => {
  it('Speed Insights のスクリプトと計測値の送信先 (/_vercel/speed-insights/*) はミドルウェアを通さない', () => {
    expect(runsMiddleware('/_vercel/speed-insights/script.js')).toBe(false);
    expect(runsMiddleware('/_vercel/speed-insights/vitals')).toBe(false);
  });

  it('/_vercel/ 以下は、他の Vercel のパスも通さない (画像の最適化など)', () => {
    expect(runsMiddleware('/_vercel/image')).toBe(false);
    expect(runsMiddleware('/_vercel/insights/script.js')).toBe(false);
  });

  it('前方一致で巻き込まない (/_vercel/ で始まらないパスは従来どおり対象)', () => {
    expect(runsMiddleware('/_vercelfoo/bar')).toBe(true);
    expect(runsMiddleware('/vercel')).toBe(true);
    expect(runsMiddleware('/about/_vercel/x')).toBe(true);
  });

  it('ページと API は従来どおりミドルウェアの対象のまま', () => {
    expect(runsMiddleware('/')).toBe(true);
    expect(runsMiddleware('/login')).toBe(true);
    expect(runsMiddleware('/home')).toBe(true);
    expect(runsMiddleware('/health')).toBe(true);
    expect(runsMiddleware('/api/profile')).toBe(true);
    expect(runsMiddleware('/api/health/goals')).toBe(true);
  });

  it('既存の除外 (静的ファイル・manifest・robots・service worker・画像・/api/health) は変わらない', () => {
    expect(runsMiddleware('/_next/static/chunks/main.js')).toBe(false);
    expect(runsMiddleware('/_next/image')).toBe(false);
    expect(runsMiddleware('/favicon.ico')).toBe(false);
    expect(runsMiddleware('/manifest.json')).toBe(false);
    expect(runsMiddleware('/robots.txt')).toBe(false);
    expect(runsMiddleware('/sw.js')).toBe(false);
    expect(runsMiddleware('/workbox-abc123.js')).toBe(false);
    expect(runsMiddleware('/logo.png')).toBe(false);
    expect(runsMiddleware('/api/health')).toBe(false);
  });
});
