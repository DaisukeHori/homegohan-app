/**
 * tests/local-ci-workflow-sync.test.ts
 *
 * scripts/local-ci.sh (PR の CI 検査をローカルで回すスクリプト) が、CI のワークフローとずれていないことを確かめる。
 *
 * 背景: local-ci.sh は、次の 4 つのワークフローのコマンド・対象パス・環境変数を写して、ローカルで同じ検査を回す。
 *   - .github/workflows/ci.yml                  → stage_unit        (typecheck / lint / vitest)
 *   - .github/workflows/mobile-test.yml         → stage_mobile      (apps/mobile の jest / packages/core の vitest)
 *   - .github/workflows/security-regression.yml → stage_integration (結合テスト 2 本)
 *   - .github/workflows/e2e-local.yml           → stage_e2e         (Playwright)
 * ワークフローだけを変えてスクリプトを直し忘れると、「ローカルは緑なのに CI は赤」(またはその逆) になり、
 * ローカルの緑を根拠にマージする運用が成り立たなくなる。
 *
 * そこで、DB もサーバーも使わずにソースだけを見る静的検査にして、通常の `npm test` (PR の CI) に載せる。
 *
 * 照合のしかた:
 *   - 照合する範囲は、ワークフローに対応する段の関数と、そこから呼ぶ関数 (run_in など) と、関数の外 (npm ci などの前準備) だけ。
 *     別の段にある似たコマンドで満たしたことにはしない。
 *   - ワークフローの run の各コマンド (シェルの制御・待ち・表示は PLUMBING_COMMANDS で理由つきで除く) は、
 *     スクリプトの 1 つのコマンドの先頭に、同じ語の並びで現れなければならない。配列 ("${INTEG1_ARGS[@]}") と
 *     定数 (readonly NAME="値") は展開してから比べる。後ろに足してよいのは結果を JSON で出すための引数 (REPORTING_FLAGS) だけ、
 *     前に置いてよい環境変数は、そのステップの env と REPORTING_ENV だけ。作業ディレクトリ (working-directory) も比べる。
 *   - ステップの env は、そのコマンドの前に置くか、ci_env (全コマンドの環境を作る関数) で export していなければならない。
 *     ワークフロー / ジョブの env は ci_env で export していなければならない (ACTIONS_ONLY_ENV は理由つきで除く)。
 *   - uses のアクション・ジョブやステップのキー・ステップの if は、知っているもの (理由つきの対応表) だけを受け付ける。
 *     知らないものが出てきたら赤にする (読み飛ばして緑にしない)。
 *   - スクリプトのコメント (# 以降) は読まない (コメントに書いただけで通ることを防ぐ)。
 *   - 枠 (slot) で変わる値 (apply_slot の代入。ポートと URL) は、枠 0 の値に置き換えて照合する。CI は枠を指定しない (= 枠 0) ので、
 *     枠 0 の値が yml と同じでなければならない。枠 0 の値は scripts/lib/local-ci-slot.sh を実際に実行して得る (文字列で推測しない)。
 *     置き換えられない代入 (知らない変数を使うもの) は展開しない (= yml の値と一致せず赤になる)。
 */

import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const SCRIPT = "scripts/local-ci.sh";
const NVMRC = ".nvmrc";
/** 枠 (slot) ごとの値を決めるスクリプト (`bash <これ> <枠>` で SLOT_*=値 を出す) */
const SLOT_LIB = "scripts/lib/local-ci-slot.sh";
/** スクリプトで、枠の値を段が使う変数に入れる関数 */
const SLOT_FUNCTION = "apply_slot";
/** CI が使う枠 (yml は枠を指定しない。supabase-local.sh / local-ci.sh の既定) */
const CI_SLOT = "0";

/** ワークフローと、それを写したスクリプトの段 (関数) */
const WORKFLOW_STAGES = {
  ".github/workflows/ci.yml": "stage_unit",
  ".github/workflows/mobile-test.yml": "stage_mobile",
  ".github/workflows/security-regression.yml": "stage_integration",
  ".github/workflows/e2e-local.yml": "stage_e2e",
} as const;
type WorkflowPath = keyof typeof WORKFLOW_STAGES;
const WORKFLOWS = Object.keys(WORKFLOW_STAGES) as WorkflowPath[];

/** スクリプトで作業用 worktree を指す変数。CI の作業ディレクトリ (リポジトリの直下) にあたる */
const WORKTREE_VAR = "$WT";
/** スクリプトで、全コマンドの環境 (CI ランナー相当) を作る関数。ここで export した値は全コマンドに効く */
const CI_ENV_FUNCTION = "ci_env";
/** スクリプトの、作業ディレクトリを最初の引数に取る実行用の関数と、コマンドの前に置く引数の数 (<dir> <log> / <dir> <out> <log>) */
const RUN_WRAPPERS = new Map<string, number>([
  ["run_in", 2],
  ["run_in_stdout", 3],
]);
/** コマンドの前に置かれても、実行するコマンドを変えない語 (シェルの制御語と、exec / nohup / env) */
const COMMAND_PREFIXES = new Set(["if", "then", "else", "elif", "do", "while", "until", "!", "{", "}", "exec", "nohup", "env"]);

/** 照合しないコマンド (シェルの制御・待ち・表示)。理由つき */
const PLUMBING_COMMANDS: Record<string, string> = {
  for: "繰り返しの枠。中で叩く API のパスは別に照合する",
  seq: "待つ回数を数えるだけ (スクリプトは DEV_WAIT_TRIES / START_WAIT_TRIES で写す)",
  sleep: "待つ間隔 (スクリプトは WAIT_INTERVAL_SEC で写す)",
  break: "シェルの制御",
  done: "シェルの制御",
  fi: "シェルの制御",
  true: "失敗を無視する `|| true` の右側",
  echo: "ログの表示とマスク (::add-mask::)。$GITHUB_ENV へ書くものは別に照合する",
};
/** 処理を変えないので、ステップの env を付けなくてよいコマンド */
const ENV_INDEPENDENT_COMMANDS: Record<string, string> = {
  curl: "サーバーの応答を待つ・API を先に叩いてコンパイルさせるだけ",
};
/** ステップの env のうち、そのステップの特定のコマンドには要らないもの */
const STEP_ENV_EXEMPTIONS: ReadonlyArray<{ command: string; key: string; reason: string }> = [
  {
    command: "npm run start",
    key: "NEXT_FONT_GOOGLE_MOCKED_RESPONSES",
    reason: "next/font のモックを読むのは next build だけ。next start はビルド済みのものを配る",
  },
];
/** ワークフロー / ジョブの env のうち、GitHub Actions の動作だけを変え、run のコマンドには効かないもの */
const ACTIONS_ONLY_ENV: Record<string, string> = {
  FORCE_JAVASCRIPT_ACTIONS_TO_NODE24:
    "JavaScript で書かれたアクション (checkout / setup-node) を動かす Node の版を選ぶだけ。run のコマンドの Node は setup-node の版",
};
/** 照合のしかたが分かっている uses のアクション (@ の後ろの版は見ない) */
const HANDLED_ACTIONS: Record<string, string> = {
  "actions/checkout": "作業場所の用意。スクリプトは git worktree add で同じことをする",
  "actions/setup-node": "Node の用意。with の node-version / node-version-file を照合する (cache は速さだけ)",
  "actions/cache": "速さのためのキャッシュ。結果に効かない",
  "actions/upload-artifact": "結果の保存。with の path をスクリプトも残しているかを照合する",
};
const SETUP_NODE = "actions/setup-node";
const UPLOAD_ARTIFACT = "actions/upload-artifact";
const SETUP_NODE_WITH_KEYS = new Set(["node-version", "node-version-file", "cache"]);
/** スクリプトが CI ランナーとして再現している環境 (TZ=UTC・LANG=C.UTF-8 は ubuntu のランナーの値) */
const SUPPORTED_RUNNERS = new Set(["ubuntu-latest"]);
const WORKFLOW_KEYS: Record<string, string> = {
  name: "表示名",
  on: "起動の条件 (ローカルでは明示して回す)",
  concurrency: "同時実行の制御",
  permissions: "GITHUB_TOKEN の権限",
  env: "ci_env と照合する",
  jobs: "ステップを照合する",
};
const JOB_KEYS: Record<string, string> = {
  name: "表示名",
  "runs-on": "SUPPORTED_RUNNERS と照合する",
  "timeout-minutes": "時間切れで止めるだけ。結果の判定は変えない",
  permissions: "GITHUB_TOKEN の権限",
  env: "ci_env と照合する",
  steps: "ステップを照合する",
};
const STEP_KEYS: Record<string, string> = {
  name: "表示名",
  id: "ステップの名前",
  uses: "HANDLED_ACTIONS と照合する",
  with: "アクションごとに照合する",
  run: "コマンドを照合する",
  env: "コマンドの環境変数として照合する",
  if: "STEP_CONDITIONS と照合する",
  "working-directory": "コマンドの作業ディレクトリとして照合する",
};
/**
 * ステップの if のうち、扱いが分かっているもの (`${{ }}` を外した形)。
 * diagnostic = 失敗時のログ表示 (検査の中身ではないので照合しない)。
 * always = 前のステップが落ちても回す (スクリプトは段の中のコマンドを前の結果によらず回す)。
 */
