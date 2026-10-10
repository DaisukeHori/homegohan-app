/**
 * T15 (#1154) アプリ (apps/mobile): AI の API に「同意が必要です」で止められたら、同意画面へ案内する — contract テスト
 *
 * 未同意の利用者のデータは、サーバーが AI へ送る手前で止める (403 AI_CONSENT_REQUIRED。src/lib/ai/consent-guard.ts の requireAiConsent)。
 * アプリの各 AI 機能の画面は、この失敗を受けたら同意画面へ案内する (apps/mobile/src/lib/ai-consent.ts)。
 * 案内の判定は画面ごとに書く作りなので、画面を足したり直したりしたときに判定が抜けやすい。
 * Web の画面は tests/ai-consent-entry-points.test.ts が検査する。このテストはアプリの対応物で、次を確かめる。
 *
 *   1. 止める側 (サーバー): src/app/api の route.ts を構文木で読み、requireAiConsent() を呼ぶ HTTP メソッドを集める
 *      (= 403 AI_CONSENT_REQUIRED を返しうる API。GET の一覧や、aiSkipped で返す API は入らない)
 *   2. 呼ぶ側 (アプリ): apps/mobile の app と src を構文木で読み (コメントは見ない)、1 の API を呼ぶ場所を全部集める
 *      (getApi() の get/post/patch/del、fetch の URL と method)
 *   3. 2 の場所を含む関数 (名前のある、いちばん内側の関数) が、同じ関数の中で判定の関数
 *      (handleAiConsentRequiredError / isAiConsentRequiredError / isAiConsentRequiredResponse) を呼んでいる。
 *      呼ばない場所は、下の分類 (URL_BUILDERS) に理由つきで載っているものだけ
 *   4. 分類が古くならない (載せた関数が無くなった・判定を呼ぶようになった・使う関数が判定しなくなったら失敗する)
 *   5. 1 の API を呼ぶアプリのファイルの一覧が、下の AI_ENTRY_FILES と一致する (足した・消したら、ここで気づく)
 *   6. アプリは Edge Function を直接呼ばない (呼ぶと 1 の検査の外になるため。呼ぶなら、このテストを広げること)
 *   7. 判定の関数で「同意が必要」と分かった分岐 (if (isAiConsentRequiredError(e)) { ... } など) の中で、例外を投げ直さない。
 *      案内を出したあとに投げ直すと、呼び出し側 (モーダルなど) の catch が同意のことを知らないまま「失敗しました」を重ねて出す
 *      (R3 の指摘: 生成のフックが投げ直し、改善モーダルが「改善に失敗しました」を出していた)。
 *      呼び出し側に「止められた」ことを伝えるときは、例外ではなく戻り値 (useV4MenuGeneration の generate は null) で伝える
 *
 * 挙動 (案内を出す・エラーの表示を出さない) は、代表の画面ごとの jest のテストが確かめる:
 *   apps/mobile/__tests__/ai/advisor-sheet-consent.test.tsx・ai/day-menu-consent.test.tsx・pantry/analyze-consent.test.tsx・
 *   menus-weekly/use-v4-menu-generation.test.tsx・menus-weekly/improve-consent.test.tsx (改善モーダルの 2 つの置き場)・
 *   menus-weekly/manual-edit-photo-consent.test.tsx (手動編集の上の写真の解析)・
 *   meals/new-consent.test.tsx (modal で開く食事の新規作成。画面を閉じてから同意画面へ移る)
 *   (と、判定の関数そのものは lib/ai-consent.test.ts)。
 * モーダルの上に開く部品が自分で案内を出さない (開いた側が閉じてから出す) こと、modal で開く画面 (Stack.Screen の presentation) が
 * 画面を閉じてから同意画面へ移ることは tests/ai-consent-mobile-modal-nesting.test.ts。
 * 受け付けたあとにサーバーが止めた失敗 (リクエストの行に保存された文) の扱いは tests/ai-consent-stored-failure-readers.test.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const MOBILE_SOURCE_DIRS = ['apps/mobile/app', 'apps/mobile/src'];
const API_DIR = 'src/app/api';

/** 判定の関数 (apps/mobile/src/lib/ai-consent.ts)。どれかを、AI の API を呼ぶ関数の中で呼ぶ */
const CONSENT_HANDLERS = ['handleAiConsentRequiredError', 'isAiConsentRequiredError', 'isAiConsentRequiredResponse'];

