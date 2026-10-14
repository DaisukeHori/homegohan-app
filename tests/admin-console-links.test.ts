/**
 * 運営コンソール (src/app/admin, src/app/super-admin) の画面の中のリンクが、存在しない画面を指していないことの確認
 *
 * 従来の問題:
 *   - /admin に page.tsx が無く、管理者のログイン直後の転送先とサイドバーの「ダッシュボード」が 404 だった
 *   - サポートチケット・営業 CRM の画面の中の「詳細」「新規起票」「一覧に戻る」が、存在しない /support/... /sales/... を指していて、
 *     押すと 404 になっていた (正しくは /admin/support/... /admin/sales/...)
 * どちらも「リンク先の画面 (page.tsx) が無い」ことが原因で、画面を開いて押してみるまで分からなかった。
 *
 * ここでは運営コンソールの画面のソースを読み (TypeScript の構文木で解析するので、コメントや文字列の中は見ない)、
 *   - JSX の href="/..." と、router.push("/...") / router.replace("/...") の行き先
 * が、src/app にある page.tsx のどれかに当たることを確かめる。
 *   - ルートグループ ((support) など) は URL に現れないので外して照合する
 *   - `/admin/support/${ticket.id}` のような値の入る部分は、動的なセグメント ([id] など) にだけ当てる
 *     (/support/${id} が、たまたまある /support/users に当たって見逃されないように)
 *   - 外部の URL・mailto:・#・変数で組み立てたリンクは対象外
 *
 * 新しい画面へのリンクを足すときは、先にその画面 (page.tsx) を作ること。
 */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const APP_DIR = path.join(ROOT, 'src/app');

/** リンクを調べる画面 (運営コンソール) */
const SCANNED_DIRS = ['src/app/admin', 'src/app/super-admin'];

/** テンプレート文字列の `${...}` の位置に置く目印 (動的なセグメントにだけ当てる) */
const PARAM = '\u0000';

// ─────────────────────────────────────────────────────────────────────────────
// 照合
// ─────────────────────────────────────────────────────────────────────────────

/** ルートの 1 つ (['admin', 'support', '[id]']) が、リンクのセグメントに当たるか */
function routeMatches(route: string[], segments: string[]): boolean {
  for (let i = 0; i < route.length; i++) {
    const part = route[i];
    // [[...slug]]: 残り全部 (無くてもよい)
    if (/^\[\[\.\.\..+\]\]$/.test(part)) return true;
    // [...slug]: 残り全部 (1 つ以上)
    if (/^\[\.\.\..+\]$/.test(part)) return segments.length > i;
    if (i >= segments.length) return false;
    // [id]: どんなセグメントにも当たる
    if (/^\[.+\]$/.test(part)) continue;
    // 値の入る部分 (${...}) は、決まった名前のセグメントには当てない
    if (segments[i].includes(PARAM)) return false;
    if (part !== segments[i]) return false;
  }
  return route.length === segments.length;
}

/** リンク ('/admin/support/\0?x=1') が、どれかのルートに当たるか */
function linkResolves(link: string, routes: string[][]): boolean {
  const pathname = link.split(/[?#]/)[0];
  const segments = pathname.split('/').filter(Boolean);
  return routes.some((route) => routeMatches(route, segments));
}

// ─────────────────────────────────────────────────────────────────────────────
// ソース解析
// ─────────────────────────────────────────────────────────────────────────────

function collectFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      files.push(...collectFiles(full));
    } else {
      files.push(full);
    }
  }
  return files;
}

/** src/app の page.tsx があるフォルダを、URL のセグメントにしたもの (ルートグループ (xxx) は外す) */
function loadRoutes(): string[][] {
  return collectFiles(APP_DIR)
    .filter((file) => /^page\.(tsx|ts|jsx|js)$/.test(path.basename(file)))
    .map((file) =>
      path
        .relative(APP_DIR, path.dirname(file))
        .split(path.sep)
        .filter((segment) => segment !== '' && !/^\(.+\)$/.test(segment)),
    );
}