const STEP_CONDITIONS: Record<string, "diagnostic" | "always"> = {
  "failure()": "diagnostic",
  "always()": "always",
  "!cancelled()": "always",
};
/** スクリプトが CI のコマンドの後ろに足してよい引数 (結果を JSON でファイルへ出すためだけのもの)。true は値を次の語に取るもの */
const REPORTING_FLAGS = new Map<string, boolean>([
  ["--", false],
  ["--json", false],
  ["--reporter", true],
  ["--outputFile", true],
  ["--format", true],
  ["--output-file", true],
]);
/** スクリプトがコマンドの前に足してよい環境変数 (結果の JSON の出力先) */
const REPORTING_ENV = ["PLAYWRIGHT_JSON_OUTPUT_NAME"];

const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const NVMRC_MAJOR = read(NVMRC).trim().replace(/^v/, "").split(".")[0];

const has = (obj: object, key: string) => Object.prototype.hasOwnProperty.call(obj, key);

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** シェルのコメント (行頭、または空白の直後の # から行末まで) を除く */
function stripShellComments(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      const m = /(^|\s)#/.exec(line);
      return m ? line.slice(0, m.index) : line;
    })
    .join("\n");
}

// ---------------------------------------------------------------------
// YAML (このリポジトリのワークフローの書き方に必要な範囲だけ。読めない書き方は例外にして赤にする)
// ---------------------------------------------------------------------

type YamlValue = string | null | YamlValue[] | YamlMap;
interface YamlMap {
  [key: string]: YamlValue;
}

const YAML_KEY = /^([A-Za-z0-9_.-]+|"[^"]*"|'[^']*'):(?:\s+(.*))?$/;

