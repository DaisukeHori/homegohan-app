/**
 * #1560 cron の共有シークレットのずれの自動検知 (設計 docs/design/operator/12-cron-secret-drift-monitor.md) の契約テスト (DB を使わない)
 *
 * 設計 §11.1 の契約。段ごとに足す (A: 本ファイルを新設して CT-12・CT-13 / B: migration の CT-1〜CT-11・CT-18 / C: アプリの CT-14〜CT-17)。
 *
 *   CT-1 〜 CT-11・CT-18: 段 B の migration (表 cron_secret_probes・関数 3 本) と rollback の形 (下の「段 B の契約」)
 *   CT-12: supabase/config.toml に [functions.cron-secret-probe] verify_jwt = false がある (段 A)
 *   CT-13: supabase/functions/cron-secret-probe/index.ts は環境変数・本文・DB・ダイジェストに触れず、
 *          200 の本文の JSON のキーは ok / matched / previous_configured / alias_used の 4 つだけ (段 A)
 *   CT-14 〜 CT-17: アプリ側 (段 C。下の「段 C の契約」)
 *          CT-14: 401 / 503 の本文の error の文と matched の 3 値が _shared/auth.ts と同じ
 *          CT-15: 判定・文面・route はダイジェストを計算しない
 *          CT-16: 所見の表の title / action は文字列の直書き (${ を含まない)・21 件 (fail 13 / warn 5 / info 3)
 *          CT-17: describeCronSecretRotationState は値を返さない (真偽値 2 つ)
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

// ─────────────────────────────────────────────────────────────────────────────
// 段 B: DB (migration と rollback)
// ─────────────────────────────────────────────────────────────────────────────

const MIGRATIONS_DIR = "supabase/migrations";
const ROLLBACKS_DIR = "supabase/rollbacks";
const MIGRATION_SUFFIX = "_cron_secret_drift_monitor.sql";
const SEGMENT_STATS_MIGRATION = `${MIGRATIONS_DIR}/20261009100000_schedule_calculate_segment_stats.sql`;
const APP_DRIFT_SOURCE = "src/lib/ops-alerts/cron-secret-drift.ts";

/**
 * アプリ側 (段 C の src/lib/ops-alerts/cron-secret-drift.ts) の定数の、設計 §7.1 での値。
 * 段 C がマージされる前は、このファイルがまだ無いので、設計の値を使って DB 側の範囲と突き合わせる。
 * 段 C が入ってからは、ファイルから読んだ値を使い、設計の値と同じであることも確かめる (CT-2 / CT-8)。
 */
const DESIGN_APP_CONSTANTS = {
  CRON_SECRET_PROBE_LOOKBACK_MINUTES: 60,
  CRON_SECRET_PROBE_RESULT_LIMIT: 8,
  CRON_SECRET_PROBE_ANSWER_GRACE_MINUTES: 5,
} as const;
const DESIGN_SEND_STATES = ["sent", "vault_missing", "vault_empty", "vault_unreadable", "vault_unavailable", "net_unavailable"];

/** DB 側の範囲 (設計 §5.2 の c_*) */
const EXPECTED_DB_CONSTANTS = {
  c_lookback_min: 15,
  c_lookback_max: 360,
  c_limit_max: 50,
  c_body_field_max_length: 64,
  c_timeout_ms: 15000,
} as const;

/** 本番のプロジェクトの cron-secret-probe の呼び先 (migration の c_url) */
const PROBE_URL_PATH = `/functions/v1/${PROBE_FUNCTION}`;

/** tests/edge-function-verify-jwt.test.ts の DB_HTTP_FENCE と同じ正規表現 (HTTP の呼び出しらしい箇所) */
const DB_HTTP_FENCE = /\bhttp(?:_(?:post|get|put|patch|delete|head|request))?"?\s*\(|\/functions\/v1\//gi;

const SEND_FUNCTION = "send_cron_secret_probe";
const RESULTS_FUNCTION = "cron_secret_probe_results";
const BODY_JSON_FUNCTION = "cron_secret_probe_body_json";

/** results の RETURNS TABLE の 12 列 (設計 §5.2・§7.5。順も固定) */
const RESULTS_COLUMNS = [
  "probe_id",
  "requested_at",
  "send_state",
  "answered",
  "http_status",
  "timed_out",
  "has_error",
  "matched",
  "previous_configured",
  "alias_used",
  "body_error",
  "body_code",
];

/** "--" の行コメントを消す (この migration の文字列に "--" は無い) */
function stripSqlComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, "");
}

function migrationFiles(): string[] {
  return fs.readdirSync(path.join(ROOT, MIGRATIONS_DIR)).filter((name) => name.endsWith(MIGRATION_SUFFIX));
}

function migrationPath(): string {
  const files = migrationFiles();
  expect(files, `${MIGRATIONS_DIR} に *${MIGRATION_SUFFIX} がちょうど 1 つある`).toHaveLength(1);
  return `${MIGRATIONS_DIR}/${files[0]}`;
}

function rollbackPath(): string {
  return `${ROLLBACKS_DIR}/${path.basename(migrationPath(), ".sql")}.down.sql`;
}

interface SqlFunction {
  /** CREATE から AS $$ の手前まで (コメントを除く) */
  head: string;
  /** AS $$ と END $$; の間 (コメントを除く) */
  body: string;
  /** RETURNS TABLE の列名 (TABLE を返さないときは null) */
  columns: string[] | null;
}

