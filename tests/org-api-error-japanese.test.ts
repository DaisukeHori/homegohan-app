// @vitest-environment node
/**
 * 組織の API (/api/org/**) の失敗の本文に、英語の文や例外の文面を入れていないことの見張り
 *
 * 問題:
 *   組織の管理画面 (src/app/(org)) と組織チャレンジの画面は、API の失敗の本文の文 (`error` の文字列か `error.message`) を
 *   そのまま利用者に見せる (例: src/app/(org)/org/challenges/page.tsx の readErrorMessage・invites/page.tsx の setSubmitError)。
 *   以前の /api/org の route は 'Unauthorized'・'Forbidden'・'Internal server error'・'Required fields missing'・
 *   'Invalid departmentId' などの英語の文や、例外の文面 (`err.message` = 'AUTH_UNAUTHENTICATED'・'owner/admin role required')
 *   を返しており、失敗したときだけ英語が画面に出ていた。文は src/lib/org-api-errors.ts の日本語の固定の文にした。
 *
 * このテストが確かめること:
 *   1. 走査: /api/org の全 route (と、route が本文を作るのに使う共通の関数のファイル) の失敗の本文の文が、どれも英語だけの文でない。
 *      本文の中で例外の文面 (`<なにか>.message`) を文として入れていない
 *   2. 組織の管理画面が呼ぶ API (src/app/(org) の `/api/...` の文字列) が、どれも 1 の走査の対象の route である
 *   3. 共通の関数 (orgAuthFailureFlat / orgAuthFailureNested / handleMemberError) が、例外の文面に関わらず日本語の固定の文を返す
 *
 * 1 の走査で数えるもの (TypeScript の構文木で読む。コメントは見ない):
 *   本文 = `NextResponse.json(本文, …)` / `Response.json(本文, …)` の 1 つ目の引数と、`challengeError(code, 文, status)` の 2 つ目の引数
 *   本文の文 = 本文のオブジェクトの `error` / `message` の値 (値がオブジェクトなら、その中の `error` / `message` も)。
 *     値の位置 = 式そのもの・三項演算子の 2 つの枝・?? / || の両辺・括弧・テンプレートの文字の部分。
 *     名前 (定数・変数) は、同じファイルの `const 名前 = …` と、import 元のファイルの `export const 名前 = …` を
 *     MAX_RESOLVE_DEPTH 段までたどる
 *   違反 = ラテン文字を含み日本語 (ひらがな・カタカナ・漢字・全角) を 1 文字も含まない文 / 値が `X.message` の文
 *
 * この検査の限界 (網羅はしない): 表 (オブジェクト) の要素を引いた文 (`MESSAGES[code]`)・関数の戻り値・別の関数に渡して本文にするもの・
 *   走査の対象の外のファイル (src/lib/membership/org-invite.ts などの所属の操作の共通の関数) が作る文は見ない。
 */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';
import {
  ORG_API_FORBIDDEN_MESSAGE,
  ORG_API_NOT_ORG_MEMBER_MESSAGE,
  ORG_API_UNAUTHENTICATED_MESSAGE,
  orgAuthFailureFlat,
  orgAuthFailureNested,
} from '@/lib/org-api-errors';
import { handleMemberError } from '@/lib/org-challenge-api';

const ROOT = path.resolve(__dirname, '..');
/** 走査する route のディレクトリ */
const API_ROOT = 'src/app/api/org';
/** route が本文を作るのに使う共通の関数のファイル (ここも走査する) */
const SHARED_BODY_FILES = ['src/lib/org-api-errors.ts', 'src/lib/org-challenge-api.ts'];
/** 組織の管理画面のルートグループ */
const SCREEN_ROOT = 'src/app/(org)';

/** 名前をたどる段数の上限 (定数 → 別の定数 → … の連鎖。循環で止まらないため) */
const MAX_RESOLVE_DEPTH = 4;
/** 本文を作る呼び出しと、本文の文が入る引数の位置 */
const BODY_ARGUMENT_INDEX: Readonly<Record<string, number>> = {
  json: 0,
  challengeError: 1,
};
const RESPONSE_CLASSES = new Set(['NextResponse', 'Response']);
/** 本文のうち、利用者に見せる文が入るプロパティ */
const TEXT_PROPERTIES = new Set(['error', 'message']);

