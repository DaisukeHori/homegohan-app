/**
 * tests/local-ci-workflow-sync.test.ts
 *
 * scripts/local-ci.sh (PR の CI 検査をローカルで回すスクリプト) が、CI のワークフローとずれていないことを確かめる。
 *
 * 背景: local-ci.sh は、次の 4 つのワークフローのコマンド・対象パス・環境変数を写して、ローカルで同じ検査を回す。
 *   - .github/workflows/ci.yml                  (typecheck / lint / vitest)
 *   - .github/workflows/mobile-test.yml         (apps/mobile の jest / packages/core の vitest)
 *   - .github/workflows/security-regression.yml (結合テスト 2 本)
 *   - .github/workflows/e2e-local.yml           (Playwright)
 * ワークフローだけを変えてスクリプトを直し忘れると、「ローカルは緑なのに CI は赤」(またはその逆) になり、
 * ローカルの緑を根拠にマージする運用が成り立たなくなる。
 *
 * そこで、DB もサーバーも使わずにソースだけを見る静的検査にして、通常の `npm test` (PR の CI) に載せる。
 * ワークフローの各ステップ (失敗時のログ表示のステップを除く) から、次を取り出し、スクリプトにも現れることを確かめる。
 *   - 実行するコマンド (npm / npx / bash / openssl で始まるもの。引数込み。vitest に渡す対象パスや Playwright の spec を含む)
 *   - ステップの環境変数 (名前と値。`${{ ... }}` の部分は何が来てもよい)
 *   - 叩く URL と API のパス、working-directory、Node の版 (.nvmrc)
 * スクリプトのコメント (# 以降) は読まない (コメントに書いただけで通ることを防ぐ)。
 * スクリプトの中の `NAME="値"` の定数は、`$NAME` / `${NAME}` を値に置き換えてから照合する。
 */

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const SCRIPT = "scripts/local-ci.sh";
const NVMRC = ".nvmrc";
const WORKFLOWS = [
  ".github/workflows/ci.yml",
  ".github/workflows/mobile-test.yml",
  ".github/workflows/security-regression.yml",
  ".github/workflows/e2e-local.yml",
] as const;

/** 1 つのコマンドを「先頭の語 + 残りの引数」に分けて照合するときの、先頭の語の数 (例: `npx vitest run` / `npx playwright test`) */
const COMMAND_HEAD_WORDS = 3;

interface Step {
  name?: string;
  run?: string;
  if?: string;
  workingDirectory?: string;
  env: Record<string, string>;
}

