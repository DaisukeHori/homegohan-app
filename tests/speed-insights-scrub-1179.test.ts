/**
 * #1179: Speed Insights の計測値から、招待先のメールアドレスと招待トークンを消す
 *
 * 本番の Speed Insights はすでに有効とみられる。Vercel が配る計測スクリプトは、パッケージが data-path を付けないので、
 * location.href (? 以降と # 以降を含む URL 全体) をそのまま計測値に載せて送る。このアプリには、URL に次のものが入るページがある。
 *   - 招待先のメールアドレス: /login?redirect=/invite/<token>&email=…、/signup?…&email=…、/auth/verify?email=…
 *   - パスに入る招待トークン: /invite/<token>、/family/promotions/<token>
 * そこで、送る前に beforeSend (scrubSpeedInsightsEvent) で URL を直す。ここでは次を確かめる。
 *
 *   1. 直した URL: ?email=… と # 以降が消える (route が無くても)。/invite/<token> は route の形 (/invite/[token]) になる。
 *   2. 直せないとき (トークンが残りうるとき) は、計測値ごと送らない。URL として読めないときも送らない。
 *   3. 実物の @vercel/speed-insights との結び付き: パッケージが作る route を受け取れること、beforeSend として登録されること。
 *   4. レイアウトが使う部品 (SpeedInsightsClient) が beforeSend を渡していること。
 *      src の中で Speed Insights を読み込むのは、その部品だけであること (beforeSend なしの <SpeedInsights /> を置かせない)。
 *   5. src/app にある [token] のページが、すべて 2 の対象に入っていること (新しい [token] のページを足したときの置き忘れ)。
 *
 * レイアウトに渡る props の検査は tests/speed-insights-1179.test.tsx にある。
 */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { computeRoute, injectSpeedInsights, type BeforeSendMiddleware } from '@vercel/speed-insights';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { scrubSpeedInsightsEvent } from '@/lib/speed-insights-scrub';

const HOST = 'https://homegohan.app';
/** 本物の招待トークンと同じ形 (uuid 2 つからハイフンを除いた 64 桁の 16 進数) */
const TOKEN = '3f9a1c0be77d4c2a9b1e5d6f7a8b9c0d' + '1e2f3a4b5c6d4e7f8a9b0c1d2e3f4a5b';
const EMAIL = 'taro.yamada@example.com';

type BeforeSendEvent = Parameters<BeforeSendMiddleware>[0];

function vital(url: string, route?: string): BeforeSendEvent {
  return route === undefined ? { type: 'vital', url } : { type: 'vital', url, route };
}

/** 送られる URL。送られない (null など) ときは null */
function sentUrl(url: string, route?: string): string | null {
  const result = scrubSpeedInsightsEvent(vital(url, route));
  return result ? result.url : null;
}

