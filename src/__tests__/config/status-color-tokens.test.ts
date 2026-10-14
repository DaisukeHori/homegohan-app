/**
 * #590 状態色 (success / warning / error / danger) のトークン化の契約テスト
 *
 * 状態色の値が Web の画面ごと・モバイルでずれていた (Web の home・health・pantry は success #4CAF50 / warning #FF9800 の B 系、
 * モバイルは success #6B9B6B / warning #E5A84B の A 系)。2026-10-08 のオーナー判断 (590 / 590-2) で、
 *   - 塗りの色は A 系に統一し、packages/shared の STATUS_COLOR_TOKENS を唯一の定義元にする
 *   - 文字に使うときは、AA (4.5:1) を満たす濃い色 (successText / warningText / dangerText) を使う
 * ことにした。ここでは次の 5 つを、ソースを TypeScript の構文木で読んで確かめる (コメントや文字列の中身は見ない)。
 *
 *   1. Web (home・pantry・health 配下) の画面が持つ色の表を実際に組み立て (`...STATUS_COLOR_TOKENS` を展開)、
 *      状態色の値がモバイルの colors と 1 つずつ同じであること (Web / モバイルの値の一致)
 *   2. 画面が状態色を hex で直書きしていないこと (旧 B 系の値も、A 系の値も。トークンを使う)
 *   3. 文字に塗りの色 (colors.success など) を使っていないこと。文字には successText / warningText / dangerText を使う
 *      (アイコン・背景・枠線・グラフの線は塗りの色のまま)
 *   4. モバイルの colors.ts も共通のトークンを展開していること
 *   5. 走査そのものが正しく動くこと (素通りして「問題なし」になっていないこと)
 *
 * 画面の見た目の確認は、実際に描画する health/graphs/__tests__/page.status-colors.test.ts が行う。
 */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { STATUS_COLOR_TOKENS } from '@homegohan/shared';
import { colors as mobileColors } from '../../../apps/mobile/src/theme/colors';

const ROOT = path.resolve(__dirname, '../../..');

const TOKEN_KEYS = Object.keys(STATUS_COLOR_TOKENS) as (keyof typeof STATUS_COLOR_TOKENS)[];
/** 塗りの状態色 (Light と Text は含まない)。文字に使ってはいけない */
const FILL_KEYS = new Set(['success', 'warning', 'error', 'danger']);

// ─────────────────────────────────────────────
// 走査の対象
// ─────────────────────────────────────────────
const HEALTH_DIR = 'src/app/(main)/health';
const HOME_AND_PANTRY = ['src/app/(main)/home/page.tsx', 'src/app/(main)/pantry/page.tsx'];

/** この PR で共通のトークンに切り替えた画面 (色の表を持つ画面)。走査が空振りしていないことの確認に使う */
const EXPECTED_PALETTE_FILES = [
  ...HOME_AND_PANTRY,
  'src/app/(main)/health/page.tsx',
  'src/app/(main)/health/blood-tests/page.tsx',
  'src/app/(main)/health/challenges/page.tsx',
  'src/app/(main)/health/checkups/page.tsx',
  'src/app/(main)/health/checkups/new/page.tsx',
  'src/app/(main)/health/checkups/[id]/CheckupDetailClient.tsx',
  'src/app/(main)/health/goals/page.tsx',
  'src/app/(main)/health/graphs/page.tsx',
  'src/app/(main)/health/insights/page.tsx',
  'src/app/(main)/health/record/page.tsx',
  'src/app/(main)/health/record/quick/page.tsx',
  'src/app/(main)/health/settings/page.tsx',
  'src/app/(main)/health/streaks/page.tsx',
];

function collectSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const relative = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      files.push(...collectSourceFiles(relative));
    } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.(test|spec)\.(ts|tsx)$/.test(entry.name)) {
      files.push(relative);
    }
  }
  return files.sort();
}

/** health 配下は走査で拾う (あとから足した画面も自動で対象になる)。home と pantry は決め打ち */
const SCANNED_FILES = [...HOME_AND_PANTRY, ...collectSourceFiles(HEALTH_DIR)];

// ─────────────────────────────────────────────
// 直書きを許す hex
// ─────────────────────────────────────────────
/** 直書きを禁じる hex: 旧 B 系の値・そのグラデーションの終点・トークンの値そのもの (大文字で比べる) */
const BANNED_LITERALS = new Set<string>([
  '#4CAF50', // 旧 success
  '#E8F5E9', // 旧 successLight
  '#FF9800', // 旧 warning
  '#FFF3E0', // 旧 warningLight
  '#66BB6A', // 旧 success のグラデーションの終点
  '#81C784', // 旧 success のグラデーションの終点 (棒グラフ)
  ...Object.values(STATUS_COLOR_TOKENS).map((value) => value.toUpperCase()),
]);

