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
 *   6. 画面そのものがモーダルのとき: Stack.Screen の presentation が card 以外 (modal など) の画面は、iOS では、
 *      そこから push した同意画面がその画面の下に隠れる (R5 の指摘: 食事の新規作成 meals/new)。その画面のファイルの中で出す案内は
 *      すべて、beforeOpenConsentScreen に useLeaveModalRouteBeforeConsentScreen() の戻り値 (画面を閉じる関数) を渡す。
 *      自分で案内を出す部品・フックを、その画面に置かない (置くと、その部品は画面を閉じずに案内を出す)
 * 挙動 (シート・モーダルを閉じてから案内を出す) は、apps/mobile/__tests__ の advisor-sheet-consent・manual-edit-photo-consent・
 * improve-consent の jest のテストが、重ねたモーダルが親と一緒に閉じることは stacked-modals-close-with-parent が、
 * modal で開く画面 (meals/new) が自分を閉じてから同意画面へ移ることは meals/new-consent が確かめる。
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

/**
 * 同意画面のパス (apps/mobile/src/lib/ai-consent.ts の AI_CONSENT_SCREEN_PATH)。案内を通さずに同意画面へ直接移る部品
 * (AI の分析を省いた旨の表示 AiSkippedNotice の「同意画面を開く」など) も、モーダルの中に置くと同意画面を隠すので、
 * 「自分で案内を出す」と同じに数える
 */
const CONSENT_SCREEN_PATH_CONSTANT = 'AI_CONSENT_SCREEN_PATH';
const CONSENT_SCREEN_PATH = '/settings/ai-consent';
/** 画面を移る router のメソッド (expo-router の router.push / navigate / replace) */
const ROUTER_MOVES = ['push', 'navigate', 'replace'];

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

function isConsentScreenTarget(expr: ts.Expression | undefined): boolean {
  if (!expr) return false;
  const e = unparen(expr);
  return isIdentifierNamed(e, CONSENT_SCREEN_PATH_CONSTANT) || (ts.isStringLiteralLike(e) && e.text === CONSENT_SCREEN_PATH);
}

/** 同意画面へ直接移る: router.push(AI_CONSENT_SCREEN_PATH) など、または <Link href={AI_CONSENT_SCREEN_PATH}> */
function opensConsentScreenDirectly(node: ts.Node): boolean {
  if (ts.isCallExpression(node)) {
    return ts.isPropertyAccessExpression(node.expression) && ROUTER_MOVES.includes(node.expression.name.text) && isConsentScreenTarget(node.arguments[0]);
  }
  if (ts.isJsxAttribute(node) && node.name.getText() === 'href' && node.initializer) {
    const init = node.initializer;
    if (ts.isStringLiteral(init)) return init.text === CONSENT_SCREEN_PATH;
    return ts.isJsxExpression(init) && isConsentScreenTarget(init.expression);
  }
  return false;
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
  /** 自分で案内を出す、または同意画面へ直接移る (直接の呼び出し。フック経由は下で足す) */
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
        if (opensConsentScreenDirectly(node)) info.promptsDirectly = true;
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
    // AiSkippedNotice は案内を通さずに同意画面へ直接移る (router.push(AI_CONSENT_SCREEN_PATH))
    for (const name of ['AIAdvisorSheet', 'ManualEditModal', 'NutritionDetailModal', 'RegenerateMealModal', 'useHomeData', 'AiSkippedNotice']) {
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
    // 案内を通さずに同意画面へ直接移る子 (AiSkippedNotice の形・<Link href>) も見つける
    const direct = example(`
      function Parent() { return (<><Modal visible /><Notice /><Linker /></>); }
      function Notice() { return <Button onPress={() => router.push(AI_CONSENT_SCREEN_PATH)} />; }
      function Linker() { return <Link href="/settings/ai-consent" />; }
    `);
    expect(nestedPrompters(direct)).toEqual(['example.tsx: Parent → Linker', 'example.tsx: Parent → Notice']);
  });
});

// ─────────────────────────────────────────────
// 6. 画面そのものがモーダル (Stack.Screen の presentation が card 以外) のとき
// ─────────────────────────────────────────────

const APP_DIR = 'apps/mobile/app';

/**
 * ネイティブのスタックで push として積む presentation (指定しないときも card)。これ以外 (modal / fullScreenModal / formSheet /
 * transparentModal / containedModal など) は、iOS の react-native-screens が modal として重ねる。そのあとに push した画面は
 * modal の下 (push の積み重ね) に入る (node_modules/react-native-screens/ios/RNSScreenStack.mm の updateContainer)
 */
