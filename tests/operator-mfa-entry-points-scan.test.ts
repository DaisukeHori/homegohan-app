/**
 * 運営ロールの MFA (AAL2) の入口の走査 (#1176。docs/design/cross/12-operator-mfa.md §20。段 B で新設・段 D で ⑨⑩ を足す)
 *
 * 運営の入口は requireRole の末尾の 1 か所で AAL2 を求める (§7.1)。その 1 か所を取りこぼす書き方が無いことを、
 * ソースの構文木 (TypeScript。コメント・文字列の中は見ない。ただし (a) は文字列リテラルそのものを見る) で毎回確かめる:
 *   ① 運営の route の全 HTTP handler が、入口の関数 (requireRole / requireSuperAdmin / respondNotSupported) を呼ぶ
 *   ② requireRole の { assurance: 'session' } (AAL の判定を外す) は自己サービスの 4 route だけ
 *   ③ requireOrgRole (ゲートを持たない) の呼び出しが src/app に無い
 *   ④ Web の運営の区画の layout は requireRoleForPage を呼び、page / layout に素の requireRole が無い
 *   ⑤ requireRole・requireSuperAdmin・lib の認可ヘルパーがゲートを外していない
 *   ⑥ @/lib/auth/mfa/assurance を import してよいのは helpers.ts・自己サービスの route・テストだけ
 *   ⑦ 番兵 (走査が空振りしていない)
 *   ⑧ 自動の取り込みの除外が古くない
 * 限界 (見張りであって証明ではない): GATED_HELPER_FUNCTIONS に載っていない別ファイルの関数へ委ねた中で requireRole を呼ぶ書き方は
 * ① で「呼んでいない」と出る。requireUser() で止める一般の route は母集合に入らない。DB を直接呼ぶ経路は §20.1 の DB の検査が見る。
 */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { MFA_REQUIRED_ROLES } from '@/lib/auth/mfa/policy';

const ROOT = path.resolve(__dirname, '..');

/** 走査の母集合 */
const API_ROOTS = ['src/app/api/admin', 'src/app/api/super-admin', 'src/app/api/operator', 'src/app/api/support'];
/** Server Component の layout / page で守る Web の運営の区画 ((support) は §13.4.1 の server layout の階層) */
const PAGE_ROOTS = ['src/app/admin', 'src/app/super-admin', 'src/app/(operator)', 'src/app/(support)/support'];
/**
 * 母集合の外にあるが運営ロールを要求する route。番兵として明記する (⑦ で自動の取り込みに入っていることも確かめる)。
 * API_ROOTS の外の src/app/**\/route.ts は、次のどれかに当たれば自動で母集合に入れる:
 *   (a) MFA_REQUIRED_ROLES のどれかと同じ文字列リテラル ('super_admin' など) を持つ。ただし AUTO_INCLUDE_EXCLUSIONS に載せたファイルは (a) では入れない
 *   (b) ROLE_CONSTANT_NAMES のどれかを参照する (定数経由の roles。下の定義)
 *   (c) GATED_ENTRY_FUNCTIONS・requireOrgRole のどれかを呼ぶ (引数の書き方によらない。除外は効かない)
 */
const EXTRA_OPERATOR_ROUTES = ['src/app/api/announcements/route.ts', 'src/app/api/comparison/trigger/route.ts'];
/**
 * (a) の除外: 運営ロールの文字列を持つが、運営の権限を与える認可ではない route。理由を書く (⑧ が理由の長さと、今も当たることを確かめる)
 */
const AUTO_INCLUDE_EXCLUSIONS: Readonly<Record<string, string>> = {
  'src/app/(auth)/auth/callback/route.ts':
    'OAuth のコールバック。roles はログイン後の行き先 (/admin か /home か) の振り分けにだけ使い、権限を与えない。運営の画面側の requireRoleForPage が判定する',
  'src/app/api/handson-tour/complete/route.ts':
    '一般の利用者の route (supabase.auth.getUser() で止める)。ADMIN_ROLES はハンズオンツアーの出し分けにだけ使い、運営の権限を与えない',
};
/**
 * lib の認可ヘルパー (route が requireRole の代わりに呼ぶ入口)。名前 → 定義のファイル。
 * ここに載せた関数は ① で requireRole と同じ「入口の呼び出し」として数え、⑤ で本体がゲートを外していないことを確かめる
 */
