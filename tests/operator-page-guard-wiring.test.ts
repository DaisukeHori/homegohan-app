/**
 * #1176 運営の layout 3 + page 11 の requireRoleForPage への置き換え (段 B)。docs/design/cross/12-operator-mfa.md §13.4.2・§21.1
 *
 * ソースを TypeScript の構文木で読み (コメント・文字列の中は見ない)、§13.4.2 の表 (EXPECTED_PAGE_GUARDS) と突き合わせる:
 *   - 各ファイルに requireRoleForPage の呼び出しが 1 つあり、第 1 引数の roles・第 2 引数の next / forbiddenPath が表と同じ
 *     (同じファイルの const の文字列は値に解き、テンプレート文字列はソースの文字列で比べる。forbiddenPath を渡さない行はプロパティが無いこと)
 *   - layout 3 つは MfaGraceBanner を JSX で描き、その next 属性が表の「バナーの next」と同じ
 *   - 素の requireRole( と redirect('/login') が残っていない
 *   - 表のファイルの集合と、PAGE_ROOTS の中で requireRoleForPage を呼ぶファイルの集合 ((support) の server layout を除く) が同じ
 */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');

/** §20 の PAGE_ROOTS (Web の運営の区画) */
const PAGE_ROOTS = ['src/app/admin', 'src/app/super-admin', 'src/app/(operator)', 'src/app/(support)/support'];
/** (support) 区画の server layout (§13.4.1。tests/support-area-guard-layout.test.tsx が見る) */
const SUPPORT_AREA_GUARD_LAYOUT = 'src/app/(support)/support/layout.tsx';
const PAGE_GUARD_FUNCTION = 'requireRoleForPage';
const GRACE_BANNER_COMPONENT = 'MfaGraceBanner';

interface ExpectedPageGuard {
  readonly roles: ReadonlyArray<string>;
  /** 文字列はその値・テンプレート文字列はソースの文字列 (`...`) */
  readonly next: string;
  /** 渡さない行は undefined */
  readonly forbiddenPath?: string;
  /** layout だけ。MfaGraceBanner の next 属性の値 */
  readonly bannerNext?: string;
}

/** §13.4.2 の表の 14 行 */
const EXPECTED_PAGE_GUARDS: Readonly<Record<string, ExpectedPageGuard>> = {
  'src/app/admin/layout.tsx': {
    roles: ['admin', 'super_admin', 'content_moderator'],
    next: '/admin',
    bannerNext: '/admin',
  },
  'src/app/super-admin/layout.tsx': {
    roles: ['super_admin'],
    next: '/super-admin/plans',
    forbiddenPath: '/login?redirect=/super-admin/plans',
    bannerNext: '/super-admin/plans',
  },
  'src/app/(operator)/operator/membership/layout.tsx': {
    roles: ['super_admin'],
    next: '/operator/membership/orgs/inactive',
    forbiddenPath: '/login?redirect=/operator/membership/orgs/inactive',
    bannerNext: '/operator/membership/orgs/inactive',
  },
  'src/app/admin/page.tsx': { roles: ['admin', 'super_admin', 'content_moderator'], next: '/admin' },
  'src/app/admin/announcements/page.tsx': { roles: ['admin', 'super_admin'], next: '/admin/announcements' },
  'src/app/admin/moderation/page.tsx': { roles: ['admin', 'super_admin', 'content_moderator'], next: '/admin/moderation' },
  'src/app/admin/moderation/[type]/[id]/page.tsx': {
    roles: ['admin', 'super_admin', 'content_moderator'],
    next: '`/admin/moderation/${encodeURIComponent(type)}/${encodeURIComponent(id)}`',
  },
  'src/app/admin/organizations/page.tsx': { roles: ['admin', 'super_admin'], next: '/admin/organizations' },
  'src/app/admin/users/page.tsx': { roles: ['admin', 'super_admin', 'support'], next: '/admin/users' },
  'src/app/admin/users/[id]/page.tsx': {
    roles: ['admin', 'super_admin', 'support'],
    next: '`/admin/users/${encodeURIComponent(id)}`',
  },
  'src/app/admin/users/[id]/freeze/page.tsx': {
    roles: ['admin', 'super_admin'],
    next: '`/admin/users/${encodeURIComponent(id)}/freeze`',
  },
  'src/app/super-admin/coupons/page.tsx': { roles: ['super_admin'], next: '/super-admin/coupons' },
  'src/app/super-admin/feature-packages/page.tsx': { roles: ['super_admin'], next: '/super-admin/feature-packages' },
  'src/app/super-admin/plans/page.tsx': { roles: ['super_admin'], next: '/super-admin/plans' },
};

interface GuardCall {
  readonly roles: string[] | null;
  readonly options: Map<string, string>;
}

interface FileAnalysis {
  readonly guardCalls: GuardCall[];
  readonly bareRequireRoleCalls: number;
  readonly loginRedirects: number;
  /** <MfaGraceBanner next={...} /> の next の値 */
  readonly bannerNexts: string[];
}

