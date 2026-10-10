/**
 * T15 (#1154) アプリ (apps/mobile): モーダルの上に開く部品は、「同意が必要です」の案内を自分で出さない — contract テスト
 *
 * アプリの同意画面は画面の遷移 (router.push) で開くので、RN の Modal が開いたままだと、同意画面はその下に隠れる。
 * 案内を出す部品が自分のモーダルだけを閉じて案内を出すと、その部品を開いた側 (下のシート・モーダル) が開いたまま残り、
 * 案内の「同意画面を開く」で移った同意画面が見えない。R4 で、AI 相談のシート (AIAdvisorSheet) の上に開く
 * 1日献立の作成 (AIDayMenuModal) がこの形だった。同じ形が、手動編集 (ManualEditModal) の上の写真の解析 (PhotoEditModal) と、
 * 栄養分析の詳細 (NutritionDetailModal) の中の献立の改善 (ImproveMealModal) にもあった。
 *
 * 規則 (apps/mobile/src/lib/ai-consent.ts の先頭の説明): モーダルを描く部品の中に置かれた部品は、自分で案内を出さず、
 * 自分を閉じてから、開いた側から受け取った onAiConsentRequired を呼ぶ。開いた側が、自分も閉じて (または
 * 「同意画面を開く」を押したときに閉じるようにして) 案内を出す。
 *
 * このテストは apps/mobile の app と src を構文木で読み (コメントは見ない)、次を確かめる。
 *   1. 部品 (いちばん外側の関数) ごとに、<Modal> を描くか・描く部品 (大文字で始まる JSX) は何か・自分で案内を出すかを集める。
 *      「自分で案内を出す」= promptAiConsentRequired / handleAiConsentRequiredError / handleStoredAiConsentFailure を呼ぶ、
 *      onAiConsentRequired を渡さずに useV4MenuGeneration を呼ぶ (渡さないとフックが自分で案内を出す)、
 *      または自分で案内を出すフック (use で始まる関数) を呼ぶ
 *   2. <Modal> を描く部品の中に、自分で案内を出す部品を置いていない
 *   3. 自分の <Modal> を props の visible で開く部品 (シート・モーダル) の上に重ねたモーダルは、親の <Modal> の中に置くか、
 *      visible={visible && …} で親と一緒に閉じる。週の画面は「同意画面を開く」を押したときに画面のモーダルをすべて閉じる
 *      (closeAllModals) が、閉じるのは週の画面が持つモーダルだけなので、その上に重ねたモーダルが残ると同意画面を隠す
 *   4. 走査が空振りしていない (いまの入れ子の組と、自分で案内を出す部品を見つけている)
 *   5. 検査そのものが、R4 の不具合の形を見つける
 * 挙動 (シート・モーダルを閉じてから案内を出す) は、apps/mobile/__tests__ の advisor-sheet-consent・manual-edit-photo-consent・
 * improve-consent の jest のテストが、重ねたモーダルが親と一緒に閉じることは stacked-modals-close-with-parent が確かめる。
 */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const MOBILE_SOURCE_DIRS = ['apps/mobile/app', 'apps/mobile/src'];

/** 呼ぶと自分で「同意が必要です」の案内を出す関数 (apps/mobile/src/lib/ai-consent.ts) */
const PROMPTERS = ['promptAiConsentRequired', 'handleAiConsentRequiredError', 'handleStoredAiConsentFailure'];

/** onAiConsentRequired を渡さないと、自分で案内を出すフック (apps/mobile/src/hooks/useV4MenuGeneration.ts) */
const HOOKS_PROMPTING_BY_DEFAULT = ['useV4MenuGeneration'];

const MODAL_TAG = 'Modal';

function listSources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '__tests__' || entry.name.startsWith('.')) continue;
      out.push(...listSources(rel));
    } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.d\.ts$/.test(entry.name)) {
      out.push(rel);
    }
  }
  return out;
}

function parseText(file: string, text: string): ts.SourceFile {
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
}

function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}

/** ファイルのいちばん外側の関数 (function X / const X = () => / const X = function) を、名前と本体の組で返す */
function topLevelFunctions(sf: ts.SourceFile): Array<{ name: string; body: ts.Node }> {
  const out: Array<{ name: string; body: ts.Node }> = [];
  for (const statement of sf.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) out.push({ name: statement.name.text, body: statement });
    if (ts.isVariableStatement(statement)) {
      for (const decl of statement.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name) || !decl.initializer) continue;
        if (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer)) {
          out.push({ name: decl.name.text, body: decl.initializer });
        }
      }
    }
  }
  return out;
}

