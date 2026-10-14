// tests/helpers/maestro-flow-testids.ts
// maestro の flow (apps/mobile/maestro/**/*.yaml) が期待する testID (id:) を抜き出し、
// ソース (apps/mobile と src) に実在する testID と突き合わせる (#1552)。
// 使う側: tests/maestro-flow-testids.test.ts
//
// ソースの testID の集め方
//   - 名前に testID / testId / testid を含むもの (testID・tabBarButtonTestID・inputTestID・data-testid・
//     fieldTestIdMap・testIDPrefix など) の右辺 (= や : のあと。型注釈があればその後の =) にある文字列を集める
//       "x" / 'x' / `x`          → そのままの testID
//       `prefix-${...}`           → テンプレート。${...} を「1 文字以上の何か」とした正規表現にする
//       名前が …Prefix の右辺の "x" → x と、x-<何か> (testIDPrefix を使う側が `${testIDPrefix}-${…}` で組み立てる)
//   - 右辺の読み方は、始まりの文字で決める (readExpressionLiterals)
//       文字列で始まる   → その文字列 1 つ (testID="x"・testID: "x")
//       { で始まる       → 対応の取れた { … } (testID={cond ? "a" : "b"}・fieldTestIdMap = { weight: "field-weight" } のような対応表)
//       それ以外で始まる → 式の終わりまで (const testID = cond ? "a" : "b"; ・ testID: cond ? "a" : "b", ・ [ … ] など)。
//                          式の終わり = 括弧の外の ; か , ・ 開いていない閉じ括弧の手前・括弧の外の改行で、
//                          次の行が名前の行より深く字下げされていないとき
//   - 比べる演算子 (=== !== == !=) の両側の文字列は条件なので集めない (a.href === "/health/graphs" ? … ・ typeof x === 'string')
//   - コメント (// … と /* … */) の中は読まない (空白にしてから読む)。括弧の対応は文字列の中を数えない
//
// flow の id の抜き出し方
//   - ブロックの書き方 (- tapOn: の下の id: x) と、フローの書き方 (- tapOn: { id: "x" }・below: { id: "x" } の入れ子・
//     複数行に渡る { … }) の両方を読む
//   - コメント (#) と、ブロックスカラー (| / > で始まる複数行の文字列。evalScript の JS など) の中身は読まない
//
// flow の id の扱い
//   - maestro の id は正規表現として全体一致で比べられる。正規表現の記号 (. * + ? など) を含む id は正規表現として、
//     ソースのどれか (そのままの testID、またはテンプレートの ${...} を仮の値で埋めた文字列) に全体一致すれば実在とする
//   - それ以外の id は、そのままの testID に一致するか、テンプレートの正規表現に全体一致すれば実在とする

import fs from "node:fs";
import path from "node:path";

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

