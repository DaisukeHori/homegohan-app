// @vitest-environment node
/**
 * tests/supabase-image-pull.test.ts
 *
 * Supabase CLI の Docker イメージの取得の一過性の失敗 (#1523) への備えを確かめる。
 *   - scripts/lib/supabase-image-pull.sh (取得元の切り替えと周回のやり直し・取れなかったときの出し方)
 *   - scripts/supabase-image-fallback.sh (CI の db diff が CLI を打つ入口)
 *   - scripts/supabase-local.sh start (security-regression・e2e-local・local-ci.sh が使う)
 *   - それを使う CI の yml (deploy-supabase-migrations.yml の Verify db diff・security-regression.yml・e2e-local.yml)
 *
 * 本物の CLI・Docker・待ちは使わない。CLI の代わり (fake) は、受け取った取得元 (環境変数 SUPABASE_INTERNAL_IMAGE_REGISTRY) と
 * 引数を 1 行ずつ記録し、決めた回数までは決めたエラーを stderr に出して失敗する。sleep の代わりは秒数を書くだけ。
 *
 * 取得元を替えるのに使う環境変数 SUPABASE_INTERNAL_IMAGE_REGISTRY は、CLI 2.62.10 の internal/utils/docker.go の GetRegistry が
 * 読む (viper の接頭辞 SUPABASE_ + INTERNAL_IMAGE_REGISTRY。cmd/root.go の SetEnvPrefix("SUPABASE"))。ここでは CLI の中身は確かめない。
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { resolveUnitSlotTestTimeout } from "./helpers/local-ci-slot-test-timeout";
import { SLOT_LIB, SUPABASE_IMAGE_PULL_LIB } from "./helpers/local-ci-slot-values";

// bash を何度も起動するので、負荷の高い機械で vitest の既定の 5 秒を超えうる (tests/local-ci-slot*.test.ts と同じ値。#1488・#1605)。
// テスト・フックを定義する前に置く
const TEST_TIMEOUT_MS = resolveUnitSlotTestTimeout(process.env);
vi.setConfig({ testTimeout: TEST_TIMEOUT_MS, hookTimeout: TEST_TIMEOUT_MS });

/** 文字列を RegExp の中でそのまま一致させるため、正規表現の記号をすべてエスケープする */
const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const ROOT = process.cwd();
const FALLBACK = "scripts/supabase-image-fallback.sh";
const SUPABASE_LOCAL = "scripts/supabase-local.sh";

/** CLI の既定の取得元と、Supabase の写し (scripts/lib/supabase-image-pull.sh の既定の順) */
const ECR = "public.ecr.aws";
const GHCR = "ghcr.io";
/** 取れなかったときの終了コード (sysexits.h の EX_TEMPFAIL。ライブラリの SIP_EXIT_PULL_UNAVAILABLE) */
const EXIT_PULL_UNAVAILABLE = 75;
/** 使い方の誤り */
const EXIT_USAGE = 2;
/** 取得元を一巡する回数の既定 (SIP_ROUNDS_DEFAULT) */
const DEFAULT_ROUNDS = 3;
/** 周のあとの待ちの単位秒の既定: supabase-image-fallback.sh は 60、supabase-local.sh start は 30 */
const FALLBACK_WAIT_UNIT = 60;
const START_WAIT_UNIT = 30;

/** ECR の認証なしの上限に当たったときの、実際のエラー (2026-10-14 の run 38440247647 のログの形) */
const PULL_LIMIT_ERROR =
  "failed to pull docker image: Error response from daemon: toomanyrequests: Data limit exceeded";
