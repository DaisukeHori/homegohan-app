// @vitest-environment node
/**
 * tests/local-ci-slot-consumers.test.ts
 *
 * scripts/local-ci.sh の「枠 (slot)」で変わるポート・場所を、テスト・ヘルパー・スクリプトが決め打ちしていないことを検査する。
 * 枠 1 以上ではアプリ (Next) とローカル Supabase のポートがずれる (値の表は scripts/lib/local-ci-slot.sh)。決め打ちが残っていると、
 * 枠 1 で回したテストが枠 0 のサーバー (同時に回っている別の local-ci.sh のもの、または何も無い) に繋がり、
 * 偽の結果・skip になったり、別の実行のデータを書き換えたりする。
 *
 *   1. e2e・integration のテストとヘルパー (Playwright の設定・Maestro のスクリプトを含む) は、ループバックのホストにポートを
 *      付けた URL (http://localhost:3000 など) を `??` / `||` の右 (環境変数などが無いときの既定値) にしか書かない。
 *      枠 0 のポートの既定値なら、その連なりの最初に local-ci.sh が枠の値を入れる環境変数を読む
 *      (integration は INTEGRATION_BASE_URL、e2e は PLAYWRIGHT_BASE_URL か Playwright の baseURL、Supabase は NEXT_PUBLIC_SUPABASE_URL など)。
 *      ポートを表す名前 (port など) に、枠 0 のポートの値をそのまま入れない (名前が DEFAULT_ で始まる既定値の定数は除く)
 *   2. scripts/ と Maestro のシェルは、ローカル Supabase のポートと、アプリのポートを付けたループバックの URL を書かない
 *      (値の表の正本の scripts/lib/local-ci-slot.sh だけが書く)
 *   3. scripts/baseline/drift_report.sh は、LOCAL_CI_SLOT の枠の DB に繋ぎ、結果の既定の置き場も枠ごとに分ける
 *
 * 1 の走査は TypeScript の構文木で行うので、コメントの中の URL (使い方の説明など) には反応しない。
 * 枠 0 のポートの値は scripts/lib/local-ci-slot.sh を実行して得る (このテストに数字を書かない)。
 */

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ts from "typescript";
import { afterAll, describe, expect, it } from "vitest";

const ROOT = process.cwd();
const SLOT_LIB = "scripts/lib/local-ci-slot.sh";
const SUPABASE_LOCAL = "scripts/supabase-local.sh";
const DRIFT_REPORT = "scripts/baseline/drift_report.sh";

/** e2e・integration のテストとヘルパーを置くディレクトリ (Maestro はモバイルの e2e) */
const TEST_CODE_DIRS = ["tests/e2e/", "tests/integration/", "apps/mobile/maestro/"];
/** リポジトリの直下に置く e2e・integration の設定 */
const TEST_CONFIG_FILE = /^(playwright(\.[\w-]+)?\.config\.ts|vitest\.integration\.config\.ts)$/;
const CODE_EXT = /\.(ts|tsx|js|mjs|cjs)$/;
const YAML_EXT = /\.ya?ml$/;
/** 枠で変わるポートを持つスタックを動かすシェルを置くディレクトリ */
const SHELL_DIRS = ["scripts/", "apps/mobile/maestro/"];

/** ループバックのホストにポートを付けた URL (http://localhost:3000 など。ポートの値は問わない) */
const LOOPBACK_WITH_PORT = /(?:^|[^\w.-])(?:[\w-]+\.)*(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):(\d+)/;
/** ポートを表す名前 */
const PORT_NAME = /port/i;
/**
 * 既定値 (?? / || の右) の連なりの最初に読む環境変数。scripts/local-ci.sh が枠の値を入れるもので、最初に読まないと、
 * 枠 1 以上で回しても先に読んだ別の変数 (local-ci.sh は親シェルの環境変数を持ち込まないので無い) を飛ばして既定値 (枠 0) に落ちる
 *   - integration のアプリの URL: INTEGRATION_BASE_URL (local-ci.sh が枠のアプリの URL を export する)
 *   - e2e のアプリの URL: PLAYWRIGHT_BASE_URL (local-ci.sh が Playwright に渡す) か、それで決まる Playwright の baseURL
 *   - ローカル Supabase の URL: NEXT_PUBLIC_SUPABASE_URL / SUPABASE_URL (scripts/supabase-local.sh env が枠の接続先で書く)
 */
