/**
 * #2195 V3: AI 相談の提案の実行で読み込み直してよいページ (webViewBridge.ts の AI_CONSULTATION_RELOADABLE_PATHS) の、
 * 「入力の途中なら読み込み直さない」の前提を Web のソースで確かめる (静的な検査)
 *
 * 読み込み直すかはページの上で決め、入力の部品・開いているモーダル (aiConsultationReloadBlockingSelectorOf) がある間は
 * 読み込み直さない。これが入力を守るのは、ページの入力の部品が「モーダルか開閉する欄の中にだけあり、それが出ている間は
 * 必ずその要素に当たる」ときだけ。WebViewScreen.ai-data-reload.test.tsx は querySelector を差し替えた sandbox で
 * スクリプトの動きを見るだけなので、後から role="dialog" も入力の部品も無いモーダル (ボタンだけの選択) が足されると、
 * その選択が読み込み直しで消えうる。ここでは Web のソースを TypeScript の構文木で読み、次を確かめる
 * (条件を満たさない部品が足されたら赤にする)。
 *   1. /menus/weekly のモーダル (_components/modals/*.tsx の全部と、ページが描く名前が Modal / Dialog の部品) は、
 *      role="dialog" / aria-modal / <dialog> か入力の部品を持つ。持たないと分かっていて読み込み直しで閉じることを認めた部品
 *      (KNOWN_NON_BLOCKING_DIALOGS) だけを除く。モーダルが描く同じリポジトリの部品 (共通の枠 BottomSheet など) の印も数える
 *   2. /home の体調のチェックインの欄 (showCheckin の間だけ出る) は、hidden でない入力の部品を持つ
 *   3. /profile の編集のモーダル (isEditing の間だけ出る) は、ページごとに足した要素 (.fixed.inset-0) に当たる層で始まり、
 *      ページの本体 (モーダルの外) には同じ層が無い (あると、マイページはいつまでも読み込み直されない)
 *   4. ほかの一覧のページ (/home・/comparison・/profile) が描く名前が Modal / Dialog の部品も 1 と同じ条件を満たす
 * ソースの JSX を見る検査なので、実際に描く DOM (条件つきで出ない部品など) までは確かめない
 * (読み込み直しの判定そのものは sandbox のテストが見る)。
 */
import fs from 'fs';
import path from 'path';
import * as ts from 'typescript';

import {
  AI_CONSULTATION_RELOADABLE_PATHS,
  AI_CONSULTATION_RELOAD_PAGE_BLOCKING_SELECTORS,
} from '../../src/lib/webViewBridge';

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const WEB_SRC = path.join(REPO_ROOT, 'src');
const MAIN_PAGES = path.join(WEB_SRC, 'app/(main)');
const WEEKLY_MODALS_DIR = path.join(MAIN_PAGES, 'menus/weekly/_components/modals');
const SOURCE_EXTENSIONS = ['.tsx', '.ts'];

/**
 * role="dialog" も入力の部品も持たず、読み込み直すと閉じることを認めた部品 (webViewBridge.ts の AI_CONSULTATION_RELOADABLE_PATHS の
 * '/menus/weekly' の根拠の文)。入力を持たない確認・結果の知らせで、閉じても保存していない入力は失わない。
 * ここに足すのは、閉じても入力を失わないと確かめた部品だけ
 */
const KNOWN_NON_BLOCKING_DIALOGS: Readonly<Record<string, string>> = {
  GenerationResultDialogContent: '生成の完了の知らせ (ボタンだけ。閉じても献立は保存済み)',
};

/** 名前が Modal / Dialog の部品 */
const DIALOG_LIKE_COMPONENT = /^[A-Z][A-Za-z0-9]*(?:Modal|Dialog)[A-Za-z0-9]*$/;
/** 入れるだけで入力の部品になる要素 (input は type="hidden" を除く) */
const INPUT_TAGS: ReadonlySet<string> = new Set(['textarea', 'select', 'Input', 'Textarea', 'Select']);

type JsxElementLike = ts.JsxOpeningElement | ts.JsxSelfClosingElement;