/** 7 の検査で「同意が必要」と分かった分岐を見つける関数 (受け付けたあとの失敗の文を見分ける関数を含む) */
const CONSENT_BRANCH_CHECKS = [...CONSENT_HANDLERS, 'handleStoredAiConsentFailure'];

/** 1 の API を呼ぶアプリのファイル (apps/mobile からの相対パス) */
const AI_ENTRY_FILES = [
  'app/ai/[sessionId].tsx',
  'app/health/blood-tests.tsx',
  'app/health/checkups/new.tsx',
  'app/health/insights.tsx',
  'app/meals/new.tsx',
  'app/menus/weekly/index.tsx',
  'app/menus/weekly/request/index.tsx',
  'app/pantry/index.tsx',
  'app/shopping-list/index.tsx',
  'src/components/ai/AIAdvisorSheet.tsx',
  'src/components/menu/NutritionDetailModal.tsx',
  'src/components/menu/PhotoEditModal.tsx',
  'src/components/menu/RegenerateMealModal.tsx',
  'src/components/menu/StatsModal.tsx',
  'src/hooks/useHomeData.ts',
  'src/hooks/useV4MenuGeneration.ts',
];

/**
 * URL を組み立てるだけで、自分では送らない場所 → 送る関数と理由。
 * 送る関数 (sentBy) は、この名前を参照し、判定の関数を呼んでいなければならない (検査する)
 */
const URL_BUILDERS: Record<string, { sentBy: string[]; reason: string }> = {
  'app/ai/[sessionId].tsx::messagesPath': {
    sentBy: ['send'],
    reason: 'メッセージの URL を useMemo で組み立てるだけ。POST (AI に送る) は send が `${baseUrl}${messagesPath}` で行い、send が判定する。load は GET (止められない)',
  },
};

/**
 * 呼び出しではない (関数の外の定数の一覧などに API のパスを書いているだけ) ファイル → 理由。
 * このファイルの「関数の外」にある URL は数えない (関数の中の URL は通常どおり検査する)
 */
const NOT_CALLS: Record<string, string> = {
  'src/lib/api.ts': '待ち時間を長くする API のパスの一覧 (SLOW_API_PATHS など)。呼び出しではない',
};

// ─────────────────────────────────────────────
// 構文木の道具
// ─────────────────────────────────────────────

function parse(file: string): ts.SourceFile {
  const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
}

function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}

type FunctionLike = ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression | ts.MethodDeclaration;

function isFunctionLike(node: ts.Node): node is FunctionLike {
  return ts.isFunctionDeclaration(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isMethodDeclaration(node);
}

/** フックの引数に渡した関数を、代入先の変数の名前で呼ぶ (const f = useCallback(() => ...)) */
const NAMING_HOOKS = new Set(['useCallback', 'useMemo']);

/** 関数の名前。`function f() {}` / `const f = () => {}` / `const f = useCallback(() => {})` / `{ f: () => {} }` / `f() {}`。無名なら null */
function nameOf(fn: FunctionLike): string | null {
  if ((ts.isFunctionDeclaration(fn) || ts.isMethodDeclaration(fn)) && fn.name) return fn.name.getText();
  if (ts.isFunctionExpression(fn) && fn.name) return fn.name.getText();
  const parent = fn.parent;
  if (parent && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
  if (parent && ts.isPropertyAssignment(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
  if (
    parent &&
    ts.isCallExpression(parent) &&
    ts.isIdentifier(parent.expression) &&
    NAMING_HOOKS.has(parent.expression.text) &&
    parent.parent &&
    ts.isVariableDeclaration(parent.parent) &&
    ts.isIdentifier(parent.parent.name)
  ) {
    return parent.parent.name.text;
  }
  return null;
}

/** node を含む、名前のあるいちばん内側の関数 (無名の関数の中なら、その外側の名前のある関数) */
function ownerOf(node: ts.Node): FunctionLike | null {
  for (let cur: ts.Node | undefined = node.parent; cur; cur = cur.parent) {
    if (isFunctionLike(cur) && nameOf(cur)) return cur;
  }
  return null;
}

function isCallTo(node: ts.Node, name: string): node is ts.CallExpression {
  return ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name;
}

function lineOf(sf: ts.SourceFile, node: ts.Node): number {
  return sf.getLineAndCharacterOfPosition(node.getStart()).line + 1;
}

// ─────────────────────────────────────────────
// 1. 止める側: requireAiConsent() を呼ぶ API (route.ts × HTTP メソッド)
// ─────────────────────────────────────────────

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
type HttpMethod = (typeof HTTP_METHODS)[number];

interface GuardedRoute {
  file: string;
  pattern: RegExp;
  methods: Set<HttpMethod>;
}

function listFiles(dir: string, accept: (name: string) => boolean): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '__tests__') continue;
      out.push(...listFiles(rel, accept));
    } else if (accept(entry.name)) {
      out.push(rel);
    }
  }
  return out;
}