function jsxTagName(node: ts.Node): string | null {
  if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
    return ts.isIdentifier(node.tagName) ? node.tagName.text : null;
  }
  return null;
}

function visibleAttribute(node: ts.JsxOpeningElement | ts.JsxSelfClosingElement): ts.Expression | undefined {
  for (const attr of node.attributes.properties) {
    if (ts.isJsxAttribute(attr) && attr.name.getText() === 'visible' && attr.initializer && ts.isJsxExpression(attr.initializer)) {
      return attr.initializer.expression;
    }
  }
  return undefined;
}

function unparen(expr: ts.Expression): ts.Expression {
  return ts.isParenthesizedExpression(expr) ? unparen(expr.expression) : expr;
}

function isIdentifierNamed(expr: ts.Expression | undefined, name: string): boolean {
  return expr !== undefined && ts.isIdentifier(unparen(expr)) && (unparen(expr) as ts.Identifier).text === name;
}

/** visible={visible && …} か */
function followsParentVisible(expr: ts.Expression | undefined): boolean {
  if (!expr) return false;
  const e = unparen(expr);
  return ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken && isIdentifierNamed(e.left, 'visible');
}

/** node が、stop までの間で <Modal>…</Modal> の中にあるか */
function isInsideModalElement(node: ts.Node, stop: ts.Node): boolean {
  for (let cur: ts.Node | undefined = node.parent; cur && cur !== stop; cur = cur.parent) {
    if (ts.isJsxElement(cur) && jsxTagName(cur.openingElement) === MODAL_TAG) return true;
  }
  return false;
}

function calleeName(node: ts.CallExpression): string | null {
  return ts.isIdentifier(node.expression) ? node.expression.text : null;
}

/** useV4MenuGeneration(...) の呼び出しが、onAiConsentRequired を渡していない (= フックが自分で案内を出す) か */
function hookPromptsByDefault(call: ts.CallExpression): boolean {
  const arg = call.arguments[0];
  if (!arg) return true;
  if (!ts.isObjectLiteralExpression(arg)) return false; // 変数で渡す形は読めないので、数えない (いまは無い)
  return !arg.properties.some(
    (p) => (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p) || ts.isMethodDeclaration(p)) &&
      p.name !== undefined && ts.isIdentifier(p.name) && p.name.text === 'onAiConsentRequired',
  );
}

/** 部品の中に置いた、大文字で始まる部品の JSX 1 つ */
interface ChildElement {
  tag: string;
  /** 親の <Modal>…</Modal> の中にある (親が閉じると一緒に消える) */
  insideModal: boolean;
  /** visible={…} が「visible && …」(親の visible と一緒に閉じる) */
  visibleFollowsParent: boolean;
}

interface ComponentInfo {
  file: string;
  name: string;
  rendersModal: boolean;
  /** 自分の <Modal> を props の visible で開く (<Modal visible={visible}>) */
  modalVisibleFromProp: boolean;
  children: Set<string>;
  childElements: ChildElement[];
  /** 自分で案内を出す (直接の呼び出し。フック経由は下で足す) */
  promptsDirectly: boolean;
  /** 呼んでいるフック (use で始まる関数) */
  hooks: Set<string>;
}