const GATED_HELPER_FUNCTIONS = { respondNotSupported: 'src/lib/admin/not-supported.ts' } as const;
/** requireRole に { assurance: 'session' } を渡してよいファイル (自己サービスのうち AAL1 で使うものだけ) */
const MFA_SELF_SERVICE_ROUTES = [
  'src/app/api/auth/mfa/status/route.ts',
  'src/app/api/auth/mfa/enroll/route.ts',
  'src/app/api/auth/mfa/verify/route.ts',
  'src/app/api/auth/mfa/recover/route.ts',
];
/** AAL2 のゲートを持つ入口の関数 */
const GATED_ENTRY_FUNCTIONS = ['requireRole', 'requireSuperAdmin', ...Object.keys(GATED_HELPER_FUNCTIONS)];

/** ゲートを持たない組織の役割の入口 (③) */
const UNGATED_ORG_ROLE_FUNCTION = 'requireOrgRole';
/** Web の運営の画面の入口 (④) */
const PAGE_GUARD_FUNCTION = 'requireRoleForPage';
/** 判定の facade (⑥) */
const ASSURANCE_MODULE = 'src/lib/auth/mfa/assurance';
/** ⑥ で import を許すファイル (テストは別に許す) */
const ASSURANCE_IMPORT_ALLOWED_FILES = ['src/lib/auth/helpers.ts'];
const ASSURANCE_IMPORT_ALLOWED_PREFIX = 'src/app/api/auth/mfa/';
/** (support) 区画の server layout (⑦) */
const SUPPORT_AREA_GUARD_LAYOUT = 'src/app/(support)/support/layout.tsx';

/** ⑦ の番兵の下限 (2026-10-15 の実測の数より下に置く。走査が空振りしていないことだけを見る) */
const MIN_OPERATOR_ROUTE_FILES = 60;
const MIN_PAGE_FILES = 20;
const MIN_ROUTES_CALLING_REQUIRE_ROLE = 40;
const MIN_ROUTES_VIA_GATED_HELPER = 2;
/** ⑧ の理由の最小の長さ */
const MIN_REASON_LENGTH = 10;

const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const REQUIRED_ROLE_LITERALS: ReadonlySet<string> = new Set(MFA_REQUIRED_ROLES);

// ─────────────────────────────────────────────
// ソース解析
// ─────────────────────────────────────────────

interface CallSite {
  /** 呼び出した関数の名前 (識別子の呼び出しだけ) */
  readonly name: string;
  readonly args: ReadonlyArray<ts.Expression>;
}

interface SourceAnalysis {
  /** export された HTTP handler の名前 → handler が (同じファイルの関数を辿って推移的に) 呼ぶ関数の名前 */
  readonly handlers: ReadonlyMap<string, ReadonlySet<string>>;
  /** ファイル全体の識別子の呼び出し */
  readonly calls: ReadonlyArray<CallSite>;
  /** 文字列リテラル (テンプレートの置換の無いものを含む) の値 */
  readonly stringLiterals: ReadonlySet<string>;
  /** 参照している識別子 (宣言の名前を含む) */
  readonly identifiers: ReadonlySet<string>;
  /** 関数の引数として宣言された名前 */
  readonly parameterNames: ReadonlySet<string>;
  /** import の module specifier */
  readonly imports: ReadonlyArray<string>;
  /** トップレベルの関数宣言 / const の関数の名前 → 本体の中の呼び出し (⑤ 用) */
  readonly functionBodies: ReadonlyMap<string, { readonly exported: boolean; readonly calls: ReadonlyArray<CallSite> }>;
}