/** src/app/api/ai/consultation/sessions/[sessionId]/close/route.ts → ^/api/ai/consultation/sessions/[^/]+/close$ */
function routePattern(file: string): RegExp {
  const segments = path
    .dirname(file)
    .slice('src/app'.length)
    .split('/')
    .filter((s) => s !== '' && !/^\(.*\)$/.test(s))
    .map((s) => (/^\[.*\]$/.test(s) ? '[^/]+' : s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  return new RegExp(`^/${segments.join('/')}$`);
}

function guardedRoutes(): GuardedRoute[] {
  const out: GuardedRoute[] = [];
  for (const file of listFiles(API_DIR, (name) => name === 'route.ts')) {
    const sf = parse(file);
    const methods = new Set<HttpMethod>();
    for (const statement of sf.statements) {
      const exported = ts.getCombinedModifierFlags(statement as ts.Declaration) & ts.ModifierFlags.Export;
      if (!exported) continue;
      const bodies: Array<[string, ts.Node]> = [];
      if (ts.isFunctionDeclaration(statement) && statement.name) bodies.push([statement.name.text, statement]);
      if (ts.isVariableStatement(statement)) {
        for (const decl of statement.declarationList.declarations) {
          if (ts.isIdentifier(decl.name) && decl.initializer) bodies.push([decl.name.text, decl.initializer]);
        }
      }
      for (const [name, body] of bodies) {
        if (!(HTTP_METHODS as readonly string[]).includes(name)) continue;
        let guarded = false;
        walk(body, (node) => {
          if (isCallTo(node, 'requireAiConsent')) guarded = true;
        });
        if (guarded) methods.add(name as HttpMethod);
      }
    }
    if (methods.size > 0) out.push({ file, pattern: routePattern(file), methods });
  }
  return out;
}

// ─────────────────────────────────────────────
// 2. 呼ぶ側: アプリが 1 の API を呼ぶ場所
// ─────────────────────────────────────────────

/** getApi() のメソッド名 → HTTP メソッド (apps/mobile/src/lib/api.ts) */
const API_CLIENT_METHODS: Record<string, HttpMethod> = {
  get: 'GET',
  post: 'POST',
  put: 'PUT',
  patch: 'PATCH',
  del: 'DELETE',
  delete: 'DELETE',
};

/** 文字列・テンプレートの URL から、API のパス部分を取り出す (`${baseUrl}/api/x/${id}?a=1` → /api/x/X)。API の URL でなければ null */
function apiPathOf(node: ts.Node): string | null {
  let text: string;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    text = node.text;
  } else if (ts.isTemplateExpression(node)) {
    text = node.head.text + node.templateSpans.map((span) => `X${span.literal.text}`).join('');
  } else {
    return null;
  }
  const start = text.indexOf('/api/');
  if (start < 0) return null;
  return text.slice(start).split('?')[0];
}

/** fetch(url, { method: "POST" }) の method。書かれていなければ GET、読めなければ null */
function fetchMethodOf(call: ts.CallExpression): HttpMethod | null {
  const options = call.arguments[1];
  if (!options) return 'GET';
  if (!ts.isObjectLiteralExpression(options)) return null;
  for (const prop of options.properties) {
    if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name) && prop.name.text === 'method') {
      if (!ts.isStringLiteralLike(prop.initializer)) return null;
      const method = prop.initializer.text.toUpperCase();
      return (HTTP_METHODS as readonly string[]).includes(method) ? (method as HttpMethod) : null;
    }
  }
  return 'GET';
}