describe('#1179 scrubSpeedInsightsEvent: 送る URL から ? 以降と # 以降を消す', () => {
  it('招待先のメールアドレスを含むクエリ (?email=…) が消える。redirect に入った招待トークンも消える', () => {
    const url = `${HOST}/login?redirect=/invite/${TOKEN}&email=${encodeURIComponent(EMAIL)}`;

    const sent = sentUrl(url, '/login');

    expect(sent).toBe(`${HOST}/login`);
    expect(sent).not.toContain(EMAIL);
    expect(sent).not.toContain(encodeURIComponent(EMAIL));
    expect(sent).not.toContain('example.com');
    expect(sent).not.toContain(TOKEN);
  });

  it.each([
    ['/signup', `/signup?redirect=/family/promotions/${TOKEN}&email=${encodeURIComponent(EMAIL)}`],
    ['/auth/verify', `/auth/verify?email=${encodeURIComponent(EMAIL)}`],
  ])('%s のクエリも消える', (route, pathAndQuery) => {
    const sent = sentUrl(`${HOST}${pathAndQuery}`, route);

    expect(sent).toBe(`${HOST}${route}`);
    expect(sent).not.toContain('example.com');
    expect(sent).not.toContain(TOKEN);
  });

  it('# 以降が消える (認証の戻りで、# の後ろにトークンが付くことがある)', () => {
    const sent = sentUrl(`${HOST}/home#access_token=SECRET.JWT.VALUE&refresh_token=SECRET2`, '/home');

    expect(sent).toBe(`${HOST}/home`);
  });

  it('route が無くても、? 以降と # 以降は消える', () => {
    const url = `${HOST}/signup?email=${encodeURIComponent(EMAIL)}#section`;

    expect(sentUrl(url)).toBe(`${HOST}/signup`);
    expect(sentUrl(url, '')).toBe(`${HOST}/signup`);
  });

  it('route が壊れていて (/ で始まらない)、使えないときは、URL のパスを使う', () => {
    expect(sentUrl(`${HOST}/signup?email=${encodeURIComponent(EMAIL)}`, 'signup')).toBe(`${HOST}/signup`);
  });

  it('オリジンとパスだけが残る (ポート番号は残り、ユーザー名・パスワードは消える)', () => {
    expect(sentUrl('http://user:secret@localhost:3000/login?x=1#y', '/login')).toBe('http://localhost:3000/login');
    expect(sentUrl(`${HOST}/?mode=app`)).toBe(`${HOST}/`);
  });

  it('ほかの動的ルートも、route の形になる (ID が url に残らない)', () => {
    const id = '0b9f6a3e-1111-4222-8333-444455556666';

    expect(sentUrl(`${HOST}/meals/${id}?from=home`, '/meals/[id]')).toBe(`${HOST}/meals/[id]`);
  });

  it('url 以外 (type と route) は変えず、受け取ったイベントも書き換えない', () => {
    const input = vital(`${HOST}/meals/abc?x=1#y`, '/meals/[id]');
    const before = JSON.parse(JSON.stringify(input));

    const result = scrubSpeedInsightsEvent(input);

    expect(input).toEqual(before);
    expect(result).toEqual({ type: 'vital', url: `${HOST}/meals/[id]`, route: '/meals/[id]' });
  });
});

describe('#1179 scrubSpeedInsightsEvent: パスに招待トークンが入るページ', () => {
  it.each(['/invite', '/family/promotions'])('%s: route の形 (…/[token]) になり、トークンが残らない', (prefix) => {
    const sent = sentUrl(`${HOST}${prefix}/${TOKEN}`, `${prefix}/[token]`);

    expect(sent).toBe(`${HOST}${prefix}/[token]`);
    expect(sent).not.toContain(TOKEN);
  });

  it.each(['/invite', '/family/promotions'])('%s: クエリと # が付いていても、同じ形になる', (prefix) => {
    const sent = sentUrl(`${HOST}${prefix}/${TOKEN}?email=${encodeURIComponent(EMAIL)}#top`, `${prefix}/[token]`);

    expect(sent).toBe(`${HOST}${prefix}/[token]`);
  });

  it.each(['/invite', '/family/promotions'])('%s: route が無いときは、計測値ごと送らない', (prefix) => {
    expect(sentUrl(`${HOST}${prefix}/${TOKEN}`)).toBeNull();
    expect(sentUrl(`${HOST}${prefix}/${TOKEN}?email=${encodeURIComponent(EMAIL)}`, '')).toBeNull();
    // route が壊れているときも、route が無いのと同じ
    expect(sentUrl(`${HOST}${prefix}/${TOKEN}`, 'invite')).toBeNull();
  });

  it.each(['/invite', '/family/promotions'])(
    '%s: route の置き換えに失敗して、生のトークンが残っているときも、計測値ごと送らない',
    (prefix) => {
      // 配られるスクリプトは、返された route を使わず、元の route を送る。直せないので、送らない
      expect(sentUrl(`${HOST}${prefix}/${TOKEN}`, `${prefix}/${TOKEN}`)).toBeNull();
    },
  );

  it('遷移の途中で URL と route が食い違っても (URL は招待ページ、route は前のページ)、トークンは出ない', () => {
    const sent = sentUrl(`${HOST}/invite/${TOKEN}?email=${encodeURIComponent(EMAIL)}`, '/home');

    expect(sent).toBe(`${HOST}/home`);
    expect(sent).not.toContain(TOKEN);
  });

  it('大文字のパス (/INVITE/<token>。Next.js では 404 の画面) や、末尾に / が付いた URL でも、トークンは出ない', () => {
    expect(sentUrl(`${HOST}/INVITE/${TOKEN}`, `/INVITE/${TOKEN}`)).toBeNull();
    expect(sentUrl(`${HOST}/Family/Promotions/${TOKEN}`)).toBeNull();
    // 末尾の / は、route の置き換え (/invite/[token]/) がされていれば送れる。されていなければ送らない
    expect(sentUrl(`${HOST}/invite/${TOKEN}/`, '/invite/[token]/')).toBe(`${HOST}/invite/[token]/`);
    expect(sentUrl(`${HOST}/invite/${TOKEN}/`)).toBeNull();
  });

  it('接頭辞だけ (/invite、/family/promotions) や、似た名前のパスは対象外で、そのまま送る', () => {
    expect(sentUrl(`${HOST}/invite`, '/invite')).toBe(`${HOST}/invite`);
    expect(sentUrl(`${HOST}/family/promotions`, '/family/promotions')).toBe(`${HOST}/family/promotions`);
    expect(sentUrl(`${HOST}/invitations`, '/invitations')).toBe(`${HOST}/invitations`);
    expect(sentUrl(`${HOST}/family/dashboard`, '/family/dashboard')).toBe(`${HOST}/family/dashboard`);
  });
});