interface Requirement {
  /** 何を確かめるか (失敗の表示用) */
  label: string;
  /** スクリプトのコード (コメント除去・定数展開・空白の正規化済み) に対して満たされているか */
  satisfiedBy: (code: string) => boolean;
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

function unquote(value: string): string {
  const t = value.trim();
  if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) {
    return t.slice(1, -1);
  }
  return t;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * `key: value` を 1 つ読み、続くブロック (`|` / `>` の文字列、`env:` の対応表、`with:` など) も読み飛ばす。
 * 次に読む行の番号を返す。
 */
function readKey(lines: string[], index: number, keyIndent: number, content: string, step: Step): number {
  const block: string[] = [];
  let next = index + 1;
  while (next < lines.length) {
    const line = lines[next];
    if (line.trim() !== "" && indentOf(line) <= keyIndent) break;
    block.push(line);
    next += 1;
  }
  const m = /^([A-Za-z_-]+):\s*(.*)$/.exec(content);
  if (!m) return next;
  const [, key, rawValue] = m;
  const value = rawValue.trim();
  // ブロックの中身 (空行と、シェル / YAML のコメント行は読まない)
  const body = block.map((l) => l.trim()).filter((l) => l !== "" && !l.startsWith("#"));
  if (key === "run") {
    if (/^>[-+]?$/.test(value)) step.run = body.join(" ");
    else if (/^\|[-+]?$/.test(value)) step.run = body.join("\n");
    else step.run = unquote(value);
  } else if (key === "env" && value === "") {
    for (const line of body) {
      const e = /^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(line);
      if (e) step.env[e[1]] = unquote(e[2]);
    }
  } else if (key === "name") {
    step.name = unquote(value);
  } else if (key === "if") {
    step.if = value;
  } else if (key === "working-directory") {
    step.workingDirectory = unquote(value);
  }
  return next;
}

/** ワークフローの YAML から、各ジョブの steps を読み取る (このリポジトリのワークフローの書き方に必要な範囲だけ) */
function parseSteps(yamlText: string): Step[] {
  const lines = yamlText.split("\n");
  const steps: Step[] = [];
  let i = 0;
  while (i < lines.length) {
    const header = /^(\s*)steps:\s*$/.exec(lines[i]);
    i += 1;
    if (!header) continue;
    const stepsIndent = header[1].length;
    let itemIndent = -1;
    let current: Step | undefined;
    while (i < lines.length) {
      const line = lines[i];
      const trimmed = line.trim();
      if (trimmed === "" || trimmed.startsWith("#")) {
        i += 1;
        continue;
      }
      const indent = indentOf(line);
      if (trimmed.startsWith("- ") && indent >= stepsIndent && (itemIndent < 0 || indent === itemIndent)) {
        itemIndent = indent;
        current = { env: {} };
        steps.push(current);
        i = readKey(lines, i, indent + 2, trimmed.slice(2), current);
        continue;
      }
      if (current && indent === itemIndent + 2) {
        i = readKey(lines, i, indent, trimmed, current);
        continue;
      }
      if (indent <= stepsIndent || (itemIndent >= 0 && indent <= itemIndent)) break;
      i += 1;
    }
  }
  return steps;
}

/** run の中から、スクリプトでも同じ引数で実行すべきコマンドを取り出す (リダイレクト・パイプ・`||` などの手前まで) */
function commandsOf(run: string): string[] {
  const commands: string[] = [];
  for (const line of run.split("\n")) {
    for (const m of line.matchAll(/(?:^|[\s;(&|])((?:npm|npx|bash|openssl)\s[^<>|&;)]*)/g)) {
      const command = m[1].replace(/\s+/g, " ").trim();
      if (command !== "") commands.push(command);
    }
  }
  return commands;
}

/** スクリプトのコードに、コマンドがそのまま (または「先頭の語」と「残りの引数の並び」に分けて) 現れるか */
function containsCommand(code: string, command: string): boolean {
  if (code.includes(command)) return true;
  const words = command.split(" ");
  if (words.length <= COMMAND_HEAD_WORDS) return false;
  return (
    code.includes(words.slice(0, COMMAND_HEAD_WORDS).join(" ")) &&
    code.includes(words.slice(COMMAND_HEAD_WORDS).join(" "))
  );
}

/** ステップの環境変数 `KEY: value` が、スクリプトで `KEY=value` として渡されているか (`${{ ... }}` の部分は任意) */
function envPattern(key: string, value: string): RegExp {
  const parts = value.split(/\$\{\{[^}]*\}\}/).map(escapeRegExp);
  return new RegExp(`(?<![A-Za-z0-9_])${escapeRegExp(key)}=["']?${parts.join("\\S*?")}(?=["'\\s]|$)`);
}

/** 失敗時だけ動く、ログ表示のためのステップ (検査の中身ではない) */
function isDiagnosticStep(step: Step): boolean {
  return /failure\(\)/.test(step.if ?? "");
}

/** ワークフローの YAML から、スクリプトが満たすべき条件を作る */
function requirementsOf(yamlText: string): Requirement[] {
  const requirements: Requirement[] = [];
  for (const step of parseSteps(yamlText)) {
    if (isDiagnosticStep(step)) continue;
    const where = step.name ?? step.run ?? "(名前の無いステップ)";
    if (step.run) {
      for (const command of commandsOf(step.run)) {
        requirements.push({ label: `コマンド \`${command}\` (${where})`, satisfiedBy: (code) => containsCommand(code, command) });
      }
      for (const m of step.run.matchAll(/http:\/\/localhost:\d+[^\s"')$;]*/g)) {
        const url = m[0];
        requirements.push({ label: `URL ${url} (${where})`, satisfiedBy: (code) => code.includes(url) });
      }
      for (const m of step.run.matchAll(/(?<![\w.:/])\/api\/[\w/-]+/g)) {
        const apiPath = m[0];
        requirements.push({ label: `API のパス ${apiPath} (${where})`, satisfiedBy: (code) => code.includes(apiPath) });
      }
    }
    for (const [key, value] of Object.entries(step.env)) {
      const pattern = envPattern(key, value);
      requirements.push({ label: `環境変数 ${key}=${value} (${where})`, satisfiedBy: (code) => pattern.test(code) });
    }
    if (step.workingDirectory) {
      const dir = step.workingDirectory;
      requirements.push({ label: `working-directory ${dir} (${where})`, satisfiedBy: (code) => code.includes(dir) });
    }
  }
  if (/node-version-file:\s*\.nvmrc/.test(yamlText)) {
    requirements.push({ label: "Node の版を .nvmrc から読む", satisfiedBy: (code) => code.includes(NVMRC) });
  }
  return requirements;
}

/**
 * スクリプトから照合用のコードを作る: コメント (行頭、または空白の直後の # から行末まで) を除き、
 * `NAME="値"` の定数を展開し、行の継続 (`\` + 改行) と空白をまとめて 1 行にする。
 */
function scriptCode(scriptText: string): string {
  const lines = scriptText.split("\n").map((line) => {
    const m = /(^|\s)#/.exec(line);
    return m ? line.slice(0, m.index) : line;
  });
  const constants = new Map<string, string>();
  for (const line of lines) {
    const m = /^\s*(?:readonly\s+)?([A-Z][A-Z0-9_]*)=(?:"([^"$`\\]*)"|'([^']*)'|([^\s"'$`;()]*))\s*$/.exec(line);
    if (m) constants.set(m[1], m[2] ?? m[3] ?? m[4] ?? "");
  }
  let code = lines.join("\n").replace(/\\\n/g, " ");
  for (const [name, value] of constants) {
    code = code
      .replace(new RegExp(`\\$\\{${name}\\}`, "g"), value)
      .replace(new RegExp(`\\$${name}(?![A-Za-z0-9_])`, "g"), value);
  }
  return code.replace(/\s+/g, " ");
}

