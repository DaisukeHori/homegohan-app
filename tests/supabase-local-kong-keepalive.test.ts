// @vitest-environment node
/**
 * tests/supabase-local-kong-keepalive.test.ts
 *
 * #1779 結合テストの準備の INSERT・UPDATE・RPC・/pg/query (どれも POST か PATCH) が、ローカル Supabase の入口の Kong の 502
 * (An invalid response was received from the upstream server) で間欠的に落ちていた。
 *
 * 原因 (2026-10-17 に d256 で確かめた事実):
 *   - CLI 2.62.10 の Kong 2.8.1 は、Kong の既定のまま奥への接続を使い回す (upstream_keepalive_pool_size = 60・idle 60 秒)
 *   - PostgREST は、使われていない接続を Kong の 60 秒より前に閉じることがある (測ったときは最後の要求から約 58 秒。Kong の側に
 *     TIME_WAIT が残らなかった = PostgREST が先に閉じた)
 *   - 閉じるのと Kong がその接続で次の要求を送るのが重なると、Kong の error.log に
 *     「upstream prematurely closed connection while reading response header from upstream」が出て 502 になる。
 *     nginx は POST・PATCH を別の接続で送り直さないので、落ちるのは状態を変える要求だけ
 *
 * 直し方: scripts/supabase-local.sh は、start のあと (と、db reset で Kong を再起動したあと) に、Kong のコンテナの中で
 * `kong reload` を KONG_UPSTREAM_KEEPALIVE_POOL_SIZE=0 (使い回さない) で打ち、Kong が書き出した設定 (.kong_env) に値が入ったかを
 * 確かめる (tune_kong_keepalive)。入らなければ start を失敗にする (使い回しのまま結合テストを流さない)。
 *
 * ここでは、その流れを、CLI・docker・curl を代わりのコマンドに差し替えて確かめる (本物の Docker は使わない)。
 * 代わりの docker は、reload に渡された KONG_UPSTREAM_KEEPALIVE_POOL_SIZE を状態のファイルに書き、cat .kong_env でそれを返す
 * (Kong が設定を書き出し直す動きの写し)。
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyHeavyUnitTestTimeout } from "./helpers/heavy-unit-test-timeout";
import { SLOT_LIB, SUPABASE_IMAGE_PULL_LIB } from "./helpers/local-ci-slot-values";

// テストの中で bash を何度も起こすので、負荷の高い機械で vitest の既定の時間切れを超えうる (#1605 の同じ型)。テストを定義する前に置く
applyHeavyUnitTestTimeout();

const ROOT = process.cwd();
const SUPABASE_LOCAL = "scripts/supabase-local.sh";
/** CLI 2.62.10 が Kong に渡す nginx の雛形 (reload でも同じものを渡す) */
const KONG_NGINX_TEMPLATE = "/home/kong/custom_nginx.template";
/** Kong が設定を書き出す場所 */
const KONG_ENV_FILE = "/usr/local/kong/.kong_env";
/** Kong 2.8.1 の既定の使い回しの数 (CLI のままの値) */
const KONG_DEFAULT_POOL_SIZE = "60";
/** 使い方の誤り */
const EXIT_USAGE = 2;
/** 枠 0 の project_id (scripts/lib/local-ci-slot.sh の LCS_PROJECT_ID_BASE) */
const PROJECT_ID_SLOT0 = "homegohan-local";
/** 試す枠と、その project_id */
const SLOT = "3";
const PROJECT_ID_SLOT = `${PROJECT_ID_SLOT0}-s${SLOT}`;
/** db reset の失敗のうち、Kong の再起動でやり直すもの (supabase-local.sh の db_reset_with_retry) */
const STORAGE_502_ERROR = 'Error status 502: request: Get "http://127.0.0.1:54321/storage/v1/bucket"';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "supabase-local-kong-keepalive-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const bin = path.join(tmp, "bin");
fs.mkdirSync(bin);
// CLI の代わり: 「cli <引数>」を FAKE_CALLS に足す。db reset は FAKE_RESET_ERROR があればそれを stderr に出して失敗する。
// status -o env は Kong の再起動のあとの待ちが読む接続情報を出す
fs.writeFileSync(
  path.join(bin, "fake-supabase"),
  [
    "#!/usr/bin/env bash",
    'echo "cli $*" >>"$FAKE_CALLS"',
    'if [ "$1 $2" = "db reset" ] && [ -n "${FAKE_RESET_ERROR:-}" ]; then echo "$FAKE_RESET_ERROR" >&2; exit 1; fi',
    'if [ "$1" = start ] && [ -n "${FAKE_START_FAIL:-}" ]; then echo "some other start error" >&2; exit 1; fi',
    'if [ "$1 $2 $3" = "status -o env" ]; then echo \'API_URL="http://127.0.0.1:54321"\'; echo \'SERVICE_ROLE_KEY="fake-key"\'; fi',
    "exit 0",
    "",
  ].join("\n"),
  { mode: 0o755 },
);
// docker の代わり: 「docker <引数>」を FAKE_CALLS に足す。
//   info → 成功 / restart → Kong の設定を CLI の起動時の値 (60) に戻す /
//   exec -e KONG_UPSTREAM_KEEPALIVE_POOL_SIZE=<n> <c> kong reload ... → FAKE_RELOAD_FAIL なら失敗、FAKE_RELOAD_IGNORES なら値を変えずに成功、
//     それ以外は <n> を状態に書く / exec <c> cat .kong_env → FAKE_CAT_FAIL なら失敗、それ以外は状態の値を .kong_env の形で出す
fs.writeFileSync(
  path.join(bin, "docker"),
  [
    "#!/usr/bin/env bash",
    'echo "docker $*" >>"$FAKE_CALLS"',
    'state="$FAKE_KONG_STATE"',
    'case "$1" in',
    "  info) exit 0 ;;",
    `  restart) echo ${KONG_DEFAULT_POOL_SIZE} >"$state"; exit 0 ;;`,
    "  exec)",
    '    if [[ " $* " == *" kong reload "* ]]; then',
    '      [ -n "${FAKE_RELOAD_FAIL:-}" ] && { echo "Error: reload failed" >&2; exit 1; }',
    '      echo "Kong reloaded"',
    '      [ -n "${FAKE_RELOAD_IGNORES:-}" ] && exit 0',
    '      for a in "$@"; do case "$a" in KONG_UPSTREAM_KEEPALIVE_POOL_SIZE=*) echo "${a#*=}" >"$state" ;; esac; done',
    "      exit 0",
    "    fi",
    `    if [[ " $* " == *" cat ${KONG_ENV_FILE} "* ]]; then`,
    '      [ -n "${FAKE_CAT_FAIL:-}" ] && exit 1',
    "      echo 'upstream_keepalive_max_requests = 100'",
    '      echo "upstream_keepalive_pool_size = $(cat "$state")"',
    "      echo 'upstream_keepalive_idle_timeout = 60'",
    "      exit 0",
    "    fi",
    "    exit 1 ;;",
    "esac",
    "exit 1",
    "",
  ].join("\n"),
  { mode: 0o755 },
);
// curl の代わり: Storage API がすぐ 200 を返す (Kong の再起動のあとの待ち)
fs.writeFileSync(path.join(bin, "curl"), '#!/usr/bin/env bash\necho "curl" >>"$FAKE_CALLS"\nprintf 200\n', { mode: 0o755 });
// sleep は待たない
fs.writeFileSync(path.join(bin, "sleep"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });

// 必要なファイルだけを一時的な git リポジトリに写して動かす (リポジトリの .supabase-local/ に触れない)
const repo = path.join(tmp, "repo");
beforeAll(() => {
  for (const rel of [SUPABASE_LOCAL, SLOT_LIB, SUPABASE_IMAGE_PULL_LIB, "supabase/config.toml", "supabase/baseline/manifest.json"]) {
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    fs.copyFileSync(path.join(ROOT, rel), path.join(repo, rel));
  }
  fs.mkdirSync(path.join(repo, "supabase/migrations"), { recursive: true });
  spawnSync("git", ["init", "--quiet"], { cwd: repo });
});

type Run = { status: number | null; out: string; err: string; calls: string[]; pool: string };
let caseNo = 0;

function run(command: string, env: Record<string, string> = {}): Run {
  caseNo += 1;
  const calls = path.join(tmp, `calls-${caseNo}`);
  const state = path.join(tmp, `kong-state-${caseNo}`);
  const tmpdir = path.join(tmp, `tmpdir-${caseNo}`);
  fs.writeFileSync(calls, "");
  // 起動した直後の Kong は CLI のまま (使い回す)
  fs.writeFileSync(state, `${KONG_DEFAULT_POOL_SIZE}\n`);
  fs.mkdirSync(tmpdir);
  const r = spawnSync("bash", [SUPABASE_LOCAL, command], {
    cwd: repo,
    encoding: "utf8",
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      HOME: process.env.HOME,
      TMPDIR: tmpdir,
      SUPABASE_CLI: path.join(bin, "fake-supabase"),
      FAKE_CALLS: calls,
      FAKE_KONG_STATE: state,
      ...env,
    },
  });
  return {
    status: r.status,
    out: r.stdout,
    err: r.stderr,
    calls: fs.readFileSync(calls, "utf8").split("\n").filter(Boolean),
    pool: fs.readFileSync(state, "utf8").trim(),
  };
}