/** 引用符を開ける位置か (YAML の引用符つきの値は、行頭・空白・: { [ , のあとでだけ始まる) */
function opensQuote(line: string, i: number): boolean {
  const c = line[i];
  return (c === '"' || c === "'") && (i === 0 || /[\s:{[,]/.test(line[i - 1]));
}

/**
 * 1 行から、引用符の外にある # 以降 (YAML のコメント) を外す。
 * # は行頭か空白のあとにあるときだけコメント
 */
function stripYamlComment(line: string): string {
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote !== null) {
      if (quote === '"' && c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (opensQuote(line, i)) quote = c === '"' ? '"' : "'";
    else if (c === "#" && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i);
  }
  return line;
}

/**
 * id: のあとの値を読む。引用符つきならその中身、無ければ
 * フロー ({ … } の中) では , { } [ ] の手前まで、ブロックでは行末まで (前後の空白は外す)。空なら null
 */
function readYamlScalar(rest: string, inFlow: boolean): string | null {
  const s = rest.trimStart();
  const q = s[0];
  if (q === '"' || q === "'") {
    let out = "";
    for (let i = 1; i < s.length; i++) {
      const c = s[i];
      if (q === '"' && c === "\\" && i + 1 < s.length) {
        out += s[++i];
        continue;
      }
      if (c === q) {
        // 一重引用符の中の '' は ' 1 文字
        if (q === "'" && s[i + 1] === "'") {
          out += "'";
          i++;
          continue;
        }
        return out === "" ? null : out;
      }
      out += c;
    }
    return null;
  }
  const plain = (inFlow ? s.split(/[,{}[\]]/)[0] : s).trim();
  return plain === "" ? null : plain;
}

/** フロー ({ … } の中) の区切り ({ か , ) のすぐあとに id: が来ているか (sticky で、区切りの次の位置から見る) */
const FLOW_ID_KEY_RE = /\s*id:(?=\s|$)\s*/y;
/** ブロックの id: (行頭の字下げ・- のあと) */
const BLOCK_ID_KEY_RE = /^\s*(?:-\s+)?id:(?=\s|$)/;
/** 複数行に渡るフロー ({ … } の中) の行頭の id: */
const FLOW_LINE_ID_KEY_RE = /^\s*id:(?=\s|$)/;
/** ブロックスカラー (| や > で始まる複数行の文字列。evalScript の JS など) を始める行 */
const BLOCK_SCALAR_START_RE = /:\s*[|>][-+0-9]*\s*$/;

function indentOf(line: string): number {
  return /^\s*/.exec(line)?.[0].length ?? 0;
}

/**
 * flow の 1 ファイルから、id: の値を書かれた順に抜き出す (コメント・ブロックスカラーの中身は除く)。
 * ブロックの書き方 (- tapOn: の下の id: x、below: の下の id: x) と、
 * フローの書き方 (- tapOn: { id: "x" }、{ below: { id: "x" } } のような入れ子、複数行に渡る { … }) の両方を読む
 */
export function extractFlowIds(yaml: string): string[] {
  const ids: string[] = [];
  /** 引用符の外の { [ の深さ (0 = ブロック。行をまたいで持ち越す) */
  let depth = 0;
  /** ブロックスカラーの中にいる間、その親の行の字下げ (中身はこれより深く字下げされた行・空行) */
  let blockScalarIndent: number | null = null;
  for (const rawLine of yaml.split("\n")) {
    if (blockScalarIndent !== null) {
      if (rawLine.trim() === "" || indentOf(rawLine) > blockScalarIndent) continue;
      blockScalarIndent = null;
    }
    const line = stripYamlComment(rawLine);
    const head = (depth === 0 ? BLOCK_ID_KEY_RE : FLOW_LINE_ID_KEY_RE).exec(line);
    if (head) {
      const value = readYamlScalar(line.slice(head[0].length), depth > 0);
      if (value !== null) ids.push(value);
    }
    let quote: '"' | "'" | null = null;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (quote !== null) {
        if (quote === '"' && c === "\\") i++;
        else if (c === quote) quote = null;
        continue;
      }
      if (opensQuote(line, i)) {
        quote = c === '"' ? '"' : "'";
        continue;
      }
      if (c === "}" || c === "]") {
        if (depth > 0) depth--;
        continue;
      }
      if (c === "{" || c === "[") {
        // ブロックでは、値の始まり (行頭・: のあと・- のあと) の { [ だけがフローを開く (文の途中の { は文字)
        const before = line.slice(0, i).trimEnd();
        const startsValue = before === "" || before.endsWith(":") || /(?:^|\s)-$/.test(before);
        if (depth === 0 && !startsValue) continue;
        depth++;
      } else if (c !== "," || depth === 0) {
        continue;
      }
      // ここに来るのは、フローの中の { [ , のすぐあと。id: が続けばその値を読む
      FLOW_ID_KEY_RE.lastIndex = i + 1;
      if (FLOW_ID_KEY_RE.exec(line) === null) continue;
      const value = readYamlScalar(line.slice(FLOW_ID_KEY_RE.lastIndex), true);
      if (value !== null) ids.push(value);
    }
    if (depth === 0 && BLOCK_SCALAR_START_RE.test(line)) blockScalarIndent = indentOf(line);
  }
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

const QUOTE_CHARS = new Set(['"', "'", "`"]);
const OPEN_BRACKETS = new Set(["(", "[", "{"]);
const CLOSE_BRACKETS = new Set([")", "]", "}"]);
/** 比べる演算子 (=== !== == !=) の直前・直後。その側にある文字列は条件で、testID の値ではない */
const COMPARED_BEFORE_RE = /[=!]==?\s*$/;
const COMPARED_AFTER_RE = /^\s*[=!]==?/;
/** 型注釈に使う文字だけか (fieldTestIdMap: Partial<Record<keyof FormData, string>> = … の「: と = の間」) */
const TYPE_ANNOTATION_RE = /^[\w\s.,|&<>[\]()]+$/;

/** 文字列リテラル (" ' `) の 1 つ */
type SourceLiteral = { template: boolean; body: string };

/** text[i] の引用符で始まる文字列の、閉じ引用符の位置。" と ' は同じ行の中だけ探す (JS の文字列は改行を含まない)。無ければ -1 */
function stringEnd(text: string, i: number): number {
  const q = text[i];
  for (let j = i + 1; j < text.length; j++) {
    const c = text[j];
    if (c === "\\") {
      j++;
      continue;
    }
    if (c === q) return j;
    if (c === "\n" && q !== "`") return -1;
  }
  return -1;
}

function lineStartOf(text: string, i: number): number {
  return text.lastIndexOf("\n", i - 1) + 1;
}

function lineEndOf(text: string, i: number): number {
  const end = text.indexOf("\n", i);
  return end === -1 ? text.length : end;
}

/** text[from] からの、次の空でない行が baseIndent より深く字下げされているか (= 式が次の行に続いているか) */
function continuesOnNextLine(text: string, from: number, baseIndent: number): boolean {
  let at = from;
  while (at < text.length) {
    const end = lineEndOf(text, at);
    const line = text.slice(at, end);
    if (line.trim() !== "") return indentOf(line) > baseIndent;
    at = end + 1;
  }
  return false;
}

/** 文字列リテラル text[i..end] が、比べる演算子の片側 (条件) か */
function isComparedLiteral(text: string, i: number, end: number): boolean {
  return (
    COMPARED_BEFORE_RE.test(text.slice(lineStartOf(text, i), i)) ||
    COMPARED_AFTER_RE.test(text.slice(end + 1, lineEndOf(text, end + 1)))
  );
}

/**
 * ソースのコメント (// … と /* … *\/) を空白に置き換える (位置と改行はそのまま)。
 * 文字列 (" ' `) の中の // と、\ のすぐあとの文字 (正規表現の /\// など) はコメントの始まりにしない。
 * コメントの中の「testID: …」の文は testID ではない (読むと、文の中の閉じない括弧で式の終わりを見失い、後ろの文の文字列まで拾う)
 */
export function blankSourceComments(text: string): string {
  const chunks: string[] = [];
  let copiedUpTo = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "\\") {
      i++;
      continue;
    }
    if (QUOTE_CHARS.has(c)) {
      const end = stringEnd(text, i);
      if (end !== -1) i = end;
      continue;
    }
    if (c !== "/" || (text[i + 1] !== "/" && text[i + 1] !== "*")) continue;
    const close = text[i + 1] === "*" ? text.indexOf("*/", i + 2) : -1;
    const end = text[i + 1] === "/" ? lineEndOf(text, i) : close === -1 ? text.length : close + 2;
    chunks.push(text.slice(copiedUpTo, i), text.slice(i, end).replace(/[^\n]/g, " "));
    copiedUpTo = end;
    i = end - 1;
  }
  chunks.push(text.slice(copiedUpTo));
  return chunks.join("");
}

