// @vitest-environment node
/**
 * tests/local-ci-gateway-502.test.ts
 *
 * #1779 結合テストの準備の INSERT・UPDATE・RPC・/pg/query が、入口の Kong の 502 (An invalid response was received from the
 * upstream server) で間欠的に落ちていた。原因 (Kong が使い回す奥への接続を PostgREST が先に閉じる) は scripts/supabase-local.sh の
 * tune_kong_keepalive で消した (tests/supabase-local-kong-keepalive.test.ts)。ここでは再発の見張りを固定する。
 *
 *   1. scripts/lib/local-ci-gateway-502.sh: Kong のログ (access.log と error.log が混ざったもの) から、状態が 502 の要求の数と、
 *      error.log の奥とのやりとりの失敗の文言ごとの件数を出す
 *   2. scripts/local-ci.sh の gateway_check: Kong のログを $ART/<段>-kong.log に残し、0 件なら <段>:gateway を緑、1 件でもあれば赤にする。
 *      ログを読めなければ赤 (黙って緑にしない)
 *   3. stage_integration は、2 本目の結合テストのあと、ローカル Supabase を止める前に gateway_check integration を呼ぶ
 *
 * どれも bash を実際に動かして確かめる (文字列を読んで推測しない)。docker は代わりのコマンドに差し替える。
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { applyHeavyUnitTestTimeout } from "./helpers/heavy-unit-test-timeout";

// テストの中で bash を起こすので、負荷の高い機械で vitest の既定の時間切れを超えうる (#1605 の同じ型)。テストを定義する前に置く
applyHeavyUnitTestTimeout();

const ROOT = process.cwd();
const LIB = "scripts/lib/local-ci-gateway-502.sh";
const SCRIPT = "scripts/local-ci.sh";
/** 枠の project_id (コンテナ名 supabase_kong_<これ>) の例 */
const PROJECT_ID = "homegohan-local-s3";

/** 2026-10-17 に d256 の結合テストで出た、実際の Kong のログの形 (docker logs。access.log は標準出力・error.log は標準エラー) */
const ACCESS_OK =
  '172.21.0.1 - - [16/Oct/2026:16:07:23 +0000] "POST /rest/v1/rpc/create_org_invite HTTP/1.1" 200 592 "-" "node"';
const ACCESS_502 =
  '172.21.0.1 - - [16/Oct/2026:16:07:24 +0000] "POST /rest/v1/rpc/create_org_invite HTTP/1.1" 502 75 "-" "node"';
const ACCESS_502_PATCH =
  '172.21.0.1 - - [16/Oct/2026:16:09:10 +0000] "PATCH /rest/v1/family_groups?id=eq.1 HTTP/1.1" 502 75 "-" "node"';
/** 要求の文字列に 502 が入っているが、状態は 200 (数えない) */
const ACCESS_502_IN_PATH =
  '172.21.0.1 - - [16/Oct/2026:16:07:25 +0000] "GET /rest/v1/items?id=eq.502 HTTP/1.1" 200 502 "-" "node"';
/** 状態が 500 (アプリの誤り。数えない) */
const ACCESS_500 =
  '172.21.0.1 - - [16/Oct/2026:16:15:44 +0000] "POST /rest/v1/rpc/complete_account_deletion_record HTTP/1.1" 500 89 "-" "node"';
const ERROR_PREMATURE =
  '2026/10/16 16:07:24 [error] 1114#0: *104 upstream prematurely closed connection while reading response header from upstream, client: 172.21.0.1, server: kong, request: "POST /rest/v1/rpc/create_org_invite HTTP/1.1", upstream: "http://172.21.0.7:3000/rpc/create_org_invite", host: "127.0.0.1:54821"';
const ERROR_PREMATURE_2 =
  '2026/10/16 16:09:10 [error] 1114#0: *2210 upstream prematurely closed connection while reading response header from upstream, client: 172.21.0.1, server: kong, request: "PATCH /rest/v1/family_groups?id=eq.1 HTTP/1.1", upstream: "http://172.21.0.7:3000/family_groups?id=eq.1", host: "127.0.0.1:54821"';