function read(file: string): string {
  return fs.readFileSync(file, 'utf8');
}

function parse(source: string, fileName = 'page.tsx'): ts.SourceFile {
  return ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

/** node の中の JSX の要素 (開くタグ・自分で閉じるタグ) を出てくる順に */
function jsxElementsIn(node: ts.Node): JsxElementLike[] {
  const found: JsxElementLike[] = [];
  const visit = (child: ts.Node) => {
    if (ts.isJsxOpeningElement(child) || ts.isJsxSelfClosingElement(child)) found.push(child);
    ts.forEachChild(child, visit);
  };
  visit(node);
  return found;
}

function tagNameOf(element: JsxElementLike): string {
  return element.tagName.getText();
}

/** 属性の値 (文字列なら文字列・{true}/{false} なら真偽・値が無ければ true・式なら null)。属性が無ければ undefined */
function attributeValueOf(element: JsxElementLike, name: string): string | boolean | null | undefined {
  for (const attribute of element.attributes.properties) {
    if (!ts.isJsxAttribute(attribute) || attribute.name.getText() !== name) continue;
    const initializer = attribute.initializer;
    if (!initializer) return true;
    if (ts.isStringLiteral(initializer)) return initializer.text;
    if (ts.isJsxExpression(initializer) && initializer.expression) {
      const expression = initializer.expression;
      if (expression.kind === ts.SyntaxKind.TrueKeyword) return true;
      if (expression.kind === ts.SyntaxKind.FalseKeyword) return false;
      if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) return expression.text;
      if (ts.isTemplateExpression(expression)) return expression.head.text;
    }
    return null;
  }
  return undefined;
}

/** role="dialog"・aria-modal (false 以外)・<dialog> の要素か */
function isDialogMarker(element: JsxElementLike): boolean {
  const ariaModal = attributeValueOf(element, 'aria-modal');
  return (
    tagNameOf(element) === 'dialog' ||
    attributeValueOf(element, 'role') === 'dialog' ||
    (ariaModal !== undefined && ariaModal !== false && ariaModal !== 'false')
  );
}

/** 入力の部品か (hidden の input は除く。type が式の input は入力の部品として数える) */
function isInputMarker(element: JsxElementLike): boolean {
  const tag = tagNameOf(element);
  if (INPUT_TAGS.has(tag)) return true;
  if (tag === 'input') return attributeValueOf(element, 'type') !== 'hidden';
  const editable = attributeValueOf(element, 'contentEditable');
  return editable !== undefined && editable !== false && editable !== 'false';
}

function hasBlockingMarkerIn(node: ts.Node): boolean {
  return jsxElementsIn(node).some((element) => isDialogMarker(element) || isInputMarker(element));
}

function hasBlockingMarker(source: string): boolean {
  return hasBlockingMarkerIn(parse(source));
}

/** ファイルの拡張子・index を補って、実在するソースのパスにする */
function resolveSourceFile(base: string): string | null {
  for (const candidate of [
    base,
    ...SOURCE_EXTENSIONS.map((ext) => `${base}${ext}`),
    ...SOURCE_EXTENSIONS.map((ext) => path.join(base, `index${ext}`)),
  ]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/** import の指定 (相対・@/) を、ページのファイルから見たソースのパスにする */
function resolveModule(specifier: string, fromFile: string): string | null {
  if (specifier.startsWith('@/')) return resolveSourceFile(path.join(WEB_SRC, specifier.slice(2)));
  if (specifier.startsWith('.')) return resolveSourceFile(path.resolve(path.dirname(fromFile), specifier));
  return null;
}

/** ページのファイルで、部品の名前を読み込んでいる指定 (静的な import と、next/dynamic の import(...) の両方) */
function importSpecifierOf(name: string, sourceFile: ts.SourceFile): string | null {
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const clause = statement.importClause;
    const bindings = clause?.namedBindings;
    const named = bindings && ts.isNamedImports(bindings) ? bindings.elements.map((element) => element.name.text) : [];
    if (clause?.name?.text === name || named.includes(name)) return statement.moduleSpecifier.text;
  }
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.name.text !== name || !declaration.initializer) continue;
      let specifier: string | null = null;
      const visit = (node: ts.Node) => {
        if (
          ts.isCallExpression(node) &&
          node.expression.kind === ts.SyntaxKind.ImportKeyword &&
          node.arguments[0] &&
          ts.isStringLiteral(node.arguments[0])
        ) {
          specifier = node.arguments[0].text;
          return;
        }
        ts.forEachChild(node, visit);
      };
      visit(declaration.initializer);
      if (specifier) return specifier;
    }
  }
  return null;
}

