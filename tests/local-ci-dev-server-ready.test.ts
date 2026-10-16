// @vitest-environment node
/**
 * tests/local-ci-dev-server-ready.test.ts
 *
 * #1792 結合テストの next dev (Turbopack) が Google Fonts の解決に失敗して全応答が 500 になり、結合テストが数百件の赤になった。
 * その再発を防ぐ形を固定する。
 *
 *   1. 結合テストの next dev にも、e2e のビルドと同じ Google Fonts のモック (NEXT_FONT_GOOGLE_MOCKED_RESPONSES) を渡す
 *      (.github/workflows/security-regression.yml の「Start Next dev server」と scripts/local-ci.sh の stage_integration)。
 *      外へフォントを取りに行かないので、取得の一時的な失敗で dev サーバ全体が 500 にならない
 *   2. scripts/local-ci.sh は、next dev が /login に応答したあと、結合テストを流す前に「ページを返せる」(500 未満) かを確かめ
 *      (check_dev_ready → scripts/lib/local-ci-dev-ready.sh の local_ci_dev_ready)、500 以上しか返さなければ
 *      「dev サーバの起動の失敗」として integration:setup を赤にし、next dev のログの冒頭を書き出して止める (テストは流さない)
 *   3. 確かめの回数・間隔・1 回の上限・ログの冒頭の行数は名前つきの定数 (回数は LOCAL_CI_DEV_READY_TRIES で上書きでき、1 以上の整数でなければ止める)
 *
 * yml とスクリプトのコマンド・環境変数の対応そのものは tests/local-ci-workflow-sync.test.ts が照合する (ステップの env の
 * NEXT_FONT_GOOGLE_MOCKED_RESPONSES は、スクリプトの npm run dev の前に置かれていなければ赤)。
 * 確かめの関数は、テストの中で HTTP サーバーを立てて bash と curl で実際に動かす (文字列を読んで推測しない)。
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { applyHeavyUnitTestTimeout } from "./helpers/heavy-unit-test-timeout";

// テストの中で bash と curl を起こすので、負荷の高い機械で vitest の既定の時間切れを超えうる (#1605 の同じ型)。テストを定義する前に置く
applyHeavyUnitTestTimeout();

const ROOT = process.cwd();
const SCRIPT = "scripts/local-ci.sh";
const LIB = "scripts/lib/local-ci-dev-ready.sh";
const WORKFLOW = ".github/workflows/security-regression.yml";
const MOCK_ENV = "NEXT_FONT_GOOGLE_MOCKED_RESPONSES";
const MOCK_FILE = "tests/e2e/fixtures/google-fonts-mock.cjs";
const DEV_STEP_NAME = "Start Next dev server";
/** 「dev サーバの起動の失敗」の文言 (赤の行の備考に出す) */
const DEV_START_FAILURE = "dev サーバの起動の失敗";
/** 使い方の誤りの終了コード (scripts/local-ci.sh の EXIT_USAGE) */
const EXIT_USAGE = 2;
/** HTTP のステータス */
const HTTP_OK = 200;
const HTTP_FOUND = 302;
const HTTP_NOT_FOUND = 404;
const HTTP_INTERNAL_ERROR = 500;
const HTTP_BAD_GATEWAY = 502;
/** curl が応答を得られなかったときのステータス */
const NO_RESPONSE = "000";
/** 確かめの 1 回の上限 (秒)。テストのサーバーはすぐ返すので短くてよい */
const PROBE_MAX_TIME_SEC = 5;
/** 間隔を待つかを測るときの間隔 (秒) と、その下限 (ミリ秒) */
const MEASURED_INTERVAL_SEC = 1;
const MS_PER_SEC = 1000;

const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

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

const scriptText = read(SCRIPT);
const stageIntegration = stripShellComments(functionSource(scriptText, "stage_integration"));

const tmpDirs: string[] = [];
function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "local-ci-dev-ready-"));
  tmpDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

