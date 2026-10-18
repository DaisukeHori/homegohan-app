// @vitest-environment node
// tests/csp-no-inline-script.test.ts の検出と照合 (正典)
// #1169: 本番の CSP は script-src に 'unsafe-inline' を持たないので、nonce の無いインラインのスクリプトは止まる。
// インラインのスクリプトを足したら赤にし、どうしても要るものだけを、理由と件数つきの許可リストと nonce の規則で通す。
// 構文木で見るので、コメントと正規表現リテラルには反応しない (tests/inner-html-contract.test.ts と同じ流儀)。
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/** 走査するディレクトリ (tsconfig の paths @/* → ./src/* と ./* で import される範囲。tests/inner-html-contract.test.ts と同じ) */
export const INLINE_SCRIPT_SCAN_ROOTS = ['src', 'lib', 'components'] as const;
/** 構文木にするのは、この語を含むファイルだけ (全ファイルを構文木にすると遅い) */
export const INLINE_SCRIPT_QUICK_FILTER = /<script|next\/script/i;
/** next/script のモジュール名 */
export const NEXT_SCRIPT_MODULE = 'next/script';
/** JSX で script の要素とみなすタグ名。next/script の静的 import の手元の名前は analyzeInlineScripts が足す */
export const SCRIPT_JSX_TAG_NAMES: readonly string[] = ['script', 'Script'];
/**
 * テンプレートの ${…} の位置に置く目印。文字の部分は raw (エスケープ前) を使い、raw には ${ がそのまま現れない (\${ になる) ので、
 * この目印は本物の差し込みの位置にだけ立つ。NONCE_FROM_SUBSTITUTION_PATTERN はこの目印を探す
 */
