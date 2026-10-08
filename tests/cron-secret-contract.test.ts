/**
 * #1196 cron 共有シークレットの照合を 1 か所に集めておくための、ソース走査 contract テスト
 *
 * cron から呼ばれる API / Edge Function が、シークレットを自分で比べ始めると、入れ替えのとき
 * (CRON_SECRET_PREVIOUS) の受け付けや定数時間の比較が、その場所だけ抜け落ちてしまう。
 * 次のことをソースから確かめて、新しい cron の受け口を足すときに共通の関数を通し忘れないようにする。
 *
 *   1. Edge Functions: CRON_SECRET / CRON_SECRET_PREVIOUS / SERVICE_ROLE_SECRET の環境変数は _shared/auth.ts だけが読む
 *      (ほかの Edge Function は requireServiceRole を呼ぶ)
 *   2. Edge Functions: requireServiceRole は非同期なので、呼び出しはすべて await 付き
 *      (await を忘れると Promise が真として扱われ、認証エラーの分岐に入ってしまう)
 *   3. Next.js: CRON_SECRET / CRON_SECRET_PREVIOUS は src/lib/cron-auth.ts だけが読む
 *   4. Next.js: src/app/api/cron/ 配下のルートと、vercel.json の crons に載っているパスのルートは、すべて requireCronAuth を await している
 *   5. 共通の照合 (supabase/functions/_shared/cron-secret.ts) は、Deno と Next.js の両方から読めるよう、import も Deno / Node 固有の API も持たない
 *
 * 走査は TypeScript の構文木で行うので、コメントや文字列の一部 (エラーメッセージなど) には反応しない。
 */
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "..");

const SECRET_ENV_NAMES = new Set(["CRON_SECRET", "CRON_SECRET_PREVIOUS", "SERVICE_ROLE_SECRET"]);

const EDGE_AUTH_FILE = "supabase/functions/_shared/auth.ts";
const CRON_SECRET_FILE = "supabase/functions/_shared/cron-secret.ts";
const NEXT_CRON_AUTH_FILE = "src/lib/cron-auth.ts";

// ─────────────────────────────────────────────
// ソースの列挙と解析
// ─────────────────────────────────────────────

const SKIPPED_DIRS = new Set(["node_modules", ".next", "__tests__", "__mocks__"]);

function listSourceFiles(relativeDir: string): string[] {
  const results: string[] = [];
  const base = path.join(ROOT, relativeDir);
  if (!fs.existsSync(base)) return results;
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name)) walk(full);
      } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.(test|spec)\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
        results.push(path.relative(ROOT, full).split(path.sep).join("/"));
      }
    }
  };
  walk(base);
  return results;
}

function parse(relativePath: string): ts.SourceFile {
  const text = fs.readFileSync(path.join(ROOT, relativePath), "utf8");
  const kind = relativePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  return ts.createSourceFile(relativePath, text, ts.ScriptTarget.Latest, true, kind);
}

function readText(relativePath: string): string {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

function visitAll(node: ts.Node, visit: (node: ts.Node) => void) {
  visit(node);
  ts.forEachChild(node, (child) => visitAll(child, visit));
}

function locationOf(sourceFile: ts.SourceFile, node: ts.Node): string {
  const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return `${sourceFile.fileName}:${line + 1}`;
}

/** シークレットの環境変数名を、コード中 (識別子・文字列) で使っている場所。コメントは数えない */
function secretNameUses(files: string[], names: Set<string>): Map<string, string[]> {
  const uses = new Map<string, string[]>();
  for (const file of files) {
    // 構文木を作る前に、名前を含むファイルだけに絞る (src/ 全体を解析すると遅い)
    const text = readText(file);
    if (![...names].some((name) => text.includes(name))) continue;
    const sourceFile = parse(file);
    visitAll(sourceFile, (node) => {
      const isNameNode = ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node);
      if (isNameNode && names.has(node.text)) {
        uses.set(file, [...(uses.get(file) ?? []), locationOf(sourceFile, node)]);
      }
    });
  }
  return uses;
}