/** 決めた順にステータスを返す HTTP サーバー (並びを使い切ったら最後の値を返し続ける)。受けたリクエストの数を数える */
async function withServer<T>(statuses: number[], body: (origin: string, hits: () => number) => Promise<T>): Promise<T> {
  let count = 0;
  const server = http.createServer((_req, res) => {
    const status = statuses[Math.min(count, statuses.length - 1)];
    count += 1;
    res.writeHead(status, { "content-type": "text/plain" });
    res.end(String(status));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    return await body(`http://127.0.0.1:${port}`, () => count);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/** 誰も待ち受けていないポートの URL (一度開いて閉じたポート) */
async function closedOrigin(): Promise<string> {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return `http://127.0.0.1:${port}`;
}

type Run = { code: number | null; stdout: string; stderr: string; elapsedMs: number };

/** bash を非同期に起こす (同じプロセスの HTTP サーバーが応答できるよう、イベントループを止めない) */
function runBash(args: string[], env: NodeJS.ProcessEnv = process.env): Promise<Run> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn("bash", args, { cwd: ROOT, env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr, elapsedMs: Date.now() - started }));
  });
}

type ReadyArgs = { url: string; tries: number; interval: number; headLines: number; serverLog: string; headOut: string };
function runReady(a: ReadyArgs): Promise<Run> {
  return runBash([
    LIB,
    a.url,
    String(a.tries),
    String(a.interval),
    String(PROBE_MAX_TIME_SEC),
    String(a.headLines),
    a.serverLog,
    a.headOut,
  ]);
}

/** 行の並びのログを書く */
function writeLog(dir: string, lines: string[]): string {
  const file = path.join(dir, "integration-next-dev.log");
  fs.writeFileSync(file, lines.map((l) => `${l}\n`).join(""));
  return file;
}
const SAMPLE_LOG = [
  "▲ Next.js 16 (Turbopack)",
  "⨯ ./src/app/layout.tsx",
  "Module not found: Can't resolve '@vercel/turbopack-next/internal/font/google/font'",
  "next/font/google queries have exactly one entry",
  "GET /login 500 in 12ms",
];

describe("#1792 結合テストの next dev に Google Fonts のモックを渡す", () => {
  it("モックのファイルがある", () => {
    expect(fs.existsSync(path.join(ROOT, MOCK_FILE))).toBe(true);
  });

  it("scripts/local-ci.sh の stage_integration の npm run dev に、モックの絶対パス ($WT の下) を渡す", () => {
    const launches = stageIntegration.split("\n").filter((line) => /\bnpm run dev\b/.test(line));
    expect(launches).toHaveLength(1);
    expect(launches[0]).toContain(`${MOCK_ENV}="$WT/${MOCK_FILE}"`);
    // env の後ろ (npm run dev の前) に置く (ci_env が親の環境変数を消したあとに足す)
    expect(launches[0].indexOf(`${MOCK_ENV}=`)).toBeGreaterThan(launches[0].indexOf(" env "));
    expect(launches[0].indexOf(`${MOCK_ENV}=`)).toBeLessThan(launches[0].indexOf("npm run dev"));
  });

  it(`${WORKFLOW} の「${DEV_STEP_NAME}」の env にモックを渡し、そのステップで npm run dev する`, () => {
    const yml = read(WORKFLOW);
    const start = yml.indexOf(`- name: ${DEV_STEP_NAME}`);
    expect(start).toBeGreaterThanOrEqual(0);
    const next = yml.indexOf("\n      - name:", start + 1);
    const step = yml.slice(start, next < 0 ? undefined : next);
    const envBlock = step.slice(step.indexOf("env:"), step.indexOf("run:"));
    expect(envBlock).toContain(`${MOCK_ENV}: \${{ github.workspace }}/${MOCK_FILE}`);
    expect(step.slice(step.indexOf("run:"))).toMatch(/\bnpm run dev\b/);
  });
});