function isMap(value: YamlValue | undefined): value is YamlMap {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseYamlScalar(text: string): YamlValue {
  const t = text.trim();
  if (/^[&*!{|>]/.test(t)) throw new Error(`未対応の YAML の値: ${t}`);
  if (t.startsWith('"')) {
    const end = t.indexOf('"', 1);
    if (end < 0) throw new Error(`閉じていない引用符: ${t}`);
    return t.slice(1, end);
  }
  if (t.startsWith("'")) {
    const end = t.indexOf("'", 1);
    if (end < 0) throw new Error(`閉じていない引用符: ${t}`);
    return t.slice(1, end);
  }
  const comment = /\s#/.exec(t);
  const plain = comment ? t.slice(0, comment.index).trim() : t;
  if (plain.startsWith("[")) {
    if (!plain.endsWith("]")) throw new Error(`未対応の YAML の値: ${plain}`);
    const inner = plain.slice(1, -1).trim();
    return inner === "" ? [] : inner.split(",").map((part) => parseYamlScalar(part));
  }
  return plain;
}

function parseYaml(text: string): YamlValue {
  const lines = text.replace(/\r/g, "").split("\n");
  let i = 0;
  const isSeqItem = (t: string) => t === "-" || t.startsWith("- ");
  const peek = (): { indent: number; text: string } | undefined => {
    while (i < lines.length && (lines[i].trim() === "" || lines[i].trim().startsWith("#"))) i += 1;
    if (i >= lines.length) return undefined;
    return { indent: indentOf(lines[i]), text: lines[i].trim() };
  };
  const parseNode = (minIndent: number): YamlValue => {
    const p = peek();
    if (!p || p.indent < minIndent) return null;
    return isSeqItem(p.text) ? parseSeq(p.indent) : parseMap(p.indent);
  };
  const parseBlockScalar = (parentIndent: number, style: string): string => {
    const body: string[] = [];
    while (i < lines.length && (lines[i].trim() === "" || indentOf(lines[i]) > parentIndent)) {
      body.push(lines[i]);
      i += 1;
    }
    while (body.length > 0 && body[body.length - 1].trim() === "") body.pop();
    const filled = body.filter((l) => l.trim() !== "");
    if (filled.length === 0) return "";
    const blockIndent = Math.min(...filled.map(indentOf));
    const content = body.map((l) => l.slice(blockIndent));
    if (style === "|") return content.join("\n");
    if (content.some((l) => /^\s/.test(l))) throw new Error("未対応の YAML: 字下げを深くした行を含む折り返し (>)");
    return content.map((l) => (l === "" ? "\n" : l)).join(" ").replace(/ ?\n ?/g, "\n");
  };
  const parseSeq = (indent: number): YamlValue[] => {
    const items: YamlValue[] = [];
    for (let p = peek(); p && p.indent === indent && isSeqItem(p.text); p = peek()) {
      const content = p.text.slice(1).trim();
      if (content === "") {
        i += 1;
        items.push(parseNode(indent + 1));
        continue;
      }
      if (YAML_KEY.test(content)) {
        const childIndent = indent + p.text.length - p.text.slice(1).trimStart().length;
        lines[i] = " ".repeat(childIndent) + content;
        items.push(parseMap(childIndent));
        continue;
      }
      i += 1;
      items.push(parseYamlScalar(content));
    }
    const after = peek();
    if (after && after.indent > indent) throw new Error(`字下げが合わない (${i + 1} 行目): ${after.text}`);
    return items;
  };
  const parseMap = (indent: number): YamlMap => {
    const map: YamlMap = {};
    for (let p = peek(); p && p.indent === indent && !isSeqItem(p.text); p = peek()) {
      const m = YAML_KEY.exec(p.text);
      if (!m) throw new Error(`YAML を読めない (${i + 1} 行目): ${p.text}`);
      const key = m[1].replace(/^["']|["']$/g, "");
      const rest = m[2] === undefined ? "" : m[2].trim();
      if (has(map, key)) throw new Error(`同じキーが 2 回ある: ${key}`);
      i += 1;
      if (rest === "" || rest.startsWith("#")) {
        const next = peek();
        map[key] = next && next.indent === indent && isSeqItem(next.text) ? parseSeq(indent) : parseNode(indent + 1);
      } else if (/^[|>][-+]?$/.test(rest)) {
        map[key] = parseBlockScalar(indent, rest[0]);
      } else {
        map[key] = parseYamlScalar(rest);
      }
    }
    const after = peek();
    if (after && after.indent > indent) throw new Error(`字下げが合わない (${i + 1} 行目): ${after.text}`);
    return map;
  };
  const root = parseNode(0);
  const left = peek();
  if (left) throw new Error(`読み残しがある (${i + 1} 行目): ${left.text}`);
  return root;
}

// ---------------------------------------------------------------------
// ワークフローの読み取り
// ---------------------------------------------------------------------

interface Step {
  where: string;
  run?: string;
  uses?: string;
  with: Record<string, string>;
  env: Record<string, string>;
  workingDirectory?: string;
  condition?: "diagnostic" | "always";
}

interface Workflow {
  env: Record<string, string>;
  jobs: Array<{ id: string; runsOn?: string; env: Record<string, string>; steps: Step[] }>;
  /** このテストが照合できない書き方 (それぞれ満たされない条件になる) */
  problems: string[];
}

function stringMap(value: YamlValue | undefined, where: string, problems: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  if (value === undefined || value === null) return out;
  if (!isMap(value)) {
    problems.push(`${where} が対応表になっていない`);
    return out;
  }
  for (const [key, v] of Object.entries(value)) {
    if (typeof v === "string") out[key] = v;
    else problems.push(`${where}.${key} が文字列でない`);
  }
  return out;
}

function checkKeys(map: YamlMap, known: Record<string, string>, where: string, problems: string[]): void {
  for (const key of Object.keys(map)) {
    if (!has(known, key)) {
      problems.push(`${where} の未対応のキー \`${key}\` (スクリプトに写して照合を足すか、照合しない理由を書いて対応表に足す)`);
    }
  }
}

function readWorkflow(yamlText: string): Workflow {
  const problems: string[] = [];
  const root = parseYaml(yamlText);
  if (!isMap(root)) throw new Error("ワークフローの最上位が対応表でない");
  checkKeys(root, WORKFLOW_KEYS, "ワークフロー", problems);
  const workflow: Workflow = { env: stringMap(root.env, "env", problems), jobs: [], problems };
  const jobs = root.jobs;
  if (!isMap(jobs)) throw new Error("jobs が無い");
  for (const [id, job] of Object.entries(jobs)) {
    if (!isMap(job)) throw new Error(`jobs.${id} が対応表でない`);
    checkKeys(job, JOB_KEYS, `jobs.${id}`, problems);
    const runsOn = typeof job["runs-on"] === "string" ? job["runs-on"] : undefined;
    const steps: Step[] = [];
    if (!Array.isArray(job.steps)) throw new Error(`jobs.${id}.steps が無い`);
    job.steps.forEach((raw, index) => {
      if (!isMap(raw)) throw new Error(`jobs.${id}.steps[${index}] が対応表でない`);
      const run = typeof raw.run === "string" ? raw.run : undefined;
      const uses = typeof raw.uses === "string" ? raw.uses : undefined;
      const name = typeof raw.name === "string" ? raw.name : undefined;
      const where = `${id}: ${name ?? run?.split("\n")[0] ?? uses ?? `steps[${index}]`}`;
      checkKeys(raw, STEP_KEYS, where, problems);
      const step: Step = {
        where,
        run,
        uses,
        with: stringMap(raw.with, `${where} の with`, problems),
        env: stringMap(raw.env, `${where} の env`, problems),
        workingDirectory: typeof raw["working-directory"] === "string" ? raw["working-directory"] : undefined,
      };
      if (typeof raw.if === "string") {
        const condition = raw.if.replace(/^\$\{\{\s*/, "").replace(/\s*\}\}$/, "").trim();
        if (has(STEP_CONDITIONS, condition)) step.condition = STEP_CONDITIONS[condition];
        else problems.push(`${where} の未対応の if \`${raw.if}\` (STEP_CONDITIONS に扱いを足す)`);
      } else if (raw.if !== undefined) {
        problems.push(`${where} の if が文字列でない`);
      }
      steps.push(step);
    });
    workflow.jobs.push({ id, runsOn, env: stringMap(job.env, `jobs.${id}.env`, problems), steps });
  }
  return workflow;
}

// ---------------------------------------------------------------------
// シェルのコマンドの分解 (ワークフローの run とスクリプトの両方に使う)
// ---------------------------------------------------------------------

interface ShellCommand {
  /** 作業ディレクトリ (run_in の第 1 引数、または同じ行で先に cd した先。分からなければ undefined) */
  dir?: string;
  /** コマンドの前に置いた環境変数 (`env K=V` / `K=V`) */
  env: Map<string, string>;
  /** 前置き (制御語・run_in とその引数・env・exec・nohup・環境変数) を除いた語の並び */
  words: string[];
}

interface Cursor {
  s: string;
  i: number;
}

const SHELL_OPERATOR = /[\s;|&()<>]/;
const COMMAND_SUBSTITUTION = "$(";
const GITHUB_EXPRESSION_OPEN = "${{";
const GITHUB_EXPRESSION_CLOSE = "}}";

function normalizeCommand(raw: string[], cwd: string | undefined): ShellCommand {
  let dir = cwd;
  const env = new Map<string, string>();
  let k = 0;
  while (k < raw.length) {
    const word = raw[k];
    const wrapperArgs = RUN_WRAPPERS.get(word);
    if (wrapperArgs !== undefined) {
      dir = raw[k + 1];
      k += 1 + wrapperArgs;
      continue;
    }
    if (COMMAND_PREFIXES.has(word)) {
      k += 1;
      continue;
    }
    const assignment = /^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/.exec(word);
    if (assignment) {
      env.set(assignment[1], assignment[2]);
      k += 1;
      continue;
    }
    break;
  }
  return { dir, env, words: raw.slice(k) };
}

function readDoubleQuoted(c: Cursor, out: ShellCommand[]): string {
  let text = "";
  while (c.i < c.s.length && c.s[c.i] !== '"') {
    if (c.s[c.i] === "\\" && /[$`"\\\n]/.test(c.s[c.i + 1] ?? "")) {
      text += c.s[c.i + 1];
      c.i += 2;
    } else if (c.s.startsWith(COMMAND_SUBSTITUTION, c.i)) {
      c.i += COMMAND_SUBSTITUTION.length;
      readList(c, out, true, undefined);
      text += "$()";
    } else {
      text += c.s[c.i];
      c.i += 1;
    }
  }
  c.i += 1;
  return text;
}

function readWord(c: Cursor, out: ShellCommand[]): string {
  let word = "";
  while (c.i < c.s.length) {
    const ch = c.s[c.i];
    if (ch === "'") {
      const end = c.s.indexOf("'", c.i + 1);
      const stop = end < 0 ? c.s.length : end;
      word += c.s.slice(c.i + 1, stop);
      c.i = stop + 1;
    } else if (ch === '"') {
      c.i += 1;
      word += readDoubleQuoted(c, out);
    } else if (c.s.startsWith(GITHUB_EXPRESSION_OPEN, c.i)) {
      const end = c.s.indexOf(GITHUB_EXPRESSION_CLOSE, c.i);
      const stop = end < 0 ? c.s.length : end + GITHUB_EXPRESSION_CLOSE.length;
      word += c.s.slice(c.i, stop);
      c.i = stop;
    } else if (c.s.startsWith(COMMAND_SUBSTITUTION, c.i)) {
      c.i += COMMAND_SUBSTITUTION.length;
      readList(c, out, true, undefined);
      word += "$()";
    } else if (ch === "\\") {
      word += c.s[c.i + 1] ?? "";
      c.i += 2;
    } else if (SHELL_OPERATOR.test(ch)) {
      break;
    } else {
      word += ch;
      c.i += 1;
    }
  }
  return word;
}

/** コマンドの並びを読む。`$( ... )` の中のコマンドも out に足す。nested なら対応する `)` で戻る */
function readList(c: Cursor, out: ShellCommand[], nested: boolean, baseDir: string | undefined): void {
  let words: string[] = [];
  let cwd = baseDir;
  const flush = () => {
    if (words.length === 0) return;
    const command = normalizeCommand(words, cwd);
    if (command.words[0] === "cd" && command.words.length === 2) cwd = command.words[1];
    out.push(command);
    words = [];
  };
  while (c.i < c.s.length) {
    const ch = c.s[c.i];
    if (ch === ")") {
      c.i += 1;
      flush();
      if (nested) return;
      cwd = baseDir;
    } else if (ch === "\n") {
      c.i += 1;
      flush();
      cwd = baseDir;
    } else if (ch === " " || ch === "\t" || ch === "\r") {
      c.i += 1;
    } else if (ch === ";" || ch === "|" || ch === "&" || ch === "(") {
      c.i += 1;
      flush();
    } else if (ch === ">" || ch === "<") {
      // リダイレクト: 直前に付いた fd の番号 (2>&1 の 2) と、行き先の語を捨てる
      const last = words[words.length - 1];
      if (last !== undefined && /^\d+$/.test(last) && /\d/.test(c.s[c.i - 1] ?? "")) words.pop();
      while (c.i < c.s.length && /[<>&]/.test(c.s[c.i])) c.i += 1;
      while (c.s[c.i] === " " || c.s[c.i] === "\t") c.i += 1;
      readWord(c, out);
    } else {
      const start = c.i;
      const word = readWord(c, out);
      if (c.i === start) c.i += 1;
      if (word !== "") words.push(word);
    }
  }
  flush();
}

function shellCommands(text: string, baseDir?: string): ShellCommand[] {
  const out: ShellCommand[] = [];
  readList({ s: text.replace(/\\\n/g, " "), i: 0 }, out, false, baseDir);
  return out;
}

// ---------------------------------------------------------------------
// スクリプトの読み取り
// ---------------------------------------------------------------------

interface Scope {
  /** 照合する範囲のコマンド */
  commands: ShellCommand[];
  /** 照合する範囲のコード (コメント除去・展開済み) */
  code: string;
  /** ci_env が export する環境変数 */
  ciEnv: Map<string, string>;
}

interface ParsedScript {
  functions: Map<string, string>;
  topLevel: string;
}

/** 枠 0 の SLOT_* の値 (scripts/lib/local-ci-slot.sh を実行して得る) */
let slotZeroCache: Map<string, string> | undefined;
function slotZeroValues(): Map<string, string> {
  if (slotZeroCache) return slotZeroCache;
  const out = execFileSync("bash", [SLOT_LIB, CI_SLOT], { cwd: ROOT, encoding: "utf8" });
  const values = new Map<string, string>();
  for (const line of out.split("\n")) {
    const m = /^(SLOT_[A-Z0-9_]+)=(.*)$/.exec(line);
    if (m) values.set(m[1], m[2]);
  }
  if (values.size === 0) throw new Error(`${SLOT_LIB} ${CI_SLOT} が値を出さない`);
  slotZeroCache = values;
  return values;
}

/**
 * apply_slot の `NAME="..."` の代入を、枠 0 の値に置き換えた定数にする。
 * 右辺に使えるのは定数 (readonly) と、枠 0 の SLOT_* と、先に置き換えた代入だけ。それ以外を含む代入は展開しない。
 */
function slotConstants(lines: string[], constants: Map<string, string>): Map<string, string> {
  const result = new Map<string, string>();
  const start = lines.findIndex((line) => new RegExp(`^${SLOT_FUNCTION}\\(\\)\\s*\\{\\s*$`).test(line));
  if (start < 0) return result;
  const known = new Map<string, string>([...constants, ...slotZeroValues()]);
  for (let k = start + 1; k < lines.length && !/^\}\s*$/.test(lines[k]); k += 1) {
    const a = /^\s*([A-Z][A-Z0-9_]*)="([^"`\\]*)"\s*$/.exec(lines[k]);
    if (!a) continue;
    let unknown = false;
    const value = a[2].replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (whole, braced?: string, bare?: string) => {
      const name = braced ?? bare ?? "";
      const v = known.get(name);
      if (v === undefined) {
        unknown = true;
        return whole;
      }
      return v;
    });
    if (unknown || value.includes("$")) continue;
    result.set(a[1], value);
    known.set(a[1], value);
  }
  return result;
}

/**
 * スクリプトを関数ごとに分ける。コメントと、複数行の '...' (埋め込みの JavaScript) を除き、
 * 行の継続をつなぎ、配列 (NAME=(...)) と定数 (readonly NAME="値") を展開する。
 */
function parseScript(scriptText: string): ParsedScript {
  const lines: string[] = [];
  const raw = stripShellComments(scriptText).replace(/\\\n/g, " ").split("\n");
  for (let k = 0; k < raw.length; k += 1) {
    if (/^\s*(?:readonly\s+)?[A-Z][A-Z0-9_]*='[^']*$/.test(raw[k])) {
      k += 1;
      while (k < raw.length && !raw[k].includes("'")) k += 1;
      continue;
    }
    lines.push(raw[k]);
  }
  const arrays = new Map<string, string>();
  const constants = new Map<string, string>();
  const kept: string[] = [];
  for (const line of lines) {
    const a = /^\s*([A-Z][A-Z0-9_]*)=\(([^()]*)\)\s*$/.exec(line);
    if (a) {
      arrays.set(a[1], a[2].trim());
      continue;
    }
    // 定数は readonly で宣言したものだけ (WT="" のように後で値が変わる変数は展開しない)
    const m = /^\s*readonly\s+([A-Z][A-Z0-9_]*)=(?:"([^"$`\\]*)"|'([^']*)'|([^\s"'$`;()]*))\s*$/.exec(line);
    if (m) constants.set(m[1], m[2] ?? m[3] ?? m[4] ?? "");
    kept.push(line);
  }
  for (const [name, value] of slotConstants(kept, constants)) constants.set(name, value);
  let code = kept.join("\n");
  for (const [name, value] of arrays) {
    code = code.replace(new RegExp(`"?\\$\\{${name}\\[@\\]\\}"?`, "g"), value);
  }
  for (const [name, value] of constants) {
    code = code
      .replace(new RegExp(`\\$\\{${name}\\}`, "g"), value)
      .replace(new RegExp(`\\$${name}(?![A-Za-z0-9_])`, "g"), value);
  }
  const functions = new Map<string, string>();
  const topLevel: string[] = [];
  const codeLines = code.split("\n");
  for (let k = 0; k < codeLines.length; k += 1) {
    const f = /^([a-z_][a-z0-9_]*)\(\)\s*\{(.*)$/.exec(codeLines[k]);
    if (!f) {
      topLevel.push(codeLines[k]);
      continue;
    }
    const rest = f[2].trim();
    if (rest.endsWith("}")) {
      functions.set(f[1], rest.slice(0, -1));
      continue;
    }
    const body: string[] = [rest];
    k += 1;
    while (k < codeLines.length && !/^\}\s*$/.test(codeLines[k])) {
      body.push(codeLines[k]);
      k += 1;
    }
    functions.set(f[1], body.join("\n"));
  }
  return { functions, topLevel: topLevel.join("\n") };
}