/** 式が取りうる文字列 (文字列・テンプレート文字列・条件式の両方の枝)。分からない式は null */
function stringsOf(expr: ts.Expression): string[] | null {
  if (ts.isParenthesizedExpression(expr) || ts.isAsExpression(expr) || ts.isNonNullExpression(expr)) {
    return stringsOf(expr.expression);
  }
  if (ts.isStringLiteralLike(expr)) return [expr.text];
  if (ts.isTemplateExpression(expr)) {
    return [expr.templateSpans.reduce((text, span) => `${text}${PARAM}${span.literal.text}`, expr.head.text)];
  }
  if (ts.isConditionalExpression(expr)) {
    const whenTrue = stringsOf(expr.whenTrue);
    const whenFalse = stringsOf(expr.whenFalse);
    return whenTrue && whenFalse ? [...whenTrue, ...whenFalse] : null;
  }
  return null;
}

interface FoundLink {
  line: number;
  link: string;
}

/** ソースの中の、アプリ内のリンク (/ で始まる) を取り出す */
function extractLinks(source: string, fileName = 'file.tsx'): FoundLink[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: FoundLink[] = [];

  const add = (node: ts.Node, expr: ts.Expression | undefined) => {
    const texts = expr ? stringsOf(expr) : null;
    if (!texts) return;
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    for (const link of texts) {
      // アプリ内のリンクだけ (外部の URL・mailto:・#・プロトコル相対 // は対象外)
      if (link.startsWith('/') && !link.startsWith('//')) found.push({ line: line + 1, link });
    }
  };

  const visit = (node: ts.Node): void => {
    // <Link href="/..."> / <a href={`/...`}>
    if (ts.isJsxAttribute(node) && ts.isIdentifier(node.name) && node.name.text === 'href' && node.initializer) {
      add(node, ts.isJsxExpression(node.initializer) ? node.initializer.expression : node.initializer);
    }
    // router.push('/...') / router.replace('/...')
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ['push', 'replace'].includes(node.expression.name.text) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === 'router'
    ) {
      add(node, node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

const show = (link: string) => link.split(PARAM).join('${…}');

// ─────────────────────────────────────────────────────────────────────────────
// リポジトリのソースに対する確認
// ─────────────────────────────────────────────────────────────────────────────

describe('運営コンソールの画面の中のリンク先に、画面 (page.tsx) がある', () => {
  const routes = loadRoutes();
  const scannedFiles = SCANNED_DIRS.flatMap((dir) => collectFiles(path.join(ROOT, dir))).filter((file) =>
    /\.(tsx|ts)$/.test(file),
  );
  const links = scannedFiles.flatMap((file) => {
    const relative = path.relative(ROOT, file).split(path.sep).join('/');
    return extractLinks(fs.readFileSync(file, 'utf8'), relative).map((found) => ({ file: relative, ...found }));
  });

  it('走査が機能している: ルートと、運営コンソールの多数のリンクを検出している', () => {
    // 走査が壊れて何も見つけられなくなったときに、下の確認が空振りで通ってしまわないようにする
    expect(routes.length).toBeGreaterThan(50);
    expect(routes).toContainEqual(['admin']);
    expect(routes).toContainEqual(['admin', 'support', '[id]']);
    expect(links.length).toBeGreaterThan(40);
    const known = links.filter((l) => l.file === 'src/app/admin/layout.tsx').map((l) => l.link);
    expect(known).toEqual(expect.arrayContaining(['/admin', '/admin/users', '/admin/support', '/super-admin']));
  });

  it('すべてのリンクが、存在する画面に当たる', () => {
    const dead = links
      .filter(({ link }) => !linkResolves(link, routes))
      .map(({ file, line, link }) => `${file}:${line} ${show(link)}`);

    expect(
      dead,
      'リンク先の画面 (page.tsx) が無い。リンクを直すか、先に画面を作ること (ルートグループは URL に現れない):\n' +
        dead.join('\n'),
    ).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 解析ロジック自体の確認 (合成のルート・ソースで、見つけられること / 誤検出しないこと)
// ─────────────────────────────────────────────────────────────────────────────

describe('リンクの照合ロジック', () => {
  // 実際の構成を縮めたもの: (support) グループの /support と /support/users、/admin 配下のチケット
  const routes: string[][] = [
    ['admin'],
    ['admin', 'support'],
    ['admin', 'support', 'new'],
    ['admin', 'support', '[id]'],
    ['support'],
    ['support', 'users'],
    ['docs', '[...slug]'],
    ['help', '[[...slug]]'],
  ];
  const resolves = (link: string) => linkResolves(link.split('${}').join(PARAM), routes);

  it('存在する画面に当たる (動的なセグメントにも、クエリ・ハッシュ付きにも)', () => {
    expect(resolves('/admin')).toBe(true);
    expect(resolves('/admin/support')).toBe(true);
    expect(resolves('/admin/support/new')).toBe(true);
    expect(resolves('/admin/support/${}')).toBe(true);
    expect(resolves('/admin/support?status=open&page=2')).toBe(true);
    expect(resolves('/admin/support/new#form')).toBe(true);
    expect(resolves('/support/users')).toBe(true);
  });

  it('存在しない画面は見つける (サポート・営業の画面にあった /support/new, /support/${id} の形)', () => {
    expect(resolves('/support/new')).toBe(false);
    expect(resolves('/admin/sales')).toBe(false);
    expect(resolves('/admin/support/new/extra')).toBe(false);
    expect(resolves('/admin/support/${}/extra')).toBe(false);
  });

  it('値の入る部分 (${...}) は、決まった名前の画面 (/support/users) に当てず、動的なセグメントにだけ当てる', () => {
    // /support には [id] の画面が無い。たまたま /support/users があっても、/support/${id} は見逃さない
    expect(resolves('/support/${}')).toBe(false);
    // 部分的に値が入る場合も同じ
    expect(resolves('/support/user${}')).toBe(false);
    expect(resolves('/admin/support/id-${}')).toBe(true);
  });

  it('[...slug] は 1 つ以上、[[...slug]] は 0 個以上のセグメントに当たる', () => {
    expect(resolves('/docs')).toBe(false);
    expect(resolves('/docs/a')).toBe(true);
    expect(resolves('/docs/a/b/c')).toBe(true);
    expect(resolves('/help')).toBe(true);
    expect(resolves('/help/a/b')).toBe(true);
  });

  it('ルートの照合: ルートグループは外して読み込む (src/app の実際の構成で、(support) の /support/users がある)', () => {
    const actual = loadRoutes();
    expect(actual).toContainEqual(['support', 'users']);
    expect(actual.some((route) => route.some((segment) => /^\(.+\)$/.test(segment)))).toBe(false);
  });
});

describe('リンクの取り出し', () => {
  const links = (source: string) => extractLinks(source).map(({ link }) => show(link));

  it('JSX の href と router.push / router.replace の行き先を取り出す', () => {
    expect(
      links(`
        export function A() {
          const router = useRouter();
          router.push('/admin/a');
          router.replace(\`/admin/b/\${id}\`);
          return (
            <>
              <Link href="/admin/c">c</Link>
              <a href={'/admin/d'}>d</a>
              <Link href={\`/admin/e/\${x}?tab=1\`}>e</Link>
            </>
          );
        }
      `),
    ).toEqual(['/admin/a', '/admin/b/${…}', '/admin/c', '/admin/d', '/admin/e/${…}?tab=1']);
  });

  it('条件式は両方の枝を取り出す', () => {
    expect(links(`const x = <Link href={ok ? '/admin/yes' : '/admin/no'}>x</Link>;`)).toEqual(['/admin/yes', '/admin/no']);
  });

  it('外部の URL・mailto:・ハッシュ・プロトコル相対・変数で組み立てたリンクは対象にしない', () => {
    expect(
      links(`
        const x = (
          <>
            <a href="https://example.com/admin">x</a>
            <a href="mailto:a@example.com">x</a>
            <a href="#top">x</a>
            <a href="//cdn.example.com/x">x</a>
            <Link href={item.href}>x</Link>
            <Link href={base + '/admin'}>x</Link>
            <Link href={\`\${base}/admin\`}>x</Link>
          </>
        );
      `),
    ).toEqual([]);
  });

  it('コメントや文字列の中は見ない。router 以外の push は対象にしない', () => {
    expect(
      links(`
        // <Link href="/nowhere">
        const note = '<Link href="/nowhere">';
        items.push('/nowhere');
        history.push('/nowhere');
      `),
    ).toEqual([]);
  });

  it('見つけた位置 (行) を返す', () => {
    expect(extractLinks(`const a = 1;\nconst b = <Link href="/admin/x">x</Link>;`)).toEqual([{ line: 2, link: '/admin/x' }]);
  });
});