const PUSH_PRESENTATIONS = ['card'];

/** modal で開く画面が、案内の beforeOpenConsentScreen に渡す関数を作るフック (apps/mobile/src/lib/ai-consent.ts) */
const LEAVE_MODAL_ROUTE_HOOK = 'useLeaveModalRouteBeforeConsentScreen';

const STACK_SCREEN_TAG = 'Stack.Screen';
const STACK_TAG = 'Stack';
const LAYOUT_FILE = /(^|\/)_layout\.tsx?$/;
const ROUTE_FILE_SUFFIXES = ['.tsx', '.ts', '/index.tsx', '/index.ts'];

/** modal で開く画面 1 つ (どのレイアウトの、どの名前の画面か) */
interface ModalRoute {
  /** presentation を指定したファイル */
  declaredIn: string;
  /** Stack.Screen の name (画面のファイルの中で自分に指定したときは null) */
  name: string | null;
  presentation: string;
  /** その画面のファイル (グループのレイアウトなら、その下の全ファイル) */
  files: string[];
}

function jsxTagText(node: ts.Node): string | null {
  if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) return node.tagName.getText();
  return null;
}

function jsxAttribute(node: ts.JsxOpeningElement | ts.JsxSelfClosingElement, name: string): ts.JsxAttribute | undefined {
  return node.attributes.properties.find((p): p is ts.JsxAttribute => ts.isJsxAttribute(p) && p.name.getText() === name);
}

/** 属性の値が文字列ならその文字列 (name="x" / name={"x"})。それ以外は null */
function stringAttribute(attr: ts.JsxAttribute | undefined): string | null {
  const init = attr?.initializer;
  if (!init) return null;
  if (ts.isStringLiteral(init)) return init.text;
  if (ts.isJsxExpression(init) && init.expression && ts.isStringLiteralLike(init.expression)) return init.expression.text;
  return null;
}

function propertyNamed(obj: ts.ObjectLiteralExpression, name: string): ts.ObjectLiteralElementLike | undefined {
  return obj.properties.find((p) => p.name !== undefined && ts.isIdentifier(p.name) && p.name.text === name);
}

/**
 * options={{ presentation: "…" }} / screenOptions={{ … }} から presentation を読む。
 * 指定なしは card。読めない形 (変数・関数・文字列でない値) は null (検査が見落とさないよう、呼び出し側で失敗にする)
 */
function presentationOf(attr: ts.JsxAttribute | undefined): string | null {
  if (!attr) return 'card';
  const init = attr.initializer;
  if (!init || !ts.isJsxExpression(init) || !init.expression) return null;
  const expr = unparen(init.expression);
  if (!ts.isObjectLiteralExpression(expr)) return null;
  const prop = propertyNamed(expr, 'presentation');
  // { ...共通の設定 } は中に presentation があるかを読めない
  if (!prop) return expr.properties.some(ts.isSpreadAssignment) ? null : 'card';
  if (ts.isPropertyAssignment(prop) && ts.isStringLiteralLike(prop.initializer)) return prop.initializer.text;
  return null;
}

/** 画面の名前 → ファイル。グループ (そのフォルダに _layout がある) なら、その下の全ファイル */
function routeFiles(dir: string, name: string, exists: (file: string) => boolean, listUnder: (dir: string) => string[]): string[] {
  const base = `${dir}/${name}`;
  if (exists(`${base}/_layout.tsx`) || exists(`${base}/_layout.ts`)) return listUnder(base);
  return ROUTE_FILE_SUFFIXES.map((suffix) => `${base}${suffix}`).filter(exists);
}