/** 段の関数と、そこから (たどって) 呼ぶ関数と、関数の外のコード。段の関数が無ければ例外 */
function buildScope(scriptText: string, stage: string): Scope {
  const { functions, topLevel } = parseScript(scriptText);
  if (!functions.has(stage)) throw new Error(`${SCRIPT} に段の関数 ${stage} が無い`);
  const reached = new Set<string>([stage]);
  for (const caller of reached) {
    const body = functions.get(caller) ?? "";
    for (const name of functions.keys()) {
      if (!reached.has(name) && new RegExp(`(?<![\\w-])${name}(?![\\w-])`).test(body)) reached.add(name);
    }
  }
  const parts = [topLevel, ...Array.from(reached, (name) => functions.get(name) ?? "")];
  // ci_env の export は、段から ci_env に届くとき (run_in などを経由するとき) だけ効く
  const ciEnv = new Map<string, string>();
  const ciEnvBody = reached.has(CI_ENV_FUNCTION) ? functions.get(CI_ENV_FUNCTION) ?? "" : "";
  for (const command of shellCommands(ciEnvBody)) {
    if (command.words[0] !== "export") continue;
    for (const word of command.words.slice(1)) {
      const a = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(word);
      if (a) ciEnv.set(a[1], a[2]);
    }
  }
  return { commands: parts.flatMap((part) => shellCommands(part)), code: parts.join("\n"), ciEnv };
}