const LATIN = /[A-Za-z]/;
/** ひらがな・カタカナ・CJK 統合漢字 (拡張 A を含む)・全角の英数記号 */
const JAPANESE = /[぀-ヿ㐀-鿿＀-￯]/;

interface Finding {
  file: string;
  line: number;
  text: string;
  kind: 'english' | 'exception-message';
}

function isEnglishOnly(text: string): boolean {
  return LATIN.test(text) && !JAPANESE.test(text);
}

function parse(file: string, source: string): ts.SourceFile {
  return ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
}

/** `@/x` / 相対の import 元を、リポジトリの中のファイルの相対パスにする (見つからなければ null) */
function resolveModule(fromFile: string, specifier: string): string | null {
  let base: string;
  if (specifier.startsWith('@/')) base = path.posix.join('src', specifier.slice(2));
  else if (specifier.startsWith('.')) base = path.posix.join(path.posix.dirname(fromFile), specifier);
  else return null;
  for (const candidate of [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`]) {
    if (fs.existsSync(path.join(ROOT, candidate))) return candidate;
  }
  return null;
}

const sourceCache = new Map<string, ts.SourceFile>();
function sourceOf(file: string, text?: string): ts.SourceFile {
  const cached = sourceCache.get(file);
  if (cached) return cached;
  const sf = parse(file, text ?? fs.readFileSync(path.join(ROOT, file), 'utf8'));
  sourceCache.set(file, sf);
  return sf;
}

/** ファイルの中の `const 名前 = 初期値` (どの深さでも。最初に見つかったもの) */
function findConstInitializer(sf: ts.SourceFile, name: string): ts.Expression | null {
  let found: ts.Expression | null = null;
  const visit = (node: ts.Node) => {
    if (found) return;
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name &&
      node.initializer &&
      ts.isVariableDeclarationList(node.parent) &&
      (node.parent.flags & ts.NodeFlags.Const) !== 0
    ) {
      found = node.initializer;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

/** 名前の import 元のファイル (import していなければ null) */
function importSourceOf(sf: ts.SourceFile, name: string): string | null {
  for (const statement of sf.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    if (bindings.elements.some((e) => e.name.text === name)) {
      return resolveModule(sf.fileName, statement.moduleSpecifier.text);
    }
  }
  return null;
}

/** 値の位置にある文字列を集める。名前は定数をたどる。値が `X.message` なら例外の文面として印を付ける */
function collectTexts(
  sf: ts.SourceFile,
  node: ts.Expression,
  depth: number,
  out: { texts: string[]; exceptionMessages: number },
): void {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    out.texts.push(node.text);
  } else if (ts.isTemplateExpression(node)) {
    out.texts.push([node.head.text, ...node.templateSpans.map((s) => s.literal.text)].join(' '));
  } else if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) {
    collectTexts(sf, node.expression, depth, out);
  } else if (ts.isConditionalExpression(node)) {
    collectTexts(sf, node.whenTrue, depth, out);
    collectTexts(sf, node.whenFalse, depth, out);
  } else if (ts.isBinaryExpression(node)) {
    const op = node.operatorToken.kind;
    if (op === ts.SyntaxKind.QuestionQuestionToken || op === ts.SyntaxKind.BarBarToken) {
      collectTexts(sf, node.left, depth, out);
      collectTexts(sf, node.right, depth, out);
    }
  } else if (ts.isPropertyAccessExpression(node) && node.name.text === 'message') {
    out.exceptionMessages += 1;
  } else if (ts.isIdentifier(node) && depth < MAX_RESOLVE_DEPTH) {
    const local = findConstInitializer(sf, node.text);
    if (local) {
      collectTexts(sf, local, depth + 1, out);
      return;
    }
    const from = importSourceOf(sf, node.text);
    if (from) {
      const imported = sourceOf(from);
      const init = findConstInitializer(imported, node.text);
      if (init) collectTexts(imported, init, depth + 1, out);
    }
  }
}

/** 本文のオブジェクトの error / message の値を集める (値がオブジェクトなら中も) */
function collectBodyTexts(sf: ts.SourceFile, body: ts.Expression, out: { texts: string[]; exceptionMessages: number }): void {
  if (!ts.isObjectLiteralExpression(body)) return;
  for (const property of body.properties) {
    if (ts.isPropertyAssignment(property)) {
      const name = ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) ? property.name.text : null;
      if (!name || !TEXT_PROPERTIES.has(name)) continue;
      if (ts.isObjectLiteralExpression(property.initializer)) collectBodyTexts(sf, property.initializer, out);
      else collectTexts(sf, property.initializer, 0, out);
    } else if (ts.isShorthandPropertyAssignment(property) && TEXT_PROPERTIES.has(property.name.text)) {
      collectTexts(sf, property.name, 0, out);
    }
  }
}

/** 1 つのファイルの失敗の本文の文から、違反を集める */
function findViolations(file: string, text?: string): Finding[] {
  const sf = sourceOf(file, text);
  const findings: Finding[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      let index: number | undefined;
      if (
        ts.isPropertyAccessExpression(callee) &&
        callee.name.text === 'json' &&
        ts.isIdentifier(callee.expression) &&
        RESPONSE_CLASSES.has(callee.expression.text)
      ) {
        index = BODY_ARGUMENT_INDEX.json;
      } else if (ts.isIdentifier(callee) && callee.text in BODY_ARGUMENT_INDEX && callee.text !== 'json') {
        index = BODY_ARGUMENT_INDEX[callee.text];
      }
      const arg = index === undefined ? undefined : node.arguments[index];
      if (arg) {
        const out = { texts: [] as string[], exceptionMessages: 0 };
        if (index === BODY_ARGUMENT_INDEX.json) collectBodyTexts(sf, arg, out);
        else collectTexts(sf, arg, 0, out);
        const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
        for (const t of out.texts) {
          const trimmed = t.replace(/\s+/g, ' ').trim();
          if (trimmed && isEnglishOnly(trimmed)) findings.push({ file, line, text: trimmed, kind: 'english' });
        }
        for (let i = 0; i < out.exceptionMessages; i += 1) {
          findings.push({ file, line, text: '<X.message>', kind: 'exception-message' });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return findings;
}

function walkFiles(dir: string, accept: (name: string) => boolean): string[] {
  const result: string[] = [];
  const walk = (rel: string) => {
    for (const entry of fs.readdirSync(path.join(ROOT, rel), { withFileTypes: true })) {
      const child = path.posix.join(rel, entry.name);
      if (entry.isDirectory()) walk(child);
      else if (accept(entry.name)) result.push(child);
    }
  };
  walk(dir);
  return result.sort();
}

const ROUTE_FILES = walkFiles(API_ROOT, (name) => name === 'route.ts');

/** 画面の `/api/...` の文字列 (テンプレートの式は `*` にする。? 以降は外す) */
function collectApiPaths(file: string): string[] {
  const sf = sourceOf(file);
  const paths: string[] = [];
  const visit = (node: ts.Node) => {
    let text: string | null = null;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) text = node.text;
    else if (ts.isTemplateExpression(node)) {
      text = [node.head.text, ...node.templateSpans.map((s) => `*${s.literal.text}`)].join('');
    }
    if (text !== null && text.startsWith('/api/')) paths.push(text.split('?')[0]);
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return paths;
}

/** `/api/org/members/*\/remove` を route のファイル (動的な区切り [x] も一致) に当てる */
function routeFileOf(apiPath: string): string | null {
  const segments = apiPath.replace(/^\/api\//, '').split('/').filter(Boolean);
  return (
    ROUTE_FILES.find((file) => {
      const routeSegments = file.replace(/^src\/app\/api\//, '').replace(/\/route\.ts$/, '').split('/');
      return (
        routeSegments.length === segments.length &&
        routeSegments.every((seg, i) => seg === segments[i] || (/^\[[^\]]+\]$/.test(seg) && segments[i] === '*'))
      );
    }) ?? null
  );
}

describe('走査の仕組み: 英語の文と例外の文面を見つけられる', () => {
  const FIXTURE_FILE = 'src/app/api/org/__fixture__/route.ts';
  const FIXTURE = `
    import { NextResponse } from 'next/server';
    import { ORG_API_FORBIDDEN_MESSAGE } from '@/lib/org-api-errors';
    const LOCAL_ENGLISH = 'Forbidden';
    const LOCAL_JAPANESE = 'このチャレンジの状態は変えられません';
    export async function GET() {
      // コメントの 'Unauthorized' は見ない
      if (a) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      if (b) return NextResponse.json({ error: LOCAL_ENGLISH }, { status: 403 });
      if (c) return NextResponse.json({ error: { code: 'UNAUTHORIZED', message: err.message } }, { status: 401 });
      if (d) return NextResponse.json({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } }, { status: 500 });
      if (e) return challengeError('INTERNAL_ERROR', 'Internal server error', 500);
      if (f) return NextResponse.json({ error: x ? 'Invalid JSON' : '部署が見つかりません', code: 'INVALID' }, { status: 400 });
      if (g) return NextResponse.json({ error: \`目標値は \${min} 以上\`, code: 'INVALID_TARGET' }, { status: 400 });
      if (h) return NextResponse.json({ error: LOCAL_JAPANESE, code: 'LOCKED' }, { status: 409 });
      if (i) return NextResponse.json({ error: ORG_API_FORBIDDEN_MESSAGE }, { status: 403 });
      if (j) return NextResponse.json({ error: 'id は必須です' }, { status: 400 });
      return NextResponse.json({ ok: true, title: 'Health' });
    }
  `;

  it('英語の文 (リテラル・定数・三項の枝・nested の message・challengeError の文) と、例外の文面を、行つきで見つける', () => {
    const findings = findViolations(FIXTURE_FILE, FIXTURE);
    expect(findings.filter((f) => f.kind === 'english').map((f) => f.text).sort()).toEqual(
      ['Unauthorized', 'Forbidden', 'Internal server error', 'Internal server error', 'Invalid JSON'].sort(),
    );
    expect(findings.filter((f) => f.kind === 'exception-message')).toHaveLength(1);
    const unauthorized = findings.find((f) => f.text === 'Unauthorized');
    expect(unauthorized?.line).toBe(FIXTURE.split('\n').findIndex((l) => l.includes("{ error: 'Unauthorized' }")) + 1);
  });

  it('日本語の文・日本語に混じる英字・import した日本語の定数・error / message 以外のプロパティ・コメントは数えない', () => {
    const texts = findViolations(FIXTURE_FILE, FIXTURE).map((f) => f.text);
    for (const ignored of ['部署が見つかりません', '目標値は 以上', 'このチャレンジの状態は変えられません', 'id は必須です', 'Health']) {
      expect(texts).not.toContain(ignored);
    }
  });

  it('画面の API の文字列を route のファイルに当てられる (動的な区切り・? 以降)', () => {
    expect(routeFileOf('/api/org/members/*/remove')).toBe('src/app/api/org/members/[user_id]/remove/route.ts');
    expect(routeFileOf('/api/org/departments')).toBe('src/app/api/org/departments/route.ts');
    expect(routeFileOf('/api/org/no-such-route')).toBeNull();
  });
});

describe('/api/org の失敗の本文に、英語の文と例外の文面が無い', () => {
  const files = [...ROUTE_FILES, ...SHARED_BODY_FILES];
  const findings = files.flatMap((file) => findViolations(file));

  it('走査する route がある (管理者向けとメンバー向けのチャレンジ・招待・設定・メンバー・統計・譲渡を含む)', () => {
    for (const expected of [
      'src/app/api/org/challenges/route.ts',
      'src/app/api/org/challenges/[id]/route.ts',
      'src/app/api/org/invites/route.ts',
      'src/app/api/org/settings/route.ts',
      'src/app/api/org/members/route.ts',
      'src/app/api/org/stats/route.ts',
      'src/app/api/org/owner-transfer/propose/route.ts',
    ]) {
      expect(files).toContain(expected);
    }
  });

  it('英語だけの文が無い', () => {
    expect(findings.filter((f) => f.kind === 'english').map((f) => `${f.file}:${f.line} 「${f.text}」`)).toEqual([]);
  });

  it('例外の文面 (X.message) を本文の文に入れていない', () => {
    expect(findings.filter((f) => f.kind === 'exception-message').map((f) => `${f.file}:${f.line}`)).toEqual([]);
  });

  it('以前の英語の文は、どの route のソースにも残っていない (コメントを除く)', () => {
    const removed = [
      'Unauthorized',
      'Forbidden',
      'Internal server error',
      'Required fields missing',
      'Invalid departmentId',
      'Invalid JSON',
      'Challenge ID is required',
      'Invalid challenge ID',
      'Invalid status',
      'Invite ID is required',
    ];
    for (const file of files) {
      const sf = sourceOf(file);
      const literals: string[] = [];
      const visit = (node: ts.Node) => {
        if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) literals.push(node.text);
        ts.forEachChild(node, visit);
      };
      visit(sf);
      expect(literals.filter((l) => removed.includes(l)), file).toEqual([]);
    }
  });
});

describe('組織の管理画面 (src/app/(org)) が呼ぶ API は、どれも上の走査の対象', () => {
  const screens = walkFiles(SCREEN_ROOT, (name) => name.endsWith('.tsx') || name.endsWith('.ts'));
  const apiPaths = [...new Set(screens.flatMap((file) => collectApiPaths(file)))].sort();

  it('画面の API を集められている (招待・チャレンジ・設定・除名・脱退・譲渡を含む)', () => {
    expect(apiPaths).toEqual(
      expect.arrayContaining([
        '/api/org/invites',
        '/api/org/challenges',
        '/api/org/settings',
        '/api/org/members/*/remove',
        '/api/org/leave',
        '/api/org/owner-transfer/propose',
      ]),
    );
  });

  it('画面が呼ぶ API は、どれも /api/org の route のファイルに当たる', () => {
    expect(apiPaths.filter((p) => routeFileOf(p) === null)).toEqual([]);
  });
});

describe('共通の関数は、例外の文面に関わらず日本語の固定の文を返す', () => {
  const ENGLISH_DETAIL = 'owner/admin role required';

  it.each([
    ['未ログイン (AuthError)', new AuthError('AUTH_UNAUTHENTICATED'), 401, ORG_API_UNAUTHENTICATED_MESSAGE],
    ['管理者でない (ForbiddenError PERM_DENIED)', new ForbiddenError('PERM_DENIED', ENGLISH_DETAIL), 403, ORG_API_FORBIDDEN_MESSAGE],
    ['組織に所属していない (PERM_NOT_ORG_MEMBER)', new ForbiddenError('PERM_NOT_ORG_MEMBER', 'not a member'), 403, ORG_API_NOT_ORG_MEMBER_MESSAGE],
    ['知らないコードの ForbiddenError', new ForbiddenError('SOMETHING_NEW', 'Something went wrong'), 403, ORG_API_FORBIDDEN_MESSAGE],
  ])('%s: flat は { error: 文 }・nested は { error: { code, message: 文 } }', async (_label, err, status, message) => {
    const flat = orgAuthFailureFlat(err);
    const nested = orgAuthFailureNested(err);
    expect(flat?.status).toBe(status);
    expect(nested?.status).toBe(status);
    expect(await flat?.json()).toEqual({ error: message });
    expect(await nested?.json()).toEqual({
      error: { code: status === 401 ? 'UNAUTHORIZED' : 'FORBIDDEN', message },
    });
    expect(JAPANESE.test(message)).toBe(true);
    expect(isEnglishOnly(message)).toBe(false);
  });

  it('文は以前の英語の文・例外の文面ではない', () => {
    expect(ORG_API_UNAUTHENTICATED_MESSAGE).toBe('ログインが必要です');
    expect(ORG_API_FORBIDDEN_MESSAGE).toBe('この操作を行う権限がありません');
    expect(ORG_API_NOT_ORG_MEMBER_MESSAGE).toBe('組織に所属していません');
  });

  it('認可の失敗でなければ null (呼び出し側が 500 にする)', () => {
    expect(orgAuthFailureFlat(new Error('boom'))).toBeNull();
    expect(orgAuthFailureNested('boom')).toBeNull();
    expect(orgAuthFailureNested(undefined)).toBeNull();
  });

  it('メンバー向けの handleMemberError も、知らない ForbiddenError の英語の文面を本文に入れない', async () => {
    const res = handleMemberError('GET /x', new ForbiddenError('PERM_DENIED', ENGLISH_DETAIL));
    expect(res.status).toBe(403);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: { code: 'FORBIDDEN', message: ORG_API_FORBIDDEN_MESSAGE } });
    expect(text).not.toContain(ENGLISH_DETAIL);
  });
});