function analyze(relative: string): FileAnalysis {
  const source = fs.readFileSync(path.join(ROOT, relative), 'utf-8');
  const sf = ts.createSourceFile(relative, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

  /** 同じファイルの const NAME = '...' (文字列) */
  const constStrings = new Map<string, string>();
  const collectConsts = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isStringLiteralLike(node.initializer)) {
      constStrings.set(node.name.text, node.initializer.text);
    }
    ts.forEachChild(node, collectConsts);
  };
  collectConsts(sf);

  /** 値に解く: 文字列リテラル → 値・同じファイルの const の識別子 → 値・テンプレート文字列 → ソース */
  const valueOf = (expr: ts.Expression): string => {
    if (ts.isStringLiteralLike(expr)) return expr.text;
    if (ts.isIdentifier(expr) && constStrings.has(expr.text)) return constStrings.get(expr.text)!;
    return expr.getText(sf);
  };

  const guardCalls: GuardCall[] = [];
  let bareRequireRoleCalls = 0;
  let loginRedirects = 0;
  const bannerNexts: string[] = [];

  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const name = node.expression.text;
      if (name === PAGE_GUARD_FUNCTION) {
        const [rolesArg, optionsArg] = node.arguments;
        const roles =
          rolesArg && ts.isArrayLiteralExpression(rolesArg) && rolesArg.elements.every((e) => ts.isStringLiteralLike(e))
            ? rolesArg.elements.map((e) => (e as ts.StringLiteralLike).text)
            : null;
        const options = new Map<string, string>();
        if (optionsArg && ts.isObjectLiteralExpression(optionsArg)) {
          for (const property of optionsArg.properties) {
            if (ts.isPropertyAssignment(property) && ts.isIdentifier(property.name)) {
              options.set(property.name.text, valueOf(property.initializer));
            }
          }
        }
        guardCalls.push({ roles, options });
      }
      if (name === 'requireRole') bareRequireRoleCalls += 1;
      if (name === 'redirect' && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0]) && node.arguments[0].text === '/login') {
        loginRedirects += 1;
      }
    }
    if ((ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) && node.tagName.getText(sf) === GRACE_BANNER_COMPONENT) {
      for (const attribute of node.attributes.properties) {
        if (ts.isJsxAttribute(attribute) && attribute.name.getText(sf) === 'next' && attribute.initializer) {
          const init = attribute.initializer;
          if (ts.isStringLiteral(init)) bannerNexts.push(init.text);
          else if (ts.isJsxExpression(init) && init.expression) bannerNexts.push(valueOf(init.expression));
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { guardCalls, bareRequireRoleCalls, loginRedirects, bannerNexts };
}

function collectFiles(dir: string): string[] {
  const full = path.join(ROOT, dir);
  const out: string[] = [];
  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const next = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === '__tests__') continue;
        walk(next);
      } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.(test|spec)\.(ts|tsx)$/.test(entry.name)) {
        out.push(path.relative(ROOT, next).split(path.sep).join('/'));
      }
    }
  };
  walk(full);
  return out;
}

const sameSet = (a: ReadonlyArray<string>, b: ReadonlyArray<string>) =>
  a.length === b.length && new Set(a).size === a.length && a.every((x) => b.includes(x));

describe('運営の layout / page の requireRoleForPage (#1176 cross/12 §13.4.2)', () => {
  it.each(Object.entries(EXPECTED_PAGE_GUARDS))(
    'EXPECTED_PAGE_GUARDS: %s の requireRoleForPage の roles・next・forbiddenPath が表と同じ',
    (file, expected) => {
      const { guardCalls } = analyze(file);
      expect(guardCalls.length, `${file} の requireRoleForPage の呼び出しが 1 つでない`).toBe(1);
      const [call] = guardCalls;
      expect(call.roles, `${file} の第 1 引数が文字列の配列リテラルでない`).not.toBeNull();
      expect(sameSet(call.roles!, expected.roles), `${file}: roles [${call.roles}] は [${expected.roles}] のはず`).toBe(true);
      expect(call.options.get('next')).toBe(expected.next);
      if (expected.forbiddenPath === undefined) {
        expect(call.options.has('forbiddenPath'), `${file} は forbiddenPath を渡さない (既定 /login)`).toBe(false);
      } else {
        expect(call.options.get('forbiddenPath')).toBe(expected.forbiddenPath);
      }
    },
  );

  it('layout 3 つは MfaGraceBanner を JSX で描き、その next 属性が表の「バナーの next」と同じ', () => {
    const layouts = Object.entries(EXPECTED_PAGE_GUARDS).filter(([, expected]) => expected.bannerNext !== undefined);
    expect(layouts).toHaveLength(3);
    for (const [file, expected] of layouts) {
      expect(analyze(file).bannerNexts, file).toEqual([expected.bannerNext]);
    }
    for (const [file, expected] of Object.entries(EXPECTED_PAGE_GUARDS)) {
      if (expected.bannerNext === undefined) expect(analyze(file).bannerNexts, `${file} (page) はバナーを描かない`).toEqual([]);
    }
  });

  it("14 ファイルのどれにも素の requireRole( が無く、redirect('/login') の文字列も残っていない", () => {
    for (const file of Object.keys(EXPECTED_PAGE_GUARDS)) {
      const { bareRequireRoleCalls, loginRedirects } = analyze(file);
      expect(bareRequireRoleCalls, `${file} に素の requireRole( がある`).toBe(0);
      expect(loginRedirects, `${file} に redirect('/login') が残っている`).toBe(0);
    }
  });

  it('表の 14 ファイルが全部存在し、PAGE_ROOTS の中で requireRoleForPage を呼ぶファイルの集合 ((support) の server layout を除く) と表のファイルの集合が同じ', () => {
    const tableFiles = Object.keys(EXPECTED_PAGE_GUARDS);
    expect(tableFiles).toHaveLength(14);
    for (const file of tableFiles) expect(fs.existsSync(path.join(ROOT, file)), `${file} が無い`).toBe(true);
    const callers = PAGE_ROOTS.flatMap(collectFiles)
      .filter((file) => file !== SUPPORT_AREA_GUARD_LAYOUT)
      .filter((file) => analyze(file).guardCalls.length > 0)
      .sort();
    expect(callers).toEqual([...tableFiles].sort());
  });
});
