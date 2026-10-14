/**
 * #1161 ロール認可のソース走査 contract テスト
 *
 * org_admin / support / admin の認可が route ごとに手書きされ、コピー同士で食い違って不具合になっていた
 * (support 画面が他ユーザーを開けない、org 系の判定が route ごとに違う、など)。再発を防ぐための安全網。
 * src/app/api 配下の全 route をソースとして読み (TypeScript の構文木で解析するので、コメントや文字列の中は見ない)、
 *
 *   1. `profile?.roles?.some(...)` のような、DB の行から読んだ roles を手書きで判定する書き方が無いこと
 *      -> requireRole() を使う。requireRole の戻り値の roles は null にならないので `?.` は要らない。
 *         `?.` で roles を判定しているのは、route が user_profiles を自分で読んで判定している印。
 *   2. `['owner', 'admin']` の手書きの許可リストや、isOrgAdmin() の直接呼び出しが無いこと
 *      -> 組織の管理者判定は requireOrgAdmin() (src/lib/auth/helpers.ts) を使う。
 *   3. 組織の管理系 route / サポート系 route / お知らせ route の全ての HTTP handler が、決められた共通ヘルパーを
 *      決められたロールで呼んでいること (許可するロールを黙って変えたり、handler を足して認可を忘れたりしない)
 *   4. 許可リスト (ALLOW_LIST) が古くならないこと
 *
 * 本当に手書きの判定が必要な route は、理由を書いて ALLOW_LIST に足す。ただし、まず共通ヘルパーで書けないか考えること。
 */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const SCAN_ROOT = 'src/app/api';

/**
 * 手書きの判定を許す route と、その理由 (キーは「ファイル」、値は種別ごとの理由)。
 * 今は無い。足すときは、共通ヘルパー (requireRole / requireOrgAdmin) で書けない理由を具体的に書くこと。
 */
type FindingKind = 'roles-check' | 'org-role-allow-list' | 'is-org-admin-call';
const ALLOW_LIST: Record<string, Partial<Record<FindingKind, string>>> = {};

/** 組織の管理系 route: 全ての HTTP handler が requireOrgAdmin() を呼ぶ */
const ORG_ADMIN_ROUTES = [
  'src/app/api/org/departments/route.ts',
  'src/app/api/org/members/route.ts',
  'src/app/api/org/settings/route.ts',
  'src/app/api/org/stats/route.ts',
  'src/app/api/org/challenges/route.ts',
  'src/app/api/org/invites/route.ts',
  'src/app/api/org/invites/[id]/revoke/route.ts',
  'src/app/api/org/members/[user_id]/remove/route.ts',
];

/**
 * 組織のメンバー向けの route (#1132。役割は問わず、いずれかの組織に所属していればよい):
 * 全ての HTTP handler が requireOrgMember() (src/lib/auth/org-member.ts) を呼ぶ。
 * route に getUser() → user_profiles の取得 → 所属の判定を手書きしない
 */
const ORG_MEMBER_ROUTES = [
  'src/app/api/org/my-challenges/route.ts',
  'src/app/api/org/challenges/[id]/route.ts',
  'src/app/api/org/challenges/[id]/join/route.ts',
];

const SUPPORT_ROLES = ['support', 'admin', 'super_admin'];
const ADMIN_ROLES = ['admin', 'super_admin'];

/** requireRole() で認可する route: 全ての HTTP handler が、決められたロールで requireRole() を呼ぶ */
const ROLE_GATED_ROUTES: Record<string, string[]> = {
  'src/app/api/support/stats/route.ts': SUPPORT_ROLES,
  'src/app/api/support/users/[id]/route.ts': SUPPORT_ROLES,
  'src/app/api/support/users/[id]/notes/route.ts': SUPPORT_ROLES,
  'src/app/api/announcements/route.ts': ADMIN_ROLES,
};

const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const ARRAY_METHODS = new Set(['some', 'every', 'includes', 'find', 'findIndex', 'indexOf', 'filter']);

// ─────────────────────────────────────────────
// ソース解析
// ─────────────────────────────────────────────
interface Finding {
  kind: FindingKind;
  line: number;
  text: string;
}

interface HandlerInfo {
  name: string;
  /** handler の中で呼んでいる関数名 -> 第 1 引数が文字列の配列リテラルなら、その中身 */
  calls: Map<string, string[][]>;
}