const INTEGRATION_APP_ENV = "INTEGRATION_BASE_URL";
const E2E_APP_ENV = "PLAYWRIGHT_BASE_URL";
const PLAYWRIGHT_BASE_URL_NAME = "baseURL";
const SUPABASE_URL_ENVS = ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_URL"];
/** 既定値を入れておく定数の名前 (環境変数が無いときだけ使う値) */
const DEFAULT_NAME = /^DEFAULT_/;

function slotValues(slot: string): Map<string, string> {
  const out = execFileSync("bash", [SLOT_LIB, slot], { cwd: ROOT, encoding: "utf8" });
  const values = new Map<string, string>();
  for (const line of out.split("\n")) {
    const m = /^(SLOT_[A-Z0-9_]+)=(.*)$/.exec(line);
    if (m) values.set(m[1], m[2]);
  }
  return values;
}

const SLOT_ZERO = slotValues("0");
/** 枠 0 のローカル Supabase のポート (範囲 + inspector) */
const SLOT_ZERO_SUPABASE_PORTS = new Set([
  ...(SLOT_ZERO.get("SLOT_SUPABASE_PORTS") ?? "").split(" ").filter(Boolean),
  SLOT_ZERO.get("SLOT_INSPECTOR_PORT") ?? "",
]);
/** 枠 0 のアプリ (Next) のポート */
const SLOT_ZERO_APP_PORTS = new Set(
  ["SLOT_APP_PORT", "SLOT_ENFORCED_APP_PORT", "SLOT_NOTICE_APP_PORT"].map((name) => SLOT_ZERO.get(name) ?? ""),
);
const SLOT_ZERO_PORTS = new Set([...SLOT_ZERO_SUPABASE_PORTS, ...SLOT_ZERO_APP_PORTS]);

/** 枠の番号の上限 (scripts/lib/local-ci-slot.sh の LCS_SLOT_MAX) */
function slotMax(): number {
  const m = /^readonly LCS_SLOT_MAX=(\d+)$/m.exec(fs.readFileSync(path.join(ROOT, SLOT_LIB), "utf8"));
  if (!m) throw new Error(`${SLOT_LIB} に LCS_SLOT_MAX が無い`);
  return Number(m[1]);
}