function collectCallSites(root: ts.Node): CallSite[] {
  const calls: CallSite[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      calls.push({ name: node.expression.text, args: node.arguments });
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return calls;
}

function isExported(node: ts.Node): boolean {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
}

function analyzeSource(source: string, fileName = 'file.tsx'): SourceAnalysis {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const stringLiterals = new Set<string>();
  const identifiers = new Set<string>();
  const parameterNames = new Set<string>();
  const imports: string[] = [];
  /** 同じファイルの関数 (関数宣言と const x = (…) => … / const x = function …) → 本体で呼ぶ関数の名前 */
  const localFunctions = new Map<string, Set<string>>();
  const functionBodies = new Map<string, { exported: boolean; calls: CallSite[] }>();
  const handlerRoots = new Map<string, ts.Node>();

  const visit = (node: ts.Node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) stringLiterals.add(node.text);
    if (ts.isIdentifier(node)) identifiers.add(node.text);
    if (ts.isParameter(node) && ts.isIdentifier(node.name)) parameterNames.add(node.name.text);
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) imports.push(node.moduleSpecifier.text);
    if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      imports.push(node.moduleSpecifier.text);
    }

    if (ts.isFunctionDeclaration(node) && node.name && node.body) {
      const calls = collectCallSites(node.body);
      localFunctions.set(node.name.text, new Set(calls.map((c) => c.name)));
      if (node.parent === sf) functionBodies.set(node.name.text, { exported: isExported(node), calls });
      if (HTTP_METHODS.has(node.name.text) && isExported(node)) handlerRoots.set(node.name.text, node.body);
    }
    if (ts.isVariableStatement(node)) {
      for (const declaration of node.declarationList.declarations) {
        const init = declaration.initializer;
        if (!ts.isIdentifier(declaration.name) || !init) continue;
        if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) {
          const calls = collectCallSites(init.body);
          localFunctions.set(declaration.name.text, new Set(calls.map((c) => c.name)));
          if (node.parent === sf) functionBodies.set(declaration.name.text, { exported: isExported(node), calls });
        }
        if (HTTP_METHODS.has(declaration.name.text) && isExported(node)) handlerRoots.set(declaration.name.text, init);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  // handler が推移的に呼ぶ関数 (同じファイルの関数を辿る)
  const handlers = new Map<string, Set<string>>();
  for (const [name, root] of handlerRoots) {
    const reached = new Set<string>();
    const queue = collectCallSites(root).map((c) => c.name);
    while (queue.length > 0) {
      const callee = queue.pop()!;
      if (reached.has(callee)) continue;
      reached.add(callee);
      for (const next of localFunctions.get(callee) ?? []) queue.push(next);
    }
    handlers.set(name, reached);
  }

  return {
    handlers,
    calls: collectCallSites(sf),
    stringLiterals,
    identifiers,
    parameterNames,
    imports,
    functionBodies,
  };
}

/** (a): MFA_REQUIRED_ROLES のどれかと同じ文字列リテラルを持つ */
function hitsRoleLiteral(analysis: SourceAnalysis): boolean {
  return [...analysis.stringLiterals].some((value) => REQUIRED_ROLE_LITERALS.has(value));
}

/** (b): 定数経由の roles を参照する */
function hitsRoleConstant(analysis: SourceAnalysis, roleConstants: ReadonlySet<string>): boolean {
  return [...analysis.identifiers].some((name) => roleConstants.has(name));
}

/** (c): 入口の関数か requireOrgRole を呼ぶ */
function hitsEntryCall(analysis: SourceAnalysis): boolean {
  return analysis.calls.some((c) => GATED_ENTRY_FUNCTIONS.includes(c.name) || c.name === UNGATED_ORG_ROLE_FUNCTION);
}

/** ① の判定: 入口の関数を (推移的に) 呼ばない handler の名前 */
function ungatedHandlers(analysis: SourceAnalysis): string[] {
  return [...analysis.handlers]
    .filter(([, reached]) => !GATED_ENTRY_FUNCTIONS.some((fn) => reached.has(fn)))
    .map(([name]) => name);
}

/** 第 2 引数に { assurance: 'session' } を持つ requireRole の呼び出しがあるか */
function hasSessionAssuranceOptOut(analysis: SourceAnalysis): boolean {
  return analysis.calls.some((c) => c.name === 'requireRole' && c.args.length >= 2 && isSessionAssuranceObject(c.args[1]));
}

function isSessionAssuranceObject(expr: ts.Expression): boolean {
  if (!ts.isObjectLiteralExpression(expr)) return false;
  return expr.properties.some(
    (p) =>
      ts.isPropertyAssignment(p) &&
      ((ts.isIdentifier(p.name) && p.name.text === 'assurance') || (ts.isStringLiteral(p.name) && p.name.text === 'assurance')) &&
      ts.isStringLiteralLike(p.initializer) &&
      p.initializer.text === 'session',
  );
}