describe('#1179 scrubSpeedInsightsEvent: 読めない入力と不変条件', () => {
  it.each(['', 'not a url', '/invite/abc', 'data:text/plain,hello'])(
    'URL として読めない (%j) ときは、送らず、例外も投げない',
    (url) => {
      expect(() => scrubSpeedInsightsEvent(vital(url, '/x'))).not.toThrow();
      expect(scrubSpeedInsightsEvent(vital(url, '/x'))).toBeNull();
    },
  );

  it('どんな入力でも、送る URL にクエリ・#・ユーザー名・パスワード・メールアドレス・トークンは残らない', () => {
    const inputs: Array<[string, string | undefined]> = [
      [`${HOST}/login?redirect=/invite/${TOKEN}&email=${encodeURIComponent(EMAIL)}#a=1`, '/login'],
      [`${HOST}/login?email=${encodeURIComponent(EMAIL)}`, undefined],
      [`http://u:p@localhost:3000/signup?email=${encodeURIComponent(EMAIL)}#x`, '/signup'],
      [`${HOST}/invite/${TOKEN}?email=${encodeURIComponent(EMAIL)}#x`, '/invite/[token]'],
      [`${HOST}/family/promotions/${TOKEN}`, '/family/promotions/[token]'],
      // route の中に ? や # があっても、クエリや # として解釈されない
      [`${HOST}/x`, '/a?x=1#b'],
      [`${HOST}/x`, '//evil.example.com/path'],
    ];

    for (const [url, route] of inputs) {
      const sent = sentUrl(url, route);
      if (sent === null) continue;
      const parsed = new URL(sent);
      expect(parsed.search, sent).toBe('');
      expect(parsed.hash, sent).toBe('');
      expect(parsed.username, sent).toBe('');
      expect(parsed.password, sent).toBe('');
      expect(sent).not.toContain(TOKEN);
      expect(sent).not.toContain('@example.com');
      expect(sent).not.toContain(encodeURIComponent(EMAIL));
    }
  });
});