function trackedFiles(): string[] {
  return execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" }).split("\0").filter(Boolean);
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. TypeScript / JavaScript の構文木の走査
// ─────────────────────────────────────────────────────────────────────────────

interface Finding {
  line: number;
  text: string;
  reason: string;
}

/** 括弧を外した親 */
function parentOutsideParens(node: ts.Node): { parent: ts.Node; child: ts.Node } {
  let child = node;
  let parent = node.parent;
  while (parent && ts.isParenthesizedExpression(parent)) {
    child = parent;
    parent = parent.parent;
  }
  return { parent, child };
}

/** `a ?? <node>` / `a || <node>` の右 (左が無いときの既定値) か */
function isFallback(node: ts.Node): boolean {
  const { parent, child } = parentOutsideParens(node);
  return (
    !!parent &&
    ts.isBinaryExpression(parent) &&
    parent.right === child &&
    (parent.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
      parent.operatorToken.kind === ts.SyntaxKind.BarBarToken)
  );
}

function isFallbackOperator(kind: ts.SyntaxKind): boolean {
  return kind === ts.SyntaxKind.QuestionQuestionToken || kind === ts.SyntaxKind.BarBarToken;
}

/** 既定値 (`a ?? b ?? <node>`) の連なりの最初の項 (a)。括弧は外す */
function firstOperandOfFallbackChain(node: ts.Node): ts.Expression | undefined {
  const { parent } = parentOutsideParens(node);
  if (!parent || !ts.isBinaryExpression(parent)) return undefined;
  let left: ts.Expression = parent.left;
  for (;;) {
    while (ts.isParenthesizedExpression(left)) left = left.expression;
    if (!ts.isBinaryExpression(left) || !isFallbackOperator(left.operatorToken.kind)) return left;
    left = left.left;
  }
}

/** `process.env.X` / `process.env["X"]` の X */
function envNameOf(node: ts.Expression): string | undefined {
  const isProcessEnv = (e: ts.Expression) =>
    ts.isPropertyAccessExpression(e) && e.name.text === "env" && ts.isIdentifier(e.expression) && e.expression.text === "process";
  if (ts.isPropertyAccessExpression(node) && isProcessEnv(node.expression)) return node.name.text;
  if (ts.isElementAccessExpression(node) && isProcessEnv(node.expression) && ts.isStringLiteralLike(node.argumentExpression)) {
    return node.argumentExpression.text;
  }
  return undefined;
}

/** Playwright の baseURL (`baseURL` / `x.baseURL` / `x?.baseURL`) */
function isPlaywrightBaseURL(node: ts.Expression): boolean {
  if (ts.isIdentifier(node)) return node.text === PLAYWRIGHT_BASE_URL_NAME;
  return ts.isPropertyAccessExpression(node) && node.name.text === PLAYWRIGHT_BASE_URL_NAME;
}

/** 既定値のポートとファイルの場所から、連なりの最初に読むべきもの (無ければ決まりなし) */
function fallbackSourceRequirement(fileName: string, port: string): { label: string; ok: (e: ts.Expression) => boolean } | undefined {
  const isIntegration = fileName.startsWith("tests/integration/") || fileName === "vitest.integration.config.ts";
  const isE2e = fileName.startsWith("tests/e2e/") || /^playwright(\.[\w-]+)?\.config\.ts$/.test(fileName);
  if (!isIntegration && !isE2e) return undefined;
  if (SLOT_ZERO_SUPABASE_PORTS.has(port)) {
    return { label: SUPABASE_URL_ENVS.join(" / "), ok: (e) => SUPABASE_URL_ENVS.includes(envNameOf(e) ?? "") };
  }
  if (!SLOT_ZERO_APP_PORTS.has(port)) return undefined;
  if (isIntegration) return { label: INTEGRATION_APP_ENV, ok: (e) => envNameOf(e) === INTEGRATION_APP_ENV };
  return {
    label: `${E2E_APP_ENV} か Playwright の ${PLAYWRIGHT_BASE_URL_NAME}`,
    ok: (e) => envNameOf(e) === E2E_APP_ENV || isPlaywrightBaseURL(e),
  };
}

/** 文字列・テンプレートの中身 (テンプレートは ${} の外の部分をつないだもの) */
function literalText(node: ts.Node): string | undefined {
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isTemplateExpression(node)) return [node.head.text, ...node.templateSpans.map((s) => s.literal.text)].join("${}");
  return undefined;
}

/** ポートの値 (数値か、数字だけの文字列) */
function portLiteralValue(node: ts.Node): string | undefined {
  if (ts.isNumericLiteral(node)) return node.text;
  if (ts.isStringLiteralLike(node) && /^\d+$/.test(node.text)) return node.text;
  return undefined;
}

function nameText(name: ts.Node): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isPrivateIdentifier(name)) return name.text;
  return undefined;
}

/** ポートを決め打ちしている箇所 (1 始まりの行番号) */
function findHardCodedPorts(source: string, fileName: string): Finding[] {
  const kind = /\.(js|mjs|cjs)$/.test(fileName) ? ts.ScriptKind.JS : ts.ScriptKind.TSX;
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind);
  const findings: Finding[] = [];
  const add = (node: ts.Node, reason: string) =>
    findings.push({
      line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
      text: node.getText(sf).slice(0, 160),
      reason,
    });
  /** ポートを表す名前に、枠 0 のポートの値をそのまま入れている */
  const checkPortBinding = (name: string | undefined, value: ts.Node | undefined) => {
    if (!name || !value || !PORT_NAME.test(name) || DEFAULT_NAME.test(name)) return;
    const port = portLiteralValue(value);
    if (port !== undefined && SLOT_ZERO_PORTS.has(String(Number(port)))) add(value, `${name} に枠 0 のポート ${port} を決め打ち`);
  };
  const visit = (node: ts.Node): void => {
    const text = literalText(node);
    const url = text === undefined ? null : LOOPBACK_WITH_PORT.exec(text);
    if (url && !isFallback(node)) {
      add(node, "ポート付きのループバックの URL が既定値 (?? / || の右) でない");
    } else if (url) {
      const required = fallbackSourceRequirement(fileName, url[1]);
      const first = firstOperandOfFallbackChain(node);
      if (required && first && !required.ok(first)) {
        add(node, `既定値の前に、local-ci.sh が枠の値を入れる ${required.label} を最初に読んでいない`);
      }
    }
    if (ts.isVariableDeclaration(node)) checkPortBinding(nameText(node.name), node.initializer);
    if (ts.isPropertyAssignment(node)) checkPortBinding(nameText(node.name), node.initializer);
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      (ts.isIdentifier(node.left) || ts.isPropertyAccessExpression(node.left))
    ) {
      checkPortBinding(ts.isIdentifier(node.left) ? node.left.text : node.left.name.text, node.right);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return findings;
}

