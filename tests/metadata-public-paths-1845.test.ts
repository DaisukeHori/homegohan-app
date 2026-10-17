// @vitest-environment node
/**
 * #1845: ページのメタ情報・manifest が指す画像などのパスが、すべて実在して未ログインでも開けることの見張り
 *
 * 以前は src/app/layout.tsx の openGraph.images・twitter.images が /og-image.png を、icons.apple が /apple-touch-icon.png を、
 * public/manifest.json の icons が /icon-192.png・/icon-512.png を、通知のアイコン (src/lib/local-notification.ts) が
 * /icon-192x192.png を指していたが、どれも存在せず本番で 404 だった (public/ には SVG しか無かった)。
 * 同じ型の取りこぼし (存在しないファイルを指すメタ情報) を、ここで止める。
 *
 * 「実在する」とは、次のどれかに当たること:
 *   - public/<パス> のファイル
 *   - src/app/<パス> のファイル (Next の file convention。例: src/app/favicon.ico → /favicon.ico)
 *   - src/app/<パス>/route.ts(x) の route (例: src/app/icon-192.png/route.ts → /icon-192.png)
 * あわせて、そのパスが src/proxy.ts の matcher の外 (未ログインの訪問者・クローラーを /login へ送らない) であることも確かめる。
 * file convention の画像 (opengraph-image など) の URL も、matcher の外であることを確かめる。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { config } from '@/proxy';
import { DEFAULT_NOTIFICATION_ICON } from '@/lib/local-notification';

vi.mock('next/font/google', () => ({
  Noto_Sans_JP: () => ({ variable: 'font-sans-test' }),
  Noto_Serif_JP: () => ({ variable: 'font-serif-test' }),
}));
vi.mock('@vercel/speed-insights/next', () => ({ SpeedInsights: () => null }));

const ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const APP_DIR = path.join(ROOT, 'src/app');
const ROUTE_FILES = ['route.ts', 'route.tsx'];

/** matcher を正規表現にして判定する (tests/health-middleware-exemption.test.ts と同じ方法) */
function runsMiddleware(pathname: string): boolean {
  const [matcher] = config.matcher;
  return new RegExp(`^${matcher}$`).test(pathname);
}

/** URL のパス (先頭が /・クエリ無し) が、public のファイル・app のファイル・app の route のどれかで返るか */
function resolvesToAsset(urlPath: string): boolean {
  const relative = urlPath.replace(/^\//, '');
  if (relative === '' || relative.includes('..')) return false;
  const publicFile = path.join(PUBLIC_DIR, relative);
  if (fs.existsSync(publicFile) && fs.statSync(publicFile).isFile()) return true;
  const appFile = path.join(APP_DIR, relative);
  if (fs.existsSync(appFile) && fs.statSync(appFile).isFile()) return true;
  return ROUTE_FILES.some((file) => fs.existsSync(path.join(APP_DIR, relative, file)));
}

type UrlLike = string | URL | { url: string | URL };

/** metadata の icons / images の値 (文字列・URL・{ url }・その配列) から、パスの一覧を取り出す */
function collectUrls(value: UrlLike | UrlLike[] | undefined | null): string[] {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value.flatMap((item) => collectUrls(item));
  if (typeof value === 'string') return [value];
  if (value instanceof URL) return [value.pathname];
  return collectUrls(value.url);
}

/** layout の metadata と manifest.json と通知の既定のアイコンが指す、同じサイトの中のパス (重複なし) */
async function referencedPaths(): Promise<Array<{ from: string; urlPath: string }>> {
  const { metadata } = await import('@/app/layout');
  const refs: Array<{ from: string; urlPath: string }> = [];
  const push = (from: string, urls: string[]) => {
    for (const url of urls) refs.push({ from, urlPath: url });
  };

  const icons = metadata.icons;
  if (icons && typeof icons === 'object' && !Array.isArray(icons) && !(icons instanceof URL)) {
    const iconDescriptor = icons as Record<string, UrlLike | UrlLike[] | undefined>;
    for (const key of ['icon', 'apple', 'shortcut', 'other'] as const) {
      push(`layout metadata.icons.${key}`, collectUrls(iconDescriptor[key]));
    }
  } else {
    push('layout metadata.icons', collectUrls(icons as UrlLike | UrlLike[] | undefined));
  }
  push('layout metadata.manifest', collectUrls(metadata.manifest as UrlLike | undefined));
  push('layout metadata.openGraph.images', collectUrls((metadata.openGraph?.images ?? undefined) as UrlLike | UrlLike[] | undefined));
  push('layout metadata.twitter.images', collectUrls((metadata.twitter?.images ?? undefined) as UrlLike | UrlLike[] | undefined));

  const manifest = JSON.parse(fs.readFileSync(path.join(PUBLIC_DIR, 'manifest.json'), 'utf8')) as {
    icons?: Array<{ src: string }>;
    screenshots?: Array<{ src: string }>;
  };
  push('public/manifest.json icons', (manifest.icons ?? []).map(({ src }) => src));
  push('public/manifest.json screenshots', (manifest.screenshots ?? []).map(({ src }) => src));

  push('src/lib/local-notification.ts DEFAULT_NOTIFICATION_ICON', [DEFAULT_NOTIFICATION_ICON]);

  // 絶対 URL (外部のサイト) は対象外。同じサイトの中のパスだけ (クエリは除く)
  return refs
    .filter(({ urlPath }) => urlPath.startsWith('/') && !urlPath.startsWith('//'))
    .map(({ from, urlPath }) => ({ from, urlPath: urlPath.split('?')[0] }));
}

/** file convention の画像のファイル名 (Next の metadata の画像。拡張子の無い URL で返る) */
const IMAGE_FILE_CONVENTION = /^(opengraph-image|twitter-image|icon|apple-icon)\d*\.(tsx|ts|jsx|js)$/;

/** src/app の中の file convention の画像のファイルを、相対パスで列挙する */
function findImageConventionFiles(dir: string = APP_DIR): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '__tests__') continue;
      found.push(...findImageConventionFiles(full));
    } else if (IMAGE_FILE_CONVENTION.test(entry.name)) {
      found.push(path.relative(APP_DIR, full));
    }
  }
  return found;
}