/** `<name>(...)` の呼び出し (関数呼び出しのみ。メソッド呼び出しは対象外) */
function callsTo(sourceFile: ts.SourceFile, name: string): ts.CallExpression[] {
  const calls: ts.CallExpression[] = [];
  visitAll(sourceFile, (node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name) {
      calls.push(node);
    }
  });
  return calls;
}

/** 呼び出しの結果を await している (括弧は無視する) */
function isAwaited(call: ts.CallExpression): boolean {
  let parent: ts.Node = call.parent;
  while (ts.isParenthesizedExpression(parent)) parent = parent.parent;
  return ts.isAwaitExpression(parent);
}

// ─────────────────────────────────────────────
// 1・2: Edge Functions
// ─────────────────────────────────────────────

describe("Edge Functions の cron シークレット (#1196)", () => {
  const edgeFiles = listSourceFiles("supabase/functions");

  it("CC-1: CRON_SECRET / CRON_SECRET_PREVIOUS / SERVICE_ROLE_SECRET を読むのは _shared/auth.ts だけ", () => {
    expect(edgeFiles.length).toBeGreaterThan(10);
    const uses = secretNameUses(edgeFiles, SECRET_ENV_NAMES);
    // 走査が空振りしていないこと (auth.ts は 3 つとも読む)
    expect(uses.get(EDGE_AUTH_FILE)?.length ?? 0).toBeGreaterThanOrEqual(3);
    const others = [...uses.entries()].filter(([file]) => file !== EDGE_AUTH_FILE);
    expect(others, "ほかの Edge Function は requireServiceRole を呼ぶ。シークレットを自分で比べない").toEqual([]);
  });

  it("CC-2: requireServiceRole の呼び出しはすべて await 付き", () => {
    const callers: string[] = [];
    const notAwaited: string[] = [];
    for (const file of edgeFiles) {
      if (!readText(file).includes("requireServiceRole")) continue;
      const sourceFile = parse(file);
      const calls = callsTo(sourceFile, "requireServiceRole");
      if (calls.length > 0) callers.push(file);
      for (const call of calls) {
        if (!isAwaited(call)) notAwaited.push(locationOf(sourceFile, call));
      }
    }
    // 走査が空振りしていないこと (cron で呼ぶ Edge Function は少なくとも 5 つある)
    expect(callers.length).toBeGreaterThanOrEqual(5);
    expect(notAwaited).toEqual([]);
  });

  it("CC-3: 共通の照合 (_shared/auth.ts) は _shared/cron-secret.ts の checkCronSecret を使い、自前の比較をしない", () => {
    const sourceFile = parse(EDGE_AUTH_FILE);
    const serviceRole = callsTo(sourceFile, "checkCronSecret");
    expect(serviceRole.length).toBe(1);
    expect(readText(EDGE_AUTH_FILE)).toMatch(/from\s+"\.\/cron-secret\.ts"/);
  });
});

// ─────────────────────────────────────────────
// 3・4: Next.js
// ─────────────────────────────────────────────