/** YAML (Maestro の flow) のコメントでない行の、ポート付きのループバックの URL */
function findHardCodedPortsInYaml(source: string): Finding[] {
  return source.split("\n").flatMap((raw, i) => {
    const line = raw.trim();
    if (line.startsWith("#") || !LOOPBACK_WITH_PORT.test(line)) return [];
    return [{ line: i + 1, text: line, reason: "ポート付きのループバックの URL" }];
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. シェルの走査
// ─────────────────────────────────────────────────────────────────────────────

/** シェルの 1 行からコメントを外す (クォートの外の、行頭か空白の後の # から後ろ) */
function stripShellComment(line: string): string {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === "\\" && quote === '"') i++;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === "\\") i++;
    else if (c === "#" && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i);
  }
  return line;
}

function findHardCodedPortsInShell(source: string): Finding[] {
  return source.split("\n").flatMap((raw, i) => {
    const code = stripShellComment(raw);
    const found: string[] = [];
    for (const m of code.matchAll(/(?<![0-9])([0-9]{4,5})(?![0-9])/g)) {
      if (SLOT_ZERO_SUPABASE_PORTS.has(m[1])) found.push(`ローカル Supabase のポート ${m[1]}`);
    }
    const url = LOOPBACK_WITH_PORT.exec(code);
    if (url && SLOT_ZERO_APP_PORTS.has(url[1])) found.push(`アプリのポート ${url[1]} の URL`);
    return found.map((reason) => ({ line: i + 1, text: raw.trim(), reason }));
  });
}

