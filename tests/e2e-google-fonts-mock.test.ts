// @vitest-environment node
/**
 * e2e のビルドで使う Google Fonts のモック (tests/e2e/fixtures/google-fonts-mock.cjs) が、
 * 今の Next.js の next/font/google で、Turbopack (#1745。Next 16 の既定のバンドラー) でも効くことを確かめる (#1330)。
 *
 * モックは next/font の内部の仕組み (環境変数 NEXT_FONT_GOOGLE_MOCKED_RESPONSES) に頼っている。Turbopack はこの仕組みを
 * Rust で持っていて (next.js の crates/next-core/src/next_font/google/mod.rs)、vitest からは呼べない。そのため、Turbopack が
 * モックに求める形を 1 つずつ確かめる (どれかが崩れると e2e のビルドが落ちるか、Google Fonts へ取りに行く):
 *   - モックのファイルは、そのディレクトリだけを根にして束ねられる → 他のモジュールを読まない (require / import が無い)
 *   - 返したオブジェクトは JSON にして受け取られる → JSON にしても、layout.tsx の指定から Next.js が作る URL が全部キーとして残る
 *   - CSS の `src: url(...)` の行のフォントファイルは HTTP で取りに行かれる → CSS に `src: url(` の行が無い
 * あわせて、Next.js の next/font/google のローダー (JavaScript の実装。webpack のビルドが使う) と postcss-next-font の検査を
 * 実際に通し、モックの CSS が next/font に受け付けられる形 (@font-face がある・CSS 変数が定義される) であることを確かめる。
 * Turbopack で実際にビルドが通ることは、e2e のビルド (scripts/local-ci.sh の e2e 段・.github/workflows/e2e-local.yml) が確かめる。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import postcss from 'postcss';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(__dirname, '..');
const MOCK_PATH = path.resolve(__dirname, 'e2e/fixtures/google-fonts-mock.cjs');
const LAYOUT_PATH = path.join(ROOT, 'src/app/layout.tsx');
const NEXT_FONT_GOOGLE = 'next/font/google';
const NEXT_FONT_GOOGLE_DIST = 'next/dist/compiled/@next/font/dist/google';

type LoaderResult = {
  css: string;
  variable?: string;
  weight?: string;
  style?: string;
  fallbackFonts?: string[];
  adjustFontFallback?: unknown;
};

type GoogleFontLoader = (args: {
  functionName: string;
  data: unknown[];
  emitFontFile: (content: Buffer, ext: string, preload: boolean, isUsingSizeAdjust?: boolean) => string;
  isDev: boolean;
  isServer: boolean;
}) => Promise<LoaderResult>;

type PostcssNextFontPlugin = (options: {
  exports: Array<{ name: string; value: string }>;
  fallbackFonts?: string[];
  adjustFontFallback?: unknown;
  variable?: string;
  weight?: string;
  style?: string;
}) => postcss.Plugin;

/** next/font/google の validateGoogleFontFunctionCall が返すもの (ここで使う項目だけ) */
type ValidatedFontCall = {
  fontFamily: string;
  weights: string[];
  styles: string[];
  display: string;
  selectedVariableAxes?: string[];
};

const loader: GoogleFontLoader = require(`${NEXT_FONT_GOOGLE_DIST}/loader.js`).default;
const { validateGoogleFontFunctionCall } = require(`${NEXT_FONT_GOOGLE_DIST}/validate-google-font-function-call.js`) as {
  validateGoogleFontFunctionCall: (functionName: string, options: unknown) => ValidatedFontCall;
};
const { getFontAxes } = require(`${NEXT_FONT_GOOGLE_DIST}/get-font-axes.js`) as {
  getFontAxes: (fontFamily: string, weights: string[], styles: string[], selectedVariableAxes?: string[]) => unknown;
};
const { getGoogleFontsUrl } = require(`${NEXT_FONT_GOOGLE_DIST}/get-google-fonts-url.js`) as {
  getGoogleFontsUrl: (fontFamily: string, axes: unknown, display: string) => string;
};
const { findFontFilesInCss } = require(`${NEXT_FONT_GOOGLE_DIST}/find-font-files-in-css.js`) as {
  findFontFilesInCss: (css: string, subsetsToPreload?: string[]) => unknown[];
};
const postcssNextFont: PostcssNextFontPlugin =
  require('next/dist/build/webpack/loaders/next-font-loader/postcss-next-font.js').default;