export const TEMPLATE_SUBSTITUTION_MARK = '${}';
/** 全ページ動的の宣言を見るファイルと値 (docs/design/cross/18-csp-nonce.md §5.2) */
export const ROOT_LAYOUT_FILE = 'src/app/layout.tsx';
export const FORCE_DYNAMIC = 'force-dynamic';
/** 文字に script を埋めているとみなす語 (小文字にして比べる) */
const SCRIPT_OPEN_TAG_WORD = '<script';
/** 文字の中の <script の開きタグ (次の > まで。> が無ければ終わりまで) */
const SCRIPT_OPEN_TAG_PATTERN = /<script\b[^>]*/gi;
/** 開きタグの nonce 属性の値がテンプレートの差し込み (nonce="${…}" / nonce='${…}' / nonce=${…})。属性名の前は空白 (data-nonce を数えない) */
const NONCE_FROM_SUBSTITUTION_PATTERN = /\snonce\s*=\s*["']?\$\{\}/i;

/** 検出の種類。jsx = JSX の script の要素・next-script = next/script の参照・string = <script を含む文字列とテンプレート */
export type InlineScriptKind = 'jsx' | 'next-script' | 'string';

/** 検出 1 件 */
export interface InlineScriptFinding {
  kind: InlineScriptKind;
  /** 1 始まりの行 (失敗の文に出す) */
  line: number;
  /** その種類の nonce の規則 (NONCE_RULES) を満たすか */
  nonceOk: boolean;
  /** 見つけたもの (失敗の文に出す) */
  label: string;
}

/**
 * インラインのスクリプトを許す項目。鍵は file と kind の組 (同じ組は 1 項目だけ)。
 * その file のその kind の検出がちょうど count 件で、どれも NONCE_RULES[kind] を満たすときだけ緑。
 * next/script を使うファイルは next-script (import の件数) と jsx (<Script> の要素の件数) の 2 項目を載せる。
 */
export interface AllowedInlineScript {
  /** リポジトリのルートからの相対パス ('/' 区切り。例: 'src/app/foo/page.tsx') */
  file: string;
  kind: InlineScriptKind;
  /** その file のその kind の検出の件数 (1 以上の整数・ちょうど一致)。足しても消しても赤になり、理由を見直させる */
  count: number;
  /** なぜ JS のモジュール (import) にできず、インラインが要るか。空は不可 */
  reason: string;
}

/**
 * 許可したインラインの script (docs/design/cross/18-csp-nonce.md §6.1 の時点では 0 本)。
 * #1867: トップの構造化データ (JSON-LD) の 1 本だけ。
 */
export const ALLOWED_INLINE_SCRIPTS: readonly AllowedInlineScript[] = [
  {
    file: 'src/components/seo/SiteStructuredData.tsx',
    kind: 'jsx',
    count: 1,
    reason:
      '構造化データ (JSON-LD の Organization と WebSite。#1867) は、検索エンジンが HTML の中の <script type="application/ld+json"> だけを読むので、' +
      'JS のモジュールに移せない。実行されないデータの塊だが、規則どおり getCspNonce() の値を nonce に渡す (src/app/page.tsx が読んで渡す)',
  },
];

/** 種類ごとの nonce の規則 (失敗の文に出す) */
export const NONCE_RULES: Record<InlineScriptKind, string> = {
  jsx: '要素に nonce={…} (getCspNonce() の値) を渡す。nonce が無い・nonce="固定"・値なし・{...props} だけは不可',
  'next-script':
    "import Script from 'next/script' の静的 import にし、同じファイルの <Script> の要素を jsx の項目でも載せる。export … from・import()・require は nonce を確かめられないので不可",
  string: '<script の開きタグごとに、nonce= の値をテンプレートの差し込みにする。差し込みの無い文字列 (固定の nonce を含む) は不可',
};

/** 失敗の文に添える案内 */
export const INLINE_SCRIPT_GUIDANCE =
  '本番の CSP は script-src に unsafe-inline を持たないので、nonce の無いインラインのスクリプトは止まります。' +
  'まず JS のモジュール (import) に移せないか考え、どうしても要るなら getCspNonce() (src/lib/security/csp-nonce.ts) の値を nonce に渡し、' +
  '理由と件数を ALLOWED_INLINE_SCRIPTS に足してください (docs/design/cross/18-csp-nonce.md §9.11)。';

/** 照合で返す問題 1 件 */
export interface InlineScriptProblem {
  file: string;
  kind: InlineScriptKind;
  message: string;
}

/** file の末尾が x (.tsx) なら JSX として読む */
const parseSource = (file: string, text: string): ts.SourceFile =>
  ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
const lineOf = (source: ts.SourceFile, node: ts.Node): number =>
  source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;

/** 文字に <script (大小を区別しない) を含むか */
function containsScriptOpenTag(text: string): boolean {
  return text.toLowerCase().includes(SCRIPT_OPEN_TAG_WORD);
}

/** JSX の要素の属性に nonce={式} があるか (nonce="固定"・値なし・{...props} だけは満たさない) */
function hasNonceExpression(attributes: ts.JsxAttributes, source: ts.SourceFile): boolean {
  return attributes.properties.some(
    (property) =>
      ts.isJsxAttribute(property) &&
      property.name.getText(source) === 'nonce' &&
      property.initializer !== undefined &&
      ts.isJsxExpression(property.initializer) &&
      property.initializer.expression !== undefined,
  );
}

/** テンプレートの文字の部分 (raw) をつなぎ、${…} の位置に TEMPLATE_SUBSTITUTION_MARK を置いた文字列 */
function templateRawTextOf(node: ts.TemplateExpression): string {
  return node.templateSpans.reduce(
    (text, span) => `${text}${TEMPLATE_SUBSTITUTION_MARK}${span.literal.rawText ?? span.literal.text}`,
    node.head.rawText ?? node.head.text,
  );
}

/** templateRawTextOf の文字の <script の開きタグが 1 つ以上あり、どれも nonce= の値を差し込みから受けているか */
export function stringScriptNonceOk(rawTemplateText: string): boolean {
  const openTags: string[] = rawTemplateText.match(SCRIPT_OPEN_TAG_PATTERN) ?? [];
  return openTags.length > 0 && openTags.every((tag) => NONCE_FROM_SUBSTITUTION_PATTERN.test(tag));
}

/** 1 ファイルの検出 (種類と nonce の規則は NONCE_RULES) */
export function analyzeInlineScripts(file: string, text: string): InlineScriptFinding[] {
  const source = parseSource(file, text);
  // 1 周目: next/script の静的 import と、その手元の名前 (import Script from … / import { default as S } from …)
  const staticImports: ts.ImportDeclaration[] = [];
  const nextScriptBindings = new Set<string>();
  for (const statement of source.statements) {
    if (
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text === NEXT_SCRIPT_MODULE
    ) {
      staticImports.push(statement);
      const clause = statement.importClause;
      if (clause?.name) nextScriptBindings.add(clause.name.text);
      const namedBindings = clause?.namedBindings;
      if (namedBindings && ts.isNamedImports(namedBindings)) {
        for (const element of namedBindings.elements) {
          if (element.propertyName?.text === 'default') nextScriptBindings.add(element.name.text);
        }
      }
    }
  }
  const scriptTagNames = new Set<string>([...SCRIPT_JSX_TAG_NAMES, ...nextScriptBindings]);
  const findings: InlineScriptFinding[] = [];
  let elementsOfNextScript = 0;
  const pushNextScriptReference = (node: ts.Node, label: string): void => {
    findings.push({ kind: 'next-script', line: lineOf(source, node), nonceOk: false, label });
  };

  // 2 周目: 構文木を全部たどる
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) return; // 静的 import は 1 周目で拾った
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName.getText(source);
      if (scriptTagNames.has(tag)) {
        if (nextScriptBindings.has(tag)) elementsOfNextScript += 1;
        const nonceOk = hasNonceExpression(node.attributes, source);
        findings.push({ kind: 'jsx', line: lineOf(source, node), nonceOk, label: `<${tag}>` });
      }
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text === NEXT_SCRIPT_MODULE
    ) {
      pushNextScriptReference(node, "export … from 'next/script'");
      return;
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      ts.isStringLiteral(node.moduleReference.expression) &&
      node.moduleReference.expression.text === NEXT_SCRIPT_MODULE
    ) {
      pushNextScriptReference(node, "import … = require('next/script')");
      return;
    } else if (ts.isCallExpression(node)) {
      const [firstArgument] = node.arguments;
      const isNextScriptArgument =
        firstArgument !== undefined && ts.isStringLiteral(firstArgument) && firstArgument.text === NEXT_SCRIPT_MODULE;
      if (isNextScriptArgument && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        pushNextScriptReference(node, "import('next/script')");
      } else if (isNextScriptArgument && ts.isIdentifier(node.expression) && node.expression.text === 'require') {
        pushNextScriptReference(node, "require('next/script')");
      }
    } else if (ts.isTemplateExpression(node)) {
      // 検出は cooked の文字をつないで見る (差し込みで <scr と ipt に割っても見つける)。規則は raw で見る
      const cooked = node.templateSpans.reduce((text, span) => `${text}${span.literal.text}`, node.head.text);
      if (containsScriptOpenTag(cooked)) {
        const nonceOk = stringScriptNonceOk(templateRawTextOf(node));
        findings.push({ kind: 'string', line: lineOf(source, node), nonceOk, label: '<script を含むテンプレート' });
      }
      for (const span of node.templateSpans) visit(span.expression);
      return;
    } else if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      // 差し込みの無い文字は毎リクエストの nonce を持てないので、規則を満たさない
      if (containsScriptOpenTag(node.text)) {
        findings.push({ kind: 'string', line: lineOf(source, node), nonceOk: false, label: '<script を含む文字列' });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);

  // next/script の静的 import は、手元の名前があり、同じファイルにその名前の要素が 1 つ以上あるときだけ規則を満たす
  const staticImportOk = nextScriptBindings.size > 0 && elementsOfNextScript > 0;
  for (const declaration of staticImports) {
    findings.push({ kind: 'next-script', line: lineOf(source, declaration), nonceOk: staticImportOk, label: "import … from 'next/script'" });
  }
  return findings;
}

