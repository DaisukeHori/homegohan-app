// tests/helpers/maestro-flow-testids.ts
// maestro の flow (apps/mobile/maestro/**/*.yaml) が期待する testID (id:) を抜き出し、
// ソース (apps/mobile と src) に実在する testID と突き合わせる (#1552)。
// 使う側: tests/maestro-flow-testids.test.ts
//
// どちらの側も、文字を数えて読むのではなく構文として読む (ソース = TypeScript の構文木、flow = YAML のパーサ)。
// コメント・文字列の中身・式の終わり・字下げは、パーサがそのまま扱う。
//
// ソースの testID の集め方 (TypeScript の構文木。ts.createSourceFile)
//   - 名前に testID / testId / testid を含むもの (testID・tabBarButtonTestID・inputTestID・data-testid・
//     fieldTestIdMap・testIDPrefix など) の値を見る。名前と値の組:
//       JSX の属性 (testID="x"・testID={…}) / オブジェクトのプロパティ (testID: …) / 変数 (const testID = …) /
//       引数・分割代入の既定値 ({ testID = … }) / クラスのフィールド / 代入 (testID = …・x.testID = …)
//   - 値は、testID になりうる部分だけをたどる
//       ( … )・as・satisfies・<T>x・x!・JSX の { … } → 中身
//       三項 (cond ? a : b) → a と b (cond は条件なので見ない。a === "x" の "x" はここで外れる)
//       ?? || && → 左右
//       [ … ] → 要素 / { … } → プロパティの値
//   - たどった先の文字列
//       "x" / 'x' / `x`              → そのままの testID
//       `prefix-${...}`               → テンプレート。${...} を「1 文字以上の何か」とした正規表現にする
//       名前が …Prefix の右辺の "x"     → x と、x-<何か> (testIDPrefix を使う側が `${testIDPrefix}-${…}` で組み立てる)
//
// flow の id の抜き出し方 (YAML のパーサ。js-yaml の loadAll)
//   - すべての文書をたどり、キーが id の値を出てきた順に集める。ブロックの書き方 (- tapOn: の下の id: x) も
//     フローの書き方 (- tapOn: { id: "x" }・below: { id: "x" } の入れ子) も同じ構造になる
//   - コメントはパーサが捨て、ブロックスカラー (| / > の複数行の文字列。evalScript の JS など) は 1 つの文字列なので中を見ない
//   - 値はすべて文字列として読む (FAILSAFE_SCHEMA)。maestro は id を文字列として比べるので、id: 2024 も "2024" として扱う
//
// flow の id の扱い
//   - maestro の id は正規表現として全体一致で比べられる。正規表現の記号 (. * + ? など) を含む id は正規表現として、
//     ソースのどれか (そのままの testID、またはテンプレートの ${...} を仮の値で埋めた文字列) に全体一致すれば実在とする
//   - それ以外の id は、そのままの testID に一致するか、テンプレートの正規表現に全体一致すれば実在とする

import fs from "node:fs";
import path from "node:path";

import yaml from "js-yaml";
import ts from "typescript";

export const REPO_ROOT = path.resolve(__dirname, "../..");

/** maestro の flow を置く場所 */
export const MAESTRO_DIR = "apps/mobile/maestro";

/** testID を探すソースの場所 (#1552: apps/mobile と src) */
export const SOURCE_DIRS = ["apps/mobile/app", "apps/mobile/src", "src"] as const;

const SOURCE_FILE_RE = /\.(?:tsx?|jsx?)$/;
const TEST_FILE_RE = /(?:^|[\\/])__tests__[\\/]|\.(?:test|spec)\.[tj]sx?$/;
const SKIP_DIR_NAMES = new Set(["node_modules", "__tests__", "__mocks__"]);

/** 正規表現の記号 (maestro の id がこれを含むときは正規表現として比べる) */
const REGEX_META_RE = /[.*+?^$()[\]{}|\\]/;
/** テンプレートの ${...} を埋める仮の値 (正規表現の id との突き合わせ用) */
const TEMPLATE_SAMPLE_VALUE = "x";

function walk(dir: string, pred: (file: string) => boolean, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || SKIP_DIR_NAMES.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, pred, out);
    else if (pred(full)) out.push(full);
  }
  return out;
}

export function listMaestroFlowFiles(root: string = REPO_ROOT): string[] {
  return walk(path.join(root, MAESTRO_DIR), (f) => /\.ya?ml$/.test(f))
    .map((f) => path.relative(root, f).split(path.sep).join("/"))
    .sort();
}

export function listSourceFiles(root: string = REPO_ROOT): string[] {
  return SOURCE_DIRS.flatMap((d) => walk(path.join(root, d), (f) => SOURCE_FILE_RE.test(f) && !TEST_FILE_RE.test(f)));
}

/** maestro の flow で、要素の testID を指すキー */
const FLOW_ID_KEY = "id";