describe('#1179 実物の @vercel/speed-insights との結び付き', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    document.head.querySelectorAll('script').forEach((script) => script.remove());
    delete window.si;
    delete window.siq;
  });

  /**
   * Vercel が配る計測スクリプト (script.js、scriptVersion 0.1.3) の beforeSend まわりの処理を再現する。
   * 計測値ごとに beforeSend({ type: 'vital', url: location.href, route: <script の data-route> }) を呼び、
   * 偽 (null など) を返したら送らない。返ったイベントの url を href として送る (route は元の data-route のまま)。
   * 配られるスクリプトはここでは動かせないので、読んで確かめた動作を写している。
   */
  function sentBy(beforeSend: BeforeSendMiddleware, href: string, route: string | undefined) {
    const result = beforeSend({ type: 'vital', url: href, route });
    return result ? { href: result.url, route } : null;
  }

  it('パッケージが作る route (computeRoute) を受け取ると、招待トークンの入るページの URL が …/[token] になる', () => {
    const enc = encodeURIComponent;
    const cases: Array<{ pathname: string; params: Record<string, string>; search: string; expected: string }> = [
      // 動的セグメントがあるページ: params は動的セグメントの値
      {
        pathname: `/invite/${TOKEN}`,
        params: { token: TOKEN },
        search: `?email=${enc(EMAIL)}`,
        expected: `${HOST}/invite/[token]`,
      },
      {
        pathname: `/family/promotions/${TOKEN}`,
        params: { token: TOKEN },
        search: '',
        expected: `${HOST}/family/promotions/[token]`,
      },
      // 動的セグメントが無いページ: パッケージは URL のクエリを params として route を作る
      {
        pathname: '/login',
        params: { redirect: `/invite/${TOKEN}`, email: EMAIL },
        search: `?redirect=/invite/${TOKEN}&email=${enc(EMAIL)}`,
        expected: `${HOST}/login`,
      },
      { pathname: '/signup', params: { email: EMAIL }, search: `?email=${enc(EMAIL)}`, expected: `${HOST}/signup` },
    ];

    for (const { pathname, params, search, expected } of cases) {
      const route = computeRoute(pathname, params) ?? undefined;

      const sent = sentBy(scrubSpeedInsightsEvent, `${HOST}${pathname}${search}#frag`, route);

      expect(sent, pathname).not.toBeNull();
      expect(sent!.href, pathname).toBe(expected);
      expect(JSON.stringify(sent)).not.toContain(TOKEN);
      expect(JSON.stringify(sent)).not.toContain('example.com');
    }
  });

  it('パッケージが route の置き換えに失敗する入力 (params が無い、エンコードが食い違う) でも、トークンを含む計測値は送らない', () => {
    // どちらも、パッケージ (computeRoute) は、生のトークンが入ったパスをそのまま route として返す
    const unreplaced = [
      { pathname: `/invite/${TOKEN}`, params: null },
      { pathname: '/invite/a%20b', params: { token: 'a b' } },
    ];

    for (const { pathname, params } of unreplaced) {
      const route = computeRoute(pathname, params) ?? undefined;
      expect(route, pathname).toBe(pathname);

      expect(sentBy(scrubSpeedInsightsEvent, `${HOST}${pathname}`, route), pathname).toBeNull();
    }
  });

  it('beforeSend に渡すと、パッケージは同じ関数を 1 回だけ登録し、script の data-route には route が入る', () => {
    vi.stubEnv('NODE_ENV', 'production');

    injectSpeedInsights({ framework: 'next', route: '/invite/[token]', beforeSend: scrubSpeedInsightsEvent });

    expect(window.siq).toEqual([['beforeSend', scrubSpeedInsightsEvent]]);
    const script = document.head.querySelector<HTMLScriptElement>('script[data-sdkn^="@vercel/speed-insights"]');
    expect(script).not.toBeNull();
    expect(script!.dataset.route).toBe('/invite/[token]');

    // 登録された関数を、再現したスクリプトの処理に通す
    const registered = window.siq![0][1] as BeforeSendMiddleware;
    const sent = sentBy(registered, `${HOST}/invite/${TOKEN}?email=${encodeURIComponent(EMAIL)}`, script!.dataset.route);
    expect(sent).toEqual({ href: `${HOST}/invite/[token]`, route: '/invite/[token]' });
  });
});