/**
 * text[start] から始まる右辺の式を読み、中の文字列リテラル (比べる演算子の片側は除く) を返す。
 * 読み方は、始まりの文字で決める (ファイルの先頭のコメントの「右辺の読み方」)。text はコメントを空白にしたもの (blankSourceComments)。
 * baseIndent = 名前のある行の字下げ (式が次の行に続いているかの判定に使う)
 */
function readExpressionLiterals(text: string, start: number, baseIndent: number): SourceLiteral[] {
  const first = text[start];
  if (first === undefined) return [];
  if (QUOTE_CHARS.has(first)) {
    const end = stringEnd(text, start);
    return end === -1 ? [] : [{ template: first === "`", body: text.slice(start + 1, end) }];
  }
  /** { で始まる式 (JSX の testID={…}) は、対応の取れた { … } だけを読む。中の ( [ は数えない (正規表現の /\(/ などで崩れないように) */
  const braceOnly = first === "{";
  const literals: SourceLiteral[] = [];
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (QUOTE_CHARS.has(c)) {
      const end = stringEnd(text, i);
      if (end === -1) continue;
      if (!isComparedLiteral(text, i, end)) literals.push({ template: c === "`", body: text.slice(i + 1, end) });
      i = end;
      continue;
    }
    const opens = braceOnly ? c === "{" : OPEN_BRACKETS.has(c);
    const closes = braceOnly ? c === "}" : CLOSE_BRACKETS.has(c);
    if (opens) {
      depth++;
    } else if (closes) {
      if (depth === 0) break;
      depth--;
      if (braceOnly && depth === 0) break;
    } else if (!braceOnly && depth === 0) {
      if (c === ";" || c === ",") break;
      if (c === "\n" && !continuesOnNextLine(text, i + 1, baseIndent)) break;
    }
  }
  return literals;
}

