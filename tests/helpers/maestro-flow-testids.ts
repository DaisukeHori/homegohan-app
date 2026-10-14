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
//   - 右辺の { … } は、括弧の対応で 1 式ぶんを読む (三項演算子・オブジェクトの中の testID: "x" も拾う)
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

/** text[start] から始まる 1 式ぶん (文字列 1 つ、または対応の取れた { … }) を返す。読めなければ null */
function readExpression(text: string, start: number): string | null {
  const c = text[start];
  if (c === '"' || c === "'" || c === "`") {
    const end = text.indexOf(c, start + 1);
    return end === -1 ? null : text.slice(start, end + 1);
  }
  if (c === "{") {
    let depth = 0;
    for (let i = start; i < text.length; i++) {
      if (text[i] === "{") depth++;
      else if (text[i] === "}") {
        depth--;
        if (depth === 0) return text.slice(start, i + 1);
      }
    }
  }
  return null;
}

/** 名前のあと (= / : / 型注釈のあとの =) から、右辺の式の始まりの位置を返す。右辺が読めなければ -1 */
function expressionStart(text: string, afterName: number): number {
  const rest = text.slice(afterName);
  const direct = /^\s*(?:=(?![=>])|:)\s*/.exec(rest);
  if (!direct) return -1;
  const at = afterName + direct[0].length;
  if (/["'`{]/.test(text[at] ?? "")) return at;
  // 型注釈 (例: fieldTestIdMap: Partial<Record<…>> = { … })。同じ行の = のあとを読む
  if (direct[0].includes(":")) {
    const lineEnd = text.indexOf("\n", afterName);
    const line = text.slice(afterName, lineEnd === -1 ? text.length : lineEnd);
    const assign = /[^=!<>]=(?![=>])\s*/.exec(line);
    if (assign) {
      const pos = afterName + assign.index + assign[0].length;
      if (/["'`{]/.test(text[pos] ?? "")) return pos;
    }
  }
  return -1;
}

/** ソースのファイルの中身から、testID を集める (collectSourceTestIds の 1 ファイル分) */
export function addTestIdsFromSource(text: string, into: SourceTestIds): void {
  const nameRe = /\b(\w*test_?id\w*)\b|\bdata-testid\b/gi;
  let m: RegExpExecArray | null;
  while ((m = nameRe.exec(text)) !== null) {
    const name = m[1] ?? "data-testid";
    const start = expressionStart(text, m.index + m[0].length);
    if (start === -1) continue;
    const expr = readExpression(text, start);
    if (expr === null) continue;
    const isPrefix = /prefix$/i.test(name);
    for (const lit of expr.matchAll(/"([^"\n]*)"|'([^'\n]*)'|`([^`]*)`/g)) {
      const plain = lit[1] ?? lit[2];
      if (plain !== undefined) {
        if (!/^[\w:-]+$/.test(plain)) continue;
        into.exact.add(plain);
        if (isPrefix) {
          into.patterns.push(new RegExp(`^${escapeRegExp(plain)}-.+$`));
          into.samples.add(`${plain}-${TEMPLATE_SAMPLE_VALUE}`);
        }
        continue;
      }
      const template = lit[3];
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