/** URL の文字列 node が、どの HTTP メソッドで送られるか。読めないとき (変数に入れて別の関数で使うなど) は null */
function methodsOf(urlNode: ts.Node): HttpMethod[] | null {
  const parent = urlNode.parent;
  if (parent && ts.isCallExpression(parent) && parent.arguments[0] === urlNode) {
    if (ts.isPropertyAccessExpression(parent.expression) && API_CLIENT_METHODS[parent.expression.name.text]) {
      return [API_CLIENT_METHODS[parent.expression.name.text]];
    }
    if (isCallTo(parent, 'fetch')) {
      const method = fetchMethodOf(parent);
      return method ? [method] : null;
    }
  }
  // const url = `${baseUrl}/api/...`; ... fetch(url, {...}) (同じ関数の中)
  if (parent && ts.isVariableDeclaration(parent) && parent.initializer === urlNode && ts.isIdentifier(parent.name)) {
    const variable = parent.name.text;
    const owner = ownerOf(urlNode);
    const methods: HttpMethod[] = [];
    let unreadable = false;
    if (owner) {
      walk(owner, (node) => {
        if (!ts.isCallExpression(node) || !node.arguments[0] || !ts.isIdentifier(node.arguments[0]) || node.arguments[0].text !== variable) return;
        if (isCallTo(node, 'fetch')) {
          const method = fetchMethodOf(node);
          if (method) methods.push(method);
          else unreadable = true;
        } else if (ts.isPropertyAccessExpression(node.expression) && API_CLIENT_METHODS[node.expression.name.text]) {
          methods.push(API_CLIENT_METHODS[node.expression.name.text]);
        }
      });
    }
    return unreadable || methods.length === 0 ? null : methods;
  }
  return null;
}

interface MobileSite {
  /** 関数の外にある (定数の一覧など) */
  topLevel: boolean;
  /** apps/mobile からの相対パス */
  file: string;
  line: number;
  path: string;
  /** 送る HTTP メソッド。読めなければ null (分類に載せる) */
  methods: HttpMethod[] | null;
  ownerName: string | null;
  handled: boolean;
}

/** 関数 (owner) の中で、判定の関数を呼んでいるか (中の名前のある別の関数の中の呼び出しは数えない) */
function callsConsentHandler(owner: FunctionLike): boolean {
  let found = false;
  walk(owner, (node) => {
    if (CONSENT_HANDLERS.some((name) => isCallTo(node, name)) && ownerOf(node) === owner) found = true;
  });
  return found;
}

function isInsideAnyFunction(node: ts.Node): boolean {
  for (let cur: ts.Node | undefined = node.parent; cur; cur = cur.parent) {
    if (isFunctionLike(cur)) return true;
  }
  return false;
}

function mobileSources(): string[] {
  return MOBILE_SOURCE_DIRS.flatMap((dir) => listFiles(dir, (name) => /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)));
}

function mobileSites(routes: GuardedRoute[]): MobileSite[] {
  const sites: MobileSite[] = [];
  for (const file of mobileSources()) {
    const sf = parse(file);
    walk(sf, (node) => {
      const apiPath = apiPathOf(node);
      if (!apiPath) return;
      // テンプレートの中の文字列 (式の中) を二重に数えない
      if (ts.isTemplateExpression(node.parent) || ts.isTemplateSpan(node.parent)) return;
      const route = routes.find((r) => r.pattern.test(apiPath));
      if (!route) return;
      const methods = methodsOf(node);
      if (methods && !methods.some((m) => route.methods.has(m))) return;
      const owner = ownerOf(node);
      sites.push({
        topLevel: owner === null && !isInsideAnyFunction(node),
        file: file.slice('apps/mobile/'.length),
        line: lineOf(sf, node),
        path: apiPath,
        methods,
        ownerName: owner ? nameOf(owner) : null,
        handled: owner ? callsConsentHandler(owner) : false,
      });
    });
  }
  return sites;
}

function findFunctions(sf: ts.SourceFile, name: string): FunctionLike[] {
  const out: FunctionLike[] = [];
  walk(sf, (node) => {
    if (isFunctionLike(node) && nameOf(node) === name) out.push(node);
  });
  return out;
}

// ─────────────────────────────────────────────
// テスト
// ─────────────────────────────────────────────

const routes = guardedRoutes();
const allSites = mobileSites(routes);
/** NOT_CALLS のファイルの、関数の外の URL を除いたもの (検査の対象) */
const sites = allSites.filter((s) => !(s.topLevel && NOT_CALLS[s.file]));
const describeSite = (s: MobileSite) => `${s.file} L${s.line} ${s.ownerName ?? '(無名)'}: ${s.methods?.join('/') ?? '(メソッド不明)'} ${s.path}`;