/** 部品の定義のファイル。import が index (まとめのファイル) を指すときは、同じディレクトリの <名前>.tsx */
function componentFileOf(name: string, pageFile: string): string {
  const specifier = importSpecifierOf(name, parse(read(pageFile), pageFile));
  if (!specifier) throw new Error(`${path.relative(REPO_ROOT, pageFile)} で ${name} の import が見つからない`);
  const resolved = resolveModule(specifier, pageFile);
  if (!resolved) throw new Error(`${name} の import (${specifier}) をファイルにできない`);
  if (/^index\.tsx?$/.test(path.basename(resolved))) {
    const sibling = resolveSourceFile(path.join(path.dirname(resolved), name));
    if (!sibling) throw new Error(`${name} の定義が ${path.relative(REPO_ROOT, path.dirname(resolved))} に見つからない`);
    return sibling;
  }
  return resolved;
}

/** ページが描く、名前が Modal / Dialog の部品 (重複なし) */
function dialogLikeComponentsOf(pageFile: string): string[] {
  const names = jsxElementsIn(parse(read(pageFile), pageFile))
    .map(tagNameOf)
    .filter((name) => DIALOG_LIKE_COMPONENT.test(name));
  return [...new Set(names)].sort();
}

/** `{<条件> && …}` の右側 (条件が真の間だけ出る JSX)。ちょうど 1 つでなければ例外 */
function conditionalJsxOf(sourceFile: ts.SourceFile, condition: string): ts.Expression {
  const found: ts.Expression[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
      ts.isIdentifier(node.left) &&
      node.left.text === condition &&
      jsxElementsIn(node.right).length > 0
    ) {
      found.push(node.right);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  if (found.length !== 1) throw new Error(`{${condition} && <JSX>} が ${found.length} 個 (1 個のはず)`);
  return found[0];
}

/**
 * 部品が描く、同じリポジトリの部品をたどる深さ。モーダルが共通の枠 (src/components/common/BottomSheet.tsx。role="dialog" を持つ)
 * や入力の欄の部品を描くときに、その中の印も数えるため。2 段 (モーダル → 枠 → 枠の中の部品) あれば今の部品は足りる
 */
const COMPONENT_FOLLOW_DEPTH = 2;

/** ファイルが描く、大文字で始まる部品の名前 (重複なし) */
function renderedComponentsOf(sourceFile: ts.SourceFile): string[] {
  const names = jsxElementsIn(sourceFile)
    .map(tagNameOf)
    .filter((name) => /^[A-Z][A-Za-z0-9]*$/.test(name));
  return [...new Set(names)];
}

/**
 * 部品のファイル (とそれが描く同じリポジトリの部品。COMPONENT_FOLLOW_DEPTH 段まで) が、読み込み直しを止める印を持つか。
 * 外のライブラリの部品 (lucide-react など) と、ファイルにできない部品はたどらない
 */
function componentHasBlockingMarker(file: string, depth = COMPONENT_FOLLOW_DEPTH, visited: Set<string> = new Set()): boolean {
  if (visited.has(file)) return false;
  visited.add(file);
  const sourceFile = parse(read(file), file);
  if (hasBlockingMarkerIn(sourceFile)) return true;
  if (depth <= 0) return false;
  return renderedComponentsOf(sourceFile).some((name) => {
    const specifier = importSpecifierOf(name, sourceFile);
    const resolved = specifier ? resolveModule(specifier, file) : null;
    if (!resolved) return false;
    const definition = /^index\.tsx?$/.test(path.basename(resolved))
      ? resolveSourceFile(path.join(path.dirname(resolved), name))
      : resolved;
    return definition ? componentHasBlockingMarker(definition, depth - 1, visited) : false;
  });
}

const pageFileOf = (pathname: string) => path.join(MAIN_PAGES, pathname, 'page.tsx');

describe('/menus/weekly のモーダルは、読み込み直しを止める印を持つ (#2195 V3)', () => {
  const modalFiles = fs
    .readdirSync(WEEKLY_MODALS_DIR)
    .filter((name) => name.endsWith('.tsx'))
    .sort();

  it('モーダルのディレクトリを読めている (走査の場所を間違えて、何も見ずに通ることを防ぐ)', () => {
    expect(modalFiles).toEqual(expect.arrayContaining(['AddMealModal.tsx', 'EditMealModal.tsx', 'ShoppingModal.tsx']));
  });

  it.each(modalFiles.map((name) => [name]))('_components/modals/%s は role="dialog" か入力の部品を持つ', (name) => {
    expect(componentHasBlockingMarker(path.join(WEEKLY_MODALS_DIR, name))).toBe(true);
  });

  it('ページが描く名前が Modal / Dialog の部品は、認めた部品を除いて印を持つ', () => {
    const pageFile = pageFileOf('/menus/weekly');
    const components = dialogLikeComponentsOf(pageFile);
    expect(components).toEqual(expect.arrayContaining(['V4GenerateModal', 'ConfirmDeleteModal', 'CancelGenerationConfirmModal']));
    // 生成の取り消しの確認は、ConfirmDeleteModal → BottomSheet の role="dialog" を持つ (認めた部品の一覧に入れない)
    expect(componentHasBlockingMarker(componentFileOf('CancelGenerationConfirmModal', pageFile))).toBe(true);
    const missing = components
      .filter((name) => !Object.prototype.hasOwnProperty.call(KNOWN_NON_BLOCKING_DIALOGS, name))
      .filter((name) => !componentHasBlockingMarker(componentFileOf(name, pageFile)));
    expect(missing).toEqual([]);
  });

  it('認めた部品は、今もページが描いていて、印を持たない (一覧を古いまま残さない)', () => {
    const pageFile = pageFileOf('/menus/weekly');
    const components = dialogLikeComponentsOf(pageFile);
    for (const name of Object.keys(KNOWN_NON_BLOCKING_DIALOGS)) {
      expect(components).toContain(name);
      expect({ name, marked: componentHasBlockingMarker(componentFileOf(name, pageFile)) }).toEqual({ name, marked: false });
    }
  });
});

describe('ほかの一覧のページが描く名前が Modal / Dialog の部品も印を持つ (#2195 V3)', () => {
  it.each(AI_CONSULTATION_RELOADABLE_PATHS.filter((pathname) => pathname !== '/menus/weekly').map((pathname) => [pathname]))(
    '%s',
    (pathname) => {
      const pageFile = pageFileOf(pathname);
      const missing = dialogLikeComponentsOf(pageFile).filter((name) => !componentHasBlockingMarker(componentFileOf(name, pageFile)));
      expect(missing).toEqual([]);
    },
  );
});

describe('/home の体調のチェックインの欄は入力の部品を持つ (#2195 V3)', () => {
  it('showCheckin の間だけ出る欄に、hidden でない入力の部品がある', () => {
    const block = conditionalJsxOf(parse(read(pageFileOf('/home'))), 'showCheckin');
    expect(jsxElementsIn(block).some(isInputMarker)).toBe(true);
  });
});

describe('/profile の編集のモーダルは、ページごとに足した要素に当たる層で始まる (#2195 V3)', () => {
  const PROFILE_SELECTOR = AI_CONSULTATION_RELOAD_PAGE_BLOCKING_SELECTORS['/profile'];
  /** `.a.b` の形のセレクタのクラス名 (この検査は、クラスだけのセレクタを扱う) */
  const classesOf = (selector: string) => selector.split('.').filter(Boolean);
  /** 要素の className (文字列か、テンプレート文字列の最初の固定の部分) が、クラスを全部持つか */
  const hasAllClasses = (element: JsxElementLike, classes: readonly string[]) => {
    const className = attributeValueOf(element, 'className');
    if (typeof className !== 'string') return false;
    const tokens = className.split(/\s+/);
    return classes.every((name) => tokens.includes(name));
  };

  it('ページごとに足す要素はクラスだけのセレクタ', () => {
    expect(PROFILE_SELECTOR).toMatch(/^(?:\.[A-Za-z0-9_-]+)+$/);
  });

  it('isEditing の間だけ出る塊の最初の要素が、ページごとに足した要素に当たる', () => {
    const block = conditionalJsxOf(parse(read(pageFileOf('/profile'))), 'isEditing');
    const elements = jsxElementsIn(block).filter((element) => !DIALOG_LIKE_COMPONENT.test(tagNameOf(element)));
    const first = elements.find((element) => attributeValueOf(element, 'className') !== undefined);
    expect(first).toBeDefined();
    expect(first ? hasAllClasses(first, classesOf(PROFILE_SELECTOR)) : false).toBe(true);
  });

  it('編集のモーダルの外 (ページの本体) には、同じ要素に当たる要素が無い (あるとマイページが読み込み直されない)', () => {
    const sourceFile = parse(read(pageFileOf('/profile')));
    const inside = new Set(jsxElementsIn(conditionalJsxOf(sourceFile, 'isEditing')));
    const hits = jsxElementsIn(sourceFile)
      .filter((element) => !inside.has(element))
      .filter((element) => hasAllClasses(element, classesOf(PROFILE_SELECTOR)))
      .map((element) => element.getText().slice(0, 80));
    expect(hits).toEqual([]);
  });

  it('判定は、両方のクラスを持つときだけ当たる (見張りの自己検査)', () => {
    const classes = classesOf('.fixed.inset-0');
    const elements = jsxElementsIn(
      parse(
        '<>' +
          '<div className="fixed inset-0 z-[60] flex" />' +
          '<div className="fixed bottom-0" />' +
          '<div className="absolute inset-0" />' +
          '<div className={`fixed inset-0 ${open ? "a" : "b"}`} />' +
          '</>',
      ),
    ).filter((element) => tagNameOf(element) === 'div');
    expect(elements.map((element) => hasAllClasses(element, classes))).toEqual([true, false, false, true]);
  });
});

describe('部品をたどる判定 (見張りの自己検査)', () => {
  it('共通の枠 (BottomSheet) を描くだけのモーダルは、枠の role="dialog" で印を持つ', () => {
    const bottomSheet = resolveSourceFile(path.join(WEB_SRC, 'components/common/BottomSheet'));
    expect(bottomSheet).not.toBeNull();
    expect(hasBlockingMarker(read(bottomSheet ?? ''))).toBe(true);
    const improve = path.join(WEEKLY_MODALS_DIR, 'ImproveMealModal.tsx');
    expect(hasBlockingMarker(read(improve))).toBe(false);
    expect(componentHasBlockingMarker(improve)).toBe(true);
    expect(componentHasBlockingMarker(improve, 0)).toBe(false);
  });
});

describe('印の判定 (見張りの自己検査)', () => {
  it.each([
    ['role="dialog"', '<div role="dialog" />', true],
    ['aria-modal', '<div aria-modal="true" />', true],
    ['aria-modal={false} だけ', '<div aria-modal={false} />', false],
    ['<dialog>', '<dialog open />', true],
    ['入力', '<textarea value={x} />', true],
    ['部品の Input', '<Input value={x} />', true],
    ['type が式の input', '<input type={kind} />', true],
    ['hidden の input だけ', '<input type="hidden" name="x" />', false],
    ['ボタンだけ', '<div className="fixed inset-0"><button>はい</button></div>', false],
    ['コメントの中の語だけ', '// role="dialog" を足すこと\nconst a = <div><button /></div>;', false],
    ['文字列の中の /* (accept="image/*") の後ろの role="dialog"', '<><input type="hidden" accept="image/*" /><div role="dialog" /></>', true],
  ])('%s', (_label, source, expected) => {
    expect(hasBlockingMarker(source)).toBe(expected);
  });
});