describe("決め打ちを見つける仕組み (このテスト自身の検出力)", () => {
  it("ポート付きのループバックの URL を、既定値 (?? / || の右) 以外に書いた箇所を見つける", () => {
    const flagged = [
      // R4 の指摘: ページの URL に localhost があれば PLAYWRIGHT_BASE_URL を無視して 3000 に繋いでいた
      'const baseURL = page.url().includes("localhost") ? "http://localhost:3000" : (process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000");',
      // Playwright の webServer の url を決め打ち
      'export default { webServer: { command: "npm run dev", url: "http://localhost:3000" } };',
      // 認証の戻り先を決め打ち (枠 1 の Supabase の site_url と食い違う)
      "await client.auth.updateUser({ email }, { emailRedirectTo: 'http://127.0.0.1:3000/auth/callback' });",
      // Maestro の runScript の API の URL を決め打ち
      "var apiBaseUrl = 'http://localhost:3000';",
      // テンプレートの中の決め打ち
      "await fetch(`http://localhost:54321/rest/v1/${table}`);",
      // 既定値の後ろに条件を付けても、条件の結果側は既定値ではない
      'const u = process.env.X ?? (ok ? "http://localhost:3001" : "x");',
    ];
    for (const source of flagged) {
      expect(findHardCodedPorts(source, "spec.ts").map((f) => f.line), source).toEqual([1]);
    }
    expect(findHardCodedPorts(flagged[3], "script.js")).toHaveLength(1);
  });

  it("既定値の前に、local-ci.sh が枠の値を入れる環境変数を最初に読んでいない箇所を見つける", () => {
    const appPort = SLOT_ZERO.get("SLOT_APP_PORT");
    const apiPort = SLOT_ZERO.get("SLOT_API_PORT");
    const flagged: Array<[string, string]> = [
      // R3 の指摘と同じ形: integration が API_BASE_URL を先に読む (local-ci.sh は入れない) → 既定値 (枠 0) に落ちる
      ["tests/integration/x.test.ts", `const BASE_URL = process.env.API_BASE_URL ?? process.env.${INTEGRATION_APP_ENV} ?? 'http://localhost:${appPort}';`],
      ["tests/integration/x.test.ts", `const BASE_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:${appPort}';`],
      ["tests/e2e/x.spec.ts", `const BASE_URL = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:${appPort}";`],
      ["playwright.x.config.ts", `const baseURL = process.env.APP_URL || "http://localhost:${appPort}";`],
      ["tests/e2e/x.spec.ts", `const SUPABASE = process.env.${E2E_APP_ENV} ?? "http://127.0.0.1:${apiPort}";`],
    ];
    for (const [fileName, source] of flagged) {
      expect(findHardCodedPorts(source, fileName).map((f) => f.line), source).toEqual([1]);
    }
  });

  it("ポートを表す名前に枠 0 のポートの値をそのまま入れた箇所を見つける", () => {
    const appPort = SLOT_ZERO.get("SLOT_APP_PORT");
    const apiPort = SLOT_ZERO.get("SLOT_API_PORT");
    const flagged = [
      `export default { webServer: { command: "npm run start", port: ${appPort} } };`,
      `const supabasePort = "${apiPort}";`,
      `url.port = "${appPort}";`,
    ];
    for (const source of flagged) {
      expect(findHardCodedPorts(source, "spec.ts").map((f) => f.line), source).toEqual([1]);
    }
  });

  it("環境変数からとる形・既定値の定数・コメント・ポートでない数は見逃す (誤検知しない)", () => {
    const e2e = "tests/e2e/x.spec.ts";
    const integration = "tests/integration/x.test.ts";
    const allowed: Array<[string, string]> = [
      [e2e, 'const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000";'],
      [e2e, 'const BASE_URL = process.env.PLAYWRIGHT_BASE_URL || "http://localhost:3000";'],
      [e2e, 'const baseURL =\n  config.projects[0]?.use?.baseURL ??\n  process.env.PLAYWRIGHT_BASE_URL ??\n  "http://localhost:3000";'],
      [e2e, 'const b = (page.context() as unknown as { _options?: { baseURL?: string } })._options?.baseURL ?? "http://localhost:3000";'],
      [e2e, 'const base = baseURL ?? process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000";'],
      [e2e, 'const s = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";'],
      // 枠で変わらないポート (ほかの dev サーバーを想定した既定値) は、読む変数を問わない
      [e2e, 'const BASE_URL = process.env.OTHER_URL ?? "http://localhost:3003";'],
      [integration, "const BASE_URL = process.env.INTEGRATION_BASE_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';"],
      [integration, "const BASE_URL =\n  process.env.INTEGRATION_BASE_URL ??\n  process.env.API_BASE_URL ??\n  'http://localhost:3000';"],
      [integration, "const DEFAULT_APP_PORT = '3000';\nconst u = new URL(process.env.INTEGRATION_BASE_URL ?? `http://localhost:${DEFAULT_APP_PORT}`);"],
      [integration, "const p = `http://127.0.0.1:${appBaseUrl.port || DEFAULT_APP_PORT}/auth/callback`;"],
      ["apps/mobile/maestro/x.js", "var apiBaseUrl = (typeof API_BASE_URL !== 'undefined' && API_BASE_URL) || 'http://localhost:3000';"],
      [e2e, "// 使い方: PLAYWRIGHT_BASE_URL=http://localhost:3000 npx playwright test\n/* INTEGRATION_BASE_URL=http://localhost:3001 */"],
      [e2e, "const res = await GET(new Request('http://localhost/api/admin/users'));"],
      [e2e, "test.setTimeout(3000); const LCP_WARN_MS = 3000; const opts = { timeout: 3000 };"],
    ];
    for (const [fileName, source] of allowed) {
      expect(findHardCodedPorts(source, fileName), source).toEqual([]);
    }
  });

  it("シェルでは、コメントの外のローカル Supabase のポートと、アプリのポートの URL を見つける", () => {
    const dbPort = SLOT_ZERO.get("SLOT_DB_PORT");
    const appPort = SLOT_ZERO.get("SLOT_APP_PORT");
    expect(findHardCodedPortsInShell(`DB_URL="postgresql://postgres:postgres@127.0.0.1:${dbPort}/postgres"`)).toHaveLength(1);
    expect(findHardCodedPortsInShell(`curl -s http://localhost:${appPort}/login`)).toHaveLength(1);
    expect(findHardCodedPortsInShell(`  # CLI の既定 (site_url = http://127.0.0.1:${appPort}) と同じ形`)).toEqual([]);
    expect(findHardCodedPortsInShell(`readonly X=1  # DB は ${dbPort}`)).toEqual([]);
    expect(findHardCodedPortsInShell(`echo "# ${dbPort} は文字列の中"`)).toHaveLength(1);
    expect(findHardCodedPortsInShell('DB_URL="postgresql://postgres:postgres@127.0.0.1:$SLOT_DB_PORT/postgres"')).toEqual([]);
    expect(findHardCodedPortsInShell("sleep 3000")).toEqual([]);
  });
});

