/**
 * #1169: HTML 文字列の差し込み (dangerouslySetInnerHTML など) の contract テスト
 *
 * AI の応答のように信頼できない文字列を HTML にして dangerouslySetInnerHTML へ渡すと、入力中の <img onerror=...> が
 * そのまま実行される (CSP が 'unsafe-inline' を許しているので防げない)。修正前の AIChatBubble.tsx は、まさに
 * エスケープなしの自前 parseMarkdown でこれをやっていた。同じ穴が増えないよう、HTML を差し込む場所を許可リストで固定する。
 *
 *   1. HTML を差し込むファイル (dangerouslySetInnerHTML / innerHTML = / outerHTML = / insertAdjacentHTML / document.write)
 *      は、下の許可リストに載っていること
 *   2. 許可リストの各ファイルの差し込み元が、理由どおりの安全な形であること
 *        - src/app/layout.tsx           : 式の埋め込みが無い固定の文字列 (ダークモードの古い設定を消すだけのスクリプト)
 *        - src/components/AIChatBubble.tsx : src/lib/markdown-lite.ts の parseMarkdown の戻り値
 *   3. parseMarkdown を、共有モジュール以外で自前定義していないこと (コピーを作らず、共有関数を使う)
 *   4. 許可リストが古くならないこと (載っているのに差し込みが無くなったファイルは、リストから消す)
 *
 * 新しく HTML を差し込みたくなったら、まず JSX のテキストとして描画できないか考える (React が自動でエスケープする)。
 * どうしても HTML が要るときは parseMarkdown を通すか、通せない理由を書いて許可リストに足す。
 * 走査は TypeScript の構文木で行うので、コメントや文字列の中の記述には反応しない。
 */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
// tsconfig の paths (@/* → ./src/* と ./*) で import される範囲
const SCAN_ROOTS = ['src', 'components', 'lib'];
const SHARED_MODULE = '@/lib/markdown-lite';
const SHARED_MODULE_FILE = 'src/lib/markdown-lite.ts';

// 構文木にするのは、下の語を含むファイルだけ (全ファイルを構文木にすると遅い)
const QUICK_FILTER = /dangerouslySetInnerHTML|innerHTML|outerHTML|insertAdjacentHTML|document\s*\.\s*write|parseMarkdown/;

// ─────────────────────────────────────────────
// ソース解析
// ─────────────────────────────────────────────
interface HtmlSink {
  kind: string;
  /** HTML として差し込まれる式。取り出せない形 (props をそのまま渡すなど) なら undefined */
  html: ts.Expression | undefined;
}

interface FileAnalysis {
  sinks: HtmlSink[];
  /** parseMarkdown を自前で宣言している (function / const) */
  declaresParseMarkdown: boolean;
  /** `import { parseMarkdown } from '@/lib/markdown-lite'` がある */
  importsSharedParseMarkdown: boolean;
}

function analyze(file: string, text: string): FileAnalysis {
  const source = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const result: FileAnalysis = { sinks: [], declaresParseMarkdown: false, importsSharedParseMarkdown: false };

  /** `{ __html: <expr> }` から <expr> を取り出す */
  const htmlOf = (expression: ts.Expression | undefined): ts.Expression | undefined => {
    if (!expression || !ts.isObjectLiteralExpression(expression)) return undefined;
    for (const property of expression.properties) {
      if (ts.isPropertyAssignment(property) && property.name.getText(source) === '__html') {
        return property.initializer;
      }
    }
    return undefined;
  };

  const visit = (node: ts.Node): void => {
    if (ts.isJsxAttribute(node) && node.name.getText(source) === 'dangerouslySetInnerHTML') {
      // <div dangerouslySetInnerHTML={{ __html: ... }} />
      const initializer = node.initializer;
      const expression = initializer && ts.isJsxExpression(initializer) ? initializer.expression : undefined;
      result.sinks.push({ kind: 'dangerouslySetInnerHTML', html: htmlOf(expression) });
    } else if (ts.isPropertyAssignment(node) && node.name.getText(source) === 'dangerouslySetInnerHTML') {
      // React.createElement('div', { dangerouslySetInnerHTML: { __html: ... } })
      result.sinks.push({ kind: 'dangerouslySetInnerHTML', html: htmlOf(node.initializer) });
    } else if (
      ts.isBinaryExpression(node) &&
      (node.operatorToken.kind === ts.SyntaxKind.EqualsToken ||
        node.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken) &&
      ts.isPropertyAccessExpression(node.left) &&
      (node.left.name.text === 'innerHTML' || node.left.name.text === 'outerHTML')
    ) {
      // el.innerHTML = ... / el.outerHTML = ...
      result.sinks.push({ kind: `${node.left.name.text} =`, html: node.right });
    } else if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const callee = node.expression;
      if (callee.name.text === 'insertAdjacentHTML') {
        result.sinks.push({ kind: 'insertAdjacentHTML', html: node.arguments[1] });
      } else if (
        ts.isIdentifier(callee.expression) &&
        callee.expression.text === 'document' &&
        (callee.name.text === 'write' || callee.name.text === 'writeln')
      ) {
        result.sinks.push({ kind: `document.${callee.name.text}`, html: node.arguments[0] });
      }
    } else if (ts.isFunctionDeclaration(node) && node.name?.text === 'parseMarkdown') {
      result.declaresParseMarkdown = true;
    } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'parseMarkdown') {
      result.declaresParseMarkdown = true;
    } else if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text === SHARED_MODULE
    ) {
      const bindings = node.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          if ((element.propertyName ?? element.name).text === 'parseMarkdown') {
            result.importsSharedParseMarkdown = true;
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return result;
}

function listSourceFiles(dir: string): string[] {
  const files: string[] = [];
  // 走査対象のディレクトリが無くなっても (例: ルートの components/ を整理した場合) 例外にしない
  if (!fs.existsSync(path.join(ROOT, dir))) return files;
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const relative = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '__tests__' || entry.name === '.next') continue;
      files.push(...listSourceFiles(relative));
    } else if (/\.tsx?$/.test(entry.name) && !/\.(?:d|test|spec)\.tsx?$/.test(entry.name)) {
      files.push(relative);
    }
  }
  return files;
}

