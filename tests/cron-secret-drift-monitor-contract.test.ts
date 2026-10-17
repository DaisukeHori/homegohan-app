/**
 * #1560 cron の共有シークレットのずれの自動検知 (設計 docs/design/operator/12-cron-secret-drift-monitor.md) の契約テスト (DB を使わない)
 *
 * 設計 §11.1 の契約。段ごとに足す (A: 本ファイルを新設して CT-12・CT-13 / B: migration の CT-1〜CT-11・CT-18 / C: アプリの CT-14〜CT-17)。
 *
 *   CT-12: supabase/config.toml に [functions.cron-secret-probe] verify_jwt = false がある (段 A)
 *   CT-13: supabase/functions/cron-secret-probe/index.ts は環境変数・本文・DB・ダイジェストに触れず、
 *          200 の本文の JSON のキーは ok / matched / previous_configured / alias_used の 4 つだけ (段 A)
 *
 * CT-13 は TypeScript の構文木で確かめる (コメントや文字列の一部には反応しない)。
 */
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "..");

const CONFIG_TOML = "supabase/config.toml";
const PROBE_FUNCTION = "cron-secret-probe";
const PROBE_SOURCE = `supabase/functions/${PROBE_FUNCTION}/index.ts`;

/** 200 の本文の JSON のキー (設計 §6.2。キーを足すときは設計と、受ける側の cron-secret-drift.ts の読み方を直す) */
const PROBE_RESPONSE_KEYS = ["alias_used", "matched", "ok", "previous_configured"];

/** 本文を読む Request / Response のメソッド */
const BODY_READERS = new Set(["json", "text", "formData", "arrayBuffer", "blob"]);

/** DB のクライアントを作る・呼ぶ名前 */
const DB_CLIENT_IDENTIFIERS = new Set(["createClient"]);
const DB_CALL_NAMES = new Set(["from", "rpc"]);

/** ダイジェストを作る名前 (この関数は値もダイジェストも作らない) */
const DIGEST_IDENTIFIERS = new Set(["createHash"]);