describe("#1792 scripts/local-ci.sh は、結合テストの前に dev サーバがページを返せるかを確かめる", () => {
  it("wait_app のあと、最初の結合テストより前に check_dev_ready を呼ぶ", () => {
    const waitApp = stageIntegration.indexOf('wait_app "$DEV_WAIT_TRIES"');
    const check = stageIntegration.indexOf('check_dev_ready "$log"');
    const firstVitest = stageIntegration.indexOf("npx vitest");
    expect(waitApp).toBeGreaterThanOrEqual(0);
    expect(check).toBeGreaterThan(waitApp);
    expect(firstVitest).toBeGreaterThan(check);
    // 事前コンパイル (結果を見ない curl) より前に確かめる (500 しか返さないサーバーに事前コンパイルの待ちを重ねない)
    expect(stageIntegration.indexOf("$PRECOMPILE_MAX_TIME_SEC")).toBeGreaterThan(check);
  });

  it("確かめに失敗したら integration:setup を赤にし (備考は「dev サーバの起動の失敗」・手がかりはログの冒頭)、サーバーと Supabase を止めて段を終える", () => {
    const m = /if ! check_dev_ready "\$log"; then\n([\s\S]*?)\n\s*fi\n/.exec(stageIntegration);
    expect(m).not.toBeNull();
    const lines = (m?.[1] ?? "").split("\n").map((l) => l.trim());
    expect(lines[0]).toMatch(/^record integration:setup RED /);
    expect(lines[0]).toContain(DEV_START_FAILURE);
    expect(lines[0]).toContain('"$DEV_READY_HEAD_LOG")"');
    expect(lines.slice(1)).toEqual(["stop_server", "stop_supabase", "return 0"]);
  });

  it("check_dev_ready は、名前つきの定数 (回数・間隔・1 回の上限・冒頭の行数) を local_ci_dev_ready に渡す (数を直に書かない)", () => {
    const fn = stripShellComments(functionSource(scriptText, "check_dev_ready"));
    expect(fn).toContain(
      'local_ci_dev_ready "$APP_ORIGIN/login" "$DEV_READY_TRIES" "$WAIT_INTERVAL_SEC" "$DEV_READY_PROBE_MAX_TIME_SEC" "$DEV_LOG_HEAD_LINES" "$log" "$DEV_READY_HEAD_LOG"',
    );
    for (const name of ["DEV_READY_TRIES_DEFAULT", "DEV_READY_PROBE_MAX_TIME_SEC", "DEV_LOG_HEAD_LINES"]) {
      expect(scriptText).toMatch(new RegExp(`^readonly ${name}=\\S+`, "m"));
    }
    expect(scriptText).toMatch(/^DEV_READY_TRIES="\$\{LOCAL_CI_DEV_READY_TRIES:-\$DEV_READY_TRIES_DEFAULT\}"$/m);
    expect(scriptText).toMatch(/^\. "\$\(dirname "\$0"\)\/lib\/local-ci-dev-ready\.sh"$/m);
  });

  it.each([["0"], ["abc"], ["-1"], ["1.5"]])("LOCAL_CI_DEV_READY_TRIES=%s は使い方の誤りで止める (何も作らない)", (value) => {
    const r = spawnSync("bash", [SCRIPT, "--only", "unit"], {
      cwd: ROOT,
      env: { ...process.env, LOCAL_CI_DEV_READY_TRIES: value },
      encoding: "utf8",
    });
    expect(r.status).toBe(EXIT_USAGE);
    expect(r.stderr).toContain(`LOCAL_CI_DEV_READY_TRIES は 1 以上の整数: ${value}`);
  });
});