interface SourceAnalysis {
  findings: Finding[];
  handlers: HandlerInfo[];
}

/** 括弧・非 null アサーション・型アサーションを外す */
function unwrap(expr: ts.Expression): ts.Expression {
  let current = expr;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function isRolesAccess(expr: ts.Expression): expr is ts.PropertyAccessExpression {
  const inner = unwrap(expr);
  return ts.isPropertyAccessExpression(inner) && inner.name.text === 'roles';
}

function stringElements(node: ts.ArrayLiteralExpression): string[] | null {
  const values: string[] = [];
  for (const element of node.elements) {
    if (!ts.isStringLiteralLike(element)) return null;
    values.push(element.text);
  }
  return values;
}

/** 順序を無視して同じ要素か。重複があるものは別物として扱う */
function sameSet(a: string[], b: string[]): boolean {
  const setA = new Set(a);
  const setB = new Set(b);
  return setA.size === a.length && setB.size === b.length && a.length === b.length && a.every((x) => setB.has(x));
}

function analyzeSource(source: string, fileName = 'file.ts'): SourceAnalysis {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const findings: Finding[] = [];
  const handlers: HandlerInfo[] = [];

  const report = (kind: FindingKind, node: ts.Node) => {
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    findings.push({ kind, line: line + 1, text: node.getText(sf).split('\n')[0].slice(0, 120) });
  };

  const collectCalls = (root: ts.Node): Map<string, string[][]> => {
    const calls = new Map<string, string[][]>();
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        const list = calls.get(node.expression.text) ?? [];
        const first = node.arguments[0];
        list.push(first && ts.isArrayLiteralExpression(first) ? (stringElements(first) ?? []) : []);
        calls.set(node.expression.text, list);
      }
      ts.forEachChild(node, visit);
    };
    visit(root);
    return calls;
  };

  const visit = (node: ts.Node): void => {
    // 1. 手書きの roles 判定: `x?.roles?.some(...)` / `(x.roles ?? []).includes(...)` など
    if (ts.isCallExpression(node)) {
      const callee = unwrap(node.expression);
      if (ts.isPropertyAccessExpression(callee) && ARRAY_METHODS.has(callee.name.text)) {
        const receiver = unwrap(callee.expression);
        // 1-a. roles を `?.` で辿っている (DB の行を直接見ている印)
        if (isRolesAccess(receiver) && (callee.questionDotToken || receiver.questionDotToken)) {
          report('roles-check', node);
        }
        // 1-b. `(x.roles ?? [])` / `(x.roles || [])` の形で、roles が null の場合に備えている
        else if (
          ts.isBinaryExpression(receiver) &&
          (receiver.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
            receiver.operatorToken.kind === ts.SyntaxKind.BarBarToken) &&
          isRolesAccess(receiver.left)
        ) {
          report('roles-check', node);
        }
      }

      // 2-b. isOrgAdmin() の直接呼び出し (route は requireOrgAdmin() を使う)
      if (ts.isIdentifier(node.expression) && node.expression.text === 'isOrgAdmin') {
        report('is-org-admin-call', node);
      }
    }

    // 2-a. ['owner', 'admin'] の手書きの許可リスト
    if (ts.isArrayLiteralExpression(node)) {
      const values = stringElements(node);
      if (values && sameSet(values, ['owner', 'admin'])) report('org-role-allow-list', node);
    }

    // HTTP handler: `export async function GET(...)` / `export const GET = async (...) => ...`
    if (
      ts.isFunctionDeclaration(node) &&
      node.name &&
      HTTP_METHODS.has(node.name.text) &&
      node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
    ) {
      handlers.push({ name: node.name.text, calls: collectCalls(node) });
    }
    if (ts.isVariableStatement(node) && node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) {
      for (const declaration of node.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && HTTP_METHODS.has(declaration.name.text) && declaration.initializer) {
          handlers.push({ name: declaration.name.text, calls: collectCalls(declaration.initializer) });
        }
      }
    }

    ts.forEachChild(node, visit);
  };
  visit(sf);

  return { findings, handlers };
}

function collectSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      files.push(...collectSourceFiles(full));
    } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.(test|spec)\.(ts|tsx)$/.test(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

const analyses = new Map<string, SourceAnalysis>();
for (const file of collectSourceFiles(path.join(ROOT, SCAN_ROOT))) {
  const relative = path.relative(ROOT, file).split(path.sep).join('/');
  analyses.set(relative, analyzeSource(fs.readFileSync(file, 'utf-8'), relative));
}

const describeFinding = (file: string, f: Finding) => `${file}:${f.line} [${f.kind}] ${f.text}`;

// ─────────────────────────────────────────────
// リポジトリのソースに対する contract
// ─────────────────────────────────────────────
describe('ロール認可の手書き禁止 (#1161): src/app/api のソース', () => {
  it('走査が機能している: 既知の route と、requireRole を使う多数の route を検出している', () => {
    // 走査が壊れて何も見つけられなくなったときに、下の contract が空振りで通ってしまわないようにする
    expect(analyses.size).toBeGreaterThan(100);
    for (const file of [...ORG_ADMIN_ROUTES, ...ORG_MEMBER_ROUTES, ...Object.keys(ROLE_GATED_ROUTES)]) {
      expect(analyses.has(file), `${file} が走査に含まれていない`).toBe(true);
      expect(analyses.get(file)!.handlers.length, `${file} の HTTP handler を検出できていない`).toBeGreaterThan(0);
    }
    const usingRequireRole = [...analyses.values()].filter((a) => a.handlers.some((h) => h.calls.has('requireRole')));
    expect(usingRequireRole.length).toBeGreaterThan(40);
  });

  it.each(['roles-check', 'org-role-allow-list', 'is-org-admin-call'] as const)(
    '手書きの判定 (%s) が無い (許可リストの分を除く)',
    (kind) => {
      const violations = [...analyses]
        .flatMap(([file, analysis]) =>
          analysis.findings.filter((f) => f.kind === kind && !ALLOW_LIST[file]?.[kind]).map((f) => describeFinding(file, f)),
        );

      expect(
        violations,
        'route に roles / org_role の判定を手書きしないこと。requireRole(...) / requireOrgAdmin() を使う ' +
          '(src/lib/auth/helpers.ts)。どうしても必要なら、理由を書いて ALLOW_LIST に足す:\n' +
          violations.join('\n'),
      ).toEqual([]);
    },
  );

  it.each(ORG_ADMIN_ROUTES)('%s: 全ての HTTP handler が requireOrgAdmin() を呼ぶ', (file) => {
    const { handlers } = analyses.get(file)!;

    expect(handlers.length).toBeGreaterThan(0);
    const missing = handlers.filter((h) => !h.calls.has('requireOrgAdmin')).map((h) => h.name);
    expect(missing, `${file} の ${missing.join(', ')} が requireOrgAdmin() を呼んでいない`).toEqual([]);
  });

  it.each(ORG_MEMBER_ROUTES)('%s: 全ての HTTP handler が requireOrgMember() を呼ぶ', (file) => {
    const { handlers } = analyses.get(file)!;

    expect(handlers.length).toBeGreaterThan(0);
    const missing = handlers.filter((h) => !h.calls.has('requireOrgMember')).map((h) => h.name);
    expect(missing, `${file} の ${missing.join(', ')} が requireOrgMember() を呼んでいない`).toEqual([]);
  });

  it.each(Object.entries(ROLE_GATED_ROUTES))(
    '%s: 全ての HTTP handler が、決められたロールで requireRole() を呼ぶ',
    (file, roles) => {
      const { handlers } = analyses.get(file)!;

      expect(handlers.length).toBeGreaterThan(0);
      for (const handler of handlers) {
        const calls = handler.calls.get('requireRole') ?? [];
        expect(calls.length, `${file} の ${handler.name} が requireRole() を呼んでいない`).toBeGreaterThan(0);
        for (const called of calls) {
          expect(sameSet(called, roles), `${file} の ${handler.name}: requireRole([${called}]) は [${roles}] のはず`).toBe(true);
        }
      }
    },
  );

  describe('許可リストが古くなっていない', () => {
    it('許可リストのファイルは存在し、理由が書かれ、今もその手書きの判定を含んでいる', () => {
      for (const [file, reasons] of Object.entries(ALLOW_LIST)) {
        expect(analyses.has(file), `${file} が存在しない: 許可リストから消すこと`).toBe(true);
        for (const [kind, reason] of Object.entries(reasons)) {
          expect(reason!.trim().length, '理由を書くこと').toBeGreaterThan(10);
          const still = analyses.get(file)!.findings.some((f) => f.kind === kind);
          expect(still, `${file} にはもう ${kind} が無い: 許可リストから消すこと`).toBe(true);
        }
      }
    });
  });
});

// ─────────────────────────────────────────────
// 走査ロジック自体の確認 (合成ソースで検出できること / 誤検出しないこと)
// ─────────────────────────────────────────────
describe('ロール認可の手書き禁止 (#1161): ソース解析のロジック', () => {
  const kinds = (source: string) => analyzeSource(source).findings.map((f) => f.kind);

  it.each([
    ['profile?.roles?.some(...) (announcements / support の旧実装)', `if (profile?.roles?.some((r: string) => ['admin'].includes(r)) !== true) {}`],
    ['!profile?.roles?.some(...) (support の旧実装)', `if (!profile || !profile?.roles?.some((r) => ok.includes(r))) {}`],
    ['profile.roles?.includes(...)', `const ok = profile.roles?.includes('admin');`],
    ['profile?.roles.includes(...)', `const ok = profile?.roles.includes('admin');`],
    ['(profile.roles ?? []).some(...)', `const ok = (profile.roles ?? []).some((r) => r === 'admin');`],
    ['(profile?.roles || []).includes(...)', `const ok = (profile?.roles || []).includes('admin');`],
    ['非 null アサーション越しの ?.', `const ok = profile!?.roles?.every((r) => r === 'support');`],
  ])('手書きの roles 判定として検出する: %s', (_label, source) => {
    expect(kinds(source)).toContain('roles-check');
  });

  it.each([
    ['requireRole の戻り値の roles (?. が無い)', `const actor = await requireRole(['admin']); const ok = actor.roles.includes('super_admin');`],
    ['対象ユーザーの roles を見る業務ルール (?. が無い)', `if (Array.isArray(profile.roles) && profile.roles.includes('super_admin')) {}`],
    ['roles に触れない some()', `const ok = items?.some((i) => i.roles);`],
    ['roles を配列メソッドの引数に渡すだけ', `const ok = allowed.includes(profile?.roles);`],
    ['コメントや文字列の中', `// profile?.roles?.some(...) と書かない\nconst note = 'profile?.roles?.some(x)';`],
  ])('検出しない: %s', (_label, source) => {
    expect(kinds(source)).not.toContain('roles-check');
  });

  it("['owner', 'admin'] の手書きの許可リストを検出する (順序・引用符・関数に渡す形が違っても)", () => {
    expect(kinds(`const allowedRoles = ['owner', 'admin']; if (!allowedRoles.includes(p.org_role)) {}`)).toContain(
      'org-role-allow-list',
    );
    expect(kinds(`if (!["admin", "owner"].includes(profile.org_role as string)) {}`)).toContain('org-role-allow-list');
  });

  it("['owner', 'admin'] 以外の配列は検出しない", () => {
    expect(kinds(`const a = ['owner']; const b = ['owner', 'admin', 'member']; const c = ['admin', 'super_admin'];`)).toEqual([]);
  });

  it('isOrgAdmin() の直接呼び出しを検出する (メソッド呼び出しや別の関数は対象外)', () => {
    expect(kinds(`if (!isOrgAdmin(profile)) {}`)).toContain('is-org-admin-call');
    expect(kinds(`const x = guard.isOrgAdmin(profile); const y = requireOrgAdmin();`)).not.toContain('is-org-admin-call');
  });

  it('HTTP handler と、その中で呼んでいる関数・requireRole のロールを取り出す', () => {
    const analysis = analyzeSource(`
      export async function GET(request: Request) {
        await requireRole(['support', 'admin']);
        return helper();
      }
      export const POST = async (request: Request) => {
        await requireOrgAdmin();
      };
      async function notExported() { await requireRole(['user']); }
      export function helperOnly() { requireRole(['user']); }
    `);

    expect(analysis.handlers.map((h) => h.name)).toEqual(['GET', 'POST']);
    expect(analysis.handlers[0].calls.get('requireRole')).toEqual([['support', 'admin']]);
    expect(analysis.handlers[0].calls.has('requireOrgAdmin')).toBe(false);
    expect(analysis.handlers[1].calls.has('requireOrgAdmin')).toBe(true);
  });

  it('sameSet は順序を無視し、重複や過不足は別物として扱う', () => {
    expect(sameSet(['b', 'a'], ['a', 'b'])).toBe(true);
    expect(sameSet(['a'], ['a', 'b'])).toBe(false);
    expect(sameSet(['a', 'a'], ['a', 'b'])).toBe(false);
  });
});