/**
 * flow の 1 ファイルから、id: の値を書かれた順に抜き出す (YAML のパーサで読む。コメント・ブロックスカラーの中身は除く)。
 * ブロックの書き方 (- tapOn: の下の id: x、below: の下の id: x) と、
 * フローの書き方 (- tapOn: { id: "x" }、{ below: { id: "x" } } のような入れ子、複数行に渡る { … }) の両方を読む。
 * YAML として読めない flow は例外 (maestro も読めない)
 */
export function extractFlowIds(text: string): string[] {
  const ids: string[] = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (node === null || typeof node !== "object") return;
    for (const [key, value] of Object.entries(node)) {
      if (key === FLOW_ID_KEY && typeof value === "string") ids.push(value);
      visit(value);
    }
  };
  for (const doc of yaml.loadAll(text, undefined, { schema: yaml.FAILSAFE_SCHEMA })) visit(doc);
  return ids;
}

export type SourceTestIds = {
  /** そのままの testID */
  exact: Set<string>;
  /** テンプレートなどから作った、全体一致の正規表現 */
  patterns: RegExp[];
  /** テンプレートの ${...} を仮の値で埋めた文字列 (正規表現の id との突き合わせ用) */
  samples: Set<string>;
};

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 名前が testID か (testID・tabBarButtonTestID・inputTestID・data-testid・fieldTestIdMap・testIDPrefix など) */
const TEST_ID_NAME_RE = /test_?id/i;
/** 名前が …Prefix か (testIDPrefix を使う側が `${testIDPrefix}-${…}` で組み立てる) */
const PREFIX_NAME_RE = /prefix$/i;
/** testID として集める文字列の形 (英数字・_ ・: ・-。文の文字列や URL は testID ではない) */
const TEST_ID_VALUE_RE = /^[\w:-]+$/;
/** テンプレートの固定の部分に英数字があるか (無ければ何にでも一致するので使わない) */
const HAS_ALNUM_RE = /[a-z0-9]/i;

/** ソースの文字列を直接渡したとき (ファイル名が無いとき) の仮の名前。JSX も型注釈も読める TSX として読む */
const INLINE_SOURCE_NAME = "inline.tsx";

/**
 * 読み方。.ts だけは JSX を読まない (<T>x を型の指定として読む)。
 * .tsx・.js・.jsx (とファイル名なし) は JSX を読む TSX として読む (JS の JSX も TSX と同じ構文木になる)
 */
function scriptKindOf(fileName: string): ts.ScriptKind {
  return path.extname(fileName) === ".ts" ? ts.ScriptKind.TS : ts.ScriptKind.TSX;
}

/** 値の左右をたどる演算子 (?? || &&)。比べる演算子 (=== など) の両側は条件なので入れない */
const EITHER_SIDE_OPERATORS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.QuestionQuestionToken,
  ts.SyntaxKind.BarBarToken,
  ts.SyntaxKind.AmpersandAmpersandToken,
]);

/** 名前の文字列 (識別子・#private・引用符つきのプロパティ名・JSX の a:b)。計算するプロパティ名 ([key]) などは undefined */
function nameText(name: ts.Node | undefined): string | undefined {
  if (name === undefined) return undefined;
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  if (ts.isJsxNamespacedName(name)) return `${name.namespace.text}:${name.name.text}`;
  return undefined;
}

/** 名前と値の組 (ファイルの先頭のコメントの「名前と値の組」)。node がそのどれでもなければ undefined */
function namedValue(node: ts.Node): { names: (string | undefined)[]; value: ts.Node | undefined } | undefined {
  if (ts.isJsxAttribute(node)) return { names: [nameText(node.name)], value: node.initializer };
  if (ts.isPropertyAssignment(node)) return { names: [nameText(node.name)], value: node.initializer };
  if (ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isPropertyDeclaration(node)) {
    return { names: [nameText(node.name)], value: node.initializer };
  }
  // { testID = "x" } と { testID: alias = "x" } (どちらの名前でも testID とみなす)
  if (ts.isBindingElement(node)) return { names: [nameText(node.propertyName), nameText(node.name)], value: node.initializer };
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
    const left = node.left;
    const name = ts.isIdentifier(left) ? left.text : ts.isPropertyAccessExpression(left) ? nameText(left.name) : undefined;
    return { names: [name], value: node.right };
  }
  return undefined;
}

/** そのままの文字列 (引用符・置き換えの無いテンプレート) を testID として足す */
function addPlainTestId(text: string, isPrefix: boolean, into: SourceTestIds): void {
  if (!TEST_ID_VALUE_RE.test(text)) return;
  into.exact.add(text);
  if (!isPrefix) return;
  into.patterns.push(new RegExp(`^${escapeRegExp(text)}-.+$`));
  into.samples.add(`${text}-${TEMPLATE_SAMPLE_VALUE}`);
}