const analyses = new Map<string, FileAnalysis>();
for (const scanRoot of SCAN_ROOTS) {
  for (const file of listSourceFiles(scanRoot)) {
    const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
    if (QUICK_FILTER.test(text)) analyses.set(file, analyze(file, text));
  }
}

// ─────────────────────────────────────────────
// 許可リスト
// ─────────────────────────────────────────────
const isFixedString = (expression: ts.Expression | undefined): boolean =>
  expression !== undefined && (ts.isNoSubstitutionTemplateLiteral(expression) || ts.isStringLiteral(expression));

const isParseMarkdownCall = (expression: ts.Expression | undefined): boolean =>
  expression !== undefined &&
  ts.isCallExpression(expression) &&
  ts.isIdentifier(expression.expression) &&
  expression.expression.text === 'parseMarkdown';

/**
 * HTML を差し込んでよいファイルと、その理由・安全な形かどうかの検査。
 * problems は、理由どおりの形になっていない点を返す (空なら問題なし)。
 */
const ALLOWED_HTML_SINKS: Record<string, { reason: string; problems: (analysis: FileAnalysis) => string[] }> = {
  'src/app/layout.tsx': {
    reason: '利用者の入力が一切入らない固定のインラインスクリプト (旧ダークモードの localStorage キーを消すだけ)',
    problems: (analysis) =>
      analysis.sinks
        .filter((sink) => !isFixedString(sink.html))
        .map((sink) => `${sink.kind} が固定の文字列ではない (式の埋め込みがある)`),
  },
  'src/components/AIChatBubble.tsx': {
    reason: 'AI の応答を、エスケープと URL 検査をする共有の parseMarkdown (src/lib/markdown-lite.ts) を通して描画する',
    problems: (analysis) => [
      ...analysis.sinks
        .filter((sink) => !isParseMarkdownCall(sink.html))
        .map((sink) => `${sink.kind} の中身が parseMarkdown(...) の戻り値ではない`),
      ...(analysis.importsSharedParseMarkdown ? [] : [`parseMarkdown を ${SHARED_MODULE} から import していない`]),
    ],
  },
};