/** requireRole( / requireRoleForPage( の第 1 引数の識別子 (関数の引数の名前は除く: ヘルパーが受け取った roles を渡すだけのもの) */
function requireRoleArgumentIdentifiers(analysis: SourceAnalysis): string[] {
  return analysis.calls
    .filter((c) => (c.name === 'requireRole' || c.name === PAGE_GUARD_FUNCTION) && c.args.length > 0)
    .map((c) => c.args[0])
    .filter((arg): arg is ts.Identifier => ts.isIdentifier(arg))
    .map((arg) => arg.text)
    .filter((name) => !analysis.parameterNames.has(name));
}

/** import の specifier を、リポジトリの相対パス (拡張子なし) に解く。'@/' は src/。それ以外のパッケージは null */
function resolveImport(fromFile: string, specifier: string): string | null {
  if (specifier.startsWith('@/')) return path.posix.join('src', specifier.slice(2));
  if (specifier.startsWith('.')) return path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), specifier));
  return null;
}

// ─────────────────────────────────────────────
// リポジトリのファイル
// ─────────────────────────────────────────────

function isTestPath(relative: string): boolean {
  return /(^|\/)__tests__\//.test(relative) || /\.(test|spec)\.(ts|tsx)$/.test(relative);
}

function collectFiles(dir: string, filter: (relative: string) => boolean): string[] {
  const full = path.join(ROOT, dir);
  if (!fs.existsSync(full)) return [];
  const out: string[] = [];
  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const next = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules') continue;
        walk(next);
        continue;
      }
      const relative = path.relative(ROOT, next).split(path.sep).join('/');
      if (/\.(ts|tsx)$/.test(entry.name) && !isTestPath(relative) && filter(relative)) out.push(relative);
    }
  };
  walk(full);
  return out.sort();
}

const analysisCache = new Map<string, SourceAnalysis>();
function analyzeFile(relative: string): SourceAnalysis {
  const cached = analysisCache.get(relative);
  if (cached) return cached;
  const analysis = analyzeSource(fs.readFileSync(path.join(ROOT, relative), 'utf-8'), relative);
  analysisCache.set(relative, analysis);
  return analysis;
}

const srcFiles = collectFiles('src', () => true);

/** ROLE_CONSTANT_NAMES: src (テスト除く) で requireRole( / requireRoleForPage( の第 1 引数に識別子として渡されている名前 */
function collectRequireRoleArgumentIdentifiers(files: ReadonlyArray<string>): ReadonlySet<string> {
  const names = new Set<string>();
  for (const file of files) for (const name of requireRoleArgumentIdentifiers(analyzeFile(file))) names.add(name);
  return names;
}
const ROLE_CONSTANT_NAMES: ReadonlySet<string> = collectRequireRoleArgumentIdentifiers(srcFiles);

const isRouteFile = (relative: string) => relative.endsWith('/route.ts');
const apiRootRoutes = API_ROOTS.flatMap((root) => collectFiles(root, isRouteFile));
const apiRootSet = new Set(apiRootRoutes);
const outsideRoutes = collectFiles('src/app', isRouteFile).filter((file) => !apiRootSet.has(file));

interface AutoInclusion {
  readonly a: boolean;
  readonly b: boolean;
  readonly c: boolean;
}
function autoInclusionOf(file: string): AutoInclusion {
  const analysis = analyzeFile(file);
  return {
    a: hitsRoleLiteral(analysis),
    b: hitsRoleConstant(analysis, ROLE_CONSTANT_NAMES),
    c: hitsEntryCall(analysis),
  };
}
function isAutoIncluded(file: string): boolean {
  const hit = autoInclusionOf(file);
  return (hit.a && !(file in AUTO_INCLUDE_EXCLUSIONS)) || hit.b || hit.c;
}
const autoIncludedRoutes = outsideRoutes.filter(isAutoIncluded);
const operatorRoutes = [...new Set([...apiRootRoutes, ...autoIncludedRoutes, ...EXTRA_OPERATOR_ROUTES])].sort();

const pageRootFiles = PAGE_ROOTS.flatMap((root) => collectFiles(root, () => true));
const pageAndLayoutFiles = pageRootFiles.filter((file) => /\/(page|layout)\.tsx$/.test(file));
const layoutFiles = pageRootFiles.filter((file) => file.endsWith('/layout.tsx'));