/** 取得以外の失敗 (やり直さない) */
const OTHER_ERROR = "ERROR: relation \"public.x\" does not exist (SQLSTATE 42P01)";
/** Docker の再起動直後の失敗 (supabase-local.sh start だけが、同じ取得元でやり直す) */
const NOT_READY_ERROR = "Error response from daemon: container supabase_db_homegohan-local is not ready";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "supabase-image-pull-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const bin = path.join(tmp, "bin");
fs.mkdirSync(bin);
// CLI / コマンドの代わり: 呼ばれるたびに「<取得元> <引数>」を FAKE_CALLS に 1 行足す。FAKE_FAILS 回目までは FAKE_ERROR を stderr に
// 出して FAKE_FAIL_CODE で終わる (FAKE_ERROR_LATER があれば、2 回目以降の失敗はそれを出す)。毎回 stdout に「OUT <回>」を出す
const fakeCli = path.join(bin, "fake-supabase");
fs.writeFileSync(
  fakeCli,
  [
    "#!/usr/bin/env bash",
    'echo "${SUPABASE_INTERNAL_IMAGE_REGISTRY:-<unset>} $*" >>"$FAKE_CALLS"',
    'n="$(wc -l <"$FAKE_CALLS" | tr -d " ")"',
    'echo "OUT $n"',
    'echo "progress $n" >&2',
    'if [ "$n" -gt 1 ] && [ -n "${FAKE_ERROR_LATER:-}" ]; then FAKE_ERROR="$FAKE_ERROR_LATER"; fi',
    'if [ "$n" -le "${FAKE_FAILS:-0}" ]; then echo "$FAKE_ERROR" >&2; exit "${FAKE_FAIL_CODE:-1}"; fi',
    "",
  ].join("\n"),
  { mode: 0o755 },
);
// sleep は待たずに秒数を書く。docker は supabase-local.sh の ensure_docker の docker info だけに答える
fs.writeFileSync(path.join(bin, "sleep"), '#!/usr/bin/env bash\necho "$1" >>"$FAKE_SLEEPS"\n', { mode: 0o755 });
fs.writeFileSync(path.join(bin, "docker"), '#!/usr/bin/env bash\n[ "$1" = info ]\n', { mode: 0o755 });

type Run = { status: number | null; out: string; err: string; calls: string[]; sleeps: number[]; summary: string; tmpLeft: string[] };
let caseNo = 0;

/** コマンドを、代わりの CLI・sleep と最小の環境で動かす (呼んだ側の SUPABASE_* や GITHUB_* を持ち込まない) */
function runWith(cwd: string, args: string[], opts: { fails: number; error?: string; errorLater?: string; failCode?: number; env?: Record<string, string> }): Run {
  caseNo += 1;
  const calls = path.join(tmp, `calls-${caseNo}`);
  const sleeps = path.join(tmp, `sleeps-${caseNo}`);
  const summary = path.join(tmp, `summary-${caseNo}`);
  // スクリプトが作る一時ファイル (mktemp) の置き場。終わったあとに残っていないことを確かめる
  const tmpdir = path.join(tmp, `tmpdir-${caseNo}`);
  fs.writeFileSync(calls, "");
  fs.writeFileSync(sleeps, "");
  fs.writeFileSync(summary, "");
  fs.mkdirSync(tmpdir);
  const env: NodeJS.ProcessEnv = {
    PATH: `${bin}:${process.env.PATH}`,
    HOME: process.env.HOME,
    TMPDIR: tmpdir,
    FAKE_CALLS: calls,
    FAKE_SLEEPS: sleeps,
    FAKE_FAILS: String(opts.fails),
    FAKE_ERROR: opts.error ?? PULL_LIMIT_ERROR,
    FAKE_FAIL_CODE: String(opts.failCode ?? 1),
    ...(opts.errorLater ? { FAKE_ERROR_LATER: opts.errorLater } : {}),
    ...opts.env,
  };
  if (env.GITHUB_STEP_SUMMARY === "") env.GITHUB_STEP_SUMMARY = summary;
  const r = spawnSync("bash", args, { cwd, env, encoding: "utf8" });
  const lines = (file: string) => fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
  return {
    status: r.status,
    out: r.stdout,
    err: r.stderr,
    calls: lines(calls),
    sleeps: lines(sleeps).map(Number),
    summary: fs.readFileSync(summary, "utf8"),
    tmpLeft: fs.readdirSync(tmpdir),
  };
}