describe("#1792 local_ci_dev_ready (scripts/lib/local-ci-dev-ready.sh) を実際に動かす", () => {
  it("すぐページを返すサーバー (200) は、1 回の問い合わせで通し、ステータスを出し、ログの冒頭を書かない", async () => {
    const dir = tmpDir();
    const serverLog = writeLog(dir, SAMPLE_LOG);
    const headOut = path.join(dir, "head.log");
    await withServer([HTTP_OK], async (origin, hits) => {
      const r = await runReady({ url: `${origin}/login`, tries: 3, interval: 0, headLines: 2, serverLog, headOut });
      expect(r.code).toBe(0);
      expect(r.stdout.trim()).toBe(String(HTTP_OK));
      expect(hits()).toBe(1);
    });
    expect(fs.existsSync(headOut)).toBe(false);
  });

  it("一時的な 500 のあとにページを返せば通す (500・502 のあと 200 → 3 回目で通る)", async () => {
    const dir = tmpDir();
    const serverLog = writeLog(dir, SAMPLE_LOG);
    const headOut = path.join(dir, "head.log");
    await withServer([HTTP_INTERNAL_ERROR, HTTP_BAD_GATEWAY, HTTP_OK], async (origin, hits) => {
      const r = await runReady({ url: `${origin}/login`, tries: 5, interval: 0, headLines: 2, serverLog, headOut });
      expect(r.code).toBe(0);
      expect(r.stdout.trim()).toBe(String(HTTP_OK));
      expect(hits()).toBe(3);
    });
    expect(fs.existsSync(headOut)).toBe(false);
  });

  it.each([[HTTP_FOUND], [HTTP_NOT_FOUND]])("500 未満のステータス (%s) はページを返せているとみなす", async (status) => {
    const dir = tmpDir();
    await withServer([status], async (origin) => {
      const r = await runReady({
        url: `${origin}/login`,
        tries: 1,
        interval: 0,
        headLines: 2,
        serverLog: writeLog(dir, SAMPLE_LOG),
        headOut: path.join(dir, "head.log"),
      });
      expect(r.code).toBe(0);
      expect(r.stdout.trim()).toBe(String(status));
    });
  });

  it("500 しか返さないサーバーは、決めた回数だけ問い合わせて偽を返し、最後のステータスとログの冒頭 (決めた行数) を書き出す", async () => {
    const dir = tmpDir();
    const serverLog = writeLog(dir, SAMPLE_LOG);
    const headOut = path.join(dir, "head.log");
    const tries = 4;
    const headLines = 3;
    await withServer([HTTP_INTERNAL_ERROR], async (origin, hits) => {
      const r = await runReady({ url: `${origin}/login`, tries, interval: 0, headLines, serverLog, headOut });
      expect(r.code).toBe(1);
      expect(r.stdout.trim()).toBe(String(HTTP_INTERNAL_ERROR));
      expect(hits()).toBe(tries);
    });
    expect(fs.readFileSync(headOut, "utf8")).toBe(SAMPLE_LOG.slice(0, headLines).map((l) => `${l}\n`).join(""));
  });

  it("応答が無い (誰も待ち受けていない) ときは 000 を出して偽を返す", async () => {
    const dir = tmpDir();
    const headOut = path.join(dir, "head.log");
    const r = await runReady({
      url: `${await closedOrigin()}/login`,
      tries: 2,
      interval: 0,
      headLines: 1,
      serverLog: writeLog(dir, SAMPLE_LOG),
      headOut,
    });
    expect(r.code).toBe(1);
    expect(r.stdout.trim()).toBe(NO_RESPONSE);
    expect(fs.readFileSync(headOut, "utf8")).toBe(`${SAMPLE_LOG[0]}\n`);
  });

  it("サーバーのログが無ければ、無いことを冒頭の書き出し先に書く", async () => {
    const dir = tmpDir();
    const headOut = path.join(dir, "head.log");
    const missing = path.join(dir, "missing.log");
    await withServer([HTTP_INTERNAL_ERROR], async (origin) => {
      const r = await runReady({ url: `${origin}/login`, tries: 1, interval: 0, headLines: 2, serverLog: missing, headOut });
      expect(r.code).toBe(1);
    });
    expect(fs.readFileSync(headOut, "utf8")).toContain(missing);
  });

  it("問い合わせのあいだは間隔だけ待ち、最後の問い合わせの後は待たない", async () => {
    const dir = tmpDir();
    const serverLog = writeLog(dir, SAMPLE_LOG);
    await withServer([HTTP_INTERNAL_ERROR], async (origin) => {
      const two = await runReady({
        url: `${origin}/login`,
        tries: 2,
        interval: MEASURED_INTERVAL_SEC,
        headLines: 1,
        serverLog,
        headOut: path.join(dir, "head-2.log"),
      });
      expect(two.code).toBe(1);
      expect(two.elapsedMs).toBeGreaterThanOrEqual(MEASURED_INTERVAL_SEC * MS_PER_SEC);
      // 1 回だけなら待たない (間隔を長くしても、その分は掛からない)
      const longInterval = PROBE_MAX_TIME_SEC;
      const one = await runReady({
        url: `${origin}/login`,
        tries: 1,
        interval: longInterval,
        headLines: 1,
        serverLog,
        headOut: path.join(dir, "head-1.log"),
      });
      expect(one.code).toBe(1);
      expect(one.elapsedMs).toBeLessThan(longInterval * MS_PER_SEC);
    });
  });

  it.each([
    ["100", true],
    ["200", true],
    ["499", true],
    ["99", false],
    ["500", false],
    ["503", false],
    ["000", false],
    ["", false],
    ["abc", false],
  ])("local_ci_dev_ready_status_ok %j → %s", async (status, ok) => {
    const r = await runBash(["-c", `. ${LIB} && local_ci_dev_ready_status_ok "$1"`, "bash", status]);
    expect(r.code === 0).toBe(ok);
  });
});