describe("Next.js の cron シークレット (#1196)", () => {
  const nextFiles = [...listSourceFiles("src"), ...listSourceFiles("lib")];

  it("CC-4: CRON_SECRET / CRON_SECRET_PREVIOUS を読むのは src/lib/cron-auth.ts だけ", () => {
    expect(nextFiles.length).toBeGreaterThan(100);
    const uses = secretNameUses(nextFiles, new Set(["CRON_SECRET", "CRON_SECRET_PREVIOUS"]));
    expect(uses.get(NEXT_CRON_AUTH_FILE)?.length ?? 0).toBeGreaterThanOrEqual(2);
    const others = [...uses.entries()].filter(([file]) => file !== NEXT_CRON_AUTH_FILE);
    expect(others, "cron のルートは requireCronAuth を呼ぶ。シークレットを自分で比べない").toEqual([]);
  });

  it("CC-5: src/lib/cron-auth.ts は共通の checkCronSecret を使い、node:crypto には頼らない (Edge Runtime のルートからも呼ぶ)", () => {
    const text = readText(NEXT_CRON_AUTH_FILE);
    expect(text).toMatch(/from\s+'\.\.\/\.\.\/supabase\/functions\/_shared\/cron-secret'/);
    expect(callsTo(parse(NEXT_CRON_AUTH_FILE), "checkCronSecret").length).toBe(1);
    expect(text).not.toMatch(/from\s+['"](node:)?crypto['"]/);
    expect(text).not.toMatch(/\brequire\s*\(/);
  });

  /** src/app/api/cron/ 配下のルートと、vercel.json の crons に載っているパスのルート */
  function cronRouteFiles(): string[] {
    const fromDirectory = listSourceFiles("src/app/api/cron").filter((file) => /\/route\.tsx?$/.test(file));
    const vercel = JSON.parse(readText("vercel.json")) as { crons?: Array<{ path: string }> };
    const fromVercel = (vercel.crons ?? []).map((cron) => {
      const pathname = cron.path.split("?")[0].replace(/^\/+|\/+$/g, "");
      return `src/app/${pathname}/route.ts`;
    });
    return [...new Set([...fromDirectory, ...fromVercel])].sort();
  }

  it("CC-6: cron のルートはすべて requireCronAuth を await し、認証に失敗したときの Response をそのまま返している", () => {
    const routes = cronRouteFiles();
    expect(routes).toContain("src/app/api/cron/process-menu-queue/route.ts");
    for (const route of routes) {
      expect(fs.existsSync(path.join(ROOT, route)), `${route} が無い (vercel.json の crons と合わない)`).toBe(true);
      const text = readText(route);
      expect(text, route).toMatch(/import\s*\{[^}]*\brequireCronAuth\b[^}]*\}\s*from\s*'@\/lib\/cron-auth'/);
      const sourceFile = parse(route);
      const calls = callsTo(sourceFile, "requireCronAuth");
      expect(calls.length, `${route}: requireCronAuth を呼んでいない`).toBeGreaterThan(0);
      for (const call of calls) {
        expect(isAwaited(call), `${locationOf(sourceFile, call)}: await が無い`).toBe(true);
      }
      // `const authError = await requireCronAuth(req); if (authError) return authError;` の形 (波括弧は付けてもよい)
      expect(text, route).toMatch(
        /const\s+(\w+)\s*=\s*await\s+requireCronAuth\([^)]*\);\s*if\s*\(\s*\1\s*\)\s*\{?\s*return\s+\1\s*;?\s*\}?/,
      );
    }
  });
});

// ─────────────────────────────────────────────
// 5: 共通の照合モジュール
// ─────────────────────────────────────────────

describe("_shared/cron-secret.ts の制約 (#1196)", () => {
  it("CC-7: import を持たず、Deno / Node 固有の API を使わない (Edge Functions と Next.js の両方で読むため)", () => {
    const source = readText(CRON_SECRET_FILE);
    // コメントの中の説明に反応しないよう、構文木から識別子とモジュール指定を拾う
    const sourceFile = parse(CRON_SECRET_FILE);
    const importsAndIdentifiers: string[] = [];
    visitAll(sourceFile, (node) => {
      if (ts.isImportDeclaration(node) || (ts.isExportDeclaration(node) && node.moduleSpecifier)) {
        importsAndIdentifiers.push(`module:${node.getText(sourceFile)}`);
      }
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        importsAndIdentifiers.push("dynamic import");
      }
      if (ts.isIdentifier(node) && ["Deno", "process", "Buffer", "require"].includes(node.text)) {
        importsAndIdentifiers.push(`identifier:${node.text}`);
      }
    });
    expect(importsAndIdentifiers).toEqual([]);
    expect(source).not.toMatch(/["']node:/);
  });

  it("CC-8: 使う暗号 API は Web 標準の crypto.subtle だけ (node:crypto の timingSafeEqual は Edge Runtime で使えない)", () => {
    const sourceFile = parse(CRON_SECRET_FILE);
    const subtleCalls: string[] = [];
    visitAll(sourceFile, (node) => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        subtleCalls.push(node.expression.getText(sourceFile));
      }
    });
    expect(subtleCalls).toContain("crypto.subtle.digest");
    expect(subtleCalls.some((call) => /timingSafeEqual|createHash|createHmac/.test(call))).toBe(false);
  });
});