const ERROR_RESET =
  '2026/10/16 16:10:00 [error] 1114#0: *3000 recv() failed (104: Connection reset by peer) while reading response header from upstream, client: 172.21.0.1, server: kong, request: "POST /pg/query HTTP/1.1", upstream: "http://172.21.0.9:8080/query", host: "127.0.0.1:54821"';
/** 重さが warn の行 (数えない)。upstream を含むが、応答は返せている */
const WARN_UPSTREAM =
  '2026/10/16 16:12:00 [warn] 1114#0: *4878 upstream sent more data than specified in "Content-Length" header while reading upstream, client: 172.21.0.1, server: kong';
/** upstream を含まない error の行 (数えない) */
const ERROR_OTHER = '2026/10/16 16:13:00 [error] 1114#0: *5000 client intended to send too large body: 2000000 bytes, client: 172.21.0.1, server: kong';

const tmpDirs: string[] = [];
function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "local-ci-gateway-502-"));
  tmpDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function writeLog(dir: string, lines: string[]): string {
  const file = path.join(dir, "kong.log");
  fs.writeFileSync(file, lines.map((l) => `${l}\n`).join(""));
  return file;
}

function runLib(args: string[]) {
  return spawnSync("bash", [LIB, ...args], { cwd: ROOT, encoding: "utf8" });
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

/** スクリプトから関数の定義 (`name() {` から行頭の `}` まで) を取り出す */
function functionSource(source: string, name: string): string {
  const m = new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?\\n\\}\\n`, "m").exec(source);
  if (!m) throw new Error(`${name} の定義が見つからない`);
  return m[0];
}

const scriptText = fs.readFileSync(path.join(ROOT, SCRIPT), "utf8");

describe("#1779 scripts/lib/local-ci-gateway-502.sh: Kong のログの 502 を数える", () => {
  it("状態の欄が 502 の要求だけを数え、理由は error.log の upstream の文言ごとに件数の多い順で出す", () => {
    const dir = tmpDir();
    const log = writeLog(dir, [
      ACCESS_OK,
      ACCESS_502,
      ACCESS_502_IN_PATH,
      ACCESS_500,
      ACCESS_502_PATCH,
      ERROR_PREMATURE,
      ERROR_RESET,
      ERROR_PREMATURE_2,
      WARN_UPSTREAM,
      ERROR_OTHER,
    ]);
    const r = runLib([log]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toBe(
      "2\t" +
        "upstream prematurely closed connection while reading response header from upstream × 2" +
        " / recv() failed (104: Connection reset by peer) while reading response header from upstream × 1\n",
    );
  });

  it("502 も理由も無ければ「0<TAB>なし」", () => {
    const dir = tmpDir();
    const r = runLib([writeLog(dir, [ACCESS_OK, ACCESS_502_IN_PATH, ACCESS_500, WARN_UPSTREAM, ERROR_OTHER])]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toBe("0\tなし\n");
  });

  it("空のログでも「0<TAB>なし」", () => {
    const dir = tmpDir();
    const r = runLib([writeLog(dir, [])]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toBe("0\tなし\n");
  });

  it("ログのファイルが無ければ、何も出さずに偽を返す", () => {
    const dir = tmpDir();
    const r = runLib([path.join(dir, "missing.log")]);
    expect(r.status).not.toBe(0);
    expect(r.stdout).toBe("");
  });
});

/**
 * scripts/local-ci.sh の gateway_check を、代わりの docker・record と一緒に bash で動かす。
 * record は「RECORD <引数をタブ区切り>」を標準出力に出す
 */
function runGatewayCheck(opts: { dockerLog?: string[]; dockerFails?: boolean }) {
  const dir = tmpDir();
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  const art = path.join(dir, "art");
  fs.mkdirSync(art);
  const logSource = path.join(dir, "docker-logs.txt");
  fs.writeFileSync(logSource, (opts.dockerLog ?? []).map((l) => `${l}\n`).join(""));
  const calls = path.join(dir, "docker-calls.txt");
  fs.writeFileSync(
    path.join(bin, "docker"),
    [
      "#!/usr/bin/env bash",
      `echo "$*" >>"${calls}"`,
      opts.dockerFails ? 'echo "Error: No such container: $2" >&2; exit 1' : `cat "${logSource}"`,
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  const harness = [
    "set -u -o pipefail",
    `. "${path.join(ROOT, LIB)}"`,
    "record() { local IFS=$'\\t'; echo \"RECORD $*\"; }",
    "tail_hint() { printf '%s (末尾は %s)' \"$1\" \"$2\"; }",
    `ART="${art}"`,
    `SLOT_PROJECT_ID="${PROJECT_ID}"`,
    functionSource(scriptText, "gateway_check"),
    "gateway_check integration",
  ].join("\n");
  const r = spawnSync("bash", ["-c", harness], { cwd: ROOT, encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
  const records = r.stdout
    .split("\n")
    .filter((l) => l.startsWith("RECORD "))
    .map((l) => l.slice("RECORD ".length).split("\t"));
  return {
    status: r.status,
    stderr: r.stderr,
    records,
    calls: fs.existsSync(calls) ? fs.readFileSync(calls, "utf8").split("\n").filter(Boolean) : [],
    savedLog: path.join(art, "integration-kong.log"),
  };
}

describe("#1779 scripts/local-ci.sh の gateway_check", () => {
  it("枠の Kong のコンテナのログを $ART/<段>-kong.log に残し、502 が 0 件なら <段>:gateway を緑にする", () => {
    const r = runGatewayCheck({ dockerLog: [ACCESS_OK, ACCESS_502_IN_PATH, WARN_UPSTREAM] });
    expect(r.status, r.stderr).toBe(0);
    expect(r.calls).toEqual([`logs supabase_kong_${PROJECT_ID}`]);
    expect(fs.readFileSync(r.savedLog, "utf8")).toBe(`${ACCESS_OK}\n${ACCESS_502_IN_PATH}\n${WARN_UPSTREAM}\n`);
    expect(r.records).toEqual([
      ["integration:gateway", "GREEN", "-", "0", "-", "-", "-", "0", `Kong の 502: 0 件 (ログ: ${r.savedLog})`],
    ]);
  });

  it("502 が 1 件でもあれば <段>:gateway を赤にし、件数を failed の欄に、理由を備考に書く", () => {
    const r = runGatewayCheck({ dockerLog: [ACCESS_OK, ACCESS_502, ERROR_PREMATURE] });
    expect(r.status, r.stderr).toBe(0);
    expect(r.records).toEqual([
      [
        "integration:gateway",
        "RED",
        "-",
        "1",
        "-",
        "-",
        "-",
        "0",
        `Kong の 502: 1 件 (理由: upstream prematurely closed connection while reading response header from upstream × 1。ログ: ${r.savedLog}。#1779)`,
      ],
    ]);
  });

  it("docker logs が失敗したら (コンテナが無いなど)、黙って緑にせず <段>:gateway を赤にする", () => {
    const r = runGatewayCheck({ dockerFails: true });
    expect(r.status, r.stderr).toBe(0);
    expect(r.records).toHaveLength(1);
    expect(r.records[0].slice(0, 2)).toEqual(["integration:gateway", "RED"]);
    expect(r.records[0][8]).toBe(
      `Kong のログを読めない (docker logs supabase_kong_${PROJECT_ID} が失敗) (末尾は ${r.savedLog})`,
    );
  });
});

describe("#1779 stage_integration が見張りを呼ぶ位置", () => {
  const stage = stripShellComments(functionSource(scriptText, "stage_integration"));

  it("2 本目の結合テスト (運営コンソール) の記録のあと、Next と Supabase を止める前に gateway_check integration を 1 回呼ぶ", () => {
    const calls = stage.split("\n").filter((l) => /\bgateway_check\b/.test(l));
    expect(calls.map((l) => l.trim())).toEqual(["gateway_check integration"]);
    const operator = stage.indexOf("record_parsed integration:operator");
    const check = stage.indexOf("gateway_check integration");
    const tail = stage.slice(check);
    expect(operator).toBeGreaterThanOrEqual(0);
    expect(check).toBeGreaterThan(operator);
    expect(tail.indexOf("stop_server")).toBeGreaterThan(0);
    expect(tail.indexOf("stop_supabase")).toBeGreaterThan(0);
  });

  it("local-ci.sh は数える関数のライブラリを読み込む", () => {
    expect(stripShellComments(scriptText)).toMatch(/^\. "\$\(dirname "\$0"\)\/lib\/local-ci-gateway-502\.sh"$/m);
  });
});