describe("#1792 scripts/local-ci.sh の check_dev_ready を実際に動かす (関数をスクリプトから取り出す)", () => {
  /** check_dev_ready を、ライブラリと say だけを用意した bash で動かす。最後に戻り値と変数を出す */
  async function runCheck(origin: string, log: string, tries: number) {
    const fn = functionSource(scriptText, "check_dev_ready");
    const harness = [
      "set -u",
      `. ${LIB}`,
      "say() { printf '[local-ci] %s\\n' \"$*\" >&2; }",
      `APP_ORIGIN='${origin}'`,
      `DEV_READY_TRIES=${tries}`,
      "WAIT_INTERVAL_SEC=0",
      `DEV_READY_PROBE_MAX_TIME_SEC=${PROBE_MAX_TIME_SEC}`,
      "DEV_LOG_HEAD_LINES=2",
      fn,
      `check_dev_ready '${log}'; rc=$?`,
      'printf "rc=%s status=%s head=%s\\n" "$rc" "$DEV_READY_LAST_STATUS" "$DEV_READY_HEAD_LOG"',
    ].join("\n");
    return runBash(["-c", harness]);
  }

  it("500 しか返さなければ偽を返し、ログの冒頭を <ログ>-head.log に書いて表示し、ログに最後のステータスを残す", async () => {
    const dir = tmpDir();
    const log = writeLog(dir, SAMPLE_LOG);
    const head = log.replace(/\.log$/, "-head.log");
    await withServer([HTTP_INTERNAL_ERROR], async (origin, hits) => {
      const r = await runCheck(origin, log, 2);
      expect(r.stdout.trim()).toBe(`rc=1 status=${HTTP_INTERNAL_ERROR} head=${head}`);
      expect(hits()).toBe(2);
      expect(r.stderr).toContain(DEV_START_FAILURE);
      expect(r.stderr).toContain(SAMPLE_LOG[0]);
      expect(r.stderr).toContain(SAMPLE_LOG[1]);
      expect(r.stderr).not.toContain(SAMPLE_LOG[2]);
    });
    expect(fs.readFileSync(head, "utf8")).toBe(SAMPLE_LOG.slice(0, 2).map((l) => `${l}\n`).join(""));
    expect(fs.readFileSync(log, "utf8")).toContain(`-> ${HTTP_INTERNAL_ERROR}\n`);
  });

  it("ページを返せれば真を返し、何も表示しない", async () => {
    const dir = tmpDir();
    const log = writeLog(dir, SAMPLE_LOG);
    await withServer([HTTP_OK], async (origin) => {
      const r = await runCheck(origin, log, 2);
      expect(r.stdout.trim()).toBe(`rc=0 status=${HTTP_OK} head=${log.replace(/\.log$/, "-head.log")}`);
      expect(r.stderr).toBe("");
    });
    expect(fs.existsSync(log.replace(/\.log$/, "-head.log"))).toBe(false);
    expect(fs.readFileSync(log, "utf8")).toContain(`-> ${HTTP_OK}\n`);
  });
});