describe('止める側: requireAiConsent() を呼ぶ API の走査', () => {
  it('requireAiConsent を import する route.ts は、どれもメソッドを見つけられている (走査が空振りしていない)', () => {
    const importing = listFiles(API_DIR, (name) => name === 'route.ts').filter((file) =>
      parse(file).statements.some(
        (s) =>
          ts.isImportDeclaration(s) &&
          s.importClause?.namedBindings &&
          ts.isNamedImports(s.importClause.namedBindings) &&
          s.importClause.namedBindings.elements.some((e) => e.name.text === 'requireAiConsent'),
      ),
    );
    expect(importing.length).toBeGreaterThan(0);
    expect(routes.map((r) => r.file).sort()).toEqual(importing.sort());
  });

  it('代表の API を、正しいメソッドで見つけている', () => {
    const methodsFor = (apiPath: string) => [...(routes.find((r) => r.pattern.test(apiPath))?.methods ?? [])].sort();
    expect(methodsFor('/api/ai/analyze-fridge')).toEqual(['POST']);
    expect(methodsFor('/api/ai/consultation/sessions/X/messages')).toEqual(['POST']);
    expect(methodsFor('/api/ai/consultation/actions/X/execute')).toEqual(['POST']);
    expect(methodsFor('/api/health/insights')).toEqual(['POST']);
    expect(methodsFor('/api/shopping-list/regenerate')).toEqual(['POST']);
    // 閉じる API は止めずに aiSkipped で返す (tests/ai-consent-skipped.test.ts の範囲)
    expect(methodsFor('/api/ai/consultation/sessions/X/close')).toEqual([]);
  });
});

describe('呼ぶ側: アプリが AI の API に止められたら、同意画面へ案内する', () => {
  it('止められうる API を呼ぶファイルの一覧が AI_ENTRY_FILES と一致する (足した・消したら、このテストの一覧も直す)', () => {
    expect([...new Set(sites.map((s) => s.file))].sort()).toEqual([...AI_ENTRY_FILES].sort());
  });

  it('止められうる API を呼ぶ関数は、同じ関数の中で判定の関数を呼ぶ (呼ばないものは URL_BUILDERS に理由つきで載っている)', () => {
    const unhandled = sites.filter((s) => !s.handled && !(s.ownerName && URL_BUILDERS[`${s.file}::${s.ownerName}`]));
    expect(
      unhandled.map(describeSite),
      `判定していない。catch で handleAiConsentRequiredError(e) を呼ぶ (自動で送る処理は isAiConsentRequiredError で一文を出す・fetch を直接使うなら isAiConsentRequiredResponse) こと。判定の関数: ${CONSENT_HANDLERS.join(' / ')}`,
    ).toEqual([]);
  });

  it('URL_BUILDERS が古くなっていない (載せた場所があり、判定していない。送る関数は名前を参照し、判定している)', () => {
    for (const [key, { sentBy, reason }] of Object.entries(URL_BUILDERS)) {
      const [file, name] = key.split('::');
      expect(reason.length, key).toBeGreaterThan(0);
      const matched = sites.filter((s) => s.file === file && s.ownerName === name);
      expect(matched.length, `${key}: 止められうる API の URL がもう無い。分類から外すこと`).toBeGreaterThanOrEqual(1);
      expect(matched.every((s) => !s.handled), `${key}: 自分で判定するようになった。分類から外すこと`).toBe(true);
      const sf = parse(`apps/mobile/${file}`);
      for (const sender of sentBy) {
        const fns = findFunctions(sf, sender);
        expect(fns.length, `${key}: 送る関数 ${sender} が見つからない`).toBeGreaterThanOrEqual(1);
        for (const fn of fns) {
          let references = false;
          walk(fn, (node) => {
            if (ts.isIdentifier(node) && node.text === name) references = true;
          });
          expect(references, `${key}: ${sender} が ${name} を使っていない`).toBe(true);
          expect(callsConsentHandler(fn), `${key}: 送る関数 ${sender} が判定の関数を呼んでいない`).toBe(true);
        }
      }
    }
  });

  it('NOT_CALLS が古くなっていない (載せたファイルの関数の外に、止められうる API のパスがある)', () => {
    for (const [file, reason] of Object.entries(NOT_CALLS)) {
      expect(reason.length, file).toBeGreaterThan(0);
      expect(
        allSites.some((s) => s.file === file && s.topLevel),
        `${file}: 関数の外に止められうる API のパスがもう無い。分類から外すこと`,
      ).toBe(true);
    }
  });

  it('アプリは Edge Function を直接呼ばない (呼ぶなら、このテストの走査を広げること)', () => {
    const direct: string[] = [];
    for (const file of mobileSources()) {
      const sf = parse(file);
      walk(sf, (node) => {
        const isInvoke =
          ts.isCallExpression(node) &&
          ts.isPropertyAccessExpression(node.expression) &&
          node.expression.name.text === 'invoke' &&
          ts.isPropertyAccessExpression(node.expression.expression) &&
          node.expression.expression.name.text === 'functions';
        const isFunctionsUrl =
          (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) &&
          node.text.includes('/functions/v1/');
        if (isInvoke || isFunctionsUrl) direct.push(`${file} L${lineOf(sf, node)}`);
      });
    }
    expect(direct).toEqual([]);
  });
});