/**
 * 状態色ではないが、たまたま禁じる値と同じ hex を直書きしている箇所。理由を書いて足す (増やさないこと)。
 * 食事の種類の色 (朝食・昼食) は状態色ではなく、モバイルも同じ値 (apps/mobile/app/menus/weekly/index.tsx など) を使っている。
 */
const ALLOWED_LITERALS: { file: string; literal: string; line: RegExp; reason: string }[] = [
  {
    file: 'src/app/(main)/home/page.tsx',
    literal: '#FF9800',
    line: /^\s*breakfast:/,
    reason: '朝食の色 (食事の種類の色。状態色ではない)。モバイルの朝食も #FF9800',
  },
  {
    file: 'src/app/(main)/home/page.tsx',
    literal: '#4CAF50',
    line: /^\s*lunch:/,
    reason: '昼食の色 (食事の種類の色。状態色ではない)。モバイルの昼食も #4CAF50',
  },
];

// ─────────────────────────────────────────────
// ソース解析
// ─────────────────────────────────────────────
type FindingRule =
  | 'text-uses-fill-token' // 文字 (style の color / SVG <text> の fill) に塗りの状態色を使っている
  | 'text-key-uses-fill-token' // { bg, text } のような「文字の色」の項目に塗りの状態色を入れている
  | 'status-literal'; // 状態色を hex で直書きしている

interface Finding {
  rule: FindingRule;
  line: number;
  snippet: string;
}