/** テンプレート (`a-${…}-b`) を、固定の部分 (["a-", "-b"]) から正規表現と埋めた文字列にして足す */
function addTemplateTestId(fixedParts: string[], into: SourceTestIds): void {
  // ${…} だけで固定の部分が無いテンプレート (例: `${testIDPrefix}-${opt.value}`) は、何にでも一致するので使わない
  if (!HAS_ALNUM_RE.test(fixedParts.join(""))) return;
  into.patterns.push(new RegExp(`^${fixedParts.map(escapeRegExp).join(".+")}$`));
  into.samples.add(fixedParts.join(TEMPLATE_SAMPLE_VALUE));
}

/** testID の値の式から、testID になりうる文字列を集める (ファイルの先頭のコメントの「値は、testID になりうる部分だけをたどる」) */
function addTestIdsFromValue(value: ts.Node, isPrefix: boolean, into: SourceTestIds): void {
  const next = (node: ts.Node | undefined) => {
    if (node !== undefined) addTestIdsFromValue(node, isPrefix, into);
  };
  if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) {
    addPlainTestId(value.text, isPrefix, into);
  } else if (ts.isTemplateExpression(value)) {
    addTemplateTestId([value.head.text, ...value.templateSpans.map((span) => span.literal.text)], into);
  } else if (ts.isJsxExpression(value)) {
    next(value.expression);
  } else if (
    ts.isParenthesizedExpression(value) ||
    ts.isAsExpression(value) ||
    ts.isSatisfiesExpression(value) ||
    ts.isTypeAssertionExpression(value) ||
    ts.isNonNullExpression(value)
  ) {
    next(value.expression);
  } else if (ts.isConditionalExpression(value)) {
    next(value.whenTrue);
    next(value.whenFalse);
  } else if (ts.isBinaryExpression(value) && EITHER_SIDE_OPERATORS.has(value.operatorToken.kind)) {
    next(value.left);
    next(value.right);
  } else if (ts.isArrayLiteralExpression(value)) {
    value.elements.forEach(next);
  } else if (ts.isObjectLiteralExpression(value)) {
    for (const property of value.properties) if (ts.isPropertyAssignment(property)) next(property.initializer);
  }
}

/**
 * ソースのファイルの中身から、testID を集める (collectSourceTestIds の 1 ファイル分)。
 * fileName の拡張子で読み方を決める (scriptKindOf)。省くと TSX として読む
 */
export function addTestIdsFromSource(source: string, into: SourceTestIds, fileName: string = INLINE_SOURCE_NAME): void {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, false, scriptKindOf(fileName));
  const visit = (node: ts.Node): void => {
    const named = namedValue(node);
    const name = named?.names.find((n) => n !== undefined && TEST_ID_NAME_RE.test(n));
    if (named?.value !== undefined && name !== undefined) addTestIdsFromValue(named.value, PREFIX_NAME_RE.test(name), into);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
}

export function collectSourceTestIds(root: string = REPO_ROOT): SourceTestIds {
  const ids: SourceTestIds = { exact: new Set(), patterns: [], samples: new Set() };
  for (const file of listSourceFiles(root)) addTestIdsFromSource(fs.readFileSync(file, "utf8"), ids, file);
  return ids;
}

/** flow の id が、ソースの testID として実在するか */
export function isFlowIdInSource(id: string, source: SourceTestIds): boolean {
  if (REGEX_META_RE.test(id)) {
    let re: RegExp;
    try {
      re = new RegExp(`^(?:${id})$`);
    } catch {
      return false;
    }
    for (const s of source.exact) if (re.test(s)) return true;
    for (const s of source.samples) if (re.test(s)) return true;
    return false;
  }
  return source.exact.has(id) || source.patterns.some((re) => re.test(id));
}

export type MissingFlowId = { flow: string; id: string };

/** flow の 1 ファイルの id (YAML として読めなければ、どの flow かを添えて例外) */
function readFlowIds(root: string, flow: string): string[] {
  try {
    return extractFlowIds(fs.readFileSync(path.join(root, flow), "utf8"));
  } catch (error) {
    throw new Error(`maestro の flow を YAML として読めません: ${flow}`, { cause: error });
  }
}

/** ソースに無い testID を期待している (flow, id) の一覧 (同じ flow の同じ id は 1 件にまとめる) */
export function findMissingFlowIds(root: string = REPO_ROOT): MissingFlowId[] {
  const source = collectSourceTestIds(root);
  const missing: MissingFlowId[] = [];
  for (const flow of listMaestroFlowFiles(root)) {
    const seen = new Set<string>();
    for (const id of readFlowIds(root, flow)) {
      if (seen.has(id)) continue;
      seen.add(id);
      if (!isFlowIdInSource(id, source)) missing.push({ flow, id });
    }
  }
  return missing;
}