// ---------------------------------------------------------------------
// 照合
// ---------------------------------------------------------------------

interface Requirement {
  /** 何を確かめるか (失敗の表示用) */
  label: string;
  satisfiedBy: (scope: Scope) => boolean;
}

interface ExpectedCommand {
  words: string[];
  /** 期待する作業ディレクトリ。undefined なら作業場所の直下 (または作業ディレクトリに依らない) */
  dir?: string;
  /** コマンドの前か ci_env に、この値で渡っていなければならない環境変数 */
  requiredEnv: Map<string, string>;
  /** コマンドの前に置いてよい環境変数の名前 */
  allowedEnvKeys: Set<string>;
}

/** 環境変数の値の照合 (`${{ ... }}` の部分は何が来てもよい) */
function envValuePattern(value: string): RegExp {
  const parts = value.split(/\$\{\{[^}]*\}\}/).map(escapeRegExp);
  return new RegExp(`^${parts.join(".*?")}$`);
}

/** コードの中に `KEY=value` があるか (`${{ ... }}` の部分は任意) */
function envInCode(key: string, value: string): RegExp {
  const parts = value.split(/\$\{\{[^}]*\}\}/).map(escapeRegExp);
  return new RegExp(`(?<![A-Za-z0-9_])${escapeRegExp(key)}=["']?${parts.join("\\S*?")}(?=["'\\s]|$)`);
}

function isReportingOnly(extra: string[]): boolean {
  for (let k = 0; k < extra.length; k += 1) {
    const word = extra[k];
    const eq = word.indexOf("=");
    const flag = eq > 0 ? word.slice(0, eq) : word;
    const takesValue = REPORTING_FLAGS.get(flag);
    if (takesValue === undefined) return false;
    if (takesValue && eq < 0) k += 1;
  }
  return true;
}

function commandMatches(command: ShellCommand, expected: ExpectedCommand, ciEnv: Map<string, string>): boolean {
  const { words } = expected;
  if (command.words.length < words.length || words.some((w, k) => command.words[k] !== w)) return false;
  if (!isReportingOnly(command.words.slice(words.length))) return false;
  if (expected.dir === undefined) {
    if (command.dir !== undefined && command.dir !== WORKTREE_VAR) return false;
  } else if (command.dir !== expected.dir) {
    return false;
  }
  for (const key of command.env.keys()) {
    if (!expected.allowedEnvKeys.has(key)) return false;
  }
  for (const [key, value] of expected.requiredEnv) {
    const actual = command.env.has(key) ? command.env.get(key) : ciEnv.get(key);
    if (actual === undefined || !envValuePattern(value).test(actual)) return false;
  }
  return true;
}

function unsatisfiable(label: string): Requirement {
  return { label, satisfiedBy: () => false };
}