const mockSource = fs.readFileSync(MOCK_PATH, 'utf8');
const mock: Record<string, string | undefined> = require(MOCK_PATH);
/** Turbopack はモックの値を JSON にして受け取る (get_mock_stylesheet の parse_json_with_source_context) */
const mockAsTurbopackSeesIt: Record<string, string> = JSON.parse(JSON.stringify(mock));

/** 文字列・真偽値・それらの配列・それらのオブジェクトだけからなる式を値にする (layout.tsx のフォントの指定を読む) */
function literalValueOf(node: ts.Expression): unknown {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (ts.isArrayLiteralExpression(node)) return node.elements.map(literalValueOf);
  if (ts.isObjectLiteralExpression(node)) {
    return Object.fromEntries(
      node.properties.map((property) => {
        if (!ts.isPropertyAssignment(property) || !(ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))) {
          throw new Error(`layout.tsx のフォントの指定に読めない項目がある: ${property.getText()}`);
        }
        return [property.name.text, literalValueOf(property.initializer)];
      }),
    );
  }
  throw new Error(`layout.tsx のフォントの指定に読めない値がある: ${node.getText()}`);
}

type FontCall = { functionName: string; options: Record<string, unknown> };

/** src/app/layout.tsx が next/font/google から import した関数を呼ぶところ (関数名と、渡したオプション) */
function fontCallsInLayout(): FontCall[] {
  const source = ts.createSourceFile(LAYOUT_PATH, fs.readFileSync(LAYOUT_PATH, 'utf8'), ts.ScriptTarget.Latest, true);
  /** 手元の名前 → next/font/google での名前 */
  const imported = new Map<string, string>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    if (statement.moduleSpecifier.text !== NEXT_FONT_GOOGLE) continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) imported.set(element.name.text, (element.propertyName ?? element.name).text);
  }
  const calls: FontCall[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const functionName = imported.get(node.expression.text);
      if (functionName !== undefined) {
        const [argument] = node.arguments;
        const options = argument ? literalValueOf(argument) : {};
        calls.push({ functionName, options: options as Record<string, unknown> });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return calls;
}

/** next/font が、このフォントの指定から作る Google Fonts の CSS の URL (Turbopack の get_stylesheet_url も同じ作り方) */
function stylesheetUrlOf({ functionName, options }: FontCall): string {
  const { fontFamily, weights, styles, display, selectedVariableAxes } = validateGoogleFontFunctionCall(functionName, options);
  return getGoogleFontsUrl(fontFamily, getFontAxes(fontFamily, weights, styles, selectedVariableAxes), display);
}

const layoutFontCalls = fontCallsInLayout();

describe('Google Fonts のモック (e2e のビルド用・Turbopack でも効く形)', () => {
  const previous = process.env.NEXT_FONT_GOOGLE_MOCKED_RESPONSES;

  beforeEach(() => {
    process.env.NEXT_FONT_GOOGLE_MOCKED_RESPONSES = MOCK_PATH;
  });

  afterEach(() => {
    if (previous === undefined) delete process.env.NEXT_FONT_GOOGLE_MOCKED_RESPONSES;
    else process.env.NEXT_FONT_GOOGLE_MOCKED_RESPONSES = previous;
  });

  it('layout.tsx の next/font/google の呼び出しを読めている (読み方が空回りしていない)', () => {
    expect(layoutFontCalls.map((call) => call.functionName).sort()).toEqual(['Noto_Sans_JP', 'Noto_Serif_JP']);
  });

  it('モックのファイルは他のモジュールを読まない (Turbopack はこのディレクトリだけを根に束ね、node_modules を解決できない)', () => {
    expect(mockSource).not.toMatch(/\brequire\s*\(/);
    expect(mockSource).not.toMatch(/^\s*import\s/m);
  });

  it('layout.tsx の指定から Next.js が作る CSS の URL が、JSON にしたモックのキーに全部ある (無いと Turbopack が「url not found」で落ちる)', () => {
    const urls = layoutFontCalls.map(stylesheetUrlOf);
    expect(urls).toEqual([
      'https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@400;500;700&display=swap',
      'https://fonts.googleapis.com/css2?family=Noto+Serif+JP:wght@400;700&display=swap',
    ]);
    // layout.tsx が使わない URL も並べない (フォントをやめたらモックからも消す)
    expect(Object.keys(mockAsTurbopackSeesIt).sort()).toEqual([...urls].sort());
  });

  it('モックの CSS はフォントファイルを指さない (`src: url(...)` の行があると Turbopack が HTTP で取りに行く)', () => {
    const values = Object.values(mockAsTurbopackSeesIt);
    expect(values).toHaveLength(layoutFontCalls.length);
    for (const css of values) {
      expect(css).not.toMatch(/src:\s*url\(/);
      expect(css).not.toContain('fonts.gstatic.com');
      // next/font がフォントファイルを探すのと同じ探し方 (Turbopack の find_font_files_in_css も同じ正規表現) で、1 つも見つからない
      expect(findFontFilesInCss(css, ['latin'])).toEqual([]);
    }
  });

  it.each(layoutFontCalls.map((call) => [call.functionName, call] as const))(
    '%s: next/font/google のローダーと postcss-next-font の検査を、フォントファイルを作らずに通る',
    async (_name, { functionName, options }) => {
      const emitFontFile = vi.fn((_content: Buffer, ext: string) => `/_next/static/media/mock.${ext}`);
      const { fontFamily, weights } = validateGoogleFontFunctionCall(functionName, options);

      const result = await loader({ functionName, data: [options], emitFontFile, isDev: false, isServer: true });

      // フォントファイルは作らない (取りに行かない)
      expect(emitFontFile).not.toHaveBeenCalled();
      // 要求した太さの数だけ @font-face があり、端末の書体を名前で指す
      expect(result.css.match(/@font-face/g)).toHaveLength(weights.length);
      expect(result.css).toContain(`font-family: '${fontFamily}'`);
      expect(result.css).toContain(`src: local('${fontFamily}')`);
      for (const weight of weights) expect(result.css).toContain(`font-weight: ${weight};`);
      expect(result.variable).toBe(options.variable);
      expect(result.adjustFontFallback).toBeTruthy();

      // next build が CSS に掛ける postcss-next-font の検査・変換を、そのまま通す
      const exportsList: Array<{ name: string; value: string }> = [];
      const processed = await postcss([
        postcssNextFont({
          exports: exportsList,
          fallbackFonts: result.fallbackFonts,
          adjustFontFallback: result.adjustFontFallback,
          variable: result.variable,
          weight: result.weight,
          style: result.style,
        }),
      ]).process(result.css, { from: undefined });
      const fallbackFamily = `'${fontFamily}', '${fontFamily} Fallback'`;
      expect(processed.css).toContain(`font-family: ${fallbackFamily}`);
      // layout.tsx が使う CSS 変数 (--font-sans / --font-serif) も今までどおり定義される
      expect(processed.css).toContain(`${String(options.variable)}: ${fallbackFamily}`);
      expect(exportsList.map((e) => e.name)).toContain('style');
    },
  );

  it('並べていない CSS の URL には答えない', () => {
    expect(mock['https://fonts.googleapis.com/css2?family=Inter:wght@400&display=swap']).toBeUndefined();
    expect(mock['https://example.com/other.css']).toBeUndefined();
  });
});