describe('#1179 レイアウトが使う部品 (SpeedInsightsClient) と、Speed Insights の読み込み元', () => {
  const ROOT = path.resolve(__dirname, '..');
  const CLIENT_FILE = 'src/components/SpeedInsightsClient.tsx';
  /** Web のコードがある場所。ルート直下の components/ ・ lib/ ・ shared/ も、@/ の別名経由で Web から使われる */
  const SCAN_ROOTS = ['src', 'components', 'lib', 'shared'];

  function parse(file: string): ts.SourceFile {
    return ts.createSourceFile(file, fs.readFileSync(path.join(ROOT, file), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  }

  /**
   * ソースが読み込んでいる (import / export from / require / 動的 import) module 名。
   * `import type` は型だけで、ビルドで消えて何も読み込まないので数えない (src/lib/speed-insights-scrub.ts が型を使う)
   */
  function moduleSpecifiers(sf: ts.SourceFile): string[] {
    const specifiers: string[] = [];
    const visit = (node: ts.Node): void => {
      const typeOnly =
        (ts.isImportDeclaration(node) && node.importClause?.isTypeOnly === true) ||
        (ts.isExportDeclaration(node) && node.isTypeOnly);
      if (
        !typeOnly &&
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier)
      ) {
        specifiers.push(node.moduleSpecifier.text);
      }
      if (ts.isCallExpression(node)) {
        const first = node.arguments[0];
        const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
        const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require';
        if ((isDynamicImport || isRequire) && first && ts.isStringLiteralLike(first)) specifiers.push(first.text);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    return specifiers;
  }

  function collectSourceFiles(dir: string): string[] {
    const abs = path.join(ROOT, dir);
    if (!fs.existsSync(abs)) return [];
    const files: string[] = [];
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      const rel = path.posix.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
        files.push(...collectSourceFiles(rel));
      } else if (/\.(ts|tsx|js|jsx|mjs)$/.test(entry.name) && !/\.(test|spec)\.(ts|tsx)$/.test(entry.name)) {
        files.push(rel);
      }
    }
    return files;
  }

  const isSpeedInsights = (specifier: string) =>
    specifier === '@vercel/speed-insights' || specifier.startsWith('@vercel/speed-insights/');

  it('SpeedInsightsClient は、<SpeedInsights /> の beforeSend に scrubSpeedInsightsEvent を渡す', () => {
    const sf = parse(CLIENT_FILE);
    const passed: string[] = [];
    const visit = (node: ts.Node): void => {
      if (
        ts.isJsxAttribute(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === 'beforeSend' &&
        node.initializer &&
        ts.isJsxExpression(node.initializer) &&
        node.initializer.expression &&
        ts.isIdentifier(node.initializer.expression)
      ) {
        passed.push(node.initializer.expression.text);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);

    expect(passed).toEqual(['scrubSpeedInsightsEvent']);
    expect(moduleSpecifiers(sf)).toContain('@/lib/speed-insights-scrub');
    // beforeSend は関数なので、サーバーコンポーネントから渡せない。クライアント部品として宣言している
    expect(fs.readFileSync(path.join(ROOT, CLIENT_FILE), 'utf8').trimStart()).toMatch(/^(['"])use client\1/);
  });

  it('src の中で @vercel/speed-insights を読み込むのは、SpeedInsightsClient だけ (beforeSend なしで置かせない)', () => {
    const importers = SCAN_ROOTS.flatMap(collectSourceFiles)
      // 構文木にするのは時間がかかる (数百ファイル)。パッケージ名が文字として出てくるファイルだけにしぼる
      .filter((file) => fs.readFileSync(path.join(ROOT, file), 'utf8').includes('@vercel/speed-insights'))
      .filter((file) => moduleSpecifiers(parse(file)).some(isSpeedInsights));

    expect(
      importers,
      '@vercel/speed-insights を直に読み込むファイルを足さない。URL の ? 以降と招待トークンを消す beforeSend が付かなくなる。' +
        ' src/components/SpeedInsightsClient.tsx を使う',
    ).toEqual([CLIENT_FILE]);
  });

  it('src/app にある [token] のページは、すべて scrubSpeedInsightsEvent の対象に入っている', () => {
    /** 秘密の値がパスに入るとみられる動的セグメント: [token]、[invite_code]、[secret] など */
    const SECRET_SEGMENT = /^\[(?:\.\.\.)?\w*(?:token|secret|code|key)\w*\]$/i;
    const routes: string[] = [];

    const walk = (dir: string, segments: string[]): void => {
      const entries = fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true });
      if (entries.some((e) => e.isFile() && /^page\.(ts|tsx|js|jsx)$/.test(e.name)) && segments.some((s) => SECRET_SEGMENT.test(s))) {
        routes.push('/' + segments.join('/'));
      }
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name === 'api' || entry.name === 'node_modules') continue;
        // (main) のようなルートグループは URL に出ない
        const isGroup = /^\(.*\)$/.test(entry.name);
        walk(path.posix.join(dir, entry.name), isGroup ? segments : [...segments, entry.name]);
      }
    };
    walk('src/app', []);

    // 走査が空振りしていないこと (いまある 2 つのページが見つかる)
    expect(routes).toEqual(expect.arrayContaining(['/invite/[token]', '/family/promotions/[token]']));

    for (const route of routes) {
      const url = `${HOST}${route.replace(/\[[^\]]+\]/, TOKEN)}`;
      expect(
        sentUrl(url),
        `${route} は、パスに秘密の値が入る。route が無くても送らないように、` +
          'src/lib/speed-insights-scrub.ts の TOKEN_PATH_PREFIX と TOKEN_PLACEHOLDER に足す',
      ).toBeNull();
    }
  });
});