function collectModalRoutes(
  files: Array<{ file: string; text: string }>,
  exists: (file: string) => boolean,
  listUnder: (dir: string) => string[],
): { routes: ModalRoute[]; unreadable: string[] } {
  const routes: ModalRoute[] = [];
  const unreadable: string[] = [];
  for (const { file, text } of files) {
    const sf = parseText(file, text);
    const isLayout = LAYOUT_FILE.test(file);
    const dir = path.posix.dirname(file);
    walk(sf, (node) => {
      const tag = jsxTagText(node);
      if (tag !== STACK_SCREEN_TAG && tag !== STACK_TAG) return;
      const element = node as ts.JsxOpeningElement | ts.JsxSelfClosingElement;
      const attrName = tag === STACK_TAG ? 'screenOptions' : 'options';
      const presentation = presentationOf(jsxAttribute(element, attrName));
      const where = `${file}: <${tag} ${attrName}>`;
      if (presentation === null) {
        unreadable.push(`${where} の presentation を読めない`);
        return;
      }
      if (PUSH_PRESENTATIONS.includes(presentation)) return;
      if (tag === STACK_TAG) {
        // 画面すべてを modal で開く書き方。この検査は画面ごとの指定 (Stack.Screen) だけを読むので、広げてから使うこと
        unreadable.push(`${where} で全画面を ${presentation} にしている (検査が未対応)`);
        return;
      }
      const name = stringAttribute(jsxAttribute(element, 'name'));
      if (!isLayout) {
        // 画面のファイルの中で自分に指定した (<Stack.Screen options={{ presentation }} />)
        routes.push({ declaredIn: file, name, presentation, files: [file] });
        return;
      }
      if (name === null) {
        unreadable.push(`${where} の name を読めない`);
        return;
      }
      const targets = routeFiles(dir, name, exists, listUnder);
      if (targets.length === 0) unreadable.push(`${where}: ${name} の画面のファイルが見つからない`);
      routes.push({ declaredIn: file, name, presentation, files: targets });
    });
  }
  return { routes, unreadable: unreadable.sort() };
}

/** node を含む、名前のあるいちばん内側の関数の名前 (function f / const f = () => / const f = function) */
function ownerName(node: ts.Node): string {
  for (let cur: ts.Node | undefined = node.parent; cur; cur = cur.parent) {
    if (ts.isFunctionDeclaration(cur) && cur.name) return cur.name.text;
    if ((ts.isArrowFunction(cur) || ts.isFunctionExpression(cur)) && ts.isVariableDeclaration(cur.parent) && ts.isIdentifier(cur.parent.name)) {
      return cur.parent.name.text;
    }
  }
  return '(ファイル直下)';
}

/**
 * modal で開く画面のファイルの中の、案内を出す場所を調べる。
 *   - checked: 調べた案内の呼び出し (ファイル::それを含む関数の名前::呼んだ関数)
 *   - violations: 画面を閉じずに案内を出す場所
 * 「画面を閉じる」= beforeOpenConsentScreen の値が、useLeaveModalRouteBeforeConsentScreen() の戻り値を入れた変数か、それを呼ぶ関数
 */
function modalRoutePromptViolations(file: string, text: string, prompting: Set<string>): { checked: string[]; violations: string[] } {
  const sf = parseText(file, text);
  const leaveFns = new Set<string>();
  walk(sf, (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isCallExpression(node.initializer) &&
      calleeName(node.initializer) === LEAVE_MODAL_ROUTE_HOOK
    ) {
      leaveFns.add(node.name.text);
    }
  });
  const callsLeave = (body: ts.Node): boolean => {
    let found = false;
    walk(body, (n) => {
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && leaveFns.has(n.expression.text)) found = true;
    });
    return found;
  };
  const leaves = (expr: ts.Expression): boolean => {
    const e = unparen(expr);
    if (ts.isIdentifier(e)) return leaveFns.has(e.text);
    if (ts.isArrowFunction(e) || ts.isFunctionExpression(e)) return callsLeave(e.body);
    return false;
  };
  const hasLeaveOption = (arg: ts.Expression | undefined): boolean => {
    if (!arg) return false;
    const e = unparen(arg);
    if (!ts.isObjectLiteralExpression(e)) return false;
    const prop = propertyNamed(e, 'beforeOpenConsentScreen');
    if (!prop) return false;
    if (ts.isShorthandPropertyAssignment(prop)) return leaveFns.has(prop.name.text);
    if (ts.isPropertyAssignment(prop)) return leaves(prop.initializer);
    if (ts.isMethodDeclaration(prop)) return prop.body !== undefined && callsLeave(prop.body);
    return false;
  };

  const checked: string[] = [];
  const violations: string[] = [];
  walk(sf, (node) => {
    const line = sf.getLineAndCharacterOfPosition(node.getStart()).line + 1;
    const tag = jsxTagName(node);
    if (tag && /^[A-Z]/.test(tag) && prompting.has(tag)) {
      violations.push(`${file}:${line} <${tag}> (自分で案内を出す部品)`);
    }
    if (opensConsentScreenDirectly(node)) {
      // 案内を通さずに移ると、画面を閉じる機会が無い。案内 (beforeOpenConsentScreen で画面を閉じる) を使う
      violations.push(`${file}:${line} 同意画面へ直接移る`);
      return;
    }
    if (!ts.isCallExpression(node)) return;
    const callee = calleeName(node);
    if (!callee) return;
    if (HOOKS_PROMPTING_BY_DEFAULT.includes(callee)) {
      if (hookPromptsByDefault(node)) violations.push(`${file}:${line} ${callee} (onAiConsentRequired を渡していない)`);
      return;
    }
    if (/^use[A-Z]/.test(callee) && prompting.has(callee)) {
      violations.push(`${file}:${line} ${callee} (自分で案内を出すフック)`);
      return;
    }
    if (!PROMPTERS.includes(callee)) return;
    checked.push(`${file}::${ownerName(node)}::${callee}`);
    let ok: boolean;
    if (callee === 'promptAiConsentRequired') ok = hasLeaveOption(node.arguments[0]);
    else if (callee === 'handleAiConsentRequiredError') ok = hasLeaveOption(node.arguments[1]);
    else {
      // handleStoredAiConsentFailure(stored, prompt): 既定 (promptAiConsentRequired そのもの) では画面を閉じない。
      // 渡した prompt の中の promptAiConsentRequired の呼び出しは、それ自体をこの検査が見る
      const prompt = node.arguments[1];
      ok = prompt !== undefined && !isIdentifierNamed(prompt, 'promptAiConsentRequired');
    }
    if (!ok) violations.push(`${file}:${line} ${callee} (beforeOpenConsentScreen で画面を閉じていない)`);
  });
  return { checked: checked.sort(), violations: violations.sort() };
}