describe("e2e・integration のテストとヘルパーは、枠で変わるポートを決め打ちしない", () => {
  const files = trackedFiles().filter(
    (f) => TEST_CONFIG_FILE.test(f) || TEST_CODE_DIRS.some((dir) => f.startsWith(dir) && (CODE_EXT.test(f) || YAML_EXT.test(f))),
  );

  it("走査の対象に、e2e・integration のテスト・ヘルパー・設定と Maestro のスクリプトが入っている", () => {
    for (const f of [
      "tests/e2e/tour/01-eligibility.spec.ts",
      "tests/e2e/tour/helpers.ts",
      "tests/e2e/global-setup.ts",
      "tests/integration/helpers/api.ts",
      "tests/integration/security/account-credentials-change.test.ts",
      "playwright.config.ts",
      "playwright.fresh-user.config.ts",
      "vitest.integration.config.ts",
      "apps/mobile/maestro/flows/scripts/reset-onboarding.js",
      "apps/mobile/maestro/flows/_shared/login-for-onboarding.yaml",
    ]) {
      expect(files, f).toContain(f);
    }
  });

  it("既定値の前に読む環境変数は、local-ci.sh / supabase-local.sh が枠の値を入れるもの", () => {
    const localCi = fs.readFileSync(path.join(ROOT, "scripts/local-ci.sh"), "utf8");
    expect(localCi).toMatch(new RegExp(`^\\s*export [^\\n]*\\b${INTEGRATION_APP_ENV}="\\$APP_ORIGIN"`, "m"));
    expect(localCi).toMatch(new RegExp(`\\benv ${E2E_APP_ENV}="\\$APP_ORIGIN"`));
    const supabaseLocal = fs.readFileSync(path.join(ROOT, SUPABASE_LOCAL), "utf8");
    for (const name of SUPABASE_URL_ENVS) expect(supabaseLocal).toMatch(new RegExp(`^${name}=\\$api$`, "m"));
  });

  it("ポート付きのループバックの URL は既定値 (?? / || の右) にだけ書き、ポートの名前に枠 0 の値を入れない", () => {
    const problems = files.flatMap((f) => {
      const source = fs.readFileSync(path.join(ROOT, f), "utf8");
      const found = YAML_EXT.test(f) ? findHardCodedPortsInYaml(source) : findHardCodedPorts(source, f);
      return found.map((x) => `${f}:${x.line} ${x.reason}: ${x.text}`);
    });
    expect(problems).toEqual([]);
  });
});

describe("scripts/ と Maestro のシェルは、枠で変わるポートを決め打ちしない", () => {
  const files = trackedFiles().filter((f) => SHELL_DIRS.some((dir) => f.startsWith(dir)) && f.endsWith(".sh") && f !== SLOT_LIB);

  it("走査の対象に、ローカル Supabase を動かすシェルが入っている (値の表の正本は除く)", () => {
    for (const f of [SUPABASE_LOCAL, "scripts/local-ci.sh", DRIFT_REPORT]) expect(files, f).toContain(f);
    expect(files).not.toContain(SLOT_LIB);
  });

  it("コメントの外に、ローカル Supabase のポートや、アプリのポートを付けたループバックの URL が無い", () => {
    const problems = files.flatMap((f) =>
      findHardCodedPortsInShell(fs.readFileSync(path.join(ROOT, f), "utf8")).map((x) => `${f}:${x.line} ${x.reason}: ${x.text}`),
    );
    expect(problems).toEqual([]);
  });
});