/** public.<name>(…) の CREATE OR REPLACE FUNCTION を 1 本取り出す */
function sqlFunction(sqlWithComments: string, name: string): SqlFunction {
  const sql = stripSqlComments(sqlWithComments);
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  expect(start, `public.${name} の CREATE OR REPLACE FUNCTION がある`).toBeGreaterThanOrEqual(0);
  const open = sql.indexOf("$$", start);
  const close = sql.indexOf("END $$;", open + 2);
  expect(open).toBeGreaterThan(start);
  expect(close, `public.${name} の本文が END $$; で閉じている`).toBeGreaterThan(open);
  const head = sql.slice(start, open);
  const body = sql.slice(open + 2, close);
  const table = /RETURNS TABLE \(([\s\S]*?)\)\s*LANGUAGE/.exec(head);
  const columns = table ? table[1].split(",").map((part) => part.trim().split(/\s+/)[0]) : null;
  return { head, body, columns };
}

function appConstantsFromSource(): { values: Record<keyof typeof DESIGN_APP_CONSTANTS, number>; states: string[]; fromFile: boolean } {
  if (!fs.existsSync(path.join(ROOT, APP_DRIFT_SOURCE))) {
    return { values: { ...DESIGN_APP_CONSTANTS }, states: [...DESIGN_SEND_STATES], fromFile: false };
  }
  const text = readText(APP_DRIFT_SOURCE);
  const values = { ...DESIGN_APP_CONSTANTS } as Record<keyof typeof DESIGN_APP_CONSTANTS, number>;
  for (const name of Object.keys(DESIGN_APP_CONSTANTS) as (keyof typeof DESIGN_APP_CONSTANTS)[]) {
    const match = new RegExp(`export const ${name}\\s*=\\s*(\\d+)\\b`).exec(text);
    expect(match, `${APP_DRIFT_SOURCE} に export const ${name} = <数> がある`).not.toBeNull();
    values[name] = Number(match![1]);
  }
  const statesMatch = /export const CRON_SECRET_PROBE_SEND_STATES\s*=\s*\[([^\]]*)\]/.exec(text);
  expect(statesMatch, `${APP_DRIFT_SOURCE} に CRON_SECRET_PROBE_SEND_STATES がある`).not.toBeNull();
  const states = [...statesMatch![1].matchAll(/'([^']*)'/g)].map((match) => match[1]);
  return { values, states, fromFile: true };
}

function sqlConstant(body: string, name: string): string {
  const match = new RegExp(`${name}\\s+CONSTANT\\s+[\\w. ]+?\\s*:=\\s*([^;]+);`).exec(body);
  expect(match, `${name} の定数がある`).not.toBeNull();
  return match![1].trim();
}