// ─────────────────────────────────────────────
// リポジトリのソースに対する contract
// ─────────────────────────────────────────────
describe('運営の MFA の入口 (#1176 cross/12 §20): src のソース', () => {
  it('① 運営の route の全 HTTP handler が、入口の関数 (requireRole / requireSuperAdmin / respondNotSupported) を呼ぶ', () => {
    const violations = operatorRoutes.flatMap((file) =>
      fs.existsSync(path.join(ROOT, file)) ? ungatedHandlers(analyzeFile(file)).map((name) => `${file} ${name}`) : [],
    );
    expect(
      violations,
      '運営の route は requireRole(...) / requireSuperAdmin() を呼ぶこと (ゲートは requireRole の中にある。cross/12 §13.1)。' +
        '別ファイルのヘルパーに委ねるなら GATED_HELPER_FUNCTIONS に足して ⑤ の検査に入れる:\n' +
        violations.join('\n'),
    ).toEqual([]);
  });

  it("② requireRole の { assurance: 'session' } は MFA_SELF_SERVICE_ROUTES だけ。その 4 ファイルは必ず書く", () => {
    const optOut = srcFiles.filter((file) => hasSessionAssuranceOptOut(analyzeFile(file)));
    expect(optOut.sort()).toEqual([...MFA_SELF_SERVICE_ROUTES].sort());
  });

  it('③ src/app に requireOrgRole の呼び出しが無い (ゲートを持たない)', () => {
    const violations = srcFiles
      .filter((file) => file.startsWith('src/app/'))
      .filter((file) => analyzeFile(file).calls.some((c) => c.name === UNGATED_ORG_ROLE_FUNCTION));
    expect(violations, '産業医などの入口は requireRole([...]) + profile.organization_id の絞り込みで作る (cross/12 §7.2 ③)').toEqual([]);
  });

  it('④ PAGE_ROOTS の全 layout.tsx は requireRoleForPage を呼び、PAGE_ROOTS に素の requireRole が無く、各ディレクトリに layout.tsx がある', () => {
    const layoutsWithoutGuard = layoutFiles.filter((file) => !analyzeFile(file).calls.some((c) => c.name === PAGE_GUARD_FUNCTION));
    expect(layoutsWithoutGuard).toEqual([]);
    const bareRequireRole = pageRootFiles.filter((file) => analyzeFile(file).calls.some((c) => c.name === 'requireRole'));
    expect(bareRequireRole, 'page / layout は requireRoleForPage (@/lib/auth/page-guard) を呼ぶ (ログイン画面との往復を防ぐ)').toEqual([]);
    for (const root of PAGE_ROOTS) {
      expect(
        layoutFiles.some((file) => file.startsWith(`${root}/`)),
        `${root} に layout.tsx が無い`,
      ).toBe(true);
    }
  });

  it('⑤ requireRole は assertOperatorAssurance を、requireSuperAdmin は requireRole を、lib の認可ヘルパーは既定の requireRole を呼ぶ', () => {
    const helpers = analyzeFile('src/lib/auth/helpers.ts').functionBodies.get('requireRole');
    expect(helpers?.calls.some((c) => c.name === 'assertOperatorAssurance')).toBe(true);
    const superAdmin = analyzeFile('src/lib/auth/operator-permissions.ts').functionBodies.get('requireSuperAdmin');
    expect(superAdmin?.calls.some((c) => c.name === 'requireRole')).toBe(true);
    for (const [name, file] of Object.entries(GATED_HELPER_FUNCTIONS)) {
      const body = analyzeFile(file).functionBodies.get(name);
      expect(body?.exported, `${file} が ${name} を export していない`).toBe(true);
      expect(
        body?.calls.some((c) => c.name === 'requireRole' && c.args.length === 1),
        `${file} の ${name} が第 2 引数の無い (既定の aal2) requireRole を呼んでいない`,
      ).toBe(true);
    }
  });

  it('⑥ @/lib/auth/mfa/assurance を import するのは src/lib/auth/helpers.ts・src/app/api/auth/mfa/**・テストだけ', () => {
    const violations = srcFiles.filter((file) => {
      if (ASSURANCE_IMPORT_ALLOWED_FILES.includes(file) || file.startsWith(ASSURANCE_IMPORT_ALLOWED_PREFIX)) return false;
      if (file === `${ASSURANCE_MODULE}.ts`) return false;
      return analyzeFile(file).imports.some((specifier) => resolveImport(file, specifier) === ASSURANCE_MODULE);
    });
    expect(violations, 'route や画面が自分で claims を読まない (手製のゲートを作らない。requireRole を使う)').toEqual([]);
  });

  it('⑦ 番兵: 走査が空振りしていない', () => {
    expect(operatorRoutes.length).toBeGreaterThanOrEqual(MIN_OPERATOR_ROUTE_FILES);
    expect(pageAndLayoutFiles.length).toBeGreaterThanOrEqual(MIN_PAGE_FILES);
    const callingRequireRole = operatorRoutes.filter((file) => analyzeFile(file).calls.some((c) => c.name === 'requireRole'));
    expect(callingRequireRole.length).toBeGreaterThanOrEqual(MIN_ROUTES_CALLING_REQUIRE_ROLE);
    for (const file of [...EXTRA_OPERATOR_ROUTES, ...MFA_SELF_SERVICE_ROUTES]) {
      expect(fs.existsSync(path.join(ROOT, file)), `${file} が無い`).toBe(true);
    }
    for (const file of EXTRA_OPERATOR_ROUTES) {
      expect(isAutoIncluded(file), `${file} が自動の取り込み (a)〜(c) に入っていない`).toBe(true);
    }
    expect(ROLE_CONSTANT_NAMES.has('INQUIRY_ADMIN_ROLES')).toBe(true);
    expect(ROLE_CONSTANT_NAMES.has('NPS_EXPORT_ROLES')).toBe(true);
    const viaHelper = operatorRoutes.filter((file) =>
      [...analyzeFile(file).handlers.values()].some((reached) => Object.keys(GATED_HELPER_FUNCTIONS).some((fn) => reached.has(fn))),
    );
    expect(viaHelper.length).toBeGreaterThanOrEqual(MIN_ROUTES_VIA_GATED_HELPER);
    expect(layoutFiles).toContain(SUPPORT_AREA_GUARD_LAYOUT);
  });

  it('⑧ AUTO_INCLUDE_EXCLUSIONS の各行は、ファイルがあり、理由が 10 文字以上で、今も (a) に当たり、(c) に当たらない', () => {
    for (const [file, reason] of Object.entries(AUTO_INCLUDE_EXCLUSIONS)) {
      expect(fs.existsSync(path.join(ROOT, file)), `${file} が無い: 除外から消すこと`).toBe(true);
      expect(reason.trim().length).toBeGreaterThanOrEqual(MIN_REASON_LENGTH);
      const hit = autoInclusionOf(file);
      expect(hit.a, `${file} はもう運営ロールの文字列を持たない: 除外から消すこと`).toBe(true);
      expect(hit.c, `${file} は入口の関数を呼ぶ: 除外は要らない (母集合に入れる)`).toBe(false);
    }
  });
});