/** 照合の鍵 (kind は空白を含まないので、最初の空白で 2 つに分かれる) */
const allowKeyOf = (file: string, kind: InlineScriptKind): string => `${kind} ${file}`;

/**
 * 走査の結果 (file → 検出) を許可リストと照合し、問題を返す (空なら緑)。
 *   ① 検出の (file, kind) が許可リストに無い ② あるが検出が NONCE_RULES[kind] を満たさない
 *   ③ 項目の count とその (file, kind) の検出の件数が違う (検出 0 件 = 古い項目を含む)
 *   ④ 項目の reason が空・count が 1 以上の整数でない・同じ (file, kind) の項目が 2 つ以上
 */
export function inlineScriptProblems(
  scanned: ReadonlyMap<string, readonly InlineScriptFinding[]>,
  allowlist: readonly AllowedInlineScript[],
): InlineScriptProblem[] {
  const problems: InlineScriptProblem[] = [];
  const entries = new Map<string, AllowedInlineScript>();
  for (const entry of allowlist) {
    const key = allowKeyOf(entry.file, entry.kind);
    const report = (message: string): void => {
      problems.push({ file: entry.file, kind: entry.kind, message: `${entry.file} (${entry.kind}): ${message}` });
    };
    if (entries.has(key)) report('同じ file と kind の項目が 2 つ以上ある (1 つにまとめる)');
    entries.set(key, entry);
    if (entry.reason.trim() === '') report('reason が空');
    if (!Number.isInteger(entry.count) || entry.count < 1) report(`count は 1 以上の整数 (いま ${entry.count})`);
  }
  const counts = new Map<string, number>();
  for (const [file, findings] of scanned) {
    for (const finding of findings) {
      const key = allowKeyOf(file, finding.kind);
      counts.set(key, (counts.get(key) ?? 0) + 1);
      const where = `${file}:${finding.line} ${finding.label}`;
      if (!entries.has(key)) {
        problems.push({ file, kind: finding.kind, message: `${where}: ALLOWED_INLINE_SCRIPTS に無い` });
      } else if (!finding.nonceOk) {
        problems.push({ file, kind: finding.kind, message: `${where}: nonce の規則を満たさない (${NONCE_RULES[finding.kind]})` });
      }
    }
  }
  for (const [key, entry] of entries) {
    const found = counts.get(key) ?? 0;
    if (found === entry.count) continue;
    const message = `${entry.file} (${entry.kind}): 検出 ${found} 件 ≠ count ${entry.count} (足したなら理由を見直して count を直す。0 件なら項目を消す)`;
    problems.push({ file: entry.file, kind: entry.kind, message });
  }
  return problems;
}