function parse(source: string, fileName = 'sample.tsx'): ts.SourceFile {
  return ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

function lineOf(sf: ts.SourceFile, node: ts.Node): number {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

function lineText(sf: ts.SourceFile, line: number): string {
  return sf.text.split('\n')[line - 1] ?? '';
}

/** 式の中に `colors.success` のような塗りの状態色 (Light / Text 以外) への参照があれば返す */
function findFillTokenReference(node: ts.Node): ts.PropertyAccessExpression | null {
  let found: ts.PropertyAccessExpression | null = null;
  const visit = (n: ts.Node) => {
    if (found) return;
    if (
      ts.isPropertyAccessExpression(n) &&
      ts.isIdentifier(n.expression) &&
      n.expression.text === 'colors' &&
      FILL_KEYS.has(n.name.text)
    ) {
      found = n;
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

/** lucide-react から import したアイコンの名前 */
function lucideIconNames(sf: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  for (const statement of sf.statements) {
    if (
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text === 'lucide-react' &&
      statement.importClause?.namedBindings &&
      ts.isNamedImports(statement.importClause.namedBindings)
    ) {
      for (const element of statement.importClause.namedBindings.elements) names.add(element.name.text);
    }
  }
  return names;
}

/** アイコンのタグか。lucide のアイコン、`const Icon = config.icon` のような変数 (名前が Icon で終わる)、Icons.Xxx */
function isIconTag(tag: string, lucide: Set<string>): boolean {
  return lucide.has(tag) || /Icon$/.test(tag) || tag.startsWith('Icons.');
}

function analyze(source: string, fileName = 'sample.tsx', allowed: typeof ALLOWED_LITERALS = []): Finding[] {
  const sf = parse(source, fileName);
  const lucide = lucideIconNames(sf);
  const findings: Finding[] = [];
  const add = (rule: FindingRule, node: ts.Node) => {
    const line = lineOf(sf, node);
    findings.push({ rule, line, snippet: lineText(sf, line).trim() });
  };

  const visit = (node: ts.Node) => {
    // JSX: style={{ color: ... }} (アイコン以外) と、SVG の <text fill={...}>
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName.getText(sf);
      const icon = isIconTag(tag, lucide);
      for (const attribute of node.attributes.properties) {
        if (!ts.isJsxAttribute(attribute) || !attribute.initializer || !ts.isJsxExpression(attribute.initializer)) continue;
        const expression = attribute.initializer.expression;
        if (!expression) continue;
        const name = attribute.name.getText(sf);
        if (name === 'style' && ts.isObjectLiteralExpression(expression) && !icon) {
          for (const property of expression.properties) {
            if (ts.isPropertyAssignment(property) && property.name.getText(sf) === 'color') {
              const reference = findFillTokenReference(property.initializer);
              if (reference) add('text-uses-fill-token', reference);
            }
          }
        }
        if ((name === 'fill' && (tag === 'text' || tag === 'tspan')) || (name === 'color' && !icon)) {
          const reference = findFillTokenReference(expression);
          if (reference) add('text-uses-fill-token', reference);
        }
      }
    }

    // { bg: ..., text: colors.error } のように、文字の色の項目に塗りの色を入れている
    if (ts.isPropertyAssignment(node) && ['text', 'textColor'].includes(node.name.getText(sf))) {
      const reference = findFillTokenReference(node.initializer);
      if (reference) add('text-key-uses-fill-token', reference);
    }

    // 文字列の中の hex (コメントは構文木に出てこないので、コメントの言及は見ない)
    const literalText =
      ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)
        ? node.text
        : null;
    if (literalText !== null) {
      for (const match of literalText.matchAll(/#[0-9A-Fa-f]{6}\b/g)) {
        const literal = match[0].toUpperCase();
        if (!BANNED_LITERALS.has(literal)) continue;
        const line = lineOf(sf, node);
        const isAllowed = allowed.some(
          (entry) => entry.file === fileName && entry.literal === literal && entry.line.test(lineText(sf, line)),
        );
        if (!isAllowed) findings.push({ rule: 'status-literal', line, snippet: `${literal}  ${lineText(sf, line).trim()}` });
      }
    }

    ts.forEachChild(node, visit);
  };
  visit(sf);
  return findings;
}

// ─────────────────────────────────────────────
// 色の表 (`const colors = { ... }`) の解析
// ─────────────────────────────────────────────
interface Palette {
  /** `...STATUS_COLOR_TOKENS` を展開し、文字列で書かれた値を集めた表 */
  resolved: Record<string, string>;
  /** 状態色のキーを直接書いている (トークンを上書きしている) */
  ownStatusKeys: string[];
  /** 解釈できなかった書き方 */
  unsupported: string[];
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (ts.isAsExpression(current) || ts.isParenthesizedExpression(current) || ts.isSatisfiesExpression(current)) {
    current = current.expression;
  }
  return current;
}

function findPalette(sf: ts.SourceFile): ts.ObjectLiteralExpression | null {
  for (const statement of sf.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === 'colors' && declaration.initializer) {
        const initializer = unwrapExpression(declaration.initializer);
        if (ts.isObjectLiteralExpression(initializer)) return initializer;
      }
    }
  }
  return null;
}

function resolvePalette(sf: ts.SourceFile, palette: ts.ObjectLiteralExpression): Palette {
  const resolved: Record<string, string> = {};
  const ownStatusKeys: string[] = [];
  const unsupported: string[] = [];
  for (const property of palette.properties) {
    if (ts.isSpreadAssignment(property)) {
      if (ts.isIdentifier(property.expression) && property.expression.text === 'STATUS_COLOR_TOKENS') {
        Object.assign(resolved, STATUS_COLOR_TOKENS);
      } else {
        unsupported.push(property.getText(sf));
      }
    } else if (ts.isPropertyAssignment(property) && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))) {
      const key = property.name.text;
      if (TOKEN_KEYS.includes(key as (typeof TOKEN_KEYS)[number])) ownStatusKeys.push(key);
      if (ts.isStringLiteral(property.initializer)) resolved[key] = property.initializer.text;
      else unsupported.push(property.getText(sf));
    } else {
      unsupported.push(property.getText(sf));
    }
  }
  return { resolved, ownStatusKeys, unsupported };
}

function importsStatusTokens(sf: ts.SourceFile): boolean {
  return sf.statements.some(
    (statement) =>
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text === '@homegohan/shared' &&
      !!statement.importClause?.namedBindings &&
      ts.isNamedImports(statement.importClause.namedBindings) &&
      statement.importClause.namedBindings.elements.some((element) => (element.propertyName ?? element.name).text === 'STATUS_COLOR_TOKENS'),
  );
}

const read = (relativePath: string) => fs.readFileSync(path.join(ROOT, relativePath), 'utf-8');

// ─────────────────────────────────────────────
// テスト
// ─────────────────────────────────────────────
describe('走査の前提: 対象の画面を読めている', () => {
  it('home・pantry と、health 配下の画面を走査している', () => {
    expect(SCANNED_FILES).toEqual(expect.arrayContaining(EXPECTED_PALETTE_FILES));
    // health 配下は、色の表を持たない画面 (サーバー側のラッパーなど) も含めて走査する
    expect(SCANNED_FILES).toContain('src/app/(main)/health/checkups/[id]/page.tsx');
  });

  it('色の表を持つ画面は、期待した 15 画面ちょうど (あとから足した画面も、ここに足してトークンを使わせる)', () => {
    const withPalette = SCANNED_FILES.filter((file) => findPalette(parse(read(file), file)) !== null);
    expect(withPalette.sort()).toEqual([...EXPECTED_PALETTE_FILES].sort());
  });
});