// ─────────────────────────────────────────────
// テスト
// ─────────────────────────────────────────────
describe('HTML 文字列の差し込み (#1169)', () => {
  it('HTML を差し込むのは、許可リストのファイルだけ', () => {
    const unexpected = [...analyses]
      .filter(([file, analysis]) => analysis.sinks.length > 0 && !(file in ALLOWED_HTML_SINKS))
      .map(([file, analysis]) => `${file} (${[...new Set(analysis.sinks.map((sink) => sink.kind))].join(', ')})`);
    expect(
      unexpected,
      'HTML を差し込む処理が増えています。文字列を JSX のテキストとして描画できないか考え、どうしても HTML が要るなら ' +
        `${SHARED_MODULE_FILE} の parseMarkdown を通してください。通せない理由があれば、理由を書いて ALLOWED_HTML_SINKS に足します。`,
    ).toEqual([]);
  });

  it('許可リストのファイルの差し込み元が、理由どおりの安全な形になっている', () => {
    const problems = Object.entries(ALLOWED_HTML_SINKS).flatMap(([file, rule]) => {
      const analysis = analyses.get(file);
      return analysis ? rule.problems(analysis).map((problem) => `${file}: ${problem}`) : [`${file}: ファイルが見つからない`];
    });
    expect(problems).toEqual([]);
  });

  it('許可リストが古くなっていない (載っているのに差し込みが無いファイルは、リストから消す)', () => {
    const stale = Object.keys(ALLOWED_HTML_SINKS).filter((file) => (analyses.get(file)?.sinks.length ?? 0) === 0);
    expect(stale).toEqual([]);
  });

  it('許可リストの各項目に理由が書いてある', () => {
    for (const [file, rule] of Object.entries(ALLOWED_HTML_SINKS)) {
      expect(rule.reason.trim().length, `${file} の理由が空`).toBeGreaterThan(0);
    }
  });

  it('parseMarkdown の自前コピーが無い (共有モジュールのものを使う)', () => {
    const copies = [...analyses]
      .filter(([file, analysis]) => analysis.declaresParseMarkdown && file !== SHARED_MODULE_FILE)
      .map(([file]) => file);
    expect(copies).toEqual([]);
  });

  it('共有モジュールが parseMarkdown を定義している', () => {
    expect(analyses.get(SHARED_MODULE_FILE)?.declaresParseMarkdown).toBe(true);
  });
});

// ─────────────────────────────────────────────
// 検出処理そのものの確認 (検出し損ねて、上のテストが素通りしないように)
// ─────────────────────────────────────────────
describe('差し込みの検出処理', () => {
  const sinksOf = (code: string) => analyze('sample.tsx', code).sinks;

  it('JSX の dangerouslySetInnerHTML を見つけて、__html の式を取り出す', () => {
    const [sink] = sinksOf('const a = <div dangerouslySetInnerHTML={{ __html: parseMarkdown(text) }} />;');
    expect(sink?.kind).toBe('dangerouslySetInnerHTML');
    expect(isParseMarkdownCall(sink?.html)).toBe(true);
  });

  it('props をそのまま渡す形でも差し込みとして見つけ、式は取り出せない', () => {
    const [sink] = sinksOf('const a = <div dangerouslySetInnerHTML={props.inner} />;');
    expect(sink?.kind).toBe('dangerouslySetInnerHTML');
    expect(sink?.html).toBeUndefined();
  });

  it('固定の文字列と、式を埋め込んだテンプレートリテラルを区別する', () => {
    const [fixed] = sinksOf('const a = <script dangerouslySetInnerHTML={{ __html: `x()` }} />;');
    const [dynamic] = sinksOf('const a = <script dangerouslySetInnerHTML={{ __html: `x(${user})` }} />;');
    expect(isFixedString(fixed?.html)).toBe(true);
    expect(isFixedString(dynamic?.html)).toBe(false);
  });

  it('React.createElement の dangerouslySetInnerHTML、innerHTML 代入、insertAdjacentHTML、document.write も見つける', () => {
    expect(sinksOf("React.createElement('div', { dangerouslySetInnerHTML: { __html: x } });").map((s) => s.kind)).toEqual([
      'dangerouslySetInnerHTML',
    ]);
    expect(sinksOf('el.innerHTML = x; el.outerHTML = y; el.innerHTML += z;').map((s) => s.kind)).toEqual([
      'innerHTML =',
      'outerHTML =',
      'innerHTML =',
    ]);
    expect(sinksOf("el.insertAdjacentHTML('beforeend', x);").map((s) => s.kind)).toEqual(['insertAdjacentHTML']);
    expect(sinksOf('document.write(x); document.writeln(y);').map((s) => s.kind)).toEqual([
      'document.write',
      'document.writeln',
    ]);
  });

  it('コメントや文字列の中の記述には反応しない', () => {
    expect(sinksOf('// el.innerHTML = x\nconst s = "dangerouslySetInnerHTML";')).toEqual([]);
  });

  it('parseMarkdown の自前宣言 (function / const) と、共有モジュールからの import を見分ける', () => {
    expect(analyze('a.ts', 'function parseMarkdown(t: string) { return t; }').declaresParseMarkdown).toBe(true);
    expect(analyze('a.ts', 'const parseMarkdown = (t: string) => t;').declaresParseMarkdown).toBe(true);
    expect(analyze('a.ts', "import { parseMarkdown } from '@/lib/markdown-lite';").declaresParseMarkdown).toBe(false);
    expect(analyze('a.ts', "import { parseMarkdown } from '@/lib/markdown-lite';").importsSharedParseMarkdown).toBe(true);
    expect(analyze('a.ts', "import { parseMarkdown } from './other';").importsSharedParseMarkdown).toBe(false);
  });
});