// ─────────────────────────────────────────────
// 走査ロジック自体の確認 (合成ソースで検出できること / 誤検出しないこと)
// ─────────────────────────────────────────────
describe('運営の MFA の入口 (#1176 cross/12 §20): ソース解析のロジック', () => {
  it('① 定数の roles で requireRole(ROLES) を呼ぶ handler は通る', () => {
    const analysis = analyzeSource(`
      const ROLES = ['admin', 'super_admin'];
      export async function GET() { await requireRole(ROLES); }
    `);
    expect(ungatedHandlers(analysis)).toEqual([]);
  });

  it('① const respond = () => respondNotSupported({...}) を handler が呼ぶと通る (同一ファイルの arrow 関数を辿る)', () => {
    const analysis = analyzeSource(`
      const respond = () => respondNotSupported({ roles: ['super_admin'] });
      export async function GET() { return respond(); }
      export const POST = async () => respond();
    `);
    expect(ungatedHandlers(analysis)).toEqual([]);
  });

  it('① 別ファイルの未登録のヘルパーへ委ねるだけの handler は赤', () => {
    const analysis = analyzeSource(`
      import { authorizeAdmin } from '@/lib/admin/authorize';
      export async function GET() { await authorizeAdmin(); }
    `);
    expect(ungatedHandlers(analysis)).toEqual(['GET']);
  });

  it("① API_ROOTS の外で roles.includes('admin') だけで判定する route は (a) で母集合に入り、① で赤", () => {
    const analysis = analyzeSource(`
      export async function POST() { if (!profile.roles.includes('admin')) return forbidden(); }
    `);
    expect(hitsRoleLiteral(analysis)).toBe(true);
    expect(ungatedHandlers(analysis)).toEqual(['POST']);
  });

  it('(a) AUTO_INCLUDE_EXCLUSIONS に載せたファイルは (a) で入らない (callback の route は除外されている)', () => {
    const file = 'src/app/(auth)/auth/callback/route.ts';
    expect(autoInclusionOf(file).a).toBe(true);
    expect(autoIncludedRoutes).not.toContain(file);
  });

  it("(a) コメントの中の 'admin' は当たらない", () => {
    expect(hitsRoleLiteral(analyzeSource(`// roles に 'admin' があれば\nexport const x = 1;`))).toBe(false);
  });

  it("(b) requireRole(X_ROLES) に渡した名前は集まり、渡していない ORG_ADMIN_ROLES = ['owner','admin'] は集まらない", () => {
    const analysis = analyzeSource(`
      const X_ROLES = ['admin'];
      const ORG_ADMIN_ROLES = ['owner', 'admin'];
      export async function GET() { await requireRole(X_ROLES); return ORG_ADMIN_ROLES; }
      export async function page(allowedRoles) { return requireRoleForPage(allowedRoles, { next: '/x' }); }
    `);
    expect(requireRoleArgumentIdentifiers(analysis)).toEqual(['X_ROLES']);
  });

  it("② requireRole(roles, { assurance: 'session' }) を検出し、第 2 引数の無い呼び出しと別の値は検出しない", () => {
    expect(hasSessionAssuranceOptOut(analyzeSource(`await requireRole(R, { assurance: 'session' });`))).toBe(true);
    expect(hasSessionAssuranceOptOut(analyzeSource(`await requireRole(R);`))).toBe(false);
    expect(hasSessionAssuranceOptOut(analyzeSource(`await requireRole(R, { assurance: 'aal2' });`))).toBe(false);
  });

  it('③ requireOrgRole の呼び出しを検出する', () => {
    expect(analyzeSource(`await requireOrgRole(userId, orgId, ['org_industrial_doctor']);`).calls.map((c) => c.name)).toContain(
      UNGATED_ORG_ROLE_FUNCTION,
    );
  });

  it('④ page が requireRole を直接呼ぶと検出し、requireRoleForPage だけなら検出しない', () => {
    const bare = analyzeSource(`export default async function Page() { await requireRole(['admin']); }`);
    expect(bare.calls.some((c) => c.name === 'requireRole')).toBe(true);
    const guarded = analyzeSource(`export default async function Page() { await requireRoleForPage(['admin'], { next: '/admin' }); }`);
    expect(guarded.calls.some((c) => c.name === 'requireRole')).toBe(false);
    expect(guarded.calls.some((c) => c.name === PAGE_GUARD_FUNCTION)).toBe(true);
  });

  it("⑤ ヘルパーの本体が requireRole(roles, { assurance: 'session' }) を呼ぶと、既定の requireRole を呼んでいないとみなす (赤)", () => {
    const analysis = analyzeSource(`
      export async function respondNotSupported(options) { await requireRole(options.roles, { assurance: 'session' }); }
    `);
    const body = analysis.functionBodies.get('respondNotSupported');
    expect(body?.exported).toBe(true);
    expect(body?.calls.some((c) => c.name === 'requireRole' && c.args.length === 1)).toBe(false);
  });

  it('⑥ 相対パスと別名の import を同じモジュールに解く', () => {
    expect(resolveImport('src/lib/auth/helpers.ts', './mfa/assurance')).toBe(ASSURANCE_MODULE);
    expect(resolveImport('src/app/api/x/route.ts', '@/lib/auth/mfa/assurance')).toBe(ASSURANCE_MODULE);
    expect(resolveImport('src/app/api/x/route.ts', 'zod')).toBeNull();
  });
});