describe('Web の色の表: 状態色は共通のトークン (packages/shared) で、モバイルの colors と同じ値になる', () => {
  describe.each(EXPECTED_PALETTE_FILES)('%s', (file) => {
    const sf = parse(read(file), file);
    const paletteNode = findPalette(sf);

    it('STATUS_COLOR_TOKENS を @homegohan/shared から import している', () => {
      expect(importsStatusTokens(sf)).toBe(true);
    });

    it('色の表で `...STATUS_COLOR_TOKENS` を展開し、状態色のキーを自前で書いていない (トークンを上書きしない)', () => {
      expect(paletteNode).not.toBeNull();
      const palette = resolvePalette(sf, paletteNode!);
      expect(palette.unsupported).toEqual([]);
      expect(palette.ownStatusKeys).toEqual([]);
      expect(paletteNode!.properties.some((p) => ts.isSpreadAssignment(p) && p.expression.getText(sf) === 'STATUS_COLOR_TOKENS')).toBe(true);
    });

    it('展開した状態色の値が、モバイルの colors と 1 つずつ同じ', () => {
      const palette = resolvePalette(sf, paletteNode!);
      for (const key of TOKEN_KEYS) {
        expect(palette.resolved[key], `${file} の ${key}`).toBe(mobileColors[key]);
      }
    });
  });
});

describe('モバイルの colors: 状態色は共通のトークンから来て、値は Web と同じ', () => {
  const MOBILE_COLORS = 'apps/mobile/src/theme/colors.ts';
  const sf = parse(read(MOBILE_COLORS), MOBILE_COLORS);
  const paletteNode = findPalette(sf);

  it('STATUS_COLOR_TOKENS を import して展開し、状態色のキーを自前で書いていない', () => {
    expect(importsStatusTokens(sf)).toBe(true);
    expect(paletteNode).not.toBeNull();
    const palette = resolvePalette(sf, paletteNode!);
    expect(palette.unsupported).toEqual([]);
    expect(palette.ownStatusKeys).toEqual([]);
  });

  it.each(TOKEN_KEYS)('colors.%s が共通のトークンと同じ値', (key) => {
    expect(mobileColors[key]).toBe(STATUS_COLOR_TOKENS[key]);
  });
});