/** n 回分の取得元の並び (既定の順を交互に) */
const alternating = (n: number) => Array.from({ length: n }, (_, i) => (i % 2 === 0 ? ECR : GHCR));

describe("scripts/supabase-image-fallback.sh (CI の db diff の入口)", () => {
  const STEP = "Verify db diff (post-apply)";
  const outFile = () => path.join(tmp, `out-${caseNo + 1}.sql`);
  const errFile = () => path.join(tmp, `err-${caseNo + 1}.log`);
  const fallback = (opts: Parameters<typeof runWith>[2], extra: string[] = []) => {
    const out = outFile();
    const err = errFile();
    const r = runWith(ROOT, [FALLBACK, "--step", STEP, "--stdout", out, "--stderr", err, ...extra, "--", fakeCli, "db", "diff", "--linked"], opts);
    return { ...r, stdoutFile: fs.existsSync(out) ? fs.readFileSync(out, "utf8") : null, stderrFile: fs.existsSync(err) ? fs.readFileSync(err, "utf8") : null };
  };

  it("通れば 1 回で終わり、取得元は既定の public.ecr.aws (stdout はファイルへ)", () => {
    const r = fallback({ fails: 0 });
    expect(r.status, r.err).toBe(0);
    expect(r.calls).toEqual([`${ECR} db diff --linked`]);
    expect(r.sleeps).toEqual([]);
    expect(r.stdoutFile).toBe("OUT 1\n");
    expect(r.out).toBe("");
  });

  it("取得の失敗のあとは、待たずに取得元を ghcr.io に替えてやり直す。stdout と stderr の写しは最後の回のもの", () => {
    const r = fallback({ fails: 1 });
    expect(r.status, r.err).toBe(0);
    expect(r.calls).toEqual([`${ECR} db diff --linked`, `${GHCR} db diff --linked`]);
    expect(r.sleeps).toEqual([]);
    expect(r.stdoutFile).toBe("OUT 2\n");
    expect(r.stderrFile).toBe("progress 2\n");
    // stderr は画面にも流す (1 回目の取得の失敗も見える)
    expect(r.err).toContain(PULL_LIMIT_ERROR);
    expect(r.err).toContain(`取得元を ${GHCR} に替えてやり直します`);
  });

  it("どの取得元でも失敗したら、周ごとに 単位 × 周 秒待つ。最後まで取れなければ目印つきの 1 行を出し、75 で終わる", () => {
    const r = fallback({ fails: Number.MAX_SAFE_INTEGER });
    expect(r.status).toBe(EXIT_PULL_UNAVAILABLE);
    expect(r.calls).toEqual(alternating(DEFAULT_ROUNDS * 2).map((reg) => `${reg} db diff --linked`));
    expect(r.sleeps).toEqual([FALLBACK_WAIT_UNIT, 2 * FALLBACK_WAIT_UNIT]);
    const lines = r.err.split("\n");
    const tagged = lines.findIndex((l) => l.startsWith(`[image-pull-unavailable] ${STEP}: `));
    expect(tagged, r.err).toBeGreaterThanOrEqual(0);
    expect(lines[tagged]).toContain(`${ECR} ${GHCR}`);
    expect(lines[tagged]).toContain("検査の結果ではありません");
    expect(lines[tagged]).toContain("docs/operations/ci-supabase-image-pull.md");
    expect(lines[tagged + 1]).toBe(`[image-pull-unavailable] 最後のエラー: ${PULL_LIMIT_ERROR}`);
    // GitHub Actions の外では注記 (::error) を出さない
    expect(r.err).not.toContain("::error");
    expect(r.tmpLeft).toEqual([]);
  });

  it("GitHub Actions では、取れなかったことを ::error の注記と Step Summary にも出す (検査の赤と区別する)", () => {
    const r = fallback({ fails: Number.MAX_SAFE_INTEGER, env: { GITHUB_ACTIONS: "true", GITHUB_STEP_SUMMARY: "", SUPABASE_IMAGE_PULL_WAIT_UNIT: "0" } });
    expect(r.status).toBe(EXIT_PULL_UNAVAILABLE);
    expect(r.err).toMatch(new RegExp(`^::error title=${escapeRegExp(STEP)}: イメージを取得できない \\(検査の赤ではない\\)::\\[image-pull-unavailable\\] `, "m"));
    expect(r.summary).toContain(`## ${STEP}: Supabase の Docker イメージを取得できませんでした (検査の赤ではない)`);
    expect(r.summary).toContain(PULL_LIMIT_ERROR);
  });

  it("取得以外の失敗はやり直さず、コマンドの終了コードのまま終わる (目印を出さない)", () => {
    const failCode = 3;
    const r = fallback({ fails: Number.MAX_SAFE_INTEGER, error: OTHER_ERROR, failCode, env: { GITHUB_ACTIONS: "true", GITHUB_STEP_SUMMARY: "" } });
    expect(r.status).toBe(failCode);
    expect(r.calls).toEqual([`${ECR} db diff --linked`]);
    expect(r.sleeps).toEqual([]);
    expect(r.err).not.toContain("[image-pull-unavailable]");
    expect(r.summary).toBe("");
    expect(r.stderrFile).toContain(OTHER_ERROR);
  });

  it("取得の失敗のあとに取得以外の失敗になったら、そこで止めてその終了コードで終わる", () => {
    const failCode = 4;
    const r = fallback({ fails: Number.MAX_SAFE_INTEGER, errorLater: OTHER_ERROR, failCode });
    expect(r.status).toBe(failCode);
    expect(r.calls).toEqual([`${ECR} db diff --linked`, `${GHCR} db diff --linked`]);
    expect(r.err).not.toContain("[image-pull-unavailable]");
  });

  it("取得元・周回・待ちは環境変数で変えられる。呼ぶ側が SUPABASE_INTERNAL_IMAGE_REGISTRY を決めていれば、それだけを使う", () => {
    const custom = fallback({
      fails: Number.MAX_SAFE_INTEGER,
      env: { SUPABASE_IMAGE_REGISTRIES: `${GHCR} docker.io ${ECR}`, SUPABASE_IMAGE_PULL_ROUNDS: "2", SUPABASE_IMAGE_PULL_WAIT_UNIT: "7" },
    });
    expect(custom.status).toBe(EXIT_PULL_UNAVAILABLE);
    expect(custom.calls.map((c) => c.split(" ")[0])).toEqual([GHCR, "docker.io", ECR, GHCR, "docker.io", ECR]);
    expect(custom.sleeps).toEqual([7]);
    const fixed = fallback({ fails: Number.MAX_SAFE_INTEGER, env: { SUPABASE_INTERNAL_IMAGE_REGISTRY: "mirror.example:5000/supabase-mirror", SUPABASE_IMAGE_PULL_WAIT_UNIT: "1" } });
    expect(fixed.status).toBe(EXIT_PULL_UNAVAILABLE);
    expect(fixed.calls.map((c) => c.split(" ")[0])).toEqual(Array(DEFAULT_ROUNDS).fill("mirror.example:5000/supabase-mirror"));
    expect(fixed.sleeps).toEqual([1, 2]);
  });

  it("環境変数・引数の誤りは、コマンドを打たずに 2 で終わる", () => {
    for (const env of [
      { SUPABASE_IMAGE_PULL_ROUNDS: "0" },
      { SUPABASE_IMAGE_PULL_ROUNDS: "x" },
      { SUPABASE_IMAGE_PULL_WAIT_UNIT: "-1" },
      { SUPABASE_IMAGE_REGISTRIES: "  " },
      { SUPABASE_IMAGE_REGISTRIES: "ghcr.io;rm" },
      // パス名の展開をしない (* がファイル名に化けて取得元の形の検査を通らない)
      { SUPABASE_IMAGE_REGISTRIES: "*" },
    ]) {
      const r = fallback({ fails: 0, env });
      expect(r.status, JSON.stringify(env)).toBe(EXIT_USAGE);
      expect(r.calls, JSON.stringify(env)).toEqual([]);
    }
    for (const args of [[FALLBACK, "--", fakeCli], [FALLBACK, "--step", STEP], [FALLBACK, "--step", STEP, "--unknown", "--", fakeCli], [FALLBACK, "--step"]]) {
      const r = runWith(ROOT, args, { fails: 0 });
      expect(r.status, args.join(" ")).toBe(EXIT_USAGE);
      expect(r.calls, args.join(" ")).toEqual([]);
    }
  });

  it("--stdout が無ければ stdout は画面のまま、--stderr が無ければ一時ファイルを使って消す", () => {
    const r = runWith(ROOT, [FALLBACK, "--step", STEP, "--", fakeCli, "db", "diff"], { fails: 1 });
    expect(r.status, r.err).toBe(0);
    expect(r.out).toBe("OUT 1\nOUT 2\n");
    expect(r.tmpLeft).toEqual([]);
  });
});