function unmet(requirements: Requirement[], code: string): string[] {
  return requirements.filter((r) => !r.satisfiedBy(code)).map((r) => r.label);
}

const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

describe("scripts/local-ci.sh が CI のワークフローと同じコマンド・対象・環境変数で回している", () => {
  const code = scriptCode(read(SCRIPT));

  it("ワークフローから検査に要る値を読み取れている (読み取りが空のまま全部通ることを防ぐ)", () => {
    const commands = WORKFLOWS.flatMap((w) => parseSteps(read(w)).flatMap((s) => (s.run ? commandsOf(s.run) : [])));
    expect(commands).toEqual(
      expect.arrayContaining(["npm ci", "npm run typecheck", "npm run lint", "npm test", "npm test -- --ci --coverage"]),
    );
    expect(commands.some((c) => c.startsWith("npx vitest run") && c.includes("tests/integration/rls"))).toBe(true);
    expect(commands.some((c) => c.startsWith("npx vitest run") && c.includes("tests/integration/operator/super-admin-"))).toBe(true);
    expect(commands.some((c) => c.startsWith("npx playwright test") && c.includes("tests/e2e/01-login.spec.ts"))).toBe(true);
    const envKeys = parseSteps(read(".github/workflows/e2e-local.yml")).flatMap((s) => Object.keys(s.env));
    expect(envKeys).toEqual(
      expect.arrayContaining([
        "PLAYWRIGHT_BASE_URL",
        "E2E_USER_EMAIL",
        "E2E_REQUIRE_LOGIN",
        "PLAYWRIGHT_NO_COPY_PROMPT",
        "NEXT_FONT_GOOGLE_MOCKED_RESPONSES",
      ]),
    );
  });

  for (const workflow of WORKFLOWS) {
    it(`${workflow} のコマンド・対象・環境変数が local-ci.sh にもある`, () => {
      const requirements = requirementsOf(read(workflow));
      expect(requirements.length).toBeGreaterThan(0);
      expect(
        unmet(requirements, code),
        `${workflow} が変わったのに ${SCRIPT} が追随していません。スクリプトを直してください (yml が正)。`,
      ).toEqual([]);
    });
  }

  it("ワークフローの Node の版 (node-version) が .nvmrc と同じで、スクリプトは .nvmrc で版を確かめる", () => {
    const nvmrcMajor = read(NVMRC).trim().replace(/^v/, "").split(".")[0];
    for (const workflow of WORKFLOWS) {
      const m = /node-version:\s*['"]?(\d+)/.exec(read(workflow));
      if (m) expect(m[1], `${workflow} の node-version`).toBe(nvmrcMajor);
    }
    expect(code).toContain(NVMRC);
  });
});

describe("検査ロジック自体 (ワークフローを変えた写しで赤になること)", () => {
  const scriptText = read(SCRIPT);
  const code = scriptCode(scriptText);

  it("実際のワークフローの一部を変えると、満たされない条件として検出する", () => {
    const e2e = read(".github/workflows/e2e-local.yml");
    const integration = read(".github/workflows/security-regression.yml");
    const ci = read(".github/workflows/ci.yml");
    const mobile = read(".github/workflows/mobile-test.yml");
    const mutations: Array<[string, string, string]> = [
      // spec を足す
      [e2e, "tests/e2e/05-shopping-list.spec.ts", "tests/e2e/05-shopping-list.spec.ts tests/e2e/06-new.spec.ts"],
      // 環境変数の値を変える / 新しい環境変数を足す
      [e2e, 'E2E_REQUIRE_LOGIN: "1"', 'E2E_REQUIRE_LOGIN: "0"'],
      [e2e, 'PLAYWRIGHT_NO_COPY_PROMPT: "1"', 'PLAYWRIGHT_NO_COPY_PROMPT: "1"\n          E2E_NEW_FLAG: "1"'],
      // フォントのモックの場所を変える
      [e2e, "tests/e2e/fixtures/google-fonts-mock.cjs", "tests/e2e/fixtures/other-mock.cjs"],
      // 結合テストの対象パスを足す
      [integration, "tests/integration/handson-tour\n", "tests/integration/handson-tour tests/integration/billing\n"],
      // 事前コンパイルする API を足す
      [integration, "/api/menu-plans/add;", "/api/menu-plans/add /api/new-route;"],
      // ci.yml にステップを足す
      [ci, "      - run: npm test", "      - run: npm test\n      - run: npm run check:new"],
      // jest の引数を変える
      [mobile, "npm test -- --ci --coverage", "npm test -- --ci --coverage --maxWorkers=2"],
    ];
    for (const [original, from, to] of mutations) {
      expect(original, `写しを作る元の文字列が見つからない: ${from}`).toContain(from);
      expect(unmet(requirementsOf(original), code)).toEqual([]);
      const mutated = original.split(from).join(to);
      expect(unmet(requirementsOf(mutated), code).length, `変更が検出されない: ${from} → ${to}`).toBeGreaterThan(0);
    }
  });

  it("スクリプトのコメントに書いただけのコマンドや環境変数は、満たしたことにならない", () => {
    const yml = [
      "jobs:",
      "  test:",
      "    steps:",
      "      - name: Run",
      "        env:",
      '          E2E_REQUIRE_LOGIN: "1"',
      "        run: >",
      "          npx vitest run --config vitest.integration.config.ts",
      "          tests/integration/rls",
    ].join("\n");
    const commentOnly = scriptCode(
      [
        "# npx vitest run --config vitest.integration.config.ts tests/integration/rls",
        "echo hi # E2E_REQUIRE_LOGIN=1",
      ].join("\n"),
    );
    expect(unmet(requirementsOf(yml), commentOnly)).toHaveLength(2);
    const real = scriptCode(
      [
        "ARGS=(--config vitest.integration.config.ts tests/integration/rls)",
        'E2E_REQUIRE_LOGIN=1 npx vitest run "${ARGS[@]}"',
      ].join("\n"),
    );
    expect(unmet(requirementsOf(yml), real)).toEqual([]);
  });

  it("定数 (NAME=\"値\") を展開して照合し、`${{ ... }}` を含む環境変数は残りの部分で照合する", () => {
    const yml = [
      "jobs:",
      "  build:",
      "    steps:",
      "      - name: Build",
      "        env:",
      "          FONT_MOCK: ${{ github.workspace }}/tests/e2e/fixtures/mock.cjs",
      "        run: |",
      "          npm run build",
      "          curl -s -o /dev/null http://localhost:3000/login",
    ].join("\n");
    const script = scriptCode(
      [
        'readonly ORIGIN="http://localhost:3000"',
        'env FONT_MOCK="$WT/tests/e2e/fixtures/mock.cjs" npm run build',
        'curl -s "${ORIGIN}/login"',
      ].join("\n"),
    );
    expect(unmet(requirementsOf(yml), script)).toEqual([]);
    expect(unmet(requirementsOf(yml), scriptCode('env FONT_MOCK="$WT/other.cjs" npm run build'))).toHaveLength(2);
  });

  it("失敗時のログ表示のステップと、uses のステップは条件に入れない", () => {
    const yml = [
      "jobs:",
      "  test:",
      "    steps:",
      "      - uses: actions/setup-node@v4",
      "        with:",
      "          node-version: '22'",
      "      - name: Show logs on failure",
      "        if: failure()",
      "        run: |",
      "          npm run diagnose",
    ].join("\n");
    expect(requirementsOf(yml)).toEqual([]);
  });
});