// ─────────────────────────────────────────────
// 7. 同意が必要と分かった分岐で、例外を投げ直さない
// ─────────────────────────────────────────────

/** 条件の式が、判定の関数の呼び出し (await や ! を含む) か。! なら negated */
function consentCheckOf(condition: ts.Expression): { negated: boolean } | null {
  let expr: ts.Expression = condition;
  let negated = false;
  for (;;) {
    if (ts.isParenthesizedExpression(expr)) expr = expr.expression;
    else if (ts.isAwaitExpression(expr)) expr = expr.expression;
    else if (ts.isPrefixUnaryExpression(expr) && expr.operator === ts.SyntaxKind.ExclamationToken) {
      negated = !negated;
      expr = expr.operand;
    } else break;
  }
  if (ts.isCallExpression(expr) && ts.isIdentifier(expr.expression) && CONSENT_BRANCH_CHECKS.includes(expr.expression.text)) {
    return { negated };
  }
  return null;
}

/** statement の中 (中の関数の中は除く) の throw の行 */
function throwsIn(sf: ts.SourceFile, statement: ts.Statement | undefined): number[] {
  if (!statement) return [];
  const lines: number[] = [];
  const visit = (node: ts.Node) => {
    if (isFunctionLike(node)) return;
    if (ts.isThrowStatement(node)) lines.push(lineOf(sf, node));
    ts.forEachChild(node, visit);
  };
  visit(statement);
  return lines;
}

interface ConsentBranch {
  file: string;
  line: number;
  throws: number[];
}

function consentBranches(file: string, sf: ts.SourceFile): ConsentBranch[] {
  const out: ConsentBranch[] = [];
  walk(sf, (node) => {
    if (!ts.isIfStatement(node)) return;
    const check = consentCheckOf(node.expression);
    if (!check) return;
    // 同意が必要なときに通る側 (! なら else 側)
    const branch = check.negated ? node.elseStatement : node.thenStatement;
    out.push({ file, line: lineOf(sf, node), throws: throwsIn(sf, branch) });
  });
  return out;
}

describe('同意が必要と分かった分岐で、例外を投げ直さない (呼び出し側が「失敗しました」を重ねて出さないように)', () => {
  const branches = mobileSources().flatMap((file) => consentBranches(file.slice('apps/mobile/'.length), parse(file)));

  it('走査が空振りしていない (判定の関数で分岐している場所を見つけている)', () => {
    expect(branches.length).toBeGreaterThanOrEqual(10);
    expect(branches.some((b) => b.file === 'src/hooks/useV4MenuGeneration.ts')).toBe(true);
    expect(branches.some((b) => b.file === 'src/components/menu/ImproveMealModal.tsx')).toBe(true);
  });

  it('判定の関数で「同意が必要」と分かった分岐の中に throw が無い', () => {
    const offenders = branches.filter((b) => b.throws.length > 0).map((b) => `${b.file} L${b.line} (throw: L${b.throws.join(', L')})`);
    expect(
      offenders,
      '案内を出したあとに例外を投げ直すと、呼び出し側の catch が「失敗しました」を重ねて出す。戻り値で「止められた」ことを伝えること',
    ).toEqual([]);
  });

  it('検査そのものの確かめ: 前の周の不具合の形 (案内を出してから投げ直す) を見つけ、! の分岐は else 側を見る', () => {
    const source = `
      async function generate() {
        try { await api.post("/api/ai/menu/v4/generate", {}); }
        catch (err) {
          if (isAiConsentRequiredError(err)) { promptAiConsentRequired(); throw err; }
          throw err;
        }
      }
      function ok(e) { if (handleAiConsentRequiredError(e)) return; throw e; }
      function negated(e) { if (!isAiConsentRequiredError(e)) { throw e; } else { promptAiConsentRequired(); throw e; } }
      function nested(e) { if (isAiConsentRequiredError(e)) { const later = () => { throw e; }; later; return null; } }
    `;
    const found = consentBranches('example.ts', ts.createSourceFile('example.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS));
    expect(found.map((b) => b.throws.length)).toEqual([1, 0, 1, 0]);
  });
});