describe("scripts/supabase-local.sh start (security-regression・e2e-local・local-ci.sh)", () => {
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
  const start = (opts: Parameters<typeof runWith>[2]) =>
    runWith(repo, [SUPABASE_LOCAL, "start"], { ...opts, env: { SUPABASE_CLI: fakeCli, ...opts.env } });
  const realRepo = () => fs.realpathSync(repo);
  const startCall = (reg: string) => `${reg} start -x studio,imgproxy,logflare,vector,edge-runtime --workdir ${path.join(realRepo(), ".supabase-local")}`;

  it("通れば 1 回で終わり、取得元は既定の public.ecr.aws (ローカルの機械の取得済みのイメージの名前)", () => {
    const r = start({ fails: 0 });
    expect(r.status, r.err).toBe(0);
    expect(r.calls).toEqual([startCall(ECR)]);
    expect(r.out).toBe("OUT 1\n");
    expect(r.tmpLeft).toEqual([]);
  });

  it("取得の失敗のあとは、待たずに ghcr.io に替えてやり直す", () => {
    const r = start({ fails: 1 });
    expect(r.status, r.err).toBe(0);
    expect(r.calls).toEqual([startCall(ECR), startCall(GHCR)]);
    expect(r.sleeps).toEqual([]);
  });

  it("Docker の準備待ち (is not ready) は、同じ取得元で 単位 × 回 秒待ってやり直す", () => {
    const r = start({ fails: 2, error: NOT_READY_ERROR, env: { SUPABASE_LOCAL_RETRY_WAIT_UNIT: "5" } });
    expect(r.status, r.err).toBe(0);
    expect(r.calls).toEqual([startCall(ECR), startCall(ECR), startCall(ECR)]);
    expect(r.sleeps).toEqual([5, 10]);
  });

  it("最後まで取れなければ、既定の 30 秒単位で周を待ち、目印つきの 1 行を出して 75 で終わる (一時ファイルを残さない)", () => {
    const r = start({ fails: Number.MAX_SAFE_INTEGER });
    expect(r.status).toBe(EXIT_PULL_UNAVAILABLE);
    expect(r.calls).toEqual(alternating(DEFAULT_ROUNDS * 2).map(startCall));
    expect(r.sleeps).toEqual([START_WAIT_UNIT, 2 * START_WAIT_UNIT]);
    expect(r.err).toMatch(/^\[image-pull-unavailable\] supabase start: /m);
    expect(r.tmpLeft).toEqual([]);
  });

  it("取得以外の失敗はやり直さず、CLI の終了コードのまま終わる", () => {
    const failCode = 9;
    const r = start({ fails: Number.MAX_SAFE_INTEGER, error: OTHER_ERROR, failCode });
    expect(r.status).toBe(failCode);
    expect(r.calls).toEqual([startCall(ECR)]);
    expect(r.err).not.toContain("[image-pull-unavailable]");
  });

  it("待ちの単位・周回の環境変数が不正なら、CLI を打たずに 2 で終わる", () => {
    for (const env of [{ SUPABASE_LOCAL_RETRY_WAIT_UNIT: "x" }, { SUPABASE_IMAGE_PULL_ROUNDS: "0" }]) {
      const r = start({ fails: 0, env });
      expect(r.status, JSON.stringify(env)).toBe(EXIT_USAGE);
      expect(r.calls, JSON.stringify(env)).toEqual([]);
    }
  });
});