describe('#1845 メタ情報・manifest が指すパスの実在', () => {
  it('見張りの対象を拾えている (空振りしていない)', async () => {
    const paths = (await referencedPaths()).map(({ urlPath }) => urlPath);
    // layout の icons (favicon・icon.svg・apple-touch-icon)・manifest・manifest の 2 つのアイコン・通知のアイコン
    expect(paths).toEqual(
      expect.arrayContaining([
        '/favicon.ico',
        '/icon.svg',
        '/apple-touch-icon.png',
        '/manifest.json',
        '/icon-192.png',
        '/icon-512.png',
      ]),
    );
  });

  it('すべて public のファイル・app のファイル・app の route のどれかで返る', async () => {
    const missing = (await referencedPaths()).filter(({ urlPath }) => !resolvesToAsset(urlPath));
    expect(missing, '存在しないファイルを指している。public/ に置くか、src/app/<パス>/route.ts で返すこと').toEqual([]);
  });

  it('すべて src/proxy.ts の matcher の外 (未ログインでも /login へ送られない)', async () => {
    const proxied = (await referencedPaths()).filter(({ urlPath }) => runsMiddleware(urlPath));
    expect(proxied, 'matcher の対象になっている。未ログインのクローラー・端末が画像の代わりにログイン画面を受け取る').toEqual([]);
  });

  it('見張りの判定そのものが働く (存在しないパスは返らない・存在するパスは返る)', () => {
    expect(resolvesToAsset('/og-image.png')).toBe(false);
    expect(resolvesToAsset('/icon-192x192.png')).toBe(false);
    expect(resolvesToAsset('/icon.svg')).toBe(true);
    expect(resolvesToAsset('/favicon.ico')).toBe(true);
    expect(resolvesToAsset('/icon-192.png')).toBe(true);
    expect(resolvesToAsset('/../package.json')).toBe(false);
  });
});

describe('#1845 file convention の画像の URL は matcher の外', () => {
  it('src/app のルートに opengraph-image と twitter-image がある', () => {
    expect(findImageConventionFiles()).toEqual(expect.arrayContaining(['opengraph-image.tsx', 'twitter-image.tsx']));
  });

  it('file convention の画像はすべて src/app の直下にあり、その URL (/<名前>) は matcher の外', () => {
    for (const file of findImageConventionFiles()) {
      // 直下以外 (route group の配下など) は URL に接尾辞が付き、matcher の除外の書き方が変わる。置くときはここと matcher を見直す
      expect(path.dirname(file), `${file} は src/app の直下ではない`).toBe('.');
      const urlPath = `/${path.basename(file).replace(/\.(tsx|ts|jsx|js)$/, '')}`;
      expect(runsMiddleware(urlPath), `${urlPath} が proxy を通る`).toBe(false);
    }
  });

  it('除外はちょうどその名前だけ (前方一致で他のページを巻き込まない)', () => {
    expect(runsMiddleware('/opengraph-image')).toBe(false);
    expect(runsMiddleware('/twitter-image')).toBe(false);
    expect(runsMiddleware('/opengraph-images')).toBe(true);
    expect(runsMiddleware('/opengraph-image/x')).toBe(true);
    expect(runsMiddleware('/twitter-image-x')).toBe(true);
    expect(runsMiddleware('/home/opengraph-image')).toBe(true);
    expect(runsMiddleware('/')).toBe(true);
    expect(runsMiddleware('/login')).toBe(true);
  });
});