function mobileModalRoutes(): { routes: ModalRoute[]; unreadable: string[] } {
  const appFiles = listSources(APP_DIR).map((file) => ({ file, text: fs.readFileSync(path.join(ROOT, file), 'utf8') }));
  return collectModalRoutes(
    appFiles,
    (file) => fs.existsSync(path.join(ROOT, file)),
    (dir) => listSources(dir),
  );
}

describe('画面そのものが modal (Stack.Screen の presentation が card 以外) なら、その画面で出す案内は画面を閉じてから同意画面へ移る', () => {
  const components = mobileComponents();
  const prompting = promptingNames(components);
  const { routes, unreadable } = mobileModalRoutes();

  it('走査が空振りしていない: 食事の新規作成 (meals/new) を modal で開く画面として見つけ、5 つの解析の経路の案内を調べている', () => {
    expect(unreadable).toEqual([]);
    const mealsNew = routes.find((r) => r.name === 'meals/new');
    expect(mealsNew).toEqual({
      declaredIn: 'apps/mobile/app/_layout.tsx',
      name: 'meals/new',
      presentation: 'modal',
      files: ['apps/mobile/app/meals/new.tsx'],
    });
    const file = 'apps/mobile/app/meals/new.tsx';
    const { checked } = modalRoutePromptViolations(file, fs.readFileSync(path.join(ROOT, file), 'utf8'), prompting);
    expect(checked).toEqual(
      expect.arrayContaining(
        ['analyzeByMode', 'analyzeFridge', 'analyzeHealthCheckup', 'analyzeMealPhoto', 'analyzeWeightScale'].map(
          (fn) => `${file}::${fn}::handleAiConsentRequiredError`,
        ),
      ),
    );
  });

  it('modal で開く画面のファイルの中で、画面を閉じずに案内を出す場所が無い', () => {
    const violations = routes.flatMap((route) =>
      route.files.flatMap((file) => modalRoutePromptViolations(file, fs.readFileSync(path.join(ROOT, file), 'utf8'), prompting).violations),
    );
    expect(violations).toEqual([]);
  });

  it('検査そのものの確かめ: レイアウトの presentation を読み、card・指定なし以外を modal の画面として数える。読めない形は失敗にする', () => {
    const layout = `
      export default function Layout() {
        return (
          <Stack screenOptions={{ headerShown: false }}>
            <Stack.Screen name="index" />
            <Stack.Screen name="card" options={{ presentation: "card" }} />
            <Stack.Screen name="sheet" options={{ presentation: "formSheet" }} />
            <Stack.Screen name="group" options={{ presentation: "fullScreenModal" }} />
            <Stack.Screen name="fn" options={() => ({ presentation: "modal" })} />
            <Stack.Screen name="spread" options={{ ...modalOptions }} />
          </Stack>
        );
      }
    `;
    const page = `export default function Page() { return <Stack.Screen options={{ presentation: "modal" }} />; }`;
    const all = `export default function Layout() { return <Stack screenOptions={{ presentation: "modal" }} />; }`;
    const existing = new Set(['app/sheet.tsx', 'app/group/_layout.tsx', 'app/fn.tsx']);
    const { routes: found, unreadable: bad } = collectModalRoutes(
      [
        { file: 'app/_layout.tsx', text: layout },
        { file: 'app/self.tsx', text: page },
        { file: 'app/all/_layout.tsx', text: all },
      ],
      (file) => existing.has(file),
      (dir) => (dir === 'app/group' ? ['app/group/_layout.tsx', 'app/group/a.tsx'] : []),
    );
    expect(found).toEqual([
      { declaredIn: 'app/_layout.tsx', name: 'sheet', presentation: 'formSheet', files: ['app/sheet.tsx'] },
      { declaredIn: 'app/_layout.tsx', name: 'group', presentation: 'fullScreenModal', files: ['app/group/_layout.tsx', 'app/group/a.tsx'] },
      { declaredIn: 'app/self.tsx', name: null, presentation: 'modal', files: ['app/self.tsx'] },
    ]);
    expect(bad).toEqual([
      'app/_layout.tsx: <Stack.Screen options> の presentation を読めない',
      'app/_layout.tsx: <Stack.Screen options> の presentation を読めない',
      'app/all/_layout.tsx: <Stack screenOptions> で全画面を modal にしている (検査が未対応)',
    ]);
  });

  it('検査そのものの確かめ: R5 の不具合の形 (modal の画面が画面を閉じずに案内を出す) を見つけ、閉じる形は通す', () => {
    const check = (text: string, promptingNamesInExample: string[] = []) =>
      modalRoutePromptViolations('route.tsx', text, new Set(promptingNamesInExample)).violations;
    // R5 の形: 案内に何も渡さない
    expect(check(`export default function Page() { async function f() { try {} catch (e) { if (handleAiConsentRequiredError(e)) return; } } }`)).toEqual([
      'route.tsx:1 handleAiConsentRequiredError (beforeOpenConsentScreen で画面を閉じていない)',
    ]);
    // 渡しても、画面を閉じない関数なら通さない
    expect(
      check(`export default function Page() { promptAiConsentRequired({ beforeOpenConsentScreen: () => {} }); handleStoredAiConsentFailure(x); handleStoredAiConsentFailure(x, promptAiConsentRequired); }`),
    ).toEqual([
      'route.tsx:1 handleStoredAiConsentFailure (beforeOpenConsentScreen で画面を閉じていない)',
      'route.tsx:1 handleStoredAiConsentFailure (beforeOpenConsentScreen で画面を閉じていない)',
      'route.tsx:1 promptAiConsentRequired (beforeOpenConsentScreen で画面を閉じていない)',
    ]);
    // 直した形: useLeaveModalRouteBeforeConsentScreen() の戻り値 (そのまま・省略記法・それを呼ぶ関数) を渡す
    expect(
      check(`
        export default function Page() {
          const leave = useLeaveModalRouteBeforeConsentScreen();
          const beforeOpenConsentScreen = useLeaveModalRouteBeforeConsentScreen();
          handleAiConsentRequiredError(e, { beforeOpenConsentScreen: leave });
          promptAiConsentRequired({ beforeOpenConsentScreen });
          handleStoredAiConsentFailure(x, () => promptAiConsentRequired({ beforeOpenConsentScreen: () => { setOpen(false); leave(); } }));
        }
      `),
    ).toEqual([]);
    // 案内を通さずに同意画面へ直接移る (画面を閉じる機会が無い)
    expect(
      check(`export default function Page() { const go = () => router.push(AI_CONSENT_SCREEN_PATH); return <Link href="/settings/ai-consent" />; }`),
    ).toEqual(['route.tsx:1 同意画面へ直接移る', 'route.tsx:1 同意画面へ直接移る']);
    // 自分で案内を出す部品・フックを置く、onAiConsentRequired を渡さずに生成のフックを使う
    expect(
      check(
        `export default function Page() { useThing(); useV4MenuGeneration({}); return <Sheet />; }`,
        ['Sheet', 'useThing'],
      ),
    ).toEqual([
      'route.tsx:1 <Sheet> (自分で案内を出す部品)',
      'route.tsx:1 useThing (自分で案内を出すフック)',
      'route.tsx:1 useV4MenuGeneration (onAiConsentRequired を渡していない)',
    ]);
  });
});