/** 名前のすぐあとの = か : (== => は除く)。sticky で、名前の次の位置から見る */
const ASSIGN_OR_COLON_RE = /\s*(?:=(?![=>])|:)\s*/y;

/** 名前のあと (= / : / 型注釈のあとの =) から、右辺の式の始まりの位置を返す。右辺が無ければ -1 */
function expressionStart(text: string, afterName: number): number {
  ASSIGN_OR_COLON_RE.lastIndex = afterName;
  const direct = ASSIGN_OR_COLON_RE.exec(text);
  if (!direct) return -1;
  const at = afterName + direct[0].length;
  if (QUOTE_CHARS.has(text[at] ?? "") || text[at] === "{" || !direct[0].includes(":")) return at;
  // 型注釈 (例: fieldTestIdMap: Partial<Record<…>> = { … })。同じ行で、: と = の間が型の書き方だけなら、= のあとを読む
  const line = text.slice(at, lineEndOf(text, at));
  const assign = /(?<![=!<>])=(?![=>])\s*/.exec(line);
  if (assign && TYPE_ANNOTATION_RE.test(line.slice(0, assign.index))) return at + assign.index + assign[0].length;
  return at;
}

/** ソースのファイルの中身から、testID を集める (collectSourceTestIds の 1 ファイル分)。コメントの中は読まない */
export function addTestIdsFromSource(source: string, into: SourceTestIds): void {
  const text = blankSourceComments(source);
  const nameRe = /\b(\w*test_?id\w*)\b|\bdata-testid\b/gi;
  let m: RegExpExecArray | null;
  while ((m = nameRe.exec(text)) !== null) {
    const name = m[1] ?? "data-testid";
    const start = expressionStart(text, m.index + m[0].length);
    if (start === -1) continue;
    const baseIndent = indentOf(text.slice(lineStartOf(text, m.index), m.index));
    const isPrefix = /prefix$/i.test(name);
    for (const lit of readExpressionLiterals(text, start, baseIndent)) {
      if (!lit.template) {
        const plain = lit.body;
        if (!/^[\w:-]+$/.test(plain)) continue;
        into.exact.add(plain);
        if (isPrefix) {
          into.patterns.push(new RegExp(`^${escapeRegExp(plain)}-.+$`));
          into.samples.add(`${plain}-${TEMPLATE_SAMPLE_VALUE}`);
        }
        continue;
      }
      const template = lit.body;
      const parts = template.split(/\$\{[^}]*\}/);
      if (parts.length === 1) {
        if (/^[\w:-]+$/.test(template)) into.exact.add(template);
        continue;
      }
      // ${…} だけで固定の部分が無いテンプレート (例: `${testIDPrefix}-${opt.value}`) は、何にでも一致するので使わない
      if (!/[a-z0-9]/i.test(parts.join(""))) continue;
      into.patterns.push(new RegExp(`^${parts.map(escapeRegExp).join(".+")}$`));
      into.samples.add(parts.join(TEMPLATE_SAMPLE_VALUE));
    }
  }
}

export function collectSourceTestIds(root: string = REPO_ROOT): SourceTestIds {
  const ids: SourceTestIds = { exact: new Set(), patterns: [], samples: new Set() };
  for (const file of listSourceFiles(root)) addTestIdsFromSource(fs.readFileSync(file, "utf8"), ids);
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

/** ソースに無い testID を期待している (flow, id) の一覧 (同じ flow の同じ id は 1 件にまとめる) */
export function findMissingFlowIds(root: string = REPO_ROOT): MissingFlowId[] {
  const source = collectSourceTestIds(root);
  const missing: MissingFlowId[] = [];
  for (const flow of listMaestroFlowFiles(root)) {
    const seen = new Set<string>();
    for (const id of extractFlowIds(fs.readFileSync(path.join(root, flow), "utf8"))) {
      if (seen.has(id)) continue;
      seen.add(id);
      if (!isFlowIdInSource(id, source)) missing.push({ flow, id });
    }
  }
  return missing;
}