const reloadCall = (projectId: string, pool: string) =>
  `docker exec -e KONG_UPSTREAM_KEEPALIVE_POOL_SIZE=${pool} supabase_kong_${projectId} kong reload --nginx-conf ${KONG_NGINX_TEMPLATE}`;
const catCall = (projectId: string) => `docker exec supabase_kong_${projectId} cat ${KONG_ENV_FILE}`;
/** 呼び出しのうち、CLI の start と、Kong への docker exec / restart だけ (並びを比べる) */
const kongFlow = (calls: string[]) => calls.filter((c) => /^cli start |^docker (exec|restart) /.test(c));

describe("#1779 scripts/supabase-local.sh start は、Kong の奥への接続の使い回しを止める", () => {
  it("start のあと、枠 0 の Kong に KONG_UPSTREAM_KEEPALIVE_POOL_SIZE=0 で kong reload を打ち (CLI と同じ雛形)、.kong_env に 0 が入ったのを確かめる", () => {
    const r = run("start");
    expect(r.status, r.err).toBe(0);
    expect(kongFlow(r.calls)).toEqual([
      expect.stringMatching(/^cli start /),
      reloadCall(PROJECT_ID_SLOT0, "0"),
      catCall(PROJECT_ID_SLOT0),
    ]);
    expect(r.pool).toBe("0");
    expect(r.err).toContain(`Kong (supabase_kong_${PROJECT_ID_SLOT0}) の奥への接続の使い回しを 0 にしました`);
    // 標準出力には何も足さない (CI の yml・local-ci.sh が start の出力を読むことはないが、env のように標準出力を使うコマンドと揃える)
    expect(r.out).not.toContain("Kong reloaded");
  });

  it("枠 (LOCAL_CI_SLOT) を指定すれば、その枠の Kong のコンテナに打つ", () => {
    const r = run("start", { LOCAL_CI_SLOT: SLOT });
    expect(r.status, r.err).toBe(0);
    expect(kongFlow(r.calls).slice(1)).toEqual([reloadCall(PROJECT_ID_SLOT, "0"), catCall(PROJECT_ID_SLOT)]);
  });

  it("SUPABASE_LOCAL_KONG_UPSTREAM_KEEPALIVE_POOL_SIZE で値を変えられる (Kong の既定の 60 に戻して比べるとき)", () => {
    const r = run("start", { SUPABASE_LOCAL_KONG_UPSTREAM_KEEPALIVE_POOL_SIZE: KONG_DEFAULT_POOL_SIZE });
    expect(r.status, r.err).toBe(0);
    expect(kongFlow(r.calls).slice(1)).toEqual([reloadCall(PROJECT_ID_SLOT0, KONG_DEFAULT_POOL_SIZE), catCall(PROJECT_ID_SLOT0)]);
  });

  it("値が 0 以上の整数でなければ、CLI も docker も打たずに 2 で終わる", () => {
    for (const value of ["x", "-1", "1.5", " "]) {
      const r = run("start", { SUPABASE_LOCAL_KONG_UPSTREAM_KEEPALIVE_POOL_SIZE: value });
      expect(r.status, value).toBe(EXIT_USAGE);
      expect(r.calls, value).toEqual([]);
      expect(r.err, value).toContain("SUPABASE_LOCAL_KONG_UPSTREAM_KEEPALIVE_POOL_SIZE は 0 以上の整数にしてください");
    }
  });

  it("CLI の start が失敗したら、Kong には触らず CLI の終了コードのまま終わる", () => {
    const r = run("start", { FAKE_START_FAIL: "1" });
    expect(r.status).not.toBe(0);
    expect(r.calls.filter((c) => c.startsWith("docker exec"))).toEqual([]);
  });

  it("kong reload が失敗したら start を失敗にする (使い回しのまま結合テストを流さない)", () => {
    const r = run("start", { FAKE_RELOAD_FAIL: "1" });
    expect(r.status).toBe(1);
    expect(r.err).toContain("kong reload が失敗");
    expect(r.calls).not.toContain(catCall(PROJECT_ID_SLOT0));
  });

  it("reload が通っても .kong_env の値が変わっていなければ start を失敗にする", () => {
    const r = run("start", { FAKE_RELOAD_IGNORES: "1" });
    expect(r.status).toBe(1);
    expect(r.pool).toBe(KONG_DEFAULT_POOL_SIZE);
    expect(r.err).toContain(`upstream_keepalive_pool_size が ${KONG_DEFAULT_POOL_SIZE} のままです (入れ直そうとした値: 0)`);
  });

  it(".kong_env を読めなければ start を失敗にする", () => {
    const r = run("start", { FAKE_CAT_FAIL: "1" });
    expect(r.status).toBe(1);
    expect(r.err).toContain(`の設定 (${KONG_ENV_FILE}) を読めませんでした`);
  });
});