function stepRequirements(step: Step): Requirement[] {
  const requirements: Requirement[] = [];
  const { where } = step;
  if (step.uses !== undefined) {
    const action = step.uses.split("@")[0];
    if (!has(HANDLED_ACTIONS, action)) {
      requirements.push(unsatisfiable(`未対応のアクション ${step.uses} (${where}。スクリプトに写して HANDLED_ACTIONS に足す)`));
    }
    if (Object.keys(step.env).length > 0) requirements.push(unsatisfiable(`uses のステップの env は照合できない (${where})`));
    if (action === SETUP_NODE) {
      for (const [key, value] of Object.entries(step.with)) {
        if (!SETUP_NODE_WITH_KEYS.has(key)) requirements.push(unsatisfiable(`setup-node の未対応の with \`${key}\` (${where})`));
        if (key === "node-version") {
          requirements.push({
            label: `Node の版 ${value} が .nvmrc (${NVMRC_MAJOR}) と同じで、スクリプトが .nvmrc で版を確かめる (${where})`,
            satisfiedBy: (scope) => value.replace(/^v/, "").split(".")[0] === NVMRC_MAJOR && scope.code.includes(NVMRC),
          });
        }
        if (key === "node-version-file") {
          requirements.push({
            label: `Node の版を ${value} から読む (${where})`,
            satisfiedBy: (scope) => value === NVMRC && scope.code.includes(NVMRC),
          });
        }
      }
    }
    if (action === UPLOAD_ARTIFACT && step.with.path !== undefined) {
      const kept = step.with.path.replace(/\/+$/, "");
      requirements.push({ label: `結果の保存 ${kept} (${where})`, satisfiedBy: (scope) => scope.code.includes(kept) });
    }
  }
  if (step.run === undefined) return requirements;

  const run = stripShellComments(step.run);
  for (const line of run.split("\n")) {
    if (!/GITHUB_(ENV|PATH|OUTPUT)/.test(line)) continue;
    const m = /^\s*echo\s+["']?([A-Za-z_][A-Za-z0-9_]*)=.*>>\s*["']?\$\{?GITHUB_ENV\}?["']?\s*$/.exec(line);
    if (!m) {
      requirements.push(unsatisfiable(`読めない GITHUB_* への書き込み \`${line.trim()}\` (${where})`));
      continue;
    }
    const key = m[1];
    requirements.push({
      label: `後のステップへ渡す環境変数 ${key} (${where})`,
      satisfiedBy: (scope) => new RegExp(`(?<![A-Za-z0-9_])${key}=`).test(scope.code),
    });
  }

  const stepEnvUsed = new Set<string>();
  let commandCount = 0;
  for (const command of shellCommands(run)) {
    const program = command.words[0];
    if (program === undefined || has(PLUMBING_COMMANDS, program)) continue;
    commandCount += 1;
    const text = command.words.join(" ");
    const requiredEnv = new Map<string, string>();
    for (const [key, value] of command.env) {
      if (value.includes("$")) {
        requirements.push({
          label: `環境変数 ${key} (実行時に作る値。${where})`,
          satisfiedBy: (scope) => new RegExp(`(?<![A-Za-z0-9_])${key}=`).test(scope.code),
        });
      } else {
        requiredEnv.set(key, value);
      }
    }
    if (!has(ENV_INDEPENDENT_COMMANDS, program)) {
      for (const [key, value] of Object.entries(step.env)) {
        if (STEP_ENV_EXEMPTIONS.some((e) => e.command === text && e.key === key)) continue;
        requiredEnv.set(key, value);
        stepEnvUsed.add(key);
      }
    }
    const expected: ExpectedCommand = {
      words: command.words,
      dir: step.workingDirectory === undefined ? undefined : `${WORKTREE_VAR}/${step.workingDirectory}`,
      requiredEnv,
      allowedEnvKeys: new Set([...Object.keys(step.env), ...command.env.keys(), ...REPORTING_ENV]),
    };
    const envText = Array.from(requiredEnv, ([k, v]) => ` ${k}=${v}`).join("");
    const dirText = expected.dir === undefined ? "" : ` (作業ディレクトリ ${step.workingDirectory})`;
    requirements.push({
      label: `コマンド \`${text}\`${envText ? ` (環境変数${envText})` : ""}${dirText} (${where})`,
      satisfiedBy: (scope) => scope.commands.some((c) => commandMatches(c, expected, scope.ciEnv)),
    });
  }
  for (const [key, value] of Object.entries(step.env)) {
    if (stepEnvUsed.has(key)) continue;
    const pattern = envInCode(key, value);
    requirements.push({ label: `環境変数 ${key}=${value} (${where})`, satisfiedBy: (scope) => pattern.test(scope.code) });
  }
  if (step.workingDirectory !== undefined && commandCount === 0) {
    const dir = step.workingDirectory;
    requirements.push({ label: `working-directory ${dir} (${where})`, satisfiedBy: (scope) => scope.code.includes(dir) });
  }
  for (const m of run.matchAll(/http:\/\/localhost:\d+[^\s"')$;]*/g)) {
    const url = m[0];
    requirements.push({ label: `URL ${url} (${where})`, satisfiedBy: (scope) => scope.code.includes(url) });
  }
  for (const m of run.matchAll(/(?<![\w.:/])\/api\/[\w/-]+/g)) {
    const apiPath = m[0];
    requirements.push({ label: `API のパス ${apiPath} (${where})`, satisfiedBy: (scope) => scope.code.includes(apiPath) });
  }
  return requirements;
}

/** ワークフローの YAML から、スクリプトの段が満たすべき条件を作る */
function requirementsOf(yamlText: string): Requirement[] {
  let workflow: Workflow;
  try {
    workflow = readWorkflow(yamlText);
  } catch (e) {
    return [unsatisfiable(`ワークフローを読めない: ${e instanceof Error ? e.message : String(e)}`)];
  }
  const requirements = workflow.problems.map(unsatisfiable);
  const globalEnv = [workflow.env, ...workflow.jobs.map((j) => j.env)];
  for (const env of globalEnv) {
    for (const [key, value] of Object.entries(env)) {
      if (has(ACTIONS_ONLY_ENV, key)) continue;
      requirements.push({
        label: `ワークフロー / ジョブの環境変数 ${key}=${value} (${CI_ENV_FUNCTION} で export する)`,
        satisfiedBy: (scope) => {
          const actual = scope.ciEnv.get(key);
          return actual !== undefined && envValuePattern(value).test(actual);
        },
      });
    }
  }
  for (const job of workflow.jobs) {
    if (job.runsOn === undefined || !SUPPORTED_RUNNERS.has(job.runsOn)) {
      requirements.push(unsatisfiable(`未対応のランナー ${job.runsOn ?? "(無し)"} (jobs.${job.id}。SUPPORTED_RUNNERS を見直す)`));
    }
    for (const step of job.steps) {
      if (step.condition === "diagnostic") continue;
      requirements.push(...stepRequirements(step));
    }
  }
  return requirements;
}

function unmet(requirements: Requirement[], scope: Scope): string[] {
  return requirements.filter((r) => !r.satisfiedBy(scope)).map((r) => r.label);
}

/** ワークフローが検査として回すコマンド (照合の対象になるもの) */
function workflowCommands(yamlText: string): string[] {
  return readWorkflow(yamlText)
    .jobs.flatMap((j) => j.steps)
    .flatMap((s) => (s.condition === "diagnostic" || s.run === undefined ? [] : shellCommands(stripShellComments(s.run))))
    .map((c) => c.words)
    .filter((w) => w.length > 0 && !has(PLUMBING_COMMANDS, w[0]))
    .map((w) => w.join(" "));
}

// ---------------------------------------------------------------------
// テスト
// ---------------------------------------------------------------------

describe("scripts/local-ci.sh が CI のワークフローと同じコマンド・対象・環境変数で回している", () => {
  const scriptText = read(SCRIPT);

  it("ワークフローから検査に要る値を読み取れていて、スクリプトの各段も読めている (読み取りが空のまま全部通ることを防ぐ)", () => {
    const commands = WORKFLOWS.flatMap((w) => workflowCommands(read(w)));
    expect(commands).toEqual(
      expect.arrayContaining([
        "npm ci",
        "npm run typecheck",
        "npm run lint",
        "npm test",
        "npm test -- --ci --coverage",
        "npm run test -- --run packages/core",
        "openssl rand -hex 16",
        "curl -s -o /dev/null http://localhost:3000/login",
      ]),
    );
    expect(commands.some((c) => c.startsWith("npx vitest run") && c.includes("tests/integration/rls"))).toBe(true);
    expect(commands.some((c) => c.startsWith("npx vitest run") && c.includes("tests/integration/operator/super-admin-"))).toBe(true);
    expect(commands.some((c) => c.startsWith("npx playwright test") && c.includes("tests/e2e/01-login.spec.ts"))).toBe(true);
    const e2eSteps = readWorkflow(read(".github/workflows/e2e-local.yml")).jobs.flatMap((j) => j.steps);
    expect(e2eSteps.flatMap((s) => Object.keys(s.env))).toEqual(
      expect.arrayContaining([
        "PLAYWRIGHT_BASE_URL",
        "E2E_USER_EMAIL",
        "E2E_REQUIRE_LOGIN",
        "PLAYWRIGHT_NO_COPY_PROMPT",
        "NEXT_FONT_GOOGLE_MOCKED_RESPONSES",
      ]),
    );
    for (const workflow of WORKFLOWS) {
      const scope = buildScope(scriptText, WORKFLOW_STAGES[workflow]);
      expect(scope.commands.length, `${WORKFLOW_STAGES[workflow]} のコマンド`).toBeGreaterThan(0);
      expect(scope.ciEnv.get("TZ"), `${CI_ENV_FUNCTION} の TZ`).toBe("UTC");
      expect(scope.ciEnv.get("CI"), `${CI_ENV_FUNCTION} の CI`).toBe("true");
    }
  });

  for (const workflow of WORKFLOWS) {
    it(`${workflow} のコマンド・対象・環境変数が local-ci.sh の ${WORKFLOW_STAGES[workflow]} にもある`, () => {
      const requirements = requirementsOf(read(workflow));
      expect(requirements.length).toBeGreaterThan(0);
      expect(
        unmet(requirements, buildScope(scriptText, WORKFLOW_STAGES[workflow])),
        `${workflow} が変わったのに ${SCRIPT} が追随していません。スクリプトを直してください (yml が正)。`,
      ).toEqual([]);
    });
  }
});

describe("検査ロジック自体 (ワークフローやスクリプトを変えた写しで赤になること)", () => {
  const scriptText = read(SCRIPT);
  const scopeOf = (workflow: WorkflowPath, text = scriptText) => buildScope(text, WORKFLOW_STAGES[workflow]);

  it("実際のワークフローの一部を変えると、満たされない条件として検出する", () => {
    const mutations: Array<[WorkflowPath, string, string]> = [
      // spec を足す
      [".github/workflows/e2e-local.yml", "tests/e2e/05-shopping-list.spec.ts", "tests/e2e/05-shopping-list.spec.ts tests/e2e/06-new.spec.ts"],
      // 環境変数の値を変える / 新しい環境変数を足す
      [".github/workflows/e2e-local.yml", 'E2E_REQUIRE_LOGIN: "1"', 'E2E_REQUIRE_LOGIN: "0"'],
      [".github/workflows/e2e-local.yml", 'PLAYWRIGHT_NO_COPY_PROMPT: "1"', 'PLAYWRIGHT_NO_COPY_PROMPT: "1"\n          E2E_NEW_FLAG: "1"'],
      // フォントのモックの場所を変える
      [".github/workflows/e2e-local.yml", "tests/e2e/fixtures/google-fonts-mock.cjs", "tests/e2e/fixtures/other-mock.cjs"],
      // 失敗時に上げる結果の場所を変える
      [".github/workflows/e2e-local.yml", "path: tests/e2e/.output/", "path: tests/e2e/.other/"],
      // 結合テストの対象パスを足す
      [".github/workflows/security-regression.yml", "tests/integration/handson-tour\n", "tests/integration/handson-tour tests/integration/billing\n"],
      // 事前コンパイルする API を足す
      [".github/workflows/security-regression.yml", "/api/menu-plans/add;", "/api/menu-plans/add /api/new-route;"],
      // ワークフロー全体の環境変数を足す
      [".github/workflows/security-regression.yml", "  FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: true", "  FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: true\n  NODE_ENV: test"],
      // 2 本目の実行条件を変える
      [".github/workflows/security-regression.yml", "if: ${{ !cancelled() }}", "if: success()"],
      // ci.yml にステップを足す (npm / node)
      [".github/workflows/ci.yml", "      - run: npm test", "      - run: npm test\n      - run: npm run check:new"],
      [".github/workflows/ci.yml", "      - run: npm test", "      - run: npm test\n      - run: node scripts/check.mjs"],
      // npm test に引数を足す (カバレッジのしきい値 / 対象を絞る)。別の段にある同じ引数で満たしたことにしない
      [".github/workflows/ci.yml", "      - run: npm test", "      - run: npm test -- --coverage"],
      [".github/workflows/ci.yml", "      - run: npm test", "      - run: npm test -- packages/core"],
      // ジョブ / ワークフローの環境変数を足す
      [".github/workflows/ci.yml", "    runs-on: ubuntu-latest", "    runs-on: ubuntu-latest\n    env:\n      TZ: Asia/Tokyo"],
      [".github/workflows/ci.yml", "jobs:", 'env:\n  NEW_FLAG: "1"\njobs:'],
      // 知らないアクション・ジョブのキー・ランナー・Node の版
      [".github/workflows/ci.yml", "      - run: npm ci", "      - uses: some/test-action@v1\n      - run: npm ci"],
      [".github/workflows/ci.yml", "    runs-on: ubuntu-latest", "    runs-on: ubuntu-latest\n    strategy:\n      matrix:\n        node: [20, 22]"],
      [".github/workflows/ci.yml", "runs-on: ubuntu-latest", "runs-on: macos-latest"],
      [".github/workflows/ci.yml", "node-version: '22'", "node-version: '20'"],
      // jest の引数を変える (足す / 減らす)
      [".github/workflows/mobile-test.yml", "npm test -- --ci --coverage", "npm test -- --ci --coverage --maxWorkers=2"],
      [".github/workflows/mobile-test.yml", "npm test -- --ci --coverage", "npm test -- --ci"],
      // 作業ディレクトリを変える / 知らないステップのキーを足す
      [".github/workflows/mobile-test.yml", "working-directory: apps/mobile", "working-directory: apps/other"],
      [".github/workflows/mobile-test.yml", "        working-directory: apps/mobile", "        working-directory: apps/mobile\n        continue-on-error: true"],
    ];
    for (const [workflow, from, to] of mutations) {
      const original = read(workflow);
      const scope = scopeOf(workflow);
      expect(original, `写しを作る元の文字列が見つからない: ${from}`).toContain(from);
      expect(unmet(requirementsOf(original), scope)).toEqual([]);
      const mutated = original.split(from).join(to);
      expect(unmet(requirementsOf(mutated), scope).length, `変更が検出されない: ${from} → ${to}`).toBeGreaterThan(0);
    }
  });

  it("ジョブの環境変数は、ci_env が同じ値を export していれば満たす", () => {
    const ci = read(".github/workflows/ci.yml");
    const mutated = ci.split("    runs-on: ubuntu-latest").join("    runs-on: ubuntu-latest\n    env:\n      TZ: UTC");
    expect(mutated).not.toBe(ci);
    expect(unmet(requirementsOf(mutated), scopeOf(".github/workflows/ci.yml"))).toEqual([]);
    // 段から ci_env に届かなければ (run_in を通らなければ)、ci_env の export では満たさない
    const yml = ["jobs:", "  test:", "    runs-on: ubuntu-latest", "    env:", "      TZ: UTC", "    steps:", "      - run: npm test"].join("\n");
    const ciEnv = "ci_env() {\n  export TZ=UTC\n}\nrun_in() {\n  ( ci_env && cd \"$1\" && \"${@:3}\" )\n}";
    expect(unmet(requirementsOf(yml), buildScope(`${ciEnv}\nstage_x() {\n  run_in "$WT" "$log" npm test\n}`, "stage_x"))).toEqual([]);
    expect(unmet(requirementsOf(yml), buildScope(`${ciEnv}\nstage_x() {\n  npm test\n}`, "stage_x"))).toHaveLength(1);
  });

  it("スクリプトの一部を変えると、満たされない条件として検出する", () => {
    const mutations: Array<[WorkflowPath, string, string]> = [
      // unit の vitest を消す (mobile の `npm test --silent` や `npm test -- --ci` で満たしたことにしない)
      [
        ".github/workflows/ci.yml",
        '  run_in "$WT" "$log" npm test -- --reporter=default --reporter=json --outputFile="$ART/unit-vitest.json"\n',
        "",
      ],
      // CI に無い環境変数を前に置く (ヒープを盛る)
      [".github/workflows/ci.yml", 'run_in "$WT" "$log" npm test --', 'run_in "$WT" "$log" env NODE_OPTIONS=--max-old-space-size=8192 npm test --'],
      // 対象を絞る引数を後ろに足す
      [".github/workflows/ci.yml", '--outputFile="$ART/unit-vitest.json"', '--outputFile="$ART/unit-vitest.json" tests/unit'],
      // jest を apps/mobile でなく直下で回す
      [".github/workflows/mobile-test.yml", 'run_in "$WT/apps/mobile" "$log" npm test -- --ci', 'run_in "$WT" "$log" npm test -- --ci'],
      // Playwright の環境変数を落とす
      [".github/workflows/e2e-local.yml", " E2E_REQUIRE_LOGIN=1 PLAYWRIGHT_NO_COPY_PROMPT=1", " PLAYWRIGHT_NO_COPY_PROMPT=1"],
      // 結合テストの対象 (配列) を減らす
      [".github/workflows/security-regression.yml", " tests/integration/handson-tour)", ")"],
      // 段の関数の名前を変える (照合する範囲が無くなる)
      [".github/workflows/mobile-test.yml", "stage_mobile() {", "stage_mobile_renamed() {"],
      // 枠 0 のアプリの URL を、CI と違うポートにする (枠の値は枠 0 で照合する)
      [".github/workflows/e2e-local.yml", 'APP_ORIGIN="$APP_HOST_URL:$SLOT_APP_PORT"', 'APP_ORIGIN="$APP_HOST_URL:$SLOT_NOTICE_APP_PORT"'],
      [".github/workflows/e2e-local.yml", 'ENFORCED_APP_PORT="$SLOT_ENFORCED_APP_PORT"', 'ENFORCED_APP_PORT="$SLOT_APP_PORT"'],
      // 枠の値を、枠 0 の値に置き換えられない形にする (照合で満たしたことにしない)
      [".github/workflows/security-regression.yml", 'APP_ORIGIN="$APP_HOST_URL:$SLOT_APP_PORT"', 'APP_ORIGIN="$APP_HOST_URL:$SOME_PORT"'],
    ];
    for (const [workflow, from, to] of mutations) {
      expect(scriptText, `写しを作る元の文字列が見つからない: ${from}`).toContain(from);
      const mutated = scriptText.split(from).join(to);
      const requirements = requirementsOf(read(workflow));
      let missing: string[];
      try {
        missing = unmet(requirements, scopeOf(workflow, mutated));
      } catch (e) {
        missing = [String(e)];
      }
      expect(missing.length, `スクリプトの変更が検出されない: ${from} → ${to}`).toBeGreaterThan(0);
    }
  });

  it("スクリプトのコメントに書いただけのコマンドや環境変数は、満たしたことにならない", () => {
    const yml = [
      "jobs:",
      "  test:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - name: Run",
      "        env:",
      '          E2E_REQUIRE_LOGIN: "1"',
      "        run: >",
      "          npx vitest run --config vitest.integration.config.ts",
      "          tests/integration/rls",
    ].join("\n");
    const commentOnly = buildScope(
      [
        "stage_x() {",
        "  # npx vitest run --config vitest.integration.config.ts tests/integration/rls",
        "  echo hi # E2E_REQUIRE_LOGIN=1 npx vitest run --config vitest.integration.config.ts tests/integration/rls",
        "}",
      ].join("\n"),
      "stage_x",
    );
    expect(unmet(requirementsOf(yml), commentOnly)).toHaveLength(1);
    const real = buildScope(
      [
        "ARGS=(--config vitest.integration.config.ts tests/integration/rls)",
        "stage_x() {",
        '  run_in "$WT" "$log" env E2E_REQUIRE_LOGIN=1 npx vitest run "${ARGS[@]}" --reporter=json --outputFile="$ART/x.json"',
        "}",
      ].join("\n"),
      "stage_x",
    );
    expect(unmet(requirementsOf(yml), real)).toEqual([]);
    // 別の関数 (段から呼ばない) にあるだけでは満たさない
    const elsewhere = buildScope(
      [
        "ARGS=(--config vitest.integration.config.ts tests/integration/rls)",
        "stage_x() {",
        "  :",
        "}",
        "stage_y() {",
        '  run_in "$WT" "$log" env E2E_REQUIRE_LOGIN=1 npx vitest run "${ARGS[@]}"',
        "}",
      ].join("\n"),
      "stage_x",
    );
    expect(unmet(requirementsOf(yml), elsewhere)).toHaveLength(1);
  });

  it("定数 (readonly NAME=\"値\") を展開して照合し、`${{ ... }}` を含む環境変数は残りの部分で照合する", () => {
    const yml = [
      "jobs:",
      "  build:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - name: Build",
      "        env:",
      "          FONT_MOCK: ${{ github.workspace }}/tests/e2e/fixtures/mock.cjs",
      "        run: |",
      "          npm run build",
      "          curl -s -o /dev/null http://localhost:3000/login",
    ].join("\n");
    const script = (fontPath: string) =>
      buildScope(
        [
          'readonly ORIGIN="http://localhost:3000"',
          "stage_x() {",
          `  if ! run_in "$WT" "$log" env FONT_MOCK="$WT/${fontPath}" npm run build; then return 1; fi`,
          '  curl -s -o /dev/null "${ORIGIN}/login"',
          "}",
        ].join("\n"),
        "stage_x",
      );
    expect(unmet(requirementsOf(yml), script("tests/e2e/fixtures/mock.cjs"))).toEqual([]);
    expect(unmet(requirementsOf(yml), script("other.cjs"))).toHaveLength(1);
  });

  it("失敗時のログ表示のステップと、知っているアクションのステップは、コマンドの条件に入れない", () => {
    const yml = [
      "jobs:",
      "  test:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - uses: actions/checkout@v4",
      "      - uses: actions/cache@v4",
      "        with:",
      "          path: ~/.cache/x",
      "      - name: Show logs on failure",
      "        if: failure()",
      "        run: |",
      "          npm run diagnose",
    ].join("\n");
    expect(requirementsOf(yml)).toEqual([]);
  });

  it("読めない YAML (アンカーなど) は、読み飛ばさずに満たされない条件にする", () => {
    const yml = ["jobs:", "  test: &anchor", "    runs-on: ubuntu-latest"].join("\n");
    const requirements = requirementsOf(yml);
    expect(requirements).toHaveLength(1);
    expect(requirements[0].satisfiedBy(buildScope("stage_x() {\n  :\n}", "stage_x"))).toBe(false);
  });
});