function readText(relativePath: string): string {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

function parse(relativePath: string): ts.SourceFile {
  return ts.createSourceFile(relativePath, readText(relativePath), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}

/** `a.b.c` の形の式を "a.b.c" にする (それ以外の式は null) */
function dottedName(expression: ts.Expression): string | null {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) {
    const head = dottedName(expression.expression);
    return head === null ? null : `${head}.${expression.name.text}`;
  }
  return null;
}

function locationOf(sourceFile: ts.SourceFile, node: ts.Node): string {
  const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return `${sourceFile.fileName}:${line + 1}`;
}

describe("cron の共有シークレットの確認 (#1560) — 段 A の契約", () => {
  it("CT-12: supabase/config.toml に [functions.cron-secret-probe] verify_jwt = false がある", () => {
    const lines = readText(CONFIG_TOML).split(/\r?\n/);
    const header = `[functions.${PROBE_FUNCTION}]`;
    const headerLines = lines.flatMap((line, index) => (line.trim() === header ? [index] : []));
    expect(headerLines, `${CONFIG_TOML} に ${header} の節がちょうど 1 つある`).toHaveLength(1);

    // 次の見出しまでの行 (空行・行全体のコメントを除く) は verify_jwt = false だけ
    const sectionLines: string[] = [];
    for (const line of lines.slice(headerLines[0] + 1)) {
      const text = line.trim();
      if (text.startsWith("[")) break;
      if (text === "" || text.startsWith("#")) continue;
      sectionLines.push(text);
    }
    expect(sectionLines).toEqual(["verify_jwt = false"]);
  });

  it("CT-13: cron-secret-probe/index.ts は Deno.env・本文の読み取り・DB・ダイジェストに触れない", () => {
    const sourceFile = parse(PROBE_SOURCE);
    const violations: string[] = [];

    walk(sourceFile, (node) => {
      const where = () => locationOf(sourceFile, node);

      if (ts.isPropertyAccessExpression(node)) {
        const name = dottedName(node);
        // Deno.env (.get / .toObject など) は _shared/auth.ts だけが読む (CC-1)
        if (name === "Deno.env") violations.push(`${where()}: Deno.env`);
        // crypto.subtle (digest ほか)
        if (name !== null && /(^|\.)crypto\.subtle(\.|$)/.test(name)) violations.push(`${where()}: ${name}`);
        if (BODY_READERS.has(node.name.text) && ts.isCallExpression(node.parent) && node.parent.expression === node) {
          violations.push(`${where()}: .${node.name.text}() (本文を読む)`);
        }
        if (DB_CALL_NAMES.has(node.name.text) && ts.isCallExpression(node.parent) && node.parent.expression === node) {
          violations.push(`${where()}: .${node.name.text}() (DB を呼ぶ)`);
        }
        if (node.name.text === "digest") violations.push(`${where()}: .digest (ダイジェスト)`);
      }

      if (ts.isIdentifier(node) && DB_CLIENT_IDENTIFIERS.has(node.text)) violations.push(`${where()}: ${node.text}`);
      if (ts.isIdentifier(node) && DIGEST_IDENTIFIERS.has(node.text)) violations.push(`${where()}: ${node.text}`);
      // import 文は ../_shared/auth.ts だけ (DB クライアントや暗号の部品を持ち込まない)
      if (ts.isImportDeclaration(node)) {
        const specifier = ts.isStringLiteral(node.moduleSpecifier) ? node.moduleSpecifier.text : "";
        if (specifier !== "../_shared/auth.ts") violations.push(`${where()}: import ${specifier}`);
      }
    });

    expect(violations).toEqual([]);

    // 走査が空振りしていないこと: 先頭で認証を呼んでいる
    const text = readText(PROBE_SOURCE);
    expect(text).toMatch(/await requireServiceRole\(req\)/);
    expect(text).toMatch(/await describeServiceRoleAuth\(req\)/);
  });

  it("CT-13: 200 の本文の JSON のキーは ok / matched / previous_configured / alias_used の 4 つだけ", () => {
    const sourceFile = parse(PROBE_SOURCE);
    const stringifyArguments: ts.ObjectLiteralExpression[] = [];

    walk(sourceFile, (node) => {
      if (!ts.isCallExpression(node) || dottedName(node.expression) !== "JSON.stringify") return;
      const [argument] = node.arguments;
      expect(argument && ts.isObjectLiteralExpression(argument), `${locationOf(sourceFile, node)}: JSON.stringify の引数はオブジェクトの直書き`).toBe(true);
      stringifyArguments.push(argument as ts.ObjectLiteralExpression);
    });

    const keysOf = (object: ts.ObjectLiteralExpression): string[] =>
      object.properties.map((property) => {
        // 省略記法・スプレッド・計算されたキーは、キーを数えられないので許さない
        expect(ts.isPropertyAssignment(property), `${locationOf(sourceFile, property)}: キーは name: value の形`).toBe(true);
        const name = (property as ts.PropertyAssignment).name;
        expect(ts.isIdentifier(name) || ts.isStringLiteral(name), `${locationOf(sourceFile, property)}: キーは識別子か文字列`).toBe(true);
        return (name as ts.Identifier | ts.StringLiteral).text;
      });

    const successBodies = stringifyArguments.filter((object) => keysOf(object).includes("ok"));
    expect(successBodies, "成功の本文 (ok を持つ JSON) はちょうど 1 つ").toHaveLength(1);
    expect(keysOf(successBodies[0]).sort()).toEqual(PROBE_RESPONSE_KEYS);

    // ほかの JSON は { error } だけ (この関数が返す失敗の本文は error の 1 キー)
    const others = stringifyArguments.filter((object) => !successBodies.includes(object));
    expect(others.length).toBeGreaterThan(0);
    for (const object of others) expect(keysOf(object)).toEqual(["error"]);
  });
});