describe("cron の共有シークレットの確認 (#1560) — 段 B の契約 (migration と rollback)", () => {
  it("CT-1: migration と rollback が同じ名前で対になっていて、1・2 行目の見出しと案内が正しい", () => {
    const migration = migrationPath();
    const rollback = rollbackPath();
    expect(fs.existsSync(path.join(ROOT, rollback)), `${rollback} がある`).toBe(true);

    const file = path.basename(migration);
    const migrationLines = readText(migration).split(/\r?\n/);
    expect(migrationLines[0]).toBe(`-- migration: ${file}`);
    expect(migrationLines[1]).toBe(`-- 戻し方: ${rollback}`);

    const rollbackLines = readText(rollback).split(/\r?\n/);
    expect(rollbackLines[0]).toBe(`-- rollback: ${file}`);
    // 本番に戻すときの案内 (本番への直接 SQL の禁止) と、先に Web を戻す順
    const rollbackText = readText(rollback);
    expect(rollbackText).toContain("本番への直接 SQL は禁止");
    expect(rollbackText).toContain("先に Web のデプロイ");
    // 設計のプレースホルダーが残っていない
    expect(readText(migration)).not.toContain("<番号");
    expect(rollbackText).not.toContain("<番号");
  });

  it("CT-2: 表 cron_secret_probes の列は id / requested_at / send_state / request_id の 4 つだけで、send_state の CHECK は CRON_SECRET_PROBE_SEND_STATES と同じ 6 値", () => {
    const sql = stripSqlComments(readText(migrationPath()));
    const table = /CREATE TABLE IF NOT EXISTS public\.cron_secret_probes \(([\s\S]*?)\n\);/.exec(sql);
    expect(table, "CREATE TABLE public.cron_secret_probes がある").not.toBeNull();
    const columns = table![1]
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "")
      .map((line) => line.split(/\s+/)[0]);
    expect(columns).toEqual(["id", "requested_at", "send_state", "request_id"]);

    const check = /send_state\s+TEXT\s+NOT NULL\s+CHECK \(send_state IN \(([^)]*)\)\)/.exec(table![1]);
    expect(check, "send_state の CHECK がある").not.toBeNull();
    const states = [...check![1].matchAll(/'([^']*)'/g)].map((match) => match[1]);
    expect(states).toHaveLength(6);
    expect([...states].sort()).toEqual([...appConstantsFromSource().states].sort());
    expect([...states].sort()).toEqual([...DESIGN_SEND_STATES].sort());

    // request_id は数値 (pg_net の要求 ID) で、1 確認に 1 つ
    expect(table![1]).toMatch(/request_id\s+BIGINT\s+NULL\s+UNIQUE/);
    // 値やダイジェストを書ける型の列 (jsonb / bytea / 長い text) は send_state の text 1 つだけ
    expect(table![1].match(/\b(?:TEXT|JSONB?|BYTEA)\b/gi)).toEqual(["TEXT"]);
  });

  it("CT-3: 表は RLS 有効・全拒否ポリシー・どのロールにも表の権限を付けない", () => {
    const sql = stripSqlComments(readText(migrationPath()));
    expect(sql).toMatch(/ALTER TABLE public\.cron_secret_probes ENABLE ROW LEVEL SECURITY;/);
    expect(sql).toMatch(/REVOKE ALL ON public\.cron_secret_probes FROM PUBLIC, anon, authenticated, service_role;/);
    expect(sql).toMatch(
      /CREATE POLICY cron_secret_probes_deny_client_access ON public\.cron_secret_probes\s+FOR ALL TO anon, authenticated USING \(false\) WITH CHECK \(false\);/,
    );
    // 表への GRANT は 1 つも無い (入口は関数だけ)
    const grants = [...sql.matchAll(/GRANT\s[^;]*;/gi)].map((match) => match[0]);
    for (const grant of grants) expect(grant).not.toMatch(/\bON\s+(?:TABLE\s+)?public\.cron_secret_probes\b/i);
    // 表のポリシーは 1 つだけ (全拒否)
    expect(sql.match(/CREATE POLICY/g)).toHaveLength(1);
  });

  it("CT-4: send / results は SECURITY DEFINER・search_path 空・参照が完全修飾・動的 SQL なし。body_json は SECURITY DEFINER でない", () => {
    const sql = readText(migrationPath());
    for (const name of [SEND_FUNCTION, RESULTS_FUNCTION]) {
      const fn = sqlFunction(sql, name);
      expect(fn.head, `${name}: SECURITY DEFINER`).toMatch(/\bSECURITY DEFINER\b/);
      expect(fn.head, `${name}: SET search_path = ''`).toMatch(/SET search_path = ''/);
      expect(fn.body, `${name}: 動的 SQL (EXECUTE) が無い`).not.toMatch(/\bEXECUTE\b/i);
      // FROM / JOIN / INSERT INTO / UPDATE の対象はスキーマ付き (LATERAL の副問い合わせは対象でない)
      for (const match of fn.body.matchAll(/\b(?:FROM|JOIN|INSERT INTO|UPDATE)\s+([^\s(]+)/g)) {
        if (match[1].toUpperCase() === "LATERAL") continue;
        expect(match[1], `${name}: ${match[0]} は完全修飾`).toMatch(/^(?:public|net|vault)\.[a-z_]+$/);
      }
      // search_path が空なので、スキーマ無しの組み込み関数の呼び出しは解決できない (pg_catalog. を付ける)
      expect(fn.body, `${name}: pg_catalog. の無い組み込み関数`).not.toMatch(
        /(?<![\w.])(?:now|left|make_interval|jsonb_build_object|jsonb_typeof|to_regclass)\s*\(/,
      );
    }
    const bodyJson = sqlFunction(sql, BODY_JSON_FUNCTION);
    expect(bodyJson.head).not.toMatch(/SECURITY DEFINER/);
    expect(bodyJson.head).toMatch(/SET search_path = ''/);
    expect(bodyJson.body).not.toMatch(/\bEXECUTE\b/i);
  });

  it("CT-5: EXECUTE: send / results は service_role だけ、body_json は誰にも付けない (完全形の REVOKE)", () => {
    const sql = stripSqlComments(readText(migrationPath()));
    const signatures: [string, string, boolean][] = [
      [SEND_FUNCTION, "", true],
      [RESULTS_FUNCTION, "INTEGER, INTEGER", true],
      [BODY_JSON_FUNCTION, "TEXT", false],
    ];
    for (const [name, args, granted] of signatures) {
      expect(sql, `${name}: 完全形の REVOKE`).toContain(
        `REVOKE ALL ON FUNCTION public.${name}(${args}) FROM PUBLIC, anon, authenticated, service_role;`,
      );
      const grant = `GRANT EXECUTE ON FUNCTION public.${name}(${args}) TO service_role;`;
      if (granted) expect(sql, `${name}: service_role にだけ付ける`).toContain(grant);
      else expect(sql, `${name}: GRANT を付けない`).not.toContain(`ON FUNCTION public.${name}(${args}) TO`);
    }
    // GRANT は send / results の 2 本だけで、宛先は service_role だけ
    const grants = [...sql.matchAll(/GRANT\s[^;]*;/gi)].map((match) => match[0].replace(/\s+/g, " "));
    expect(grants).toHaveLength(2);
    for (const grant of grants) expect(grant).toMatch(/ TO service_role;$/);
  });

  it("CT-6: send の RETURNS TABLE は (probe_id, send_state, request_id) だけ。decrypted_secret は 1 か所、v_secret は許した使い方だけ", () => {
    const text = readText(migrationPath());
    const send = sqlFunction(text, SEND_FUNCTION);
    expect(send.columns).toEqual(["probe_id", "send_state", "request_id"]);

    // 復号された値の列名 (decrypted_secret。ビュー名の decrypted_secrets は別の語) は、コメントを除いて SELECT … INTO v_secret の 1 か所だけ
    const code = stripSqlComments(text);
    const uses = [...code.matchAll(/\bdecrypted_secret\b/g)];
    expect(uses).toHaveLength(1);
    expect(send.body).toMatch(/SELECT s\.decrypted_secret INTO v_secret\s+FROM vault\.decrypted_secrets AS s/);

    // v_secret が現れる行は、宣言・SELECT INTO・Bearer の連結・IS NULL・= '' の比較・例外の受け口の NULL 代入の 6 つのどれか
    const allowed = [
      /^\s*v_secret text;\s*$/,
      /SELECT s\.decrypted_secret INTO v_secret\s*$/,
      /'Authorization', 'Bearer ' \|\| v_secret,\s*$/,
      /ELSIF v_secret IS NULL THEN\s*$/,
      /ELSIF v_secret = '' THEN\s*$/,
      /^\s*v_secret := NULL;\s*$/,
    ];
    const secretLines = send.body.split("\n").filter((line) => /\bv_secret\b/.test(line));
    expect(secretLines.length).toBeGreaterThanOrEqual(allowed.length);
    for (const line of secretLines) {
      expect(
        allowed.some((pattern) => pattern.test(line)),
        `v_secret の使い方が許した形でない: ${line.trim()}`,
      ).toBe(true);
    }
    for (const pattern of allowed) expect(secretLines.some((line) => pattern.test(line)), `許した形が 1 つも無い: ${pattern}`).toBe(true);

    // 戻り値は (v_probe_id, v_state, v_request_id) だけ
    expect(send.body).toMatch(/RETURN QUERY SELECT v_probe_id, v_state, v_request_id;/);
    // 関数のコメント (COMMENT ON) に値の変数や列名を出さない
    for (const comment of code.matchAll(/COMMENT ON [\s\S]*?;\s*(?=\n|$)/g)) {
      expect(comment[0]).not.toMatch(/v_secret|decrypted_secret/);
    }
  });

  it("CT-7: results の RETURNS TABLE は設計の 12 列だけ。本文は body_json を通してから読み、text の項目は 64 字で切る。headers と error_msg の値は返さない", () => {
    const results = sqlFunction(readText(migrationPath()), RESULTS_FUNCTION);
    expect(results.columns).toEqual(RESULTS_COLUMNS);

    const body = results.body;
    // 本文 (r.content) は cron_secret_probe_body_json の引数としてだけ現れる (応答のある分岐の 1 か所)
    expect(body.match(/\br\.content\b/g)).toHaveLength(1);
    expect(body).toMatch(/LEFT JOIN LATERAL \(SELECT public\.cron_secret_probe_body_json\(r\.content\) AS body\) AS b ON true/);
    // 本文の項目の読み取りは b.body の -> / ->> だけで、読む項目は 5 つ
    const readKeys = [...body.matchAll(/\bb\.body\s*->>?\s*'([a-z_]+)'/g)].map((match) => match[1]);
    expect(new Set(readKeys)).toEqual(new Set(["matched", "previous_configured", "alias_used", "error", "code"]));
    expect(body).not.toMatch(/(?<!b\.)\bbody\s*->/);
    // text の項目 (matched / error / code) は pg_catalog.left(…, c_body_field_max_length) で切る
    for (const key of ["matched", "error", "code"]) {
      expect(body, `${key} は 64 字で切る`).toContain(`pg_catalog.left(b.body ->> '${key}', c_body_field_max_length)`);
    }
    // boolean の項目は jsonb_typeof が boolean のときだけ読む
    for (const key of ["previous_configured", "alias_used"]) {
      expect(body).toContain(`pg_catalog.jsonb_typeof(b.body -> '${key}') = 'boolean'`);
    }
    // headers は読まない。error_msg は IS NOT NULL の真偽だけ
    expect(body).not.toMatch(/\br\.headers\b/);
    const errorMsgUses = [...body.matchAll(/\br\.error_msg\b[^,\n]*/g)].map((match) => match[0].trim());
    expect(errorMsgUses).toEqual(["r.error_msg IS NOT NULL) END"]);
  });

  it("CT-8: 引数の範囲と、アプリの定数が範囲の中。タイムアウト < 猶予、保持 > 見る範囲", () => {
    const sql = readText(migrationPath());
    const results = sqlFunction(sql, RESULTS_FUNCTION);
    const send = sqlFunction(sql, SEND_FUNCTION);

    const lookbackMin = Number(sqlConstant(results.body, "c_lookback_min"));
    const lookbackMax = Number(sqlConstant(results.body, "c_lookback_max"));
    const limitMax = Number(sqlConstant(results.body, "c_limit_max"));
    const bodyFieldMax = Number(sqlConstant(results.body, "c_body_field_max_length"));
    const timeoutMs = Number(sqlConstant(send.body, "c_timeout_ms"));
    expect({ lookbackMin, lookbackMax, limitMax, bodyFieldMax, timeoutMs }).toEqual({
      lookbackMin: EXPECTED_DB_CONSTANTS.c_lookback_min,
      lookbackMax: EXPECTED_DB_CONSTANTS.c_lookback_max,
      limitMax: EXPECTED_DB_CONSTANTS.c_limit_max,
      bodyFieldMax: EXPECTED_DB_CONSTANTS.c_body_field_max_length,
      timeoutMs: EXPECTED_DB_CONSTANTS.c_timeout_ms,
    });

    const app = appConstantsFromSource();
    // 設計の値と同じ (段 C のファイルがあれば、ファイルの値を比べる)
    expect(app.values).toEqual(DESIGN_APP_CONSTANTS);
    const lookback = app.values.CRON_SECRET_PROBE_LOOKBACK_MINUTES;
    const limit = app.values.CRON_SECRET_PROBE_RESULT_LIMIT;
    const graceMinutes = app.values.CRON_SECRET_PROBE_ANSWER_GRACE_MINUTES;
    expect(lookback).toBeGreaterThanOrEqual(lookbackMin);
    expect(lookback).toBeLessThanOrEqual(lookbackMax);
    expect(limit).toBeGreaterThanOrEqual(1);
    expect(limit).toBeLessThanOrEqual(limitMax);

    // pg_net が応答を待つ上限は、アプリの猶予より短い (猶予の前に時間切れの応答が記録される)
    expect(timeoutMs).toBeLessThan(graceMinutes * 60_000);
    // 記録の保持 (24 時間) は見る範囲より長い
    const retention = /interval '(\d+) hours'/.exec(sqlConstant(send.body, "c_retention"));
    expect(retention, "c_retention は N hours の interval").not.toBeNull();
    expect(Number(retention![1]) * 60).toBeGreaterThan(lookback);
    expect(Number(retention![1])).toBe(24);
  });

  it("CT-9: HTTP の呼び出しらしい箇所はちょうど 2 つ、'app_cron_secret' と 'Bearer ' がある。c_url は本番の cron-secret-probe を指す", () => {
    const text = readText(migrationPath());
    expect([...text.matchAll(DB_HTTP_FENCE)]).toHaveLength(2);
    expect(text).toContain("'app_cron_secret'");
    expect(text).toContain("'Bearer '");

    const send = sqlFunction(text, SEND_FUNCTION);
    const url = /c_url CONSTANT text := '([^']+)';/.exec(send.body);
    expect(url, "c_url がある").not.toBeNull();
    expect(url![1].endsWith(PROBE_URL_PATH)).toBe(true);
    // ホストは、本番の別の Edge Function を呼ぶ migration (calculate-segment-stats) の c_url と同じ
    const reference = /c_url CONSTANT text := '(https:\/\/[^/']+)\/functions\/v1\//.exec(readText(SEGMENT_STATS_MIGRATION));
    expect(reference, "基準の migration に c_url がある").not.toBeNull();
    expect(url![1]).toBe(`${reference![1]}${PROBE_URL_PATH}`);
    // 呼び先は引数で差し替えられない (関数の引数は無い)
    expect(send.head).toMatch(/FUNCTION public\.send_cron_secret_probe\(\)/);
    // 呼び先の Edge Function が実在する (段 A)
    expect(fs.existsSync(path.join(ROOT, PROBE_SOURCE))).toBe(true);
  });

  it("CT-10: migration は cron.schedule を呼ばず、UPDATE は自分の表 (request_id を書く 1 か所)・DELETE は自分の表の古い行 (1 か所) だけ", () => {
    const sql = stripSqlComments(readText(migrationPath()));
    expect(sql).not.toMatch(/\bcron\.(?:un)?schedule/i);
    expect(sql).not.toMatch(/\bTRUNCATE\b/i);

    const updates = [...sql.matchAll(/\bUPDATE\s[^;]*;/g)].map((match) => match[0].replace(/\s+/g, " "));
    expect(updates).toEqual(["UPDATE public.cron_secret_probes AS p SET request_id = v_request_id WHERE p.id = v_probe_id;"]);
    const deletes = [...sql.matchAll(/\bDELETE\s[^;]*;/g)].map((match) => match[0].replace(/\s+/g, " "));
    expect(deletes).toEqual(["DELETE FROM public.cron_secret_probes AS p WHERE p.requested_at < pg_catalog.now() - c_retention;"]);

    // INSERT も自分の表だけ。ALTER は自分の表の RLS だけ。DROP は自分のポリシーの付け直しだけ
    const inserts = [...sql.matchAll(/\bINSERT INTO\s+(\S+)/g)].map((match) => match[1]);
    expect(inserts).toEqual(["public.cron_secret_probes"]);
    const alters = [...sql.matchAll(/\bALTER\s[^;]*;/g)].map((match) => match[0].replace(/\s+/g, " "));
    expect(alters).toEqual(["ALTER TABLE public.cron_secret_probes ENABLE ROW LEVEL SECURITY;"]);
    const drops = [...sql.matchAll(/\bDROP\s[^;]*;/g)].map((match) => match[0].replace(/\s+/g, " "));
    expect(drops).toEqual(["DROP POLICY IF EXISTS cron_secret_probes_deny_client_access ON public.cron_secret_probes;"]);
  });

  it("CT-11: rollback が関数 3 本と表の DROP を行い、ops_alert_state・pg_cron のジョブ・Edge Function に触れない", () => {
    const sql = stripSqlComments(readText(rollbackPath()));
    const statements = sql
      .split(";")
      .map((statement) => statement.replace(/\s+/g, " ").trim())
      .filter((statement) => statement !== "");
    expect(statements).toEqual([
      "DROP FUNCTION IF EXISTS public.cron_secret_probe_results(INTEGER, INTEGER)",
      "DROP FUNCTION IF EXISTS public.cron_secret_probe_body_json(TEXT)",
      "DROP FUNCTION IF EXISTS public.send_cron_secret_probe()",
      "DROP TABLE IF EXISTS public.cron_secret_probes",
    ]);
    expect(sql).not.toMatch(/ops_alert_state|cron\.(?:un)?schedule|functions\/v1|DELETE|UPDATE|TRUNCATE/i);
  });

  it("CT-18: send_cron_secret_probe は例外にしない (R-16): RAISE が無く、net → vault の順で有無を見て、3 つの分岐と 1 つだけの例外の受け口を持つ", () => {
    const send = sqlFunction(readText(migrationPath()), SEND_FUNCTION);
    const body = send.body;
    expect(body).not.toMatch(/\bRAISE\b/i);

    // 拡張の有無は Vault の読み取りより前に、net → vault の順で見る
    const netCheck = body.indexOf("pg_catalog.to_regclass('net._http_response') IS NULL");
    const vaultCheck = body.indexOf("pg_catalog.to_regclass('vault.decrypted_secrets') IS NULL");
    const vaultRead = body.indexOf("FROM vault.decrypted_secrets AS s");
    expect(netCheck).toBeGreaterThanOrEqual(0);
    expect(vaultCheck).toBeGreaterThan(netCheck);
    expect(vaultRead).toBeGreaterThan(vaultCheck);
    expect(body).toMatch(/IF pg_catalog\.to_regclass\('net\._http_response'\) IS NULL THEN\s*(?:\S[^\n]*\n\s*)?v_state := 'net_unavailable';/);
    expect(body).toMatch(/ELSIF pg_catalog\.to_regclass\('vault\.decrypted_secrets'\) IS NULL THEN\s*v_state := 'vault_unavailable';/);

    // 例外の受け口は 1 つだけで、中は v_secret := NULL と v_state := 'vault_unreadable' だけ
    expect(body.match(/EXCEPTION\s+WHEN\s+others/gi)).toHaveLength(1);
    const handler = /EXCEPTION\s+WHEN\s+others\s+THEN([\s\S]*?)END;/i.exec(body);
    expect(handler, "例外の受け口がある").not.toBeNull();
    const handlerStatements = handler![1]
      .split(";")
      .map((statement) => statement.replace(/\s+/g, " ").trim())
      .filter((statement) => statement !== "");
    expect(handlerStatements).toEqual(["v_secret := NULL", "v_state := 'vault_unreadable'"]);
    expect(handler![1]).not.toMatch(/SQLERRM|SQLSTATE|RAISE/i);
    // 例外の受け口は Vault の読み取りの内側のブロックにある
    expect(body.indexOf(handler![0])).toBeGreaterThan(vaultRead);

    // 値の状態の 3 つの分岐 (行が無い → NULL → 空) の順
    const notFound = body.search(/IF NOT FOUND THEN\s*v_state := 'vault_missing';/);
    const isNull = body.search(/ELSIF v_secret IS NULL THEN\s*v_state := 'vault_unreadable';/);
    const isEmpty = body.search(/ELSIF v_secret = '' THEN\s*v_state := 'vault_empty';/);
    expect(notFound).toBeGreaterThan(vaultRead);
    expect(isNull).toBeGreaterThan(notFound);
    expect(isEmpty).toBeGreaterThan(isNull);
    expect(body).toMatch(/ELSE\s*v_state := 'sent';/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 段 C: アプリ (CT-14〜CT-17。構文木で確かめる。コメントや文字列の一部には反応しない)
// ─────────────────────────────────────────────────────────────────────────────

const AUTH_SOURCE = "supabase/functions/_shared/auth.ts";
const APP_EMAIL_SOURCE = "src/lib/emails/ops/cron-secret-drift.ts";
const APP_ROUTE_SOURCE = "src/app/api/cron/app-log-alerts/route.ts";
const CRON_AUTH_SOURCE = "src/lib/cron-auth.ts";

/** 設計 §11.1 CT-16: 所見の表の件数 (level ごと) */
const EXPECTED_FINDING_COUNTS = { fail: 13, warn: 5, info: 3 } as const;

/** 名前のとおりの関数宣言を 1 つ探す */
function findFunction(sourceFile: ts.SourceFile, name: string): ts.FunctionDeclaration {
  let found: ts.FunctionDeclaration | null = null;
  walk(sourceFile, (node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) found = node;
  });
  expect(found, `${sourceFile.fileName} に function ${name} がある`).not.toBeNull();
  return found as unknown as ts.FunctionDeclaration;
}

/** `as const satisfies …` などの包みを外して、中のオブジェクトの直書きを返す */
function unwrapObjectLiteral(expression: ts.Expression): ts.ObjectLiteralExpression {
  let current: ts.Expression = expression;
  while (ts.isAsExpression(current) || ts.isSatisfiesExpression(current) || ts.isParenthesizedExpression(current)) {
    current = current.expression;
  }
  expect(ts.isObjectLiteralExpression(current), "オブジェクトの直書き").toBe(true);
  return current as ts.ObjectLiteralExpression;
}

function propertyName(property: ts.ObjectLiteralElementLike): string {
  expect(ts.isPropertyAssignment(property), "キーは name: value の形").toBe(true);
  const name = (property as ts.PropertyAssignment).name;
  expect(ts.isIdentifier(name) || ts.isStringLiteral(name), "キーは識別子か文字列").toBe(true);
  return (name as ts.Identifier | ts.StringLiteral).text;
}

/** 文字列の直書き (テンプレートリテラルは ${ を含まないものだけ) の値。それ以外は null */
function literalText(expression: ts.Expression): string | null {
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) return expression.text;
  return null;
}

describe("cron の共有シークレットの確認 (#1560) — 段 C の契約 (アプリ)", () => {
  it("CT-14: EDGE_UNAUTHORIZED_BODY_ERROR / EDGE_NOT_CONFIGURED_BODY_ERROR は _shared/auth.ts の 401 / 503 の本文の error と同じ文。CRON_SECRET_PROBE_MATCHES は ServiceRoleAuthDescription の matched の 3 値と同じ", async () => {
    const { CRON_SECRET_PROBE_MATCHES, EDGE_NOT_CONFIGURED_BODY_ERROR, EDGE_UNAUTHORIZED_BODY_ERROR } = await import("@/lib/ops-alerts/cron-secret-drift");
    const authFile = parse(AUTH_SOURCE);

    // requireServiceRole が返す new Response(JSON.stringify({ error: "…" }), { status: N, … }) の、状態コード → error の文
    const fn = findFunction(authFile, "requireServiceRole");
    const errorByStatus = new Map<number, string>();
    walk(fn, (node) => {
      if (!ts.isNewExpression(node) || dottedName(node.expression) !== "Response") return;
      const [bodyArg, initArg] = node.arguments ?? [];
      if (!bodyArg || !initArg || !ts.isCallExpression(bodyArg) || dottedName(bodyArg.expression) !== "JSON.stringify") return;
      if (!ts.isObjectLiteralExpression(initArg)) return;
      const statusProp = initArg.properties.find((p) => ts.isPropertyAssignment(p) && propertyName(p) === "status") as ts.PropertyAssignment | undefined;
      const [jsonArg] = bodyArg.arguments;
      if (!statusProp || !ts.isNumericLiteral(statusProp.initializer) || !jsonArg || !ts.isObjectLiteralExpression(jsonArg)) return;
      const errorProp = jsonArg.properties.find((p) => ts.isPropertyAssignment(p) && propertyName(p) === "error") as ts.PropertyAssignment | undefined;
      const text = errorProp ? literalText(errorProp.initializer) : null;
      if (text !== null) errorByStatus.set(Number(statusProp.initializer.text), text);
    });
    expect([...errorByStatus.keys()].sort(), "requireServiceRole の失敗の応答は 401 と 503 の 2 つ").toEqual([401, 503]);
    expect(EDGE_UNAUTHORIZED_BODY_ERROR).toBe(errorByStatus.get(401));
    expect(EDGE_NOT_CONFIGURED_BODY_ERROR).toBe(errorByStatus.get(503));

    // ServiceRoleAuthDescription の ok: true の側の matched の文字列リテラルの型
    let matchedLiterals: string[] | null = null;
    walk(authFile, (node) => {
      if (!ts.isTypeAliasDeclaration(node) || node.name.text !== "ServiceRoleAuthDescription") return;
      walk(node, (inner) => {
        if (!ts.isPropertySignature(inner) || !inner.type || !ts.isIdentifier(inner.name) || inner.name.text !== "matched") return;
        const members = ts.isUnionTypeNode(inner.type) ? inner.type.types : [inner.type];
        matchedLiterals = members.flatMap((member) => (ts.isLiteralTypeNode(member) && ts.isStringLiteral(member.literal) ? [member.literal.text] : []));
      });
    });
    expect(matchedLiterals, "ServiceRoleAuthDescription に matched の型がある").not.toBeNull();
    expect([...(matchedLiterals as unknown as string[])].sort()).toEqual([...CRON_SECRET_PROBE_MATCHES].sort());
  });

  it("CT-15: cron-secret-drift.ts (判定・文面) と route は createHash / crypto.subtle / digest( を含まない (ダイジェストを計算しない)", () => {
    for (const source of [APP_DRIFT_SOURCE, APP_EMAIL_SOURCE, APP_ROUTE_SOURCE]) {
      const sourceFile = parse(source);
      const violations: string[] = [];
      walk(sourceFile, (node) => {
        const where = locationOf(sourceFile, node);
        if (ts.isIdentifier(node) && DIGEST_IDENTIFIERS.has(node.text)) violations.push(`${where}: ${node.text}`);
        if (ts.isPropertyAccessExpression(node)) {
          const name = dottedName(node);
          if (name !== null && /(^|\.)crypto\.subtle(\.|$)/.test(name)) violations.push(`${where}: ${name}`);
          if (node.name.text === "subtle") violations.push(`${where}: .subtle`);
          if (node.name.text === "digest") violations.push(`${where}: .digest`);
        }
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "digest") violations.push(`${where}: digest(`);
        if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && /(^|[:/])crypto$/.test(node.moduleSpecifier.text)) {
          violations.push(`${where}: import ${node.moduleSpecifier.text}`);
        }
      });
      expect(violations, source).toEqual([]);
      // 走査が空振りしていないこと: 空のファイルでない
      expect(readText(source).length, source).toBeGreaterThan(0);
    }
  });

  it("CT-16: CRON_SECRET_FINDING_CATALOG の title と action は文字列リテラルで、${ を含まない (実行時の値を埋め込まない)。fail 13・warn 5・info 3 の 21 件", () => {
    const sourceFile = parse(APP_DRIFT_SOURCE);
    let catalog: ts.ObjectLiteralExpression | null = null;
    walk(sourceFile, (node) => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "CRON_SECRET_FINDING_CATALOG" && node.initializer) {
        catalog = unwrapObjectLiteral(node.initializer);
      }
    });
    expect(catalog, "CRON_SECRET_FINDING_CATALOG がある").not.toBeNull();

    const counts: Record<string, number> = { fail: 0, warn: 0, info: 0 };
    const violations: string[] = [];
    let total = 0;
    for (const entry of (catalog as unknown as ts.ObjectLiteralExpression).properties) {
      const id = propertyName(entry);
      const value = unwrapObjectLiteral((entry as ts.PropertyAssignment).initializer);
      const fields = new Map<string, ts.Expression>();
      for (const field of value.properties) fields.set(propertyName(field), (field as ts.PropertyAssignment).initializer);
      expect([...fields.keys()].sort(), `${id} のキー`).toEqual(["action", "level", "title"]);
      total += 1;
      for (const key of ["title", "action"] as const) {
        const expression = fields.get(key) as ts.Expression;
        const text = literalText(expression);
        if (text === null) violations.push(`${locationOf(sourceFile, expression)}: ${id}.${key} は文字列の直書きではない`);
        else if (text.length === 0) violations.push(`${id}.${key} が空`);
        if (expression.getText(sourceFile).includes("${")) violations.push(`${locationOf(sourceFile, expression)}: ${id}.${key} に \${ がある`);
      }
      const level = literalText(fields.get("level") as ts.Expression);
      if (level !== null && level in counts) counts[level] += 1;
      else violations.push(`${id}.level が fail / warn / info の直書きではない`);
    }
    expect(violations).toEqual([]);
    expect(total).toBe(EXPECTED_FINDING_COUNTS.fail + EXPECTED_FINDING_COUNTS.warn + EXPECTED_FINDING_COUNTS.info);
    expect(counts).toEqual(EXPECTED_FINDING_COUNTS);
  });

  it("CT-17: src/lib/cron-auth.ts の describeCronSecretRotationState は CRON_SECRET / CRON_SECRET_PREVIOUS の値を返さない (戻り値の型は真偽値 2 つ。return の中で process.env を直接返す形が無い)", () => {
    const sourceFile = parse(CRON_AUTH_SOURCE);

    // 戻り値の型 CronSecretRotationState は boolean 2 つだけ
    let memberTypes: Record<string, string> | null = null;
    walk(sourceFile, (node) => {
      if (!ts.isInterfaceDeclaration(node) || node.name.text !== "CronSecretRotationState") return;
      memberTypes = {};
      for (const member of node.members) {
        expect(ts.isPropertySignature(member) && ts.isIdentifier(member.name), "メンバーは name: type の形").toBe(true);
        const signature = member as ts.PropertySignature;
        (memberTypes as Record<string, string>)[(signature.name as ts.Identifier).text] = signature.type?.getText(sourceFile) ?? "";
      }
    });
    expect(memberTypes, "CronSecretRotationState がある").not.toBeNull();
    expect(memberTypes).toEqual({ previous_configured: "boolean", previous_same_as_current: "boolean" });

    const fn = findFunction(sourceFile, "describeCronSecretRotationState");
    expect(fn.type?.getText(sourceFile)).toBe("CronSecretRotationState");

    // return はオブジェクトの直書き 1 つで、キーは 2 つ。値の式は、環境変数の文字列をそのまま持たない
    const returns: ts.ReturnStatement[] = [];
    walk(fn, (node) => {
      if (ts.isReturnStatement(node)) returns.push(node);
    });
    expect(returns, "return はちょうど 1 つ").toHaveLength(1);
    const returned = returns[0].expression;
    expect(returned && ts.isObjectLiteralExpression(returned), "return はオブジェクトの直書き").toBe(true);
    const properties = (returned as ts.ObjectLiteralExpression).properties;
    expect(properties.map(propertyName).sort()).toEqual(["previous_configured", "previous_same_as_current"]);

    // 環境変数を持つ変数 (process.env を代入した変数)
    const envHolders = new Set<string>();
    walk(fn, (node) => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && /process\.env\./.test(node.initializer.getText(sourceFile))) {
        envHolders.add(node.name.text);
      }
    });
    expect([...envHolders].sort()).toEqual(["current", "previous"]);
    for (const property of properties) {
      const initializer = (property as ts.PropertyAssignment).initializer;
      const text = initializer.getText(sourceFile);
      expect(text, `${propertyName(property)} の値`).not.toMatch(/process\.env/);
      // 環境変数を持つ変数をそのまま返さない (=== の比較か、真偽値の変数だけ)
      expect(ts.isIdentifier(initializer) && envHolders.has(initializer.text), `${propertyName(property)} は環境変数の値そのものではない`).toBe(false);
    }
    // 値の比較は === (真偽値になる)。値を返す三項・|| ・?? の形にしない
    const sameProperty = properties.find((p) => propertyName(p) === "previous_same_as_current") as ts.PropertyAssignment;
    expect(sameProperty.initializer.getText(sourceFile)).toMatch(/===/);
    expect(sameProperty.initializer.getText(sourceFile)).not.toMatch(/\?\?|\|\||\?\s/);
  });
});