/** 走査するファイル (tests/inner-html-contract.test.ts の listSourceFiles と同じ: node_modules・__tests__・.next を飛ばし、.d.ts・.test・.spec を除く) */
export function listInlineScriptSourceFiles(root: string, dir: string): string[] {
  const files: string[] = [];
  if (!fs.existsSync(path.join(root, dir))) return files;
  for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const relative = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '__tests__' || entry.name === '.next') continue;
      files.push(...listInlineScriptSourceFiles(root, relative));
    } else if (/\.tsx?$/.test(entry.name) && !/\.(?:d|test|spec)\.tsx?$/.test(entry.name)) {
      files.push(relative);
    }
  }
  return files;
}

/** INLINE_SCRIPT_SCAN_ROOTS を走査する (INLINE_SCRIPT_QUICK_FILTER に当たるファイルだけ構文木にする)。鍵はルートからの相対パス。検出 0 件のファイルは入れない */
export function scanInlineScripts(root: string): Map<string, InlineScriptFinding[]> {
  const scanned = new Map<string, InlineScriptFinding[]>();
  for (const scanRoot of INLINE_SCRIPT_SCAN_ROOTS) {
    for (const file of listInlineScriptSourceFiles(root, scanRoot)) {
      const text = fs.readFileSync(path.join(root, file), 'utf8');
      if (!INLINE_SCRIPT_QUICK_FILTER.test(text)) continue;
      const findings = analyzeInlineScripts(file, text);
      if (findings.length > 0) scanned.set(file, findings);
    }
  }
  return scanned;
}