function collectComponents(files: Array<{ file: string; text: string }>): ComponentInfo[] {
  const out: ComponentInfo[] = [];
  for (const { file, text } of files) {
    const sf = parseText(file, text);
    for (const { name, body } of topLevelFunctions(sf)) {
      const info: ComponentInfo = {
        file,
        name,
        rendersModal: false,
        modalVisibleFromProp: false,
        children: new Set(),
        childElements: [],
        promptsDirectly: false,
        hooks: new Set(),
      };
      walk(body, (node) => {
        const tag = jsxTagName(node);
        if (tag === MODAL_TAG) {
          info.rendersModal = true;
          if (isIdentifierNamed(visibleAttribute(node as ts.JsxOpeningElement | ts.JsxSelfClosingElement), 'visible')) {
            info.modalVisibleFromProp = true;
          }
        } else if (tag && /^[A-Z]/.test(tag)) {
          info.children.add(tag);
          info.childElements.push({
            tag,
            insideModal: isInsideModalElement(node, body),
            visibleFollowsParent: followsParentVisible(visibleAttribute(node as ts.JsxOpeningElement | ts.JsxSelfClosingElement)),
          });
        }
        if (ts.isCallExpression(node)) {
          const callee = calleeName(node);
          if (!callee) return;
          if (PROMPTERS.includes(callee)) info.promptsDirectly = true;
          if (HOOKS_PROMPTING_BY_DEFAULT.includes(callee) && hookPromptsByDefault(node)) info.promptsDirectly = true;
          if (/^use[A-Z]/.test(callee)) info.hooks.add(callee);
        }
      });
      out.push(info);
    }
  }
  return out;
}

/** 自分で案内を出す部品・フックの名前 (自分で案内を出すフックを呼ぶ関数も含める。呼び出しの鎖をたどる) */
function promptingNames(components: ComponentInfo[]): Set<string> {
  const prompting = new Set(components.filter((c) => c.promptsDirectly).map((c) => c.name));
  for (let changed = true; changed; ) {
    changed = false;
    for (const c of components) {
      if (prompting.has(c.name)) continue;
      if ([...c.hooks].some((h) => !HOOKS_PROMPTING_BY_DEFAULT.includes(h) && prompting.has(h))) {
        prompting.add(c.name);
        changed = true;
      }
    }
  }
  return prompting;
}

/** <Modal> を描く部品の中に置いた、自分で案内を出す部品 (親 → 子) */
function nestedPrompters(components: ComponentInfo[]): string[] {
  const prompting = promptingNames(components);
  const out: string[] = [];
  for (const parent of components) {
    if (!parent.rendersModal) continue;
    for (const child of parent.children) {
      if (prompting.has(child)) out.push(`${parent.file}: ${parent.name} → ${child}`);
    }
  }
  return out.sort();
}

/** props の visible で開くモーダルの上に重ねたモーダルのうち、親と一緒に閉じないもの (親 → 子) */
function stackedModalsLeftOpen(components: ComponentInfo[]): string[] {
  const rendersModal = new Set(components.filter((c) => c.rendersModal).map((c) => c.name));
  const out: string[] = [];
  for (const parent of components) {
    if (!parent.modalVisibleFromProp) continue;
    for (const child of parent.childElements) {
      if (!rendersModal.has(child.tag)) continue;
      if (child.insideModal || child.visibleFollowsParent) continue;
      out.push(`${parent.file}: ${parent.name} → ${child.tag}`);
    }
  }
  return out.sort();
}

function mobileComponents(): ComponentInfo[] {
  const files = MOBILE_SOURCE_DIRS.flatMap(listSources).map((file) => ({ file, text: fs.readFileSync(path.join(ROOT, file), 'utf8') }));
  return collectComponents(files);
}