describe("scripts/baseline/drift_report.sh は LOCAL_CI_SLOT の枠の DB に繋ぐ", () => {
  // リポジトリの作業ディレクトリ (動いているスタックが使っているかもしれない) に触れないよう、必要なファイルだけを
  // 一時的な git リポジトリに写して回す。docker は引数を記録するだけの代わりに置き換え、psql を動かす docker run で
  // 止める (最初の psql の接続先が分かれば足りる)。supabase CLI も何もしない代わりに置き換える
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "local-ci-drift-"));
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
  for (const rel of [DRIFT_REPORT, SUPABASE_LOCAL, SLOT_LIB, "supabase/config.toml", "supabase/baseline/manifest.json", "supabase/.temp/postgres-version"]) {
    fs.mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true });
    fs.copyFileSync(path.join(ROOT, rel), path.join(tmp, rel));
  }
  fs.mkdirSync(path.join(tmp, "supabase/migrations"), { recursive: true });
  execFileSync("git", ["init", "--quiet"], { cwd: tmp });
  // docker run が止める終了コード (ほかの失敗と見分ける)
  const FAKE_DOCKER_RUN_EXIT = 97;
  const bin = path.join(tmp, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(
    path.join(bin, "docker"),
    ["#!/usr/bin/env bash", 'echo "docker $*" >> "$FAKE_DOCKER_LOG"', `[ "$1" = run ] && exit ${FAKE_DOCKER_RUN_EXIT}`, "exit 0", ""].join("\n"),
    { mode: 0o755 },
  );

  const run = (slot: string | undefined, out?: string) => {
    const log = path.join(tmp, `docker-${slot ?? "unset"}.log`);
    fs.rmSync(log, { force: true });
    const env: NodeJS.ProcessEnv = {
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      HOME: process.env.HOME,
      SUPABASE_CLI: "true",
      FAKE_DOCKER_LOG: log,
    };
    if (slot !== undefined) env.LOCAL_CI_SLOT = slot;
    const r = spawnSync("bash", [DRIFT_REPORT, ...(out ? [out] : [])], { cwd: tmp, env, encoding: "utf8" });
    const docker = fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "";
    return { status: r.status, stderr: r.stderr, stdout: r.stdout, docker };
  };
  const workDirOf = (slot: string) =>
    execFileSync("bash", ["-c", `. ${SLOT_LIB}; local_ci_slot_work_dir "$1"`, "_", slot], { cwd: ROOT, encoding: "utf8" }).trim();

  it("枠を指定しない (今までどおり) と枠 0 は、CLI の既定の DB (枠 0) に繋ぎ、結果を .supabase-local/drift に置く", () => {
    for (const slot of [undefined, "0"]) {
      const r = run(slot);
      expect(r.status, r.stderr).toBe(FAKE_DOCKER_RUN_EXIT);
      expect(r.docker).toContain(`postgresql://postgres:postgres@127.0.0.1:${SLOT_ZERO.get("SLOT_DB_PORT")}/postgres?sslmode=disable`);
      expect(fs.existsSync(path.join(tmp, ".supabase-local/drift/replay")), `枠 ${slot}`).toBe(true);
    }
    expect(workDirOf("0")).toBe(".supabase-local");
  });

  it("枠 1 以上は、その枠の DB に繋ぎ (枠 0 の DB には繋がない)、結果をその枠の作業ディレクトリに置く", () => {
    for (const slot of ["1", String(slotMax())]) {
      const values = slotValues(slot);
      const r = run(slot);
      expect(r.status, r.stderr).toBe(FAKE_DOCKER_RUN_EXIT);
      const runs = r.docker.split("\n").filter((l) => l.startsWith("docker run "));
      expect(runs.length, `枠 ${slot}`).toBeGreaterThan(0);
      for (const l of runs) {
        expect(l).toContain(`@127.0.0.1:${values.get("SLOT_DB_PORT")}/postgres`);
        expect(l).not.toContain(`@127.0.0.1:${SLOT_ZERO.get("SLOT_DB_PORT")}/`);
      }
      expect(workDirOf(slot)).toBe(`.supabase-local-s${slot}`);
      expect(fs.existsSync(path.join(tmp, workDirOf(slot), "drift/replay")), `枠 ${slot}`).toBe(true);
    }
  });

  it("範囲外・整数でない枠は、何も消さず・docker も呼ばずに止まる", () => {
    const keep = path.join(tmp, "keep-out");
    fs.mkdirSync(keep, { recursive: true });
    fs.writeFileSync(path.join(keep, "marker"), "x");
    for (const slot of [String(slotMax() + 1), "abc", "-1"]) {
      const r = run(slot, keep);
      expect(r.status, `枠 ${slot}: ${r.stderr}`).toBe(2);
      expect(r.stderr).toContain("LOCAL_CI_SLOT");
      expect(r.docker, `枠 ${slot}`).toBe("");
      expect(fs.existsSync(path.join(keep, "marker")), `枠 ${slot}`).toBe(true);
    }
  });
});