/** export const dynamic = 'force-dynamic' を宣言しているか (構文木で見る。layout を import すると next/font/google の偽物が要る) */
export function exportsForceDynamic(file: string, text: string): boolean {
  return parseSource(file, text).statements.some(
    (statement) =>
      ts.isVariableStatement(statement) &&
      statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) === true &&
      (statement.declarationList.flags & ts.NodeFlags.Const) !== 0 &&
      statement.declarationList.declarations.some(
        (declaration) =>
          ts.isIdentifier(declaration.name) &&
          declaration.name.text === 'dynamic' &&
          declaration.initializer !== undefined &&
          ts.isStringLiteral(declaration.initializer) &&
          declaration.initializer.text === FORCE_DYNAMIC,
      ),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ここから下はテスト (docs/design/cross/18-csp-nonce.md §15)。上の検出と照合のコードは §9.11 の正典のとおり
// ─────────────────────────────────────────────────────────────────────────────

const ROOT = path.resolve(__dirname, '..');

/** 見本のファイル名 (JSX として読むので末尾は x) */
const SAMPLE_TSX = 'src/app/sample/page.tsx';
const SAMPLE_TS = 'src/lib/sample.ts';

/** 種類ごとに、nonce の規則を満たすか (nonceOk) を並べる */
function nonceOkOf(findings: readonly InlineScriptFinding[], kind: InlineScriptKind): boolean[] {
  return findings.filter((finding) => finding.kind === kind).map((finding) => finding.nonceOk);
}

describe('インラインのスクリプトを足したら赤にする走査 (#1169)', () => {
  it('src / lib / components (テストを除く) の走査結果を ALLOWED_INLINE_SCRIPTS と照合し、問題が 0 件 (許可リストは #1867 の JSON-LD の 1 本。失敗の文に INLINE_SCRIPT_GUIDANCE を添える)', () => {
    const scanned = scanInlineScripts(ROOT);
    const problems = inlineScriptProblems(scanned, ALLOWED_INLINE_SCRIPTS).map((problem) => problem.message);

    expect(problems, INLINE_SCRIPT_GUIDANCE).toEqual([]);
    // 走査が空振りしていない: 走査の対象のファイルを読んでいる (ルートの layout は走査の範囲にある)
    const listed = INLINE_SCRIPT_SCAN_ROOTS.flatMap((scanRoot) => listInlineScriptSourceFiles(ROOT, scanRoot));
    expect(listed).toContain(ROOT_LAYOUT_FILE);
    expect(listed.some((file) => /\.(?:test|spec)\.tsx?$/.test(file))).toBe(false);
  });

  it('検出 jsx: <script> / <Script> / next/script の別名の要素を見つけ、nonce={式} のものだけが規則を満たす (nonce なし・nonce="固定"・{...props} だけは満たさない)', () => {
    const findings = analyzeInlineScripts(
      SAMPLE_TSX,
      [
        "import NextScript from 'next/script';",
        'export function Page({ nonce, props }: { nonce: string; props: Record<string, string> }) {',
        '  return (',
        '    <>',
        '      <script nonce={nonce} src="/a.js" />',
        '      <script>{"x"}</script>',
        '      <script nonce="fixed" />',
        '      <script nonce />',
        '      <script {...props} />',
        '      <Script nonce={nonce} />',
        '      <NextScript nonce={nonce} id="a" />',
        '      <NextScript id="b" />',
        '      <div nonce={nonce} />',
        '    </>',
        '  );',
        '}',
      ].join('\n'),
    );

    expect(nonceOkOf(findings, 'jsx')).toEqual([true, false, false, false, false, true, true, false]);
    expect(findings.filter((finding) => finding.kind === 'jsx').map((finding) => finding.label)).toEqual([
      '<script>',
      '<script>',
      '<script>',
      '<script>',
      '<script>',
      '<Script>',
      '<NextScript>',
      '<NextScript>',
    ]);
  });

  it('検出 next-script: import / export … from / import() / require / import = require を見つけ、静的 import で同じファイルに要素があるものだけが規則を満たす', () => {
    const withElement = analyzeInlineScripts(
      SAMPLE_TSX,
      "import Script from 'next/script';\nexport const A = ({ n }: { n: string }) => <Script nonce={n} />;\n",
    );
    expect(nonceOkOf(withElement, 'next-script')).toEqual([true]);

    const namedDefault = analyzeInlineScripts(
      SAMPLE_TSX,
      "import { default as S } from 'next/script';\nexport const A = ({ n }: { n: string }) => <S nonce={n} />;\n",
    );
    expect(nonceOkOf(namedDefault, 'next-script')).toEqual([true]);
    expect(nonceOkOf(namedDefault, 'jsx')).toEqual([true]);

    const withoutElement = analyzeInlineScripts(SAMPLE_TSX, "import Script from 'next/script';\nexport const A = Script;\n");
    expect(nonceOkOf(withoutElement, 'next-script')).toEqual([false]);

    const sideEffectOnly = analyzeInlineScripts(SAMPLE_TS, "import 'next/script';\n");
    expect(nonceOkOf(sideEffectOnly, 'next-script')).toEqual([false]);

    const others = analyzeInlineScripts(
      SAMPLE_TS,
      [
        "export { default } from 'next/script';",
        "export const lazy = () => import('next/script');",
        "export const legacy = () => require('next/script');",
        "import S = require('next/script');",
        'export const s = S;',
      ].join('\n'),
    );
    const references = others.filter((finding) => finding.kind === 'next-script');
    expect(references.map((finding) => finding.label).sort()).toEqual(
      [
        "export … from 'next/script'",
        "import('next/script')",
        "import … = require('next/script')",
        "require('next/script')",
      ].sort(),
    );
    expect(references.every((finding) => !finding.nonceOk)).toBe(true);
  });

  it('検出 string: <script (大小を区別しない) を含む文字列・テンプレートを見つけ、開きタグごとに nonce= の値が差し込みのテンプレートだけが規則を満たす (固定の文字列・\\${} と書いたものは満たさない)', () => {
    const findings = analyzeInlineScripts(
      SAMPLE_TS,
      [
        'declare const nonce: string;',
        'declare const code: string;',
        "export const a = '<script>alert(1)</script>';",
        'export const b = `<script nonce="${nonce}">${code}</script>`;',
        "export const c = `<SCRIPT nonce='${nonce}'>x</SCRIPT>`;",
        'export const d = `<script>static</script>`;',
        'export const e = `<script nonce="\\${}">${code}</script>`;',
        'export const f = `<script nonce="abc">${code}</script>`;',
        'export const g = `<scr${""}ipt nonce="${nonce}">`;',
        'export const h = `<script data-nonce="${nonce}">${code}</script>`;',
        'export const i = `<script nonce=${nonce}>${code}</script><script>${code}</script>`;',
        'export const j = `<script nonce=${nonce}>${code}</script><script nonce="${nonce}">`;',
        "export const k = '<div>not a script</div>';",
      ].join('\n'),
    );

    expect(nonceOkOf(findings, 'string')).toEqual([false, true, true, false, false, false, false, false, false, true]);
    expect(stringScriptNonceOk('<script nonce="${}">')).toBe(true);
    expect(stringScriptNonceOk('<div>')).toBe(false);
  });

  it('検出: コメントと正規表現リテラルには反応しない', () => {
    const findings = analyzeInlineScripts(
      SAMPLE_TSX,
      [
        "// <script>alert(1)</script> と next/script の説明",
        '/* <Script nonce="x" /> */',
        'export const pattern = /<script\\b[^>]*>/i;',
        "export const another = /next\\/script/;",
        'export const A = () => <div>{/* <script> */}</div>;',
      ].join('\n'),
    );

    expect(findings).toEqual([]);
  });

  it('照合: 見本の許可リストで、載っていない検出・nonce の規則を満たさない検出・件数の食い違い (検出 0 件の古い項目を含む)・空の reason・1 未満の count・同じ file と kind の重複を、それぞれ問題として返す', () => {
    const finding = (kind: InlineScriptKind, nonceOk: boolean): InlineScriptFinding => ({ kind, line: 1, nonceOk, label: kind });
    const scanned = new Map<string, InlineScriptFinding[]>([
      ['src/a.tsx', [finding('jsx', true)]],
      ['src/b.tsx', [finding('jsx', false)]],
      ['src/c.tsx', [finding('string', true), finding('string', true)]],
      ['src/f.tsx', [finding('jsx', true)]],
    ]);
    const allowlist: AllowedInlineScript[] = [
      { file: 'src/b.tsx', kind: 'jsx', count: 1, reason: '見本 (規則違反)' },
      { file: 'src/c.tsx', kind: 'string', count: 1, reason: '見本 (件数違い)' },
      { file: 'src/d.tsx', kind: 'jsx', count: 1, reason: '見本 (古い項目)' },
      { file: 'src/f.tsx', kind: 'jsx', count: 1, reason: '' },
      { file: 'src/e.tsx', kind: 'next-script', count: 0, reason: '見本 (count 0)' },
      { file: 'src/g.tsx', kind: 'string', count: 1, reason: '見本 (重複 1)' },
      { file: 'src/g.tsx', kind: 'string', count: 1, reason: '見本 (重複 2)' },
    ];

    const problems = inlineScriptProblems(scanned, allowlist);
    const messageOf = (file: string) => problems.filter((problem) => problem.file === file).map((problem) => problem.message);

    // ① 載っていない
    expect(messageOf('src/a.tsx')).toEqual([expect.stringContaining('ALLOWED_INLINE_SCRIPTS に無い')]);
    // ② nonce の規則を満たさない
    expect(messageOf('src/b.tsx')).toEqual([expect.stringContaining('nonce の規則を満たさない')]);
    // ③ 件数の食い違いと、検出 0 件の古い項目
    expect(messageOf('src/c.tsx')).toEqual([expect.stringContaining('検出 2 件 ≠ count 1')]);
    expect(messageOf('src/d.tsx')).toEqual([expect.stringContaining('検出 0 件 ≠ count 1')]);
    // ④ 空の reason・1 未満の count・同じ file と kind の重複
    expect(messageOf('src/f.tsx')).toEqual([expect.stringContaining('reason が空')]);
    expect(messageOf('src/e.tsx')).toEqual(
      expect.arrayContaining([expect.stringContaining('count は 1 以上の整数')]),
    );
    expect(messageOf('src/g.tsx')).toEqual(
      expect.arrayContaining([expect.stringContaining('同じ file と kind の項目が 2 つ以上')]),
    );
  });

  it('照合: 規則どおりの見本 (next/script の import 1 件 + <Script nonce={nonce}> 1 件 + nonce が差し込みのテンプレート 1 件を、件数どおりの 3 項目で載せる) は問題 0 件', () => {
    const findings = analyzeInlineScripts(
      SAMPLE_TSX,
      [
        "import Script from 'next/script';",
        'export function Page({ nonce, code }: { nonce: string; code: string }) {',
        '  const html = `<script nonce="${nonce}">${code}</script>`;',
        '  return <Script nonce={nonce} id={html} />;',
        '}',
      ].join('\n'),
    );
    const scanned = new Map([[SAMPLE_TSX, findings]]);
    const allowlist: AllowedInlineScript[] = [
      { file: SAMPLE_TSX, kind: 'next-script', count: 1, reason: '見本: 外部の SDK が next/script を要る' },
      { file: SAMPLE_TSX, kind: 'jsx', count: 1, reason: '見本: <Script> の要素' },
      { file: SAMPLE_TSX, kind: 'string', count: 1, reason: '見本: 決まった HTML の中のスクリプト' },
    ];

    expect(findings).toHaveLength(allowlist.length);
    expect(inlineScriptProblems(scanned, allowlist)).toEqual([]);
  });

  it("src/app/layout.tsx は export const dynamic = 'force-dynamic' を宣言している (exportsForceDynamic。見本: 宣言の無いソース・export の無い const・let は false)", () => {
    const layout = fs.readFileSync(path.join(ROOT, ROOT_LAYOUT_FILE), 'utf8');

    expect(exportsForceDynamic(ROOT_LAYOUT_FILE, layout)).toBe(true);
    expect(exportsForceDynamic(SAMPLE_TSX, 'export const revalidate = 0;\n')).toBe(false);
    expect(exportsForceDynamic(SAMPLE_TSX, "const dynamic = 'force-dynamic';\nexport default dynamic;\n")).toBe(false);
    expect(exportsForceDynamic(SAMPLE_TSX, "export let dynamic = 'force-dynamic';\n")).toBe(false);
    expect(exportsForceDynamic(SAMPLE_TSX, "export const dynamic = 'force-static';\n")).toBe(false);
  });
});