describe('モーダルの上に開く部品は、「同意が必要です」の案内を自分で出さない (開いた側が閉じてから出す)', () => {
  const components = mobileComponents();

  it('走査が空振りしていない: いまの入れ子 (モーダルの中に置いたモーダル) の 3 組と、自分で案内を出す部品を見つけている', () => {
    const byName = new Map(components.map((c) => [c.name, c]));
    const modalNesting = components
      .filter((parent) => parent.rendersModal)
      .flatMap((parent) => [...parent.children].filter((child) => byName.get(child)?.rendersModal).map((child) => `${parent.name} → ${child}`));
    expect(modalNesting).toEqual(
      expect.arrayContaining(['AIAdvisorSheet → AIDayMenuModal', 'ManualEditModal → PhotoEditModal', 'NutritionDetailModal → ImproveMealModal']),
    );
    const prompting = promptingNames(components);
    for (const name of ['AIAdvisorSheet', 'ManualEditModal', 'NutritionDetailModal', 'RegenerateMealModal', 'useHomeData']) {
      expect(prompting.has(name), name).toBe(true);
    }
  });

  it('<Modal> を描く部品の中に、自分で案内を出す部品を置いていない', () => {
    // 置くと、その部品が自分だけを閉じて案内を出したとき、下に開いたままのモーダルが同意画面を隠す。
    // 子には onAiConsentRequired を渡し、子は自分を閉じてからそれを呼ぶ (案内は開いた側が出す)
    expect(nestedPrompters(components)).toEqual([]);
  });

  it('props の visible で開くモーダルの上に重ねたモーダルは、親の <Modal> の中に置くか、visible={visible && …} で親と一緒に閉じる', () => {
    // 空振りしていない: 親の <Modal> の外に重ねたモーダル (AI 相談の 1日献立・手動編集の写真・買い物リストと冷蔵庫の追加) を見つけている
    const siblings = components
      .filter((c) => c.modalVisibleFromProp)
      .flatMap((c) => c.childElements.filter((e) => !e.insideModal && e.visibleFollowsParent).map((e) => `${c.name} → ${e.tag}`));
    expect(siblings).toEqual(
      expect.arrayContaining([
        'AIAdvisorSheet → AIDayMenuModal',
        'ManualEditModal → PhotoEditModal',
        'ShoppingListModal → AddShoppingModal',
        'PantryModal → AddFridgeModal',
      ]),
    );
    expect(stackedModalsLeftOpen(components)).toEqual([]);
  });

  it('検査そのものの確かめ: 親と一緒に閉じない重ね方を見つけ、親の <Modal> の中・visible && … は通す', () => {
    const example = (text: string) => collectComponents([{ file: 'example.tsx', text }]);
    const found = stackedModalsLeftOpen(
      example(`
        export const Child = ({ visible }) => <Modal visible={visible} />;
        export const LeftOpen = ({ visible }) => (<><Modal visible={visible} /><Child visible={addVisible} /></>);
        export const Follows = ({ visible }) => (<><Modal visible={visible} /><Child visible={visible && addVisible} /></>);
        export const Inside = ({ visible }) => (<Modal visible={visible}><Child visible={addVisible} /></Modal>);
        export const Page = () => (<><Modal visible={open} /><Child visible={addVisible} /></>);
      `),
    );
    expect(found).toEqual(['example.tsx: LeftOpen → Child']);
  });

  it('検査そのものの確かめ: R4 の不具合の形 (シートの上の部品が自分で案内を出す) と、フック経由・既定の案内を見つける', () => {
    const example = (text: string) => collectComponents([{ file: 'example.tsx', text }]);
    // R4 の形: シート (Modal を描く) の上に置いた 1日献立の部品が、自分を閉じて自分で案内を出す
    const r4 = example(`
      export const Sheet = () => (<><Modal visible /><DayMenu onClose={() => {}} /></>);
      export const DayMenu = ({ onClose }) => {
        useV4MenuGeneration({ onAiConsentRequired: () => { onClose(); promptAiConsentRequired(); } });
        return <Modal visible />;
      };
    `);
    expect(nestedPrompters(r4)).toEqual(['example.tsx: Sheet → DayMenu']);
    // 直した形: 子は受け取った onAiConsentRequired を呼ぶだけ。案内はシートが出す (シートを置いた側はモーダルを描かない)
    const fixed = example(`
      export const Fab = () => <Sheet />;
      export const Sheet = () => (<><Modal visible /><DayMenu onAiConsentRequired={() => promptAiConsentRequired()} /></>);
      export const DayMenu = ({ onClose, onAiConsentRequired }) => {
        useV4MenuGeneration({ onAiConsentRequired: () => { onClose(); onAiConsentRequired(); } });
        return <Modal visible />;
      };
    `);
    expect(nestedPrompters(fixed)).toEqual([]);
    // onAiConsentRequired を渡さずに生成のフックを使う (フックが自分で案内を出す) 子も見つける
    const byDefault = example(`
      function Parent() { return (<><Modal visible /><Child /></>); }
      function Child() { useV4MenuGeneration({ onError: () => {} }); return null; }
    `);
    expect(nestedPrompters(byDefault)).toEqual(['example.tsx: Parent → Child']);
    // 自分で案内を出すフックを呼ぶ子も見つける
    const viaHook = example(`
      function Parent() { return (<><Modal visible /><Child /></>); }
      function Child() { useThing(); return null; }
      function useThing() { return () => handleAiConsentRequiredError(new Error('x')); }
    `);
    expect(nestedPrompters(viaHook)).toEqual(['example.tsx: Parent → Child']);
  });
});