describe("#1779 db reset で Kong を再起動したときも、使い回しを止め直す", () => {
  it("Storage の 502 で Kong を docker restart したら (設定が CLI の起動時に戻る)、Storage API の応答のあとに入れ直す", () => {
    const r = run("reset", { FAKE_RESET_ERROR: STORAGE_502_ERROR });
    expect(r.status, r.err).toBe(0);
    expect(kongFlow(r.calls)).toEqual([
      `docker restart supabase_kong_${PROJECT_ID_SLOT0}`,
      reloadCall(PROJECT_ID_SLOT0, "0"),
      catCall(PROJECT_ID_SLOT0),
    ]);
    // 入れ直しは Storage API の応答 (curl) のあと
    expect(r.calls.indexOf("curl")).toBeLessThan(r.calls.indexOf(reloadCall(PROJECT_ID_SLOT0, "0")));
    expect(r.pool).toBe("0");
  });

  it("再起動のあとの入れ直しが失敗したら、reset を失敗にする", () => {
    const r = run("reset", { FAKE_RESET_ERROR: STORAGE_502_ERROR, FAKE_RELOAD_FAIL: "1" });
    expect(r.status).not.toBe(0);
    expect(r.err).toContain("kong reload が失敗");
  });

  it("db reset が通れば Kong には触らない (reset は Kong を再起動しない)", () => {
    const r = run("reset");
    expect(r.status, r.err).toBe(0);
    expect(r.calls.filter((c) => /^docker (exec|restart) /.test(c))).toEqual([]);
  });
});