describe('状態色を hex で直書きしない (旧 B 系の値も、A 系の値も。トークンを使う)', () => {
  it.each(SCANNED_FILES)('%s', (file) => {
    const findings = analyze(read(file), file, ALLOWED_LITERALS).filter((f) => f.rule === 'status-literal');
    expect(
      findings,
      `状態色は packages/shared の STATUS_COLOR_TOKENS を使うこと (colors.success など)。直書きの hex: ${findings
        .map((f) => `${file}:${f.line} ${f.snippet}`)
        .join(' / ')}`,
    ).toEqual([]);
  });

  it('直書きを許す例外は、いまも実際にあるものだけ (例外が古くならない)', () => {
    for (const entry of ALLOWED_LITERALS) {
      const sf = parse(read(entry.file), entry.file);
      const hits: number[] = [];
      const visit = (node: ts.Node) => {
        if (ts.isStringLiteral(node) && node.text.toUpperCase() === entry.literal) {
          const line = lineOf(sf, node);
          if (entry.line.test(lineText(sf, line))) hits.push(line);
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
      expect(hits, `${entry.file} ${entry.literal} (${entry.reason})`).toHaveLength(1);
    }
  });
});

describe('文字には文字用の色を使う (塗りの色 colors.success などは、アイコン・背景・枠線・グラフの線だけ)', () => {
  it.each(SCANNED_FILES)('%s', (file) => {
    const findings = analyze(read(file), file, ALLOWED_LITERALS).filter((f) => f.rule !== 'status-literal');
    expect(
      findings,
      `文字の色には colors.successText / warningText / dangerText を使うこと (error の赤い文字も dangerText)。違反: ${findings
        .map((f) => `${file}:${f.line} ${f.snippet}`)
        .join(' / ')}`,
    ).toEqual([]);
  });
});

describe('走査そのものの確認 (素通りして「問題なし」にならないこと)', () => {
  const run = (source: string) => analyze(`import { Target } from 'lucide-react';\n${source}`);
  const rules = (source: string) => run(source).map((f) => f.rule);

  it('文字に塗りの色を使っていれば見つける (style の color)', () => {
    expect(rules('const A = () => <p style={{ color: colors.success }}>ok</p>;')).toEqual(['text-uses-fill-token']);
    expect(rules('const A = () => <span style={{ color: ok ? colors.warning : colors.textMuted }}>ok</span>;')).toEqual(['text-uses-fill-token']);
    expect(rules('const A = () => <motion.div style={{ background: x, color: colors.error }}>ok</motion.div>;')).toEqual(['text-uses-fill-token']);
    expect(rules('const A = () => <p style={{ color: colors.danger }}>ok</p>;')).toEqual(['text-uses-fill-token']);
  });

  it('文字用の色なら見つけない', () => {
    expect(rules('const A = () => <p style={{ color: colors.successText }}>ok</p>;')).toEqual([]);
    expect(rules('const A = () => <p style={{ color: ok ? colors.warningText : colors.dangerText }}>ok</p>;')).toEqual([]);
  });

  it('アイコン・背景・枠線・グラフの線に塗りの色を使うのは正しいので見つけない', () => {
    expect(rules('const A = () => <Target size={14} style={{ color: colors.success }} />;')).toEqual([]);
    expect(rules('const A = () => <MealIcon color={colors.warning} />;')).toEqual([]);
    expect(rules('const A = () => <div style={{ backgroundColor: colors.error, borderColor: colors.warning }} />;')).toEqual([]);
    expect(rules('const A = () => <line stroke={colors.success} />;')).toEqual([]);
  });

  it('SVG の <text> の fill に塗りの色を使っていれば見つける', () => {
    expect(rules('const A = () => <text fill={colors.success}>目標</text>;')).toEqual(['text-uses-fill-token']);
    expect(rules('const A = () => <text fill={colors.successText}>目標</text>;')).toEqual([]);
  });

  it('{ bg, text } の text に塗りの色を入れていれば見つける (icon なら見つけない)', () => {
    expect(rules('const s = { bg: colors.errorLight, text: colors.error };')).toEqual(['text-key-uses-fill-token']);
    expect(rules('const s = { bg: colors.errorLight, text: colors.dangerText };')).toEqual([]);
    expect(rules('const s = { bg: colors.errorLight, icon: colors.error };')).toEqual([]);
  });

  it('状態色の hex の直書きを見つける (大文字小文字を問わない)。コメントの中の言及は見ない', () => {
    expect(rules("const c = '#4CAF50';")).toEqual(['status-literal']);
    expect(rules("const c = '#4caf50';")).toEqual(['status-literal']);
    expect(rules('const c = `linear-gradient(135deg, ${a} 0%, #66BB6A 100%)`;')).toEqual(['status-literal']);
    expect(rules("const c = '#6B9B6B';")).toEqual(['status-literal']);
    expect(rules("// 以前は '#4CAF50' だった\nconst c = colors.success;")).toEqual([]);
    expect(rules("const c = '#E07A5F';")).toEqual([]);
  });

  it('許可した行の hex だけ見逃す', () => {
    const allowed = [{ file: 'a.tsx', literal: '#FF9800', line: /^\s*breakfast:/, reason: 'test' }];
    const source = "const m = {\n  breakfast: { color: '#FF9800' },\n  other: { color: '#FF9800' },\n};";
    expect(analyze(source, 'a.tsx', allowed).map((f) => f.line)).toEqual([3]);
    expect(analyze(source, 'b.tsx', allowed).map((f) => f.line)).toEqual([2, 3]);
  });

  it('色の表の解析: 展開した値と、自前で書いた状態色のキーを見分ける', () => {
    const ok = parse("const colors = { bg: '#fff', ...STATUS_COLOR_TOKENS, accent: '#000' } as const;");
    const okPalette = resolvePalette(ok, findPalette(ok)!);
    expect(okPalette.resolved.success).toBe(STATUS_COLOR_TOKENS.success);
    expect(okPalette.resolved.bg).toBe('#fff');
    expect(okPalette.ownStatusKeys).toEqual([]);
    expect(okPalette.unsupported).toEqual([]);

    const overridden = parse("const colors = { ...STATUS_COLOR_TOKENS, success: '#4CAF50' };");
    expect(resolvePalette(overridden, findPalette(overridden)!).ownStatusKeys).toEqual(['success']);

    const other = parse("const colors = { ...OTHER, bg: someVariable };");
    expect(resolvePalette(other, findPalette(other)!).unsupported).toHaveLength(2);
  });
});