type Step = { name?: string; id?: string; run?: string; if?: string; env?: Record<string, string> };
type Workflow = { on: { pull_request?: { paths?: string[] } }; jobs: Record<string, { steps: Step[] }> };
const loadWorkflow = (file: string) => yaml.load(fs.readFileSync(path.join(ROOT, ".github/workflows", file), "utf8")) as Workflow;
const stepsOf = (wf: Workflow) => Object.values(wf.jobs).flatMap((j) => j.steps);

describe("CI の yml が、取得の失敗を検査の赤と区別して扱う", () => {
  it("ライブラリを source すると、yml が比べる終了コードの名前 SIP_EXIT_PULL_UNAVAILABLE が 75 になる", () => {
    const r = spawnSync("bash", ["-c", '. scripts/lib/supabase-image-pull.sh && echo "$SIP_EXIT_PULL_UNAVAILABLE"'], { cwd: ROOT, encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.trim()).toBe(String(EXIT_PULL_UNAVAILABLE));
  });

  it("Deploy Supabase Migrations の Verify db diff は、取得元を替えてやり直す入口を通し、取れなかったときも赤のまま区別して出す", () => {
    const step = stepsOf(loadWorkflow("deploy-supabase-migrations.yml")).find((s) => s.id === "db_diff");
    const run = step?.run ?? "";
    expect(step?.name).toBe("Verify db diff (post-apply)");
    expect(run).toContain(". scripts/lib/supabase-image-pull.sh");
    expect(run).toMatch(/bash scripts\/supabase-image-fallback\.sh --step "Verify db diff \(post-apply\)"/);
    expect(run).toMatch(/--stdout \/tmp\/db_diff\.sql --stderr \/tmp\/db_diff\.log/);
    expect(run).toMatch(/--\s+npx --yes supabase@[0-9.]+ db diff --linked --schema public/);
    // 取れなかったとき: Step Summary に区別して書き、赤 (exit 1) で終わる (適用の後の確かめを、確かめないまま緑にしない)
    const unavailable = run.slice(run.indexOf('if [ "$status" -eq "$SIP_EXIT_PULL_UNAVAILABLE" ]; then'));
    expect(unavailable.length).toBeLessThan(run.length);
    const branch = unavailable.slice(0, unavailable.indexOf("\nfi\n"));
    expect(branch).toContain("検査の赤ではない");
    expect(branch).toMatch(/\n\s*exit 1$/);
    // 以前の、db diff を直接打つ自前のやり直しは残っていない
    expect(run).not.toContain("PULL_ERROR_RE");
    expect(run).not.toMatch(/^\s*npx --yes supabase@[0-9.]+ db diff/m);
  });

  it("security-regression は、Supabase が起動できなかったときに 2 本目の結合テストを Supabase の無いまま流さない", () => {
    const steps = stepsOf(loadWorkflow("security-regression.yml"));
    const startStep = steps.find((s) => s.run === "bash scripts/supabase-local.sh start");
    expect(startStep?.id).toBe("supabase");
    const operator = steps.find((s) => s.name === "Run operator (admin / super-admin) integration tests");
    expect(operator?.if).toBe("${{ !cancelled() && steps.supabase.outcome == 'success' }}");
  });

  it("e2e-local は、supabase-local.sh が source するライブラリを変えた PR でも動く", () => {
    const paths = loadWorkflow("e2e-local.yml").on.pull_request?.paths ?? [];
    expect(paths).toContain(SUPABASE_LOCAL);
    expect(paths).toContain(SUPABASE_IMAGE_PULL_LIB);
  });
});
