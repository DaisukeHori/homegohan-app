#!/usr/bin/env bash
# =====================================================================
# PR の CI 検査 (本番に触れない 5 段) をローカルで CI と同じ条件で回す
# =====================================================================
# 対象と CI 上の正本 (コマンド・対象パス・env は各 yml から写している。yml が正):
#   secrets      .github/workflows/security.yml の gitleaks ジョブ (ジョブ単位で写す)
#                同じ版・同じ SHA-256 の gitleaks で、--base から HEAD までのコミット (PR で増えるコミット) を検査する
#   unit         .github/workflows/ci.yml              typecheck → lint → vitest (root の vitest.config.ts)
#   mobile       .github/workflows/mobile-test.yml     apps/mobile の jest → root の vitest (packages/core)
#   integration  .github/workflows/security-regression.yml
#                ローカル Supabase + next dev に対する結合テスト 2 本 (2 本目は 1 本目が落ちても回す)
#   e2e          .github/workflows/e2e-local.yml       ローカル Supabase + 本番ビルドに対する Playwright
#
# PR で動くほかのワークフロー・ジョブ (security.yml の dependency-review など) は写していない。
# 写していないものと理由は tests/local-ci-workflow-sync.test.ts の EXCLUDED_WORKFLOWS / EXCLUDED_JOBS にある。
#
# yml とこのスクリプトのずれは tests/local-ci-workflow-sync.test.ts が検出する (PR の npm test で落ちる)。
# PR で動くワークフローが増えて、ここにもテストの除外の一覧にも無いときも落ちる。
# そのテストは、段の関数名 (stage_secrets / stage_unit / stage_mobile / stage_integration / stage_e2e)・
# run_in / run_in_stdout の引数の形・ci_env の export・readonly の定数・配列 ("${NAME[@]}") を手がかりに読む。
# これらの形を変えるときはテストも合わせる。
#
# 使い方:
#   bash scripts/local-ci.sh [--only secrets,unit,mobile,integration,e2e] [--base <ref>] [--keep] [--no-merge]
#     --only      回す段 (カンマ区切り。既定は 5 段すべて)
#     --base      取り込む基準 (既定 origin/main)。「いまの HEAD (コミット済み) に --base をマージした状態」を検査する
#                 (CI の pull_request が PR と main のマージコミットを検査するのと揃える)
#     --no-merge  マージせず HEAD そのものを検査する (main の上で回すとき)。secrets 段は --no-merge でも
#                 --base から HEAD までのコミットを検査する (main の上では 0 件になる)
#     --keep      作業用の worktree を消さずに残す (調査用)
#
# CI と揃えている条件:
#   - 毎回まっさらな git worktree (使い回すと .next/types など CI に無い生成物まで型検査してしまう)
#   - TZ=UTC / CI=true / LANG=C.UTF-8 / NODE_OPTIONS なし / Node は .nvmrc の major
#   - 親シェルの環境変数は持ち込まない (PATH・HOME など動作に要るものだけ残す)。本番の接続情報が混ざらない
#   - npm ci は作業場所ごとに 1 回。integration / e2e はそれぞれ自分でローカル Supabase を起動・停止する
#
# 判定は終了コードだけでなく、各ツールの JSON (失敗件数・収集ファイル数) で行う。
# 収集されるはずのファイル (vitest list / jest --listTests / playwright --list) と結果のファイルが食い違えば赤。
#
# 環境変数 (どれも任意):
#   LOCAL_CI_WORKDIR               作業用 worktree の親 (既定: ${TMPDIR:-/tmp}/homegohan-local-ci)
#   LOCAL_CI_ARTIFACTS             JSON とログの置き場 (既定: ${TMPDIR:-/tmp}/homegohan-local-ci-artifacts/<HEAD の短い sha>)
#   LOCAL_CI_FETCH                 0 にすると --base (origin/...) を fetch しない (既定 1)
#   LOCAL_CI_SUPABASE_PORTS        空いていることを確かめるローカル Supabase のポート (空白区切り。既定は枠の値)
#
# 枠 (slot): integration / e2e (ローカル Supabase と Next を立てる段) を、同じ機械で複数の local-ci.sh が同時に回せるよう、
# 枠ごとに project_id (コンテナ名) と全ポートをずらす (値の表は scripts/lib/local-ci-slot.sh。枠 0 は今までと同じ値)。
# Docker を使う段の直前に、空いている枠のロックを mkdir で取り、終わったら (trap で必ず) 外す。secrets / unit / mobile だけなら取らない。
#   LOCAL_CI_SLOTS                 使ってよい枠 (空白区切り。既定 "0")。例: "0 1" なら 2 本まで同時に回せる
#   LOCAL_CI_SLOT                  この枠だけを使う (LOCAL_CI_SLOTS より優先。空くまで待つ)
#   LOCAL_CI_LOCK_DIR              枠のロックの置き場 (既定: ${TMPDIR:-/tmp}/homegohan-local-ci-locks)
#   LOCAL_CI_SLOT_WAIT_SECONDS     空きを待つ上限の秒数 (既定 SLOT_WAIT_SECONDS_DEFAULT)。過ぎたら「待ちの時間切れ」で終了コード 3
#   LOCAL_CI_LEGACY_LOCK           枠 0 を使う前に、このパスが無いことも確かめる (枠を使わずに既定のポートで動く作業の外側のロック。既定は空 = 確かめない)
#   LOCAL_CI_SLOT_MEMORY_MIB       1 枠の Docker のメモリの目安 (MiB。既定 SLOT_MEMORY_MIB_DEFAULT)。空きがこれより少なければ警告する (止めない)
#   LOCAL_CI_PLAYWRIGHT_WITH_DEPS  1 にすると playwright install に --with-deps を付ける (Linux で OS の依存も入れる。root 権限が要る)
#   LOCAL_CI_TOOLS                 gitleaks の配布物 (tar.gz) を置いておく場所 (既定: ${XDG_CACHE_HOME:-$HOME/.cache}/homegohan-local-ci)。
#                                  毎回 SHA-256 を確かめ、合わなければ取り直す
# =====================================================================

# 本番に届く余地を消す (このスクリプトは本番の Supabase に一切つながない)
unset SUPABASE_ACCESS_TOKEN SUPABASE_DB_PASSWORD SUPABASE_PROJECT_REF

if [ -z "${BASH_VERSION:-}" ]; then
  echo "bash で実行してください: bash scripts/local-ci.sh" >&2
  exit 2
fi

set -u -o pipefail

# ---------------------------------------------------------------------
# 定数
# ---------------------------------------------------------------------
readonly EXIT_RED=1         # どれかの段が赤
readonly EXIT_USAGE=2       # 使い方の誤り
readonly EXIT_SLOT_TIMEOUT=3 # 枠の空き待ちの時間切れ (検査そのものは赤でない。Docker を使う段を回せなかった)
readonly EXIT_SIGINT=130    # 128 + SIGINT(2)
readonly EXIT_SIGTERM=143   # 128 + SIGTERM(15)
readonly EXIT_SIGHUP=129    # 128 + SIGHUP(1) (端末を閉じたとき)
readonly ALL_STAGES="secrets,unit,mobile,integration,e2e"
# アプリの URL のホスト部分。ポートは枠で決まる (apply_slot。枠 0 は CI と同じ 3000 / 3001 / 3002)
readonly APP_HOST_URL="http://localhost"
# GitHub の ubuntu ランナーの LANG (Node の Intl の既定ロケールがこれで決まる)
readonly CI_LANG="C.UTF-8"
# security-regression.yml の next dev の待ち (seq 1 120 × sleep 2)
readonly DEV_WAIT_TRIES=120
# e2e-local.yml の next start の待ち (seq 1 60 × sleep 2)
readonly START_WAIT_TRIES=60
readonly WAIT_INTERVAL_SEC=2
# security-regression.yml の事前コンパイルの curl --max-time 120
readonly PRECOMPILE_MAX_TIME_SEC=120
# サーバーを止めたあと、プロセスが消えるのを待つ回数 (× WAIT_INTERVAL_SEC)。過ぎたら SIGKILL
readonly STOP_WAIT_TRIES=15
# 結果の表に出すログの末尾の行数 (赤のときの手がかり)
readonly LOG_TAIL_LINES=40
# 枠の空きを待つ上限の既定 (90 分)。Workflow が外側のロック (Docker を使う作業を 1 本ずつにする) を待つ上限と同じにしてある
readonly SLOT_WAIT_SECONDS_DEFAULT=5400
# 枠の空きを確かめる間隔
readonly SLOT_POLL_SEC=10
# ロックのディレクトリを作ってから持ち主 (owner) を書き終えるまでの猶予。これを過ぎても owner が無ければ持ち主が死んだとみなす。
# 回収の見張り (<ロック>.reclaim) を、作られてからこれだけ経つまでは持ち主の判定によらず死んだとみなさない猶予と、
# ロックを外すときに見張りが空くのを待つ上限にも使う (見張りを持つのは、ロックの持ち主の確かめと rm・mkdir の数回のあいだだけなので、これだけあれば足りる)
readonly LOCK_OWNER_GRACE_SEC=60
# ロックを外すときに、見張りが空いたかを確かめる間隔
readonly GUARD_POLL_SEC=1
# 見張りを消す rm を試す回数の上限。Ctrl-C は子プロセスの rm にも届くので、消す前に止められた rm を、まだ自分の見張りが残っている限り
# やり直す (1 回目が同じ Ctrl-C で止められても 2 回目で消える。続けて押されたときの分を 1 回足した)
readonly GUARD_DROP_TRIES=3
# 1 枠の Docker のメモリの目安 (MiB)。2026-10-10 に Docker Desktop (VM: CPU 8 / メモリ 15.6 GiB) で 20 秒ごとに docker stats を取って実測した、
# 結合テスト・e2e を回している最中のローカル Supabase 一式 (studio などを除く 8 コンテナ) の使用量の最大 (1 枠で 1164 MiB。
# 2 枠同時で合計 2019 MiB = 1 枠あたり約 1 GiB) に余裕を足した値。
# Next (next dev / next start) と Playwright は Docker の外 (ホスト) で動くので入れていない
readonly SLOT_MEMORY_MIB_DEFAULT=1536
readonly BYTES_PER_MIB=1048576
# 枠の値 (project_id・Supabase と Next のポート) を決める関数 (local_ci_slot_valid / local_ci_slot_apply)
# shellcheck source=lib/local-ci-slot.sh
. "$(dirname "$0")/lib/local-ci-slot.sh"
PLAYWRIGHT_WITH_DEPS="${LOCAL_CI_PLAYWRIGHT_WITH_DEPS:-0}"

# security.yml の gitleaks ジョブと同じ版の gitleaks。版を上げるときは security.yml と同時に上げる
# (ずれは tests/local-ci-workflow-sync.test.ts が検出する)
readonly GITLEAKS_VERSION="8.30.1"
# 配布物 (gitleaks_<版>_<OS>_<CPU>.tar.gz) の SHA-256。リリースの gitleaks_<版>_checksums.txt から写す。
# linux_x64 は security.yml の GITLEAKS_TARBALL_SHA256 と同じ値 (テストが突き合わせる)
readonly GITLEAKS_SHA256_LINUX_X64="551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb"
readonly GITLEAKS_SHA256_LINUX_ARM64="e4a487ee7ccd7d3a7f7ec08657610aa3606637dab924210b3aee62570fb4b080"
readonly GITLEAKS_SHA256_DARWIN_X64="dfe101a4db2255fc85120ac7f3d25e4342c3c20cf749f2c20a18081af1952709"
readonly GITLEAKS_SHA256_DARWIN_ARM64="b40ab0ae55c505963e365f271a8d3846efbc170aa17f2607f13df610a9aeb6a5"
readonly GITLEAKS_RELEASE_URL="https://github.com/gitleaks/gitleaks/releases/download"
# gitleaks の --exit-code (security.yml と同じ)。「見つかった」をこの値で返させ、検査そのものの失敗 (1 など) と区別する
readonly GITLEAKS_FOUND_EXIT=2
# 配布物を取るときの curl の再試行の回数と間隔 (秒)。security.yml の --retry 4 --retry-delay 2 と同じ
readonly DOWNLOAD_RETRY=4
readonly DOWNLOAD_RETRY_DELAY_SEC=2
TOOLS_DIR="${LOCAL_CI_TOOLS:-${XDG_CACHE_HOME:-$HOME/.cache}/homegohan-local-ci}"

# CI の実行対象 (yml から写す。ずれは tests/local-ci-workflow-sync.test.ts が検出する)
# security-regression.yml の 1 本目 (セキュリティ回帰 + handson-tour)
INTEG1_ARGS=(--config vitest.integration.config.ts --passWithNoTests tests/integration/rls tests/integration/security tests/integration/handson-tour)
# security-regression.yml の 2 本目 (運営コンソール。--passWithNoTests は付けない)
INTEG2_ARGS=(--config vitest.integration.config.ts tests/integration/operator/admin- tests/integration/operator/auth-boundary tests/integration/operator/super-admin-)
# e2e-local.yml の Playwright
PW_ARGS=(--trace off tests/e2e/01-login.spec.ts tests/e2e/04-menu-page.spec.ts tests/e2e/05-shopping-list.spec.ts tests/e2e/public-policy-pages.spec.ts tests/e2e/legal-consent-gate.spec.ts)
# e2e-local.yml の Playwright (2 つ目・3 つ目のサーバーに対して。規約の同意ゲートだけ)
PW_CONSENT_ARGS=(--trace off tests/e2e/legal-consent-gate.spec.ts)

# 子プロセスへ持ち込む環境変数 (これ以外は外す。CI のランナーに無いものを持ち込まない)
readonly ENV_ALLOWLIST="PATH HOME USER LOGNAME SHELL TMPDIR TERM XDG_CACHE_HOME XDG_CONFIG_HOME DOCKER_HOST DOCKER_CONTEXT DOCKER_CONFIG PLAYWRIGHT_BROWSERS_PATH HTTP_PROXY HTTPS_PROXY NO_PROXY http_proxy https_proxy no_proxy SUPABASE_CLI SUPABASE_LOCAL_EXCLUDE SUPABASE_LOCAL_REALTIME_VERSION SUPABASE_LOCAL_RETRY_WAIT_UNIT"
# 段の中だけで追加で持ち込む変数名 (e2e のパスワード)
ENV_EXTRA=""
# 枠を取ったあとに持ち込む変数名 (apply_slot が決める。supabase-local.sh が読む枠と、結合テストが叩くアプリの URL)
ENV_SLOT=""

# ---------------------------------------------------------------------
# JSON の読み取り (node -e。jq に依存しない)
#   引数: <mode: vitest|jest|playwright|eslint> <結果の JSON> <収集予定の一覧の JSON | -> <終了コード>
#   出力: 判定 passed failed skipped 収集ファイル数 期待ファイル数 備考 (タブ区切り 1 行)
# ---------------------------------------------------------------------
# shellcheck disable=SC2016  # JavaScript のテンプレート文字列。シェルでは展開しない
PARSE_JS='
const fs = require("fs");
const [mode, resultPath, listPath, exitCodeText] = process.argv.slice(1);
const SHOWN_PATHS_MAX = 3;
const exitCode = Number(exitCodeText);
const reasons = [];
const notes = [];
function readJson(p) { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch (e) { return undefined; } }
function real(p) { try { return fs.realpathSync(p); } catch (e) { return p; } }
function num(v) { return typeof v === "number" && Number.isFinite(v) ? v : undefined; }
function emit(passed, failed, skipped, files, expected) {
  const verdict = reasons.length === 0 ? "GREEN" : "RED";
  const note = reasons.concat(notes).join(" / ") || "-";
  const cell = (v) => (v === undefined ? "-" : String(v));
  process.stdout.write([verdict, cell(passed), cell(failed), cell(skipped), cell(files), cell(expected), note.replace(/[\t\n]/g, " ")].join("\t") + "\n");
}
const res = readJson(resultPath);
if (res === undefined || res === null || typeof res !== "object") {
  reasons.push("結果ファイルが無いか壊れている");
  emit();
  process.exit(0);
}
let expected;
if (listPath !== "-") {
  const list = readJson(listPath);
  let files;
  if (mode === "vitest" && Array.isArray(list)) files = list.map((x) => x && x.file);
  if (mode === "jest" && Array.isArray(list)) files = list;
  if (mode === "playwright" && list && Array.isArray(list.suites)) files = list.suites.map((s) => s && s.file);
  if (!files || files.some((f) => typeof f !== "string")) reasons.push("収集予定の一覧が無いか壊れている");
  else expected = new Set(files.map(real));
}
let passed, failed, skipped, actual;
if (mode === "vitest" || mode === "jest") {
  const results = Array.isArray(res.testResults) ? res.testResults : undefined;
  if (!results) reasons.push("testResults が無い");
  passed = num(res.numPassedTests);
  failed = num(res.numFailedTests);
  const pending = num(res.numPendingTests);
  const todo = num(res.numTodoTests);
  skipped = pending === undefined ? undefined : pending + (todo || 0);
  if (passed === undefined || failed === undefined) reasons.push("件数が読めない");
  if (failed) reasons.push(`失敗したテスト ${failed}`);
  const failedFiles = (results || []).filter((t) => t.status === "failed");
  if (failedFiles.length) reasons.push(`失敗したファイル ${failedFiles.length} (読み込みの失敗を含む。例: ${failedFiles.slice(0, SHOWN_PATHS_MAX).map((t) => t.name).join(", ")})`);
  if (mode === "jest" && num(res.numRuntimeErrorTestSuites)) reasons.push(`実行時エラーのファイル ${res.numRuntimeErrorTestSuites}`);
  if (res.success === false && failed === 0 && failedFiles.length === 0) reasons.push("success=false");
  actual = (results || []).map((t) => real(t.name));
} else if (mode === "playwright") {
  const s = res.stats || {};
  passed = num(s.expected);
  failed = num(s.unexpected);
  skipped = num(s.skipped);
  if (passed === undefined || failed === undefined) reasons.push("件数が読めない");
  if (failed) reasons.push(`失敗したテスト ${failed}`);
  if (num(s.flaky)) notes.push(`flaky ${s.flaky} (再試行で通過。CI でも緑扱い)`);
  const errors = Array.isArray(res.errors) ? res.errors : [];
  if (errors.length) reasons.push(`テスト外のエラー ${errors.length} (global setup など)`);
  actual = Array.from(new Set((Array.isArray(res.suites) ? res.suites : []).map((x) => x.file)));
} else if (mode === "eslint") {
  if (!Array.isArray(res)) {
    reasons.push("ESLint の結果が配列でない");
    emit();
    process.exit(0);
  }
  let errors = 0;
  let warnings = 0;
  let filesWithErrors = 0;
  for (const f of res) {
    const e = (f.errorCount || 0) + (f.fatalErrorCount || 0);
    errors += e;
    warnings += f.warningCount || 0;
    if (e) filesWithErrors += 1;
  }
  passed = res.length - filesWithErrors;
  failed = errors;
  if (errors) reasons.push(`エラー ${errors} (${filesWithErrors} ファイル)`);
  if (warnings) notes.push(`警告 ${warnings}`);
  actual = res.map((f) => f.filePath);
} else {
  reasons.push(`不明な mode: ${mode}`);
  emit();
  process.exit(0);
}
if (actual.length === 0) reasons.push("収集ファイル 0");
if (expected) {
  const got = new Set(actual);
  const missing = Array.from(expected).filter((f) => !got.has(f));
  const extra = actual.filter((f) => !expected.has(f));
  if (missing.length) reasons.push(`収集されるはずが結果に無いファイル ${missing.length} (例: ${missing.slice(0, SHOWN_PATHS_MAX).join(", ")})`);
  if (extra.length) reasons.push(`一覧に無いのに結果にあるファイル ${extra.length} (例: ${extra.slice(0, SHOWN_PATHS_MAX).join(", ")})`);
}
if (exitCode !== 0 && reasons.length === 0) reasons.push(`終了コード ${exitCode} (件数上は失敗 0。CI では赤になるのでログを確かめる)`);
emit(passed, failed, skipped, actual.length, expected ? expected.size : undefined);
'

# ポートが使われているか (終了コード 0 = 使用中)。接続できる、または待ち受けられないなら使用中とみなす
# shellcheck disable=SC2016
PORT_PROBE_JS='
const net = require("net");
const port = Number(process.argv[1]);
const PROBE_TIMEOUT_MS = 1000;
function tryConnect(host) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    const done = (v) => { s.destroy(); resolve(v); };
    s.setTimeout(PROBE_TIMEOUT_MS, () => done(false));
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
  });
}
function tryListen() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", (e) => resolve(e.code === "EADDRINUSE"));
    srv.listen(port, () => srv.close(() => resolve(false)));
  });
}
(async () => {
  const busy = (await tryConnect("127.0.0.1")) || (await tryConnect("::1")) || (await tryListen());
  process.exit(busy ? 0 : 1);
})();
'

# ファイルの SHA-256 (16 進)。sha256sum / shasum の有無が OS で違うので node で計る
# shellcheck disable=SC2016
SHA256_JS='
const crypto = require("crypto");
const fs = require("fs");
process.stdout.write(crypto.createHash("sha256").update(fs.readFileSync(process.argv[1])).digest("hex"));
'

# gitleaks のレポート (JSON の配列) を読む。出力: 1 行目に件数、2 行目以降に「ルール ファイル:行 (コミット)」。
# 値そのものは出さない (--redact で伏せてあるが、念のため読まない)。読めなければ終了コード 1
# shellcheck disable=SC2016
GITLEAKS_REPORT_JS='
const fs = require("fs");
let findings;
try { findings = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); } catch (e) { process.exit(1); }
if (!Array.isArray(findings)) process.exit(1);
const clean = (v) => String(v).replace(/[\r\n\t]/g, "_");
const lines = [String(findings.length)];
for (const f of findings) lines.push(`${clean(f.RuleID)} ${clean(f.File)}:${clean(f.StartLine)} (コミット ${clean(f.Commit).slice(0, 8)})`);
process.stdout.write(lines.join("\n") + "\n");
'

# ---------------------------------------------------------------------
# 共通の関数
# ---------------------------------------------------------------------
say() { printf '[local-ci] %s\n' "$*" >&2; }

usage() {
  cat <<'USAGE'
使い方: bash scripts/local-ci.sh [--only secrets,unit,mobile,integration,e2e] [--base <ref>] [--keep] [--no-merge]
  --only      回す段 (カンマ区切り。既定は 5 段すべて)
  --base      取り込む基準 (既定 origin/main)。HEAD (コミット済み) にこれをマージした状態を検査する。
              secrets 段は、ここから HEAD までのコミットを gitleaks で検査する
  --no-merge  マージせず HEAD そのものを検査する
  --keep      作業用の worktree を消さずに残す
同時に複数回すとき: LOCAL_CI_SLOTS='0 1' (使ってよい枠。integration / e2e は空いている枠のポートで回す)
前提: Docker (integration / e2e)、Node は .nvmrc の major、secrets は初回だけ GitHub から gitleaks を取得する。詳しくは CONTRIBUTING.md の「ローカル CI」
USAGE
}

now() { date +%s; }

# サブシェルの中で呼ぶ: 環境変数を CI ランナー相当まで絞り、CI と同じ値を足す
ci_env() {
  local name
  for name in $(compgen -e); do
    case " $ENV_ALLOWLIST $ENV_EXTRA $ENV_SLOT " in
      *" $name "*) ;;
      *) unset "$name" 2>/dev/null || true ;;
    esac
  done
  unset NODE_OPTIONS
  export TZ=UTC CI=true LANG="$CI_LANG"
}

# run_in <dir> <log> <command...>: CI 相当の環境で実行し、出力をログへ追記する
run_in() {
  local dir="$1" log="$2"
  shift 2
  ( ci_env && cd "$dir" && "$@" ) >>"$log" 2>&1
}

# run_in_stdout <dir> <out> <log> <command...>: 標準出力だけを out へ、標準エラーをログへ
run_in_stdout() {
  local dir="$1" out="$2" log="$3"
  shift 3
  ( ci_env && cd "$dir" && "$@" ) >"$out" 2>>"$log"
}

# record <段> <判定 GREEN|RED> <passed> <failed> <skipped> <収集> <期待> <秒> <備考>
record() {
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$@" >>"$RESULTS"
  if [ "$2" = "GREEN" ]; then say "緑 $1 (${8} 秒)"; else say "赤 $1: $9"; fi
}

# record_parsed <段> <秒> <PARSE_JS の出力 1 行>
record_parsed() {
  local stage="$1" secs="$2" line="$3" v p f s files exp note
  IFS=$'\t' read -r v p f s files exp note <<<"$line"
  record "$stage" "${v:-RED}" "${p:--}" "${f:--}" "${s:--}" "${files:--}" "${exp:--}" "$secs" "${note:-結果を読めない}"
}

parse() { node -e "$PARSE_JS" "$@"; }

port_busy() { node -e "$PORT_PROBE_JS" "$1"; }

sha256_of() { node -e "$SHA256_JS" "$1"; }

# 赤で止める (段の外の失敗。表と Markdown を出して終わる)
fail_stop() {
  record "$1" RED - - - - - 0 "$2"
  finish
}

descendants() {
  local c
  for c in $(pgrep -P "$1" 2>/dev/null); do
    echo "$c"
    descendants "$c"
  done
}

SERVER_PID=""
# e2e の 2 つ目・3 つ目のサーバー (LEGAL_CONSENT_ENFORCE=on / LEGAL_CONSENT_NOTICE=on)
ENFORCED_SERVER_PID=""
NOTICE_SERVER_PID=""
# 起動したサーバー (と、その子孫のプロセス) をすべて止める
stop_server() {
  local roots="$SERVER_PID $ENFORCED_SERVER_PID $NOTICE_SERVER_PID" pids="" alive="" p root
  [ -n "${roots// /}" ] || return 0
  for root in $roots; do
    pids="$pids $root $(descendants "$root" | tr '\n' ' ')"
  done
  # shellcheck disable=SC2086
  kill $pids 2>/dev/null || true
  for _ in $(seq 1 "$STOP_WAIT_TRIES"); do
    alive=""
    for p in $pids; do kill -0 "$p" 2>/dev/null && alive="$alive $p"; done
    [ -z "$alive" ] && break
    sleep "$WAIT_INTERVAL_SEC"
  done
  # shellcheck disable=SC2086
  if [ -n "$alive" ]; then kill -9 $alive 2>/dev/null || true; fi
  SERVER_PID=""
  ENFORCED_SERVER_PID=""
  NOTICE_SERVER_PID=""
}

SUPA_STARTED=0
SUPA_LOG=""
stop_supabase() {
  [ "$SUPA_STARTED" = 1 ] || return 0
  say "ローカル Supabase を停止します"
  run_in "$WT" "${SUPA_LOG:-/dev/null}" bash scripts/supabase-local.sh stop || true
  SUPA_STARTED=0
}

# wait_app <待つ回数> <サーバーのログ>: APP_ORIGIN/login が応答するまで待つ (yml と同じ curl)
wait_app() {
  local tries="$1" log="$2"
  for _ in $(seq 1 "$tries"); do
    if curl -s -o /dev/null "$APP_ORIGIN/login"; then break; fi
    if ! kill -0 "$SERVER_PID" 2>/dev/null; then
      say "サーバーが途中で終了しました (ログ: $log)"
      return 1
    fi
    sleep "$WAIT_INTERVAL_SEC"
  done
  curl -s -o /dev/null -w 'GET /login -> %{http_code}\n' "$APP_ORIGIN/login" >>"$log" 2>&1
}

# server_gone <pid> <サーバーのログ>: サーバーが途中で終了していたら真
server_gone() {
  if kill -0 "$1" 2>/dev/null; then return 1; fi
  say "サーバーが途中で終了しました (ログ: $2)"
}

# wait_enforced_app <サーバーのログ>: 2 つ目のサーバー (LEGAL_CONSENT_ENFORCE=on) が応答するまで待つ (yml と同じ curl)
wait_enforced_app() {
  local log="$1"
  for _ in $(seq 1 "$START_WAIT_TRIES"); do
    if curl -s -o /dev/null "$ENFORCED_APP_ORIGIN/login"; then break; fi
    if server_gone "$ENFORCED_SERVER_PID" "$log"; then return 1; fi
    sleep "$WAIT_INTERVAL_SEC"
  done
  curl -s -o /dev/null -w 'GET /login (LEGAL_CONSENT_ENFORCE=on) -> %{http_code}\n' "$ENFORCED_APP_ORIGIN/login" >>"$log" 2>&1
}

# wait_notice_app <サーバーのログ>: 3 つ目のサーバー (LEGAL_CONSENT_NOTICE=on) が応答するまで待つ (yml と同じ curl)
wait_notice_app() {
  local log="$1"
  for _ in $(seq 1 "$START_WAIT_TRIES"); do
    if curl -s -o /dev/null "$NOTICE_APP_ORIGIN/login"; then break; fi
    if server_gone "$NOTICE_SERVER_PID" "$log"; then return 1; fi
    sleep "$WAIT_INTERVAL_SEC"
  done
  curl -s -o /dev/null -w 'GET /login (LEGAL_CONSENT_NOTICE=on) -> %{http_code}\n' "$NOTICE_APP_ORIGIN/login" >>"$log" 2>&1
}

# integration / e2e の前に、使うポートが空いているかを確かめる (他のプロセスやコンテナは止めない)
#   引数: <段> [その段だけが追加で使うポート...]
check_ports() {
  local stage="$1" busy="" p
  shift
  for p in $APP_PORT "$@" $SUPABASE_PORTS; do
    if port_busy "$p"; then busy="$busy $p"; fi
  done
  if [ -n "$busy" ]; then
    record "$stage:setup" RED - - - - - 0 "使用中のポート:$busy (止めずに赤で終える。使っているプロセスやコンテナを確かめ、止めてから再実行する)"
    return 1
  fi
}

check_docker() {
  if ! docker info >/dev/null 2>&1; then
    record "$1:setup" RED - - - - - 0 "Docker に接続できない (Docker Desktop などを起動してから再実行する)"
    return 1
  fi
}

tail_hint() { printf '%s (末尾は %s)' "$1" "$2"; }

# ---------------------------------------------------------------------
# 枠 (slot) とロック
# ---------------------------------------------------------------------
SLOT=""
SLOT_LOCK=""
# 枠のロックを、持ち主の死んだロックを回収して取ったか (1 のときだけ、その枠に残ったスタックを片付ける)
SLOT_RECLAIMED=0
ART_LOCK=""
SLOT_TIMED_OUT=0

# apply_slot <枠>: 枠の値 (scripts/lib/local-ci-slot.sh) を、段が使う変数と子プロセスの環境に入れる。
# tests/local-ci-workflow-sync.test.ts は、ここの代入を枠 0 の値に置き換えて yml と照合する (枠 0 = CI と同じ値)
apply_slot() {
  local_ci_slot_apply "$1"
  SLOT="$1"
  # 結合テスト (tests/integration/helpers/api.ts) と e2e の yml が前提にするアプリの URL
  APP_PORT="$SLOT_APP_PORT"
  APP_ORIGIN="$APP_HOST_URL:$SLOT_APP_PORT"
  # e2e-local.yml の規約の同意ゲート (#1174) の 2 つ目・3 つ目のサーバー。同じビルドを、環境変数を変えて別のポートで起動する
  #   2 つ目: LEGAL_CONSENT_ENFORCE=on (強制あり)  3 つ目: LEGAL_CONSENT_NOTICE=on (お知らせあり)
  ENFORCED_APP_PORT="$SLOT_ENFORCED_APP_PORT"
  ENFORCED_APP_ORIGIN="$APP_HOST_URL:$SLOT_ENFORCED_APP_PORT"
  NOTICE_APP_PORT="$SLOT_NOTICE_APP_PORT"
  NOTICE_APP_ORIGIN="$APP_HOST_URL:$SLOT_NOTICE_APP_PORT"
  SUPABASE_PORTS="${LOCAL_CI_SUPABASE_PORTS:-$SLOT_SUPABASE_PORTS}"
  # supabase-local.sh は LOCAL_CI_SLOT で project_id とポートを決める。結合テストは INTEGRATION_BASE_URL のアプリを叩く
  export LOCAL_CI_SLOT="$SLOT" INTEGRATION_BASE_URL="$APP_ORIGIN"
  ENV_SLOT="LOCAL_CI_SLOT INTEGRATION_BASE_URL"
}

file_mtime() { stat -c %Y "$1" 2>/dev/null || stat -f %m "$1" 2>/dev/null; }

# プロセスの開始時刻 (pid が使い回されたときに、別のプロセスを持ち主と取り違えないために記録する)。
# 書いた実行と確かめる実行でロケールやタイムゾーンが違っても同じ文字列になるよう、LC_ALL=C・TZ=UTC で出す
# (違う文字列になると、生きている持ち主を死んだとみなしてロックを回収し、その枠のスタックまで片付けてしまう)
proc_lstart() { LC_ALL=C TZ=UTC ps -o lstart= -p "$1" 2>/dev/null | sed 's/^ *//; s/ *$//'; }

# この実行の持ち主の印 (pid と開始時刻)。ロックと見張りに書き、見張りがこの実行のものかを確かめるのにも使う。
# 開始時刻は始めに 1 回だけ取る (見張りを作る・消すあいだに ps などの子プロセスを動かさない。Ctrl-C は子プロセスにも届くので、
# 途中で止められた子プロセスの答えで、見張りを取り違えないため)
MY_LSTART=""
GUARD_TOKEN=""
init_owner_identity() {
  MY_LSTART="$(proc_lstart "$$")"
  GUARD_TOKEN="pid=$$"$'\n'"lstart=$MY_LSTART"$'\n'
}

# ---------------------------------------------------------------------
# 終わらせるシグナル (INT / TERM / HUP) と、後回しにする区間
# ---------------------------------------------------------------------
# 「見張りを作ってから GUARD_HELD に入れるまで」「見張りを消してから GUARD_HELD を空にするまで」「ロックを取ってから
# SLOT_LOCK / ART_LOCK に入れるまで」に届いたシグナルは、その区間を出てから終了に使う。区間の途中で終わると、cleanup が知らない
# 見張りやロックが残る (見張りは自動では消さないので、残るとその枠を誰も回収できなくなる)。区間は入れ子にできる (いちばん外の区間を出たときに終わる)
SIGNAL_DEFER_DEPTH=0
PENDING_SIGNAL_EXIT=""
# exit_on_signal <終了コード>: 持っている見張りを外してから終わる。cleanup (EXIT の trap) の途中に届いたシグナルで終わるときは
# cleanup がもう一度は動かないので、ここで外さないと見張りが残る
exit_on_signal() {
  drop_guard
  exit "$1"
}
on_signal() {
  if [ "$SIGNAL_DEFER_DEPTH" -gt 0 ]; then
    [ -n "$PENDING_SIGNAL_EXIT" ] || PENDING_SIGNAL_EXIT="$1"
    return 0
  fi
  exit_on_signal "$1"
}
defer_signals() { SIGNAL_DEFER_DEPTH=$((SIGNAL_DEFER_DEPTH + 1)); }
resume_signals() {
  local code
  SIGNAL_DEFER_DEPTH=$((SIGNAL_DEFER_DEPTH - 1))
  [ "$SIGNAL_DEFER_DEPTH" -eq 0 ] && [ -n "$PENDING_SIGNAL_EXIT" ] || return 0
  # 1 度だけ使う (終わる途中の cleanup が区間に入って出るたびに、同じシグナルでもう一度終わらない)
  code="$PENDING_SIGNAL_EXIT"
  PENDING_SIGNAL_EXIT=""
  exit_on_signal "$code"
}
# 後回しにしているシグナルがあれば真 (終わる途中なので、持ち主の死んだロックの回収のような消す操作には入らない)
signal_pending() { [ -n "$PENDING_SIGNAL_EXIT" ]; }
install_signal_traps() {
  trap cleanup EXIT
  trap 'on_signal "$EXIT_SIGINT"' INT
  trap 'on_signal "$EXIT_SIGTERM"' TERM
  trap 'on_signal "$EXIT_SIGHUP"' HUP
}

# read_owner <ロックか見張り>: 持ち主の pid と開始時刻を OWNER_PID / OWNER_LSTART に読む (ロックはディレクトリの中の owner、
# 見張りはファイルそのもの)。外のコマンド (sed など) を使わない (Ctrl-C で止められた子プロセスの空の答えを「持ち主がいない」と取り違えない)
OWNER_PID=""
OWNER_LSTART=""
read_owner() {
  local file="$1" line
  OWNER_PID=""
  OWNER_LSTART=""
  if [ -d "$file" ]; then file="$file/owner"; fi
  [ -f "$file" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      pid=*) OWNER_PID="${line#pid=}" ;;
      lstart=*) OWNER_LSTART="${line#lstart=}" ;;
    esac
  done 2>/dev/null <"$file"
}

# lock_held <ロックか見張り>: 生きている持ち主がいる (または作られた直後で持ち主をまだ書いていない) なら真。
# 持ち主が生きているか確かめられないとき (ps が開始時刻を出さないのに pid のプロセスはある・持ち主が開始時刻を書けなかった・
# 作られた時刻を読めない) は生きているとみなす (死んだと取り違えて回収すると、生きている持ち主の枠のスタックまで片付けてしまう。待つ方を選ぶ)
lock_held() {
  local path="$1" cur mtime
  [ -e "$path" ] || return 1
  read_owner "$path"
  if ! [[ "$OWNER_PID" =~ ^[0-9]+$ ]]; then
    # 持ち主をまだ書いていない: 作られてから LOCK_OWNER_GRACE_SEC 経つまでは持たれているとみなす
    if mtime="$(file_mtime "$path")" && [ -n "$mtime" ]; then
      [ "$(($(now) - mtime))" -lt "$LOCK_OWNER_GRACE_SEC" ]
      return
    fi
    [ -e "$path" ]
    return
  fi
  cur="$(proc_lstart "$OWNER_PID")"
  if [ -z "$cur" ]; then
    # ps が開始時刻を出さない: その pid のプロセスが無ければ死んでいる。あれば ps が動かなかった (fork の失敗など) だけ
    kill -0 "$OWNER_PID" 2>/dev/null
    return
  fi
  # 持ち主が開始時刻を書けなかった (書いたときに ps が動かなかった) なら、その pid のプロセスがある限り生きているとみなす
  [ -n "$OWNER_LSTART" ] || return 0
  [ "$cur" = "$OWNER_LSTART" ]
}

write_owner() {
  local dir="$1"
  {
    echo "pid=$$"
    echo "lstart=$MY_LSTART"
    echo "started=$(date '+%Y-%m-%dT%H:%M:%S%z')"
    echo "head=$HEAD_SHA"
    echo "artifacts=$ART"
  } >"$dir/owner.tmp" && mv "$dir/owner.tmp" "$dir/owner"
}

# make_lock <ロックのディレクトリ>: mkdir で原子的に作り、持ち主を書く。持ち主を書けなければ (容量不足など) 作ったものを消して失敗にする
# (持ち主の無いロックは LOCK_OWNER_GRACE_SEC を過ぎると死んだとみなされ、生きているのに回収されてしまう)
make_lock() {
  mkdir "$1" 2>/dev/null || return 1
  write_owner "$1" && return 0
  rm -rf "$1"
  return 1
}

# 回収の見張り (<ロックのディレクトリ>.reclaim。持ち主の印を書いたファイル)。持ち主の死んだロックの回収と、自分のロックを外すことは、
# 見張りを持った 1 本だけが行う。見張りを持っているあいだ、ロックのディレクトリは消えも作り直されもしない (消すのは見張りを持つ者だけ。
# 見張りの外でできるのは、ディレクトリが無いときの mkdir だけ)。だから「持ち主が死んでいると確かめたロック」と「消すロック」が必ず同じものになり、
# 消したあとの作り直しも見張りの中で行うので、遅れて回収に来た実行が、別の実行の取ったロックを消すことが無い。
# 見張りは、シグナル (INT / TERM / HUP) でどこで終わっても外す (作る・消すところは後回しの区間、そのあいだは exit_on_signal と cleanup が外す)。
# 外せないのは、外す機会の無い終わり方 (kill -9・電源断など) だけ
GUARD_HELD=""
# 持ち主の死んだ見張りを知らせ済みのもの (同じ見張りを待ちのたびに知らせない)
STALE_GUARDS_WARNED=""

# create_guard_file <見張りのパス>: 見張りのファイルを、無ければ作る (作れたら 0。あれば 1)。noclobber (set -C) のリダイレクトは
# O_EXCL で開くので、同時に作りに来ても作れるのは 1 本だけ。子プロセスを使わない (mkdir のような子プロセスが Ctrl-C で、作ったあと・
# 終了コードを返す前に止められると、自分の作った見張りを「作れなかった」と取り違えて残してしまう)。
# 後回しの区間の中でだけ呼ぶ (set -C のあいだにシグナルで終わらない)
create_guard_file() {
  local created
  set -C
  { : >"$1"; } 2>/dev/null
  created=$?
  set +C
  return "$created"
}

# make_guard <見張りのパス>: 見張りを作って GUARD_HELD に入れ、持ち主の印を書く。作れたら 0。後回しの区間の中でだけ呼ぶ
make_guard() {
  local guard="$1"
  create_guard_file "$guard" || return 1
  GUARD_HELD="$guard"
  if printf '%s' "$GUARD_TOKEN" 2>/dev/null >>"$guard"; then return 0; fi
  # 持ち主の印を書けない (容量不足など): 印の無い見張りは猶予を過ぎると持ち主の死んだ見張りになり、誰も回収できなくなるので消す
  rm -f "$guard"
  GUARD_HELD=""
  return 1
}

# guard_is_mine <見張りのパス>: 見張りが、この実行の作ったもの (中身が持ち主の印と同じ) なら真。外のコマンドを使わない
guard_is_mine() {
  local content=""
  [ -f "$1" ] || return 1
  IFS= read -r -d '' content 2>/dev/null <"$1"
  [ "$content" = "$GUARD_TOKEN" ]
}

# take_guard <ロックのディレクトリ>: 見張りを取る。取れたら 0、生きている誰かが持っていれば 1、
# 持ち主の死んだ見張り (回収かロックを外す途中で kill -9 などで終わった跡) が残っていれば 2。
# 死んだ見張りは自動では消さない (「死んでいる」と確かめてから消すまでのあいだに、同じく死んでいると見た別の実行が見張りを消して
# 取り直しているかもしれず、それを消すと 2 本が同時に回収に入る)。作られてから LOCK_OWNER_GRACE_SEC 経っていない見張りは、
# 持ち主の判定によらず死んだとみなさない (見ているあいだに外されて取り直された見張りを、死んだと取り違えない)
take_guard() {
  local guard="$1.reclaim" made mtime
  defer_signals
  make_guard "$guard"
  made=$?
  resume_signals
  [ "$made" -eq 0 ] && return 0
  lock_held "$guard" && return 1
  mtime="$(file_mtime "$guard")" || return 1
  [ "$(($(now) - mtime))" -ge "$LOCK_OWNER_GRACE_SEC" ] || return 1
  return 2
}

# drop_guard: 持っている見張りを外す (cleanup と exit_on_signal からも呼ぶ)。消すのは中身がこの実行の印のときだけ
# (消したあとに別の実行が取り直した見張りを、もう一度消さない)。rm が Ctrl-C で消す前に止められたら、GUARD_DROP_TRIES 回までやり直す
drop_guard() {
  [ -n "$GUARD_HELD" ] || return 0
  local guard="$GUARD_HELD" tries=0
  defer_signals
  while [ "$tries" -lt "$GUARD_DROP_TRIES" ] && guard_is_mine "$guard"; do
    rm -f "$guard"
    tries=$((tries + 1))
  done
  GUARD_HELD=""
  resume_signals
}

# warn_stale_guard <ロックのディレクトリ>: 持ち主の死んだ見張りが残っていることを、見張りごとに 1 回だけ知らせる
warn_stale_guard() {
  local guard="$1.reclaim"
  case " $STALE_GUARDS_WARNED " in *" $guard "*) return 0 ;; esac
  STALE_GUARDS_WARNED="$STALE_GUARDS_WARNED $guard"
  say "回収の見張り $guard が、持ち主の死んだまま残っています (回収かロックを外す途中で kill -9 などで終わった跡)。2 本が同時に回収に入らないよう自動では消しません。ほかに local-ci.sh が動いていないことを確かめてから rm -rf '$guard' で消すと、$1 を回収できるようになります"
}

# reclaim_lock <ロックのディレクトリ>: 見張りを持ったまま、持ち主の死んだロックを消して自分のロックとして作り直す
# (見張りを外してから作り直すと、そのあいだに別の実行が取ったロックを、遅れて見張りを取った実行が消してしまい、2 本が同じロックを持つ)。
# 取れたら 0 (持ち主の死んだロックを回収したなら LOCK_RECLAIMED=1。見張りを取るまでに持ち主が外していて空いていたなら 0)、取れなければ 1
reclaim_lock() {
  local dir="$1" rc=1 st
  take_guard "$dir"
  st=$?
  if [ "$st" -ne 0 ]; then
    if [ "$st" -eq 2 ]; then warn_stale_guard "$dir"; fi
    return 1
  fi
  if [ ! -d "$dir" ]; then
    make_lock "$dir" && rc=0
  elif ! lock_held "$dir" && ! signal_pending; then
    # シグナルを後回しにしているあいだは回収しない (そのシグナルで止められた ps などの答えで、生きている持ち主を死んだと取り違えうる。
    # 終わる途中なので枠も要らない)
    say "持ち主のいないロックを回収します: $dir ($(tr "\n" " " 2>/dev/null <"$dir/owner" || echo "owner なし"))"
    rm -rf "$dir"
    if make_lock "$dir"; then
      LOCK_RECLAIMED=1
      rc=0
    fi
  fi
  drop_guard
  return "$rc"
}

# try_lock <ロックのディレクトリ>: mkdir で原子的に取る。持ち主が死んでいれば (見張りを持って) 回収して取り直す。
# 取れたとき、持ち主の死んだロックを回収して取ったなら LOCK_RECLAIMED=1、空いていたのを取ったなら 0 にする。
# 取ったロックを変数 (SLOT_LOCK など) に入れ終えるまでを後回しの区間にして呼ぶ (defer_signals / resume_signals)
LOCK_RECLAIMED=0
try_lock() {
  local dir="$1"
  LOCK_RECLAIMED=0
  make_lock "$dir" && return 0
  # 生きている持ち主がいれば見張りを取りに行かない (ここで死んでいると見えても、見張りの中でもう一度確かめてから回収する)
  lock_held "$dir" && return 1
  reclaim_lock "$dir"
}

# release_lock <ロックのディレクトリ>: 自分が持ち主のときだけ、見張りを持って外す (回収する側が「持ち主が死んでいる」と確かめてから
# 消すまでのあいだに、ここで外したあと別の実行が取り直したロックを消させない)。見張りが空くのを最大 LOCK_OWNER_GRACE_SEC 秒待つ。
# 持ち主の死んだ見張りが残っているときは、誰も回収に入れないので見張りなしで外す。待っても空かなければ外さずに残す
# (この実行が終われば持ち主の死んだロックになり、次の実行が回収する)
release_lock() {
  local dir="$1" waited=0 st
  [ -n "$dir" ] || return 0
  read_owner "$dir"
  [ "$OWNER_PID" = "$$" ] || return 0
  while :; do
    take_guard "$dir"
    st=$?
    [ "$st" -eq 0 ] && break
    if [ "$st" -eq 2 ]; then
      rm -rf "$dir"
      return 0
    fi
    if [ "$waited" -ge "$LOCK_OWNER_GRACE_SEC" ]; then
      say "ロックの見張り $dir.reclaim が $LOCK_OWNER_GRACE_SEC 秒待っても空かないので、$dir は外さずに残します (この実行が終われば、次の実行が持ち主の死んだロックとして回収します)"
      return 0
    fi
    sleep "$GUARD_POLL_SEC"
    waited=$((waited + GUARD_POLL_SEC))
  done
  rm -rf "$dir"
  drop_guard
}

# 枠を使わずに既定のポートで動く作業 (Workflow など) の外側のロックがあるか
legacy_lock_held() { [ -n "$LEGACY_LOCK" ] && [ -e "$LEGACY_LOCK" ]; }

# Docker の空きメモリが 1 枠の目安より少なければ警告する (止めない)
check_docker_memory() {
  local total used free_mib
  total="$(docker info --format '{{.MemTotal}}' 2>/dev/null)" || return 0
  [[ "$total" =~ ^[0-9]+$ ]] || return 0
  used="$(docker stats --no-stream --format '{{.MemUsage}}' 2>/dev/null | awk '
    { v = $1; n = v + 0; u = v; sub(/^[0-9.]+/, "", u)
      m = 1
      if (u == "KiB") m = 1024; else if (u == "MiB") m = 1024 * 1024; else if (u == "GiB") m = 1024 * 1024 * 1024
      else if (u == "kB") m = 1000; else if (u == "MB") m = 1000 * 1000; else if (u == "GB") m = 1000 * 1000 * 1000
      sum += n * m }
    END { printf "%.0f\n", sum }')"
  [[ "$used" =~ ^[0-9]+$ ]] || used=0
  free_mib="$(((total - used) / BYTES_PER_MIB))"
  if [ "$free_mib" -lt "$SLOT_MEMORY_MIB" ]; then
    say "警告: Docker の空きメモリ ${free_mib} MiB (全体 $((total / BYTES_PER_MIB)) MiB) が 1 枠の目安 ${SLOT_MEMORY_MIB} MiB より少ない。落ちたら同時に回す本数を減らす (止めずに続けます)"
  fi
}

# acquire_slot: 空いている枠を取る。取れたら 0、待ちの時間切れなら 1
acquire_slot() {
  local s deadline waited=0
  mkdir -p "$LOCK_DIR" || { say "枠のロックの置き場を作れません: $LOCK_DIR"; return 1; }
  check_docker_memory
  deadline="$(($(now) + SLOT_WAIT_SECONDS))"
  while :; do
    for s in $SLOT_CANDIDATES; do
      if [ "$s" -eq 0 ] && legacy_lock_held; then continue; fi
      # 取ってから SLOT_LOCK に入れ終えるまでのシグナルは後回しにする (そこで終わると、cleanup の知らないロックが残る)
      defer_signals
      if try_lock "$LOCK_DIR/slot-$s"; then
        SLOT_LOCK="$LOCK_DIR/slot-$s"
        SLOT_RECLAIMED="$LOCK_RECLAIMED"
      fi
      resume_signals
      [ -n "$SLOT_LOCK" ] || continue
      # 外側のロックは別の作業が mkdir するので、取ったあとにもう一度確かめる
      # (外してから SLOT_LOCK を空にするまでに終わっても、cleanup の release_lock は持ち主がこの実行のロックしか外さない)
      if [ "$s" -eq 0 ] && legacy_lock_held; then
        release_lock "$SLOT_LOCK"
        SLOT_LOCK=""
        SLOT_RECLAIMED=0
        continue
      fi
      apply_slot "$s"
      say "枠 $s を取りました (project_id $SLOT_PROJECT_ID / Supabase API $SLOT_API_PORT / Next ${APP_PORT}・${ENFORCED_APP_PORT}・${NOTICE_APP_PORT}。ロック $SLOT_LOCK)"
      return 0
    done
    if [ "$(now)" -ge "$deadline" ]; then return 1; fi
    if [ "$waited" = 0 ]; then
      say "空いている枠がありません (候補: $SLOT_CANDIDATES / ロック: $LOCK_DIR${LEGACY_LOCK:+ / 外側のロック: $LEGACY_LOCK})。最大 $SLOT_WAIT_SECONDS 秒待ちます"
      waited=1
    fi
    sleep "$SLOT_POLL_SEC"
  done
}

# slot_stack_exists: この枠の project_id のコンテナかボリュームが 1 つでもあれば真
slot_stack_exists() {
  local filter="label=com.supabase.cli.project=$SLOT_PROJECT_ID"
  [ -n "$(docker ps -aq --filter "$filter" 2>/dev/null)" ] || [ -n "$(docker volume ls -q --filter "$filter" 2>/dev/null)" ]
}

# 持ち主の死んだ枠 (1 以上) のロックを回収して取ったときだけ、その持ち主が残したスタックを片付ける。
# 回収していない (空いていたロックを取った) ときは片付けない。そのときにこの枠のスタックがあるのは、ロックを取らずに
# 手で LOCAL_CI_SLOT を付けて起動したスタックなど、ほかの作業のものかもしれないので、消さずに段の前で赤にする (check_slot_stack)。
# 枠 0 は、枠を使わない作業 (CI・手で起動したスタック・外側のロックで動く Workflow) と共有しているので、どちらもしない
clear_slot_leftovers() {
  [ "$SLOT" -ne 0 ] && [ "$SLOT_RECLAIMED" = 1 ] || return 0
  slot_stack_exists || return 0
  say "枠 $SLOT ($SLOT_PROJECT_ID) のロックを持ち主の死んだ実行から回収したので、その実行が残したコンテナ / ボリュームを片付けます"
  run_in "$WT" "$ART/slot-leftover.log" bash scripts/supabase-local.sh stop-leftover || true
}

# check_slot_stack <段>: integration / e2e の前に、この枠 (1 以上) の project_id のコンテナ・ボリュームが残っていないかを確かめる。
# 残っていれば消さずに赤で終える (check_ports と同じく、他の作業のものには触らない)。枠 0 は今までどおり確かめない
check_slot_stack() {
  [ "$SLOT" -ne 0 ] || return 0
  slot_stack_exists || return 0
  record "$1:setup" RED - - - - - 0 "枠 $SLOT の project_id ($SLOT_PROJECT_ID) のコンテナ / ボリュームが残っている (ロックを取らずに手で起動したスタックなどかもしれないので消さずに赤で終える。持ち主を確かめ、要らなければ LOCAL_CI_SLOT=$SLOT bash scripts/supabase-local.sh stop-leftover で止めてから再実行する)"
  return 1
}

# ---------------------------------------------------------------------
# 段: secrets (.github/workflows/security.yml の gitleaks ジョブ)
# ---------------------------------------------------------------------
# gitleaks の配布物の名前に使う「<OS>_<CPU>」。配布物の無い組み合わせなら失敗
gitleaks_platform() {
  local os arch
  case "$(uname -s)" in
    Darwin) os=darwin ;;
    Linux) os=linux ;;
    *) return 1 ;;
  esac
  case "$(uname -m)" in
    x86_64|amd64) arch=x64 ;;
    arm64|aarch64) arch=arm64 ;;
    *) return 1 ;;
  esac
  printf '%s_%s\n' "$os" "$arch"
}

# gitleaks_sha256 <OS>_<CPU>: その配布物の SHA-256
gitleaks_sha256() {
  case "$1" in
    linux_x64) printf '%s\n' "$GITLEAKS_SHA256_LINUX_X64" ;;
    linux_arm64) printf '%s\n' "$GITLEAKS_SHA256_LINUX_ARM64" ;;
    darwin_x64) printf '%s\n' "$GITLEAKS_SHA256_DARWIN_X64" ;;
    darwin_arm64) printf '%s\n' "$GITLEAKS_SHA256_DARWIN_ARM64" ;;
    *) return 1 ;;
  esac
}

GL_DIR=""
stage_secrets() {
  local t0 rc log platform want_sha tarball cached tmp report parsed findings commits range
  log="$ART/secrets-gitleaks.log"
  report="$ART/secrets-gitleaks.json"
  t0=$(now)

  # 1) security.yml と同じ版の gitleaks を、SHA-256 を確かめてから使う (合わなければ止める)
  if ! platform="$(gitleaks_platform)" || ! want_sha="$(gitleaks_sha256 "$platform")"; then
    record secrets:gitleaks RED - - - - - "$(($(now) - t0))" "gitleaks $GITLEAKS_VERSION の配布物が無い OS / CPU: $(uname -s) $(uname -m)"
    return 0
  fi
  tarball="gitleaks_${GITLEAKS_VERSION}_${platform}.tar.gz"
  cached="$TOOLS_DIR/$tarball"
  if ! mkdir -p "$TOOLS_DIR"; then
    record secrets:gitleaks RED - - - - - "$(($(now) - t0))" "gitleaks の置き場を作れない: $TOOLS_DIR"
    return 0
  fi
  if [ ! -f "$cached" ] || [ "$(sha256_of "$cached")" != "$want_sha" ]; then
    say "secrets: gitleaks $GITLEAKS_VERSION ($platform) を取得します"
    tmp="$(mktemp "$TOOLS_DIR/download.XXXXXX")"
    if ! curl --fail --silent --show-error --location --retry "$DOWNLOAD_RETRY" --retry-delay "$DOWNLOAD_RETRY_DELAY_SEC" --retry-all-errors \
      --output "$tmp" "$GITLEAKS_RELEASE_URL/v${GITLEAKS_VERSION}/${tarball}" >>"$log" 2>&1; then
      rm -f "$tmp"
      record secrets:gitleaks RED - - - - - "$(($(now) - t0))" "$(tail_hint "gitleaks の配布物を取得できない" "$log")"
      return 0
    fi
    if [ "$(sha256_of "$tmp")" != "$want_sha" ]; then
      rm -f "$tmp"
      record secrets:gitleaks RED - - - - - "$(($(now) - t0))" "gitleaks の配布物の SHA-256 が合わない ($tarball)。差し替えられた可能性があるので使わない"
      return 0
    fi
    mv -f "$tmp" "$cached"
  fi
  GL_DIR="$(mktemp -d "$WORK_PARENT/gitleaks.XXXXXX")" && tar -xzf "$cached" -C "$GL_DIR" gitleaks >>"$log" 2>&1
  rc=$?
  if [ "$rc" -ne 0 ] || [ ! -x "$GL_DIR/gitleaks" ]; then
    record secrets:gitleaks RED - - - - - "$(($(now) - t0))" "$(tail_hint "gitleaks の配布物を展開できない" "$log")"
    return 0
  fi

  # 2) PR で増えるコミット (--base から HEAD まで) だけを検査する。security.yml の pull_request と同じ範囲
  #    (base.sha..head.sha)。過去の履歴は見ない。検査するのはコミット済みのものだけで、マージの差分は見ない (CI と同じ)
  range="${BASE_SHA}..${HEAD_SHA}"
  commits="$(git -C "$WT" rev-list --count "$range" 2>>"$log")" || commits="-"
  rm -f "$report"
  # shellcheck disable=SC2030,SC2031  # PATH はサブシェルの中だけで足す
  ( PATH="$GL_DIR:$PATH"
    run_in "$WT" "$log" gitleaks git . --config .gitleaks.toml --log-opts="${BASE_SHA}..${HEAD_SHA}" --redact --no-banner --exit-code "$GITLEAKS_FOUND_EXIT" --report-format json --report-path "$report" )
  rc=$?

  # 3) 判定。0 = 見つからない (緑)。GITLEAKS_FOUND_EXIT = 見つかった (赤)。それ以外 = 検査そのものの失敗 (赤。security.yml と同じ)
  if [ "$rc" -ne 0 ] && [ "$rc" -ne "$GITLEAKS_FOUND_EXIT" ]; then
    record secrets:gitleaks RED - - - "$commits" - "$(($(now) - t0))" "$(tail_hint "gitleaks の実行に失敗 (終了コード $rc)。検査できていないので赤" "$log")"
    return 0
  fi
  if ! parsed="$(node -e "$GITLEAKS_REPORT_JS" "$report")"; then
    record secrets:gitleaks RED - - - "$commits" - "$(($(now) - t0))" "$(tail_hint "gitleaks のレポートが無いか壊れている (終了コード $rc)" "$log")"
    return 0
  fi
  findings="$(printf '%s\n' "$parsed" | head -n 1)"
  if [ "$rc" -eq 0 ] && [ "$findings" = 0 ]; then
    record secrets:gitleaks GREEN - 0 - "$commits" - "$(($(now) - t0))" "検査したコミット $commits 件 (${BASE_SHA:0:8}..${HEAD_SHA:0:8})"
    return 0
  fi
  printf '%s\n' "$parsed" | tail -n +2 >>"$log"
  record secrets:gitleaks RED - "$findings" - "$commits" - "$(($(now) - t0))" "$(tail_hint "シークレットの疑い $findings 件 (終了コード ${rc}。値は出していない。本物ならキーを無効にして発行し直す。ダミーなら .gitleaks.toml か行末の gitleaks:allow)" "$log")"
}

# ---------------------------------------------------------------------
# 段: unit (.github/workflows/ci.yml)
# ---------------------------------------------------------------------
stage_unit() {
  local t0 rc errs line log

  # 1) npm run typecheck
  log="$ART/unit-typecheck.log"
  t0=$(now)
  run_in "$WT" "$log" npm run typecheck
  rc=$?
  errs=$(grep -c 'error TS' "$log")
  if [ "$rc" -eq 0 ] && [ "$errs" -eq 0 ]; then
    record unit:typecheck GREEN - 0 - - - "$(($(now) - t0))" "-"
  else
    record unit:typecheck RED - "$errs" - - - "$(($(now) - t0))" "$(tail_hint "型エラー $errs 件・終了コード $rc" "$log")"
  fi

  # 2) npm run lint (結果は ESLint の JSON で数える)
  log="$ART/unit-lint.log"
  t0=$(now)
  run_in "$WT" "$log" npm run lint -- --format json --output-file "$ART/unit-eslint.json"
  rc=$?
  line=$(parse eslint "$ART/unit-eslint.json" - "$rc")
  record_parsed unit:lint "$(($(now) - t0))" "$line"

  # 3) npm test (= vitest run)。収集されるはずのファイルを vitest 自身に数えさせて突き合わせる
  log="$ART/unit-vitest.log"
  t0=$(now)
  run_in "$WT" "$log" npx vitest list --filesOnly --json="$ART/unit-vitest-list.json"
  run_in "$WT" "$log" npm test -- --reporter=default --reporter=json --outputFile="$ART/unit-vitest.json"
  rc=$?
  line=$(parse vitest "$ART/unit-vitest.json" "$ART/unit-vitest-list.json" "$rc")
  record_parsed unit:vitest "$(($(now) - t0))" "$line"
}

# ---------------------------------------------------------------------
# 段: mobile (.github/workflows/mobile-test.yml)
# ---------------------------------------------------------------------
stage_mobile() {
  local t0 rc line log

  # 1) apps/mobile で npm test -- --ci --coverage (jest)
  log="$ART/mobile-jest.log"
  t0=$(now)
  run_in_stdout "$WT/apps/mobile" "$ART/mobile-jest-list.json" "$log" npm test --silent -- --listTests --json
  run_in "$WT/apps/mobile" "$log" npm test -- --ci --coverage --json --outputFile="$ART/mobile-jest.json"
  rc=$?
  line=$(parse jest "$ART/mobile-jest.json" "$ART/mobile-jest-list.json" "$rc")
  record_parsed mobile:jest "$(($(now) - t0))" "$line"

  # 2) root で npm run test -- --run packages/core (vitest)
  log="$ART/mobile-core.log"
  t0=$(now)
  run_in "$WT" "$log" npx vitest list --filesOnly --json="$ART/mobile-core-list.json" packages/core
  run_in "$WT" "$log" npm run test -- --run packages/core --reporter=default --reporter=json --outputFile="$ART/mobile-core-vitest.json"
  rc=$?
  line=$(parse vitest "$ART/mobile-core-vitest.json" "$ART/mobile-core-list.json" "$rc")
  record_parsed mobile:core "$(($(now) - t0))" "$line"
}

# ---------------------------------------------------------------------
# 段: integration (.github/workflows/security-regression.yml)
# ---------------------------------------------------------------------
stage_integration() {
  local t0 rc line log p
  check_ports integration || return 0
  check_docker integration || return 0
  check_slot_stack integration || return 0

  SUPA_LOG="$ART/integration-supabase.log"
  t0=$(now)
  say "integration: ローカル Supabase を起動します (初回はイメージ取得で数分)"
  SUPA_STARTED=1
  if ! run_in "$WT" "$SUPA_LOG" bash scripts/supabase-local.sh start; then
    record integration:setup RED - - - - - "$(($(now) - t0))" "$(tail_hint "supabase-local.sh start が失敗" "$SUPA_LOG")"
    stop_supabase
    return 0
  fi
  if ! run_in "$WT" "$SUPA_LOG" bash scripts/supabase-local.sh env .env.local; then
    record integration:setup RED - - - - - "$(($(now) - t0))" "$(tail_hint "supabase-local.sh env が失敗" "$SUPA_LOG")"
    stop_supabase
    return 0
  fi

  # Next dev サーバ (yml と同じく /login が応答するまで待つ)
  log="$ART/integration-next-dev.log"
  say "integration: next dev を起動します"
  ( ci_env && cd "$WT" && export PORT="$APP_PORT" && exec nohup npm run dev ) >"$log" 2>&1 &
  SERVER_PID=$!
  if ! wait_app "$DEV_WAIT_TRIES" "$log"; then
    record integration:setup RED - - - - - "$(($(now) - t0))" "$(tail_hint "next dev が $APP_ORIGIN/login に応答しない" "$log")"
    stop_server
    stop_supabase
    return 0
  fi
  # next dev は API ルートを初回リクエスト時にコンパイルするため、yml と同じく先に 1 回ずつ叩いておく (結果は見ない)
  curl -s -o /dev/null --max-time "$PRECOMPILE_MAX_TIME_SEC" "$APP_ORIGIN/api/handson-tour/status" || true
  for p in /api/handson-tour/skip /api/handson-tour/complete /api/menu-plans/add; do
    curl -s -o /dev/null --max-time "$PRECOMPILE_MAX_TIME_SEC" -X POST "$APP_ORIGIN$p" || true
  done
  record integration:setup GREEN - - - - - "$(($(now) - t0))" "-"

  # 1 本目: セキュリティ回帰 + handson-tour
  log="$ART/integration-security.log"
  t0=$(now)
  run_in "$WT" "$log" npx vitest list --filesOnly --json="$ART/integration-security-list.json" "${INTEG1_ARGS[@]}"
  run_in "$WT" "$log" npx vitest run "${INTEG1_ARGS[@]}" --reporter=default --reporter=json --outputFile="$ART/integration-security.json"
  rc=$?
  line=$(parse vitest "$ART/integration-security.json" "$ART/integration-security-list.json" "$rc")
  record_parsed integration:security "$(($(now) - t0))" "$line"

  # 2 本目: 運営コンソール。1 本目が落ちても必ず回す (yml の if: !cancelled() と同じ)
  log="$ART/integration-operator.log"
  t0=$(now)
  run_in "$WT" "$log" npx vitest list --filesOnly --json="$ART/integration-operator-list.json" "${INTEG2_ARGS[@]}"
  run_in "$WT" "$log" npx vitest run "${INTEG2_ARGS[@]}" --reporter=default --reporter=json --outputFile="$ART/integration-operator.json"
  rc=$?
  line=$(parse vitest "$ART/integration-operator.json" "$ART/integration-operator-list.json" "$rc")
  record_parsed integration:operator "$(($(now) - t0))" "$line"

  stop_server
  stop_supabase
}

# ---------------------------------------------------------------------
# 段: e2e (.github/workflows/e2e-local.yml)
# ---------------------------------------------------------------------
stage_e2e() {
  local t0 rc line log setup_log e2e_password
  check_ports e2e "$ENFORCED_APP_PORT" "$NOTICE_APP_PORT" || return 0
  check_docker e2e || return 0
  check_slot_stack e2e || return 0

  setup_log="$ART/e2e-setup.log"
  t0=$(now)
  say "e2e: Playwright の chromium を入れます"
  if [ "$PLAYWRIGHT_WITH_DEPS" = 1 ]; then
    run_in "$WT" "$setup_log" npx playwright install --with-deps chromium
    rc=$?
  else
    run_in "$WT" "$setup_log" npx playwright install chromium
    rc=$?
  fi
  if [ "$rc" -ne 0 ]; then
    record e2e:setup RED - - - - - "$(($(now) - t0))" "$(tail_hint "playwright install が失敗" "$setup_log")"
    return 0
  fi

  SUPA_LOG="$ART/e2e-supabase.log"
  say "e2e: ローカル Supabase を起動します"
  SUPA_STARTED=1
  if ! run_in "$WT" "$SUPA_LOG" bash scripts/supabase-local.sh start; then
    record e2e:setup RED - - - - - "$(($(now) - t0))" "$(tail_hint "supabase-local.sh start が失敗" "$SUPA_LOG")"
    stop_supabase
    return 0
  fi
  if ! run_in "$WT" "$SUPA_LOG" bash scripts/supabase-local.sh env .env.local; then
    record e2e:setup RED - - - - - "$(($(now) - t0))" "$(tail_hint "supabase-local.sh env が失敗" "$SUPA_LOG")"
    stop_supabase
    return 0
  fi

  # テストユーザー。パスワードは実行ごとに乱数で作り、表示もファイルへの書き出しもしない
  # (子プロセスには引数ではなく環境変数で渡す。yml と同じ作り方)
  if command -v openssl >/dev/null 2>&1; then
    e2e_password="$(openssl rand -hex 16)Aa1!"
  else
    e2e_password="$(node -e 'process.stdout.write(require("crypto").randomBytes(16).toString("hex"))')Aa1!"
  fi
  # shellcheck disable=SC2030,SC2031  # サブシェルの中だけで渡す (親シェルには残さない)
  if ! ( export E2E_USER_PASSWORD="$e2e_password"; ENV_EXTRA="E2E_USER_PASSWORD"
         run_in "$WT" "$setup_log" npx --yes tsx@4 scripts/create-e2e-accounts.ts ); then
    record e2e:setup RED - - - - - "$(($(now) - t0))" "$(tail_hint "create-e2e-accounts.ts が失敗" "$setup_log")"
    stop_supabase
    return 0
  fi
  record e2e:setup GREEN - - - - - "$(($(now) - t0))" "-"

  # 本番ビルド (next/font/google はモックのフォントで代替。yml と同じ)
  log="$ART/e2e-build.log"
  t0=$(now)
  say "e2e: npm run build"
  if ! run_in "$WT" "$log" env NEXT_FONT_GOOGLE_MOCKED_RESPONSES="$WT/tests/e2e/fixtures/google-fonts-mock.cjs" npm run build; then
    record e2e:build RED - - - - - "$(($(now) - t0))" "$(tail_hint "npm run build が失敗" "$log")"
    stop_supabase
    return 0
  fi
  log="$ART/e2e-next-start.log"
  ( ci_env && cd "$WT" && export PORT="$APP_PORT" && exec nohup npm run start ) >"$log" 2>&1 &
  SERVER_PID=$!
  if ! wait_app "$START_WAIT_TRIES" "$log"; then
    record e2e:build RED - - - - - "$(($(now) - t0))" "$(tail_hint "next start が $APP_ORIGIN/login に応答しない" "$log")"
    stop_server
    stop_supabase
    return 0
  fi
  record e2e:build GREEN - - - - - "$(($(now) - t0))" "-"

  # Playwright。global-setup が標準出力に書くので、JSON は PLAYWRIGHT_JSON_OUTPUT_NAME でファイルへ出す
  log="$ART/e2e-playwright.log"
  t0=$(now)
  # shellcheck disable=SC2030,SC2031
  ( export E2E_USER_PASSWORD="$e2e_password"; ENV_EXTRA="E2E_USER_PASSWORD"
    run_in "$WT" "$log" env PLAYWRIGHT_BASE_URL="$APP_ORIGIN" E2E_USER_EMAIL=e2e-user-01@homegohan.test E2E_REQUIRE_LOGIN=1 PLAYWRIGHT_NO_COPY_PROMPT=1 \
      PLAYWRIGHT_JSON_OUTPUT_NAME="$ART/e2e-playwright-list.json" npx playwright test --list "${PW_ARGS[@]}" --reporter=json
    run_in "$WT" "$log" env PLAYWRIGHT_BASE_URL="$APP_ORIGIN" E2E_USER_EMAIL=e2e-user-01@homegohan.test E2E_REQUIRE_LOGIN=1 PLAYWRIGHT_NO_COPY_PROMPT=1 \
      PLAYWRIGHT_JSON_OUTPUT_NAME="$ART/e2e-playwright.json" npx playwright test "${PW_ARGS[@]}" --reporter=list,json )
  rc=$?
  line=$(parse playwright "$ART/e2e-playwright.json" "$ART/e2e-playwright-list.json" "$rc")
  record_parsed e2e:playwright "$(($(now) - t0))" "$line"
  # yml が artifact に上げるのと同じもの (失敗時のスクリーンショット・動画・エラー内容) を残す。
  # Playwright は実行のたびに tests/e2e/.output を空にするので、実行ごとに別の場所へ写す
  if [ -d "$WT/tests/e2e/.output" ]; then
    cp -R "$WT/tests/e2e/.output" "$ART/e2e-output" 2>/dev/null || true
  fi

  # 規約の同意ゲート (#1174) の「強制あり」: 同じビルドを LEGAL_CONSENT_ENFORCE=on で 2 つ目のポートに起動する (yml と同じ)。
  # yml では前の手順が赤だとこの先は回らないが、ここでは手がかりを多く残すため、前の結果によらず回す
  log="$ART/e2e-next-start-enforced.log"
  t0=$(now)
  ( ci_env && cd "$WT" && exec nohup env LEGAL_CONSENT_ENFORCE=on npx next start -p "$ENFORCED_APP_PORT" ) >"$log" 2>&1 &
  ENFORCED_SERVER_PID=$!
  if wait_enforced_app "$log"; then
    record e2e:start-enforced GREEN - - - - - "$(($(now) - t0))" "-"
    log="$ART/e2e-playwright-enforced.log"
    t0=$(now)
    # shellcheck disable=SC2030,SC2031
    ( export E2E_USER_PASSWORD="$e2e_password"; ENV_EXTRA="E2E_USER_PASSWORD"
      run_in "$WT" "$log" env PLAYWRIGHT_BASE_URL="$ENFORCED_APP_ORIGIN" LEGAL_CONSENT_ENFORCE=on E2E_USER_EMAIL=e2e-user-01@homegohan.test PLAYWRIGHT_NO_COPY_PROMPT=1 \
        PLAYWRIGHT_JSON_OUTPUT_NAME="$ART/e2e-playwright-enforced-list.json" npx playwright test --list "${PW_CONSENT_ARGS[@]}" --reporter=json
      run_in "$WT" "$log" env PLAYWRIGHT_BASE_URL="$ENFORCED_APP_ORIGIN" LEGAL_CONSENT_ENFORCE=on E2E_USER_EMAIL=e2e-user-01@homegohan.test PLAYWRIGHT_NO_COPY_PROMPT=1 \
        PLAYWRIGHT_JSON_OUTPUT_NAME="$ART/e2e-playwright-enforced.json" npx playwright test "${PW_CONSENT_ARGS[@]}" --reporter=list,json )
    rc=$?
    line=$(parse playwright "$ART/e2e-playwright-enforced.json" "$ART/e2e-playwright-enforced-list.json" "$rc")
    record_parsed e2e:playwright-enforced "$(($(now) - t0))" "$line"
    if [ -d "$WT/tests/e2e/.output" ]; then
      cp -R "$WT/tests/e2e/.output" "$ART/e2e-output-enforced" 2>/dev/null || true
    fi
  else
    record e2e:start-enforced RED - - - - - "$(($(now) - t0))" "$(tail_hint "next start (LEGAL_CONSENT_ENFORCE=on) が $ENFORCED_APP_ORIGIN/login に応答しない" "$log")"
  fi

  # 規約の同意ゲート (#1174) の「お知らせあり」: 同じビルドを LEGAL_CONSENT_NOTICE=on で 3 つ目のポートに起動する (yml と同じ)
  log="$ART/e2e-next-start-notice.log"
  t0=$(now)
  ( ci_env && cd "$WT" && exec nohup env LEGAL_CONSENT_NOTICE=on npx next start -p "$NOTICE_APP_PORT" ) >"$log" 2>&1 &
  NOTICE_SERVER_PID=$!
  if wait_notice_app "$log"; then
    record e2e:start-notice GREEN - - - - - "$(($(now) - t0))" "-"
    log="$ART/e2e-playwright-notice.log"
    t0=$(now)
    # shellcheck disable=SC2030,SC2031
    ( export E2E_USER_PASSWORD="$e2e_password"; ENV_EXTRA="E2E_USER_PASSWORD"
      run_in "$WT" "$log" env PLAYWRIGHT_BASE_URL="$NOTICE_APP_ORIGIN" LEGAL_CONSENT_NOTICE=on E2E_USER_EMAIL=e2e-user-01@homegohan.test PLAYWRIGHT_NO_COPY_PROMPT=1 \
        PLAYWRIGHT_JSON_OUTPUT_NAME="$ART/e2e-playwright-notice-list.json" npx playwright test --list "${PW_CONSENT_ARGS[@]}" --reporter=json
      run_in "$WT" "$log" env PLAYWRIGHT_BASE_URL="$NOTICE_APP_ORIGIN" LEGAL_CONSENT_NOTICE=on E2E_USER_EMAIL=e2e-user-01@homegohan.test PLAYWRIGHT_NO_COPY_PROMPT=1 \
        PLAYWRIGHT_JSON_OUTPUT_NAME="$ART/e2e-playwright-notice.json" npx playwright test "${PW_CONSENT_ARGS[@]}" --reporter=list,json )
    rc=$?
    line=$(parse playwright "$ART/e2e-playwright-notice.json" "$ART/e2e-playwright-notice-list.json" "$rc")
    record_parsed e2e:playwright-notice "$(($(now) - t0))" "$line"
    if [ -d "$WT/tests/e2e/.output" ]; then
      cp -R "$WT/tests/e2e/.output" "$ART/e2e-output-notice" 2>/dev/null || true
    fi
  else
    record e2e:start-notice RED - - - - - "$(($(now) - t0))" "$(tail_hint "next start (LEGAL_CONSENT_NOTICE=on) が $NOTICE_APP_ORIGIN/login に応答しない" "$log")"
  fi

  stop_server
  stop_supabase
}

# ---------------------------------------------------------------------
# 結果の表と、PR 本文に貼る Markdown
# ---------------------------------------------------------------------
FINISHED=0
finish() {
  [ "$FINISHED" = 1 ] && return 0
  FINISHED=1
  local stage v p f s files exp secs note red=0 red_checks=0 rows=0 mark md
  md="$ART/summary.md"

  printf '\n%-22s %-6s %8s %8s %8s %13s %6s  %s\n' stage result passed failed skipped files secs note
  while IFS=$'\t' read -r stage v p f s files exp secs note; do
    [ -n "$stage" ] || continue
    rows=$((rows + 1))
    if [ "$v" != GREEN ]; then
      red=1
      [ "$stage" = slot:wait ] || red_checks=1
    fi
    printf '%-22s %-6s %8s %8s %8s %13s %6s  %s\n' "$stage" "$v" "$p" "$f" "$s" "$files/$exp" "$secs" "$note"
  done <"$RESULTS"
  [ "$rows" -gt 0 ] || red=1

  {
    echo "### ローカル CI の結果 (\`scripts/local-ci.sh\`)"
    echo
    if [ "$red" = 0 ]; then echo "- 判定: **緑**"; else echo "- 判定: **赤**"; fi
    echo "- 検査した HEAD: \`${HEAD_SHA:-?}\`"
    if [ "$MERGE" = 1 ]; then
      echo "- --base: \`$BASE\` @ \`${BASE_SHA:-?}\` (${MERGE_STATE:-マージ前に停止})"
    else
      echo "- --base: なし (${MERGE_STATE:-HEAD そのもの})"
    fi
    echo "- 実行した段: \`$ONLY\` (全段は \`$ALL_STAGES\`)"
    if [ -n "$SLOT" ]; then
      echo "- 枠: $SLOT (project_id \`$SLOT_PROJECT_ID\` / Supabase API $SLOT_API_PORT / Next ${APP_PORT}・${ENFORCED_APP_PORT}・${NOTICE_APP_PORT})"
    fi
    echo "- TZ=UTC / CI=true / LANG=$CI_LANG / NODE_OPTIONS なし / Node ${NODE_VERSION:-?} / $(uname -s) $(uname -m)"
    if [ "${DIRTY_TRACKED:-0}" != 0 ] || [ "${DIRTY_UNTRACKED:-0}" != 0 ]; then
      echo "- 未コミットの変更: 変更 ${DIRTY_TRACKED:-0} / 未追跡 ${DIRTY_UNTRACKED:-0} (検査に含まれていない)"
    fi
    echo
    echo "| 段 | 判定 | passed | failed | skipped | 収集ファイル (結果/期待) | 秒 | 備考 |"
    echo "|---|---|---:|---:|---:|---:|---:|---|"
    while IFS=$'\t' read -r stage v p f s files exp secs note; do
      [ -n "$stage" ] || continue
      if [ "$v" = GREEN ]; then mark="緑"; else mark="赤"; fi
      note="${note//|/\\|}"
      echo "| $stage | $mark | $p | $f | $s | $files / $exp | $secs | $note |"
    done <"$RESULTS"
  } >"$md"

  echo
  echo "---- PR 本文に貼る Markdown ($md) ----"
  cat "$md"
  echo "----"
  say "JSON とログ: $ART"
  if [ "$red" = 0 ]; then exit 0; fi
  # 赤の段のログの末尾を手がかりに出す (備考に書いたログ、無ければ段の名前のログ)
  local lf
  while IFS=$'\t' read -r stage v p f s files exp secs note; do
    [ "$v" = GREEN ] && continue
    case "$note" in
      *"(末尾は "*) lf="${note##*"(末尾は "}"; lf="${lf%)}" ;;
      *) lf="$ART/${stage/:/-}.log" ;;
    esac
    if [ -f "$lf" ]; then
      say "---- $stage: $lf の末尾 ----"
      tail -n "$LOG_TAIL_LINES" "$lf" >&2
    fi
  done <"$RESULTS"
  # 枠の空き待ちの時間切れだけで赤なら、検査の失敗と区別できる終了コードにする
  if [ "$SLOT_TIMED_OUT" = 1 ] && [ "$red_checks" = 0 ]; then
    say "枠の空き待ちの時間切れ: Docker を使う段 (integration / e2e) を回していません。検査の失敗ではありません (終了コード $EXIT_SLOT_TIMEOUT)"
    exit "$EXIT_SLOT_TIMEOUT"
  fi
  exit "$EXIT_RED"
}

CLEANED=0
cleanup() {
  [ "$CLEANED" = 1 ] && return 0
  CLEANED=1
  # 見張りを持ったまま終わるなら、最初に外す (残すと、その枠を誰も回収できなくなる。シグナルで終わるときは exit_on_signal が先に外している)
  drop_guard
  stop_server
  stop_supabase
  # 枠のロックは、その枠のコンテナと Next を止めたあとに外す
  release_lock "$SLOT_LOCK"
  if [ -n "${WT:-}" ] && [ -d "$WT" ]; then
    if [ "$KEEP" = 1 ]; then
      say "作業用の worktree を残しました: $WT (片付け: git worktree remove --force $WT)"
    else
      git -C "$SRC_ROOT" worktree remove --force "$WT" >/dev/null 2>&1 || true
      case "$WT" in
        "$WORK_PARENT"/wt.*) rm -rf "$WT" ;;
      esac
      git -C "$SRC_ROOT" worktree prune >/dev/null 2>&1 || true
    fi
  fi
  case "$GL_DIR" in
    "$WORK_PARENT"/gitleaks.*) rm -rf "$GL_DIR" ;;
  esac
  # 結果の置き場のロックは最後に外す (片付けが終わるまで、別の実行に同じ置き場を使わせない)
  release_lock "$ART_LOCK"
}

# ---------------------------------------------------------------------
# 本体
# ---------------------------------------------------------------------
ONLY="$ALL_STAGES"
BASE="origin/main"
KEEP=0
MERGE=1
while [ $# -gt 0 ]; do
  case "$1" in
    --only)
      [ $# -ge 2 ] || { usage >&2; exit "$EXIT_USAGE"; }
      ONLY="$2"; shift 2 ;;
    --only=*) ONLY="${1#--only=}"; shift ;;
    --base)
      [ $# -ge 2 ] || { usage >&2; exit "$EXIT_USAGE"; }
      BASE="$2"; shift 2 ;;
    --base=*) BASE="${1#--base=}"; shift ;;
    --keep) KEEP=1; shift ;;
    --no-merge) MERGE=0; shift ;;
    -h|--help) usage; exit 0 ;;
    *) say "不明な引数: $1"; usage >&2; exit "$EXIT_USAGE" ;;
  esac
done
for s in $(echo "$ONLY" | tr ',' ' '); do
  case ",$ALL_STAGES," in
    *",$s,"*) ;;
    *) say "--only に不明な段: $s (使えるのは $ALL_STAGES)"; exit "$EXIT_USAGE" ;;
  esac
done
want() { case ",$ONLY," in *",$1,"*) return 0 ;; esac; return 1; }

# 枠の設定 (使い方の誤りは、何かを作る前に止める)
if [ -n "${LOCAL_CI_SLOT:-}" ]; then SLOT_CANDIDATES="$LOCAL_CI_SLOT"; else SLOT_CANDIDATES="${LOCAL_CI_SLOTS:-0}"; fi
normalized=""
for s in $SLOT_CANDIDATES; do
  local_ci_slot_valid "$s" || { say "LOCAL_CI_SLOT / LOCAL_CI_SLOTS の枠は 0〜$LCS_SLOT_MAX の整数: $s"; exit "$EXIT_USAGE"; }
  normalized="$normalized${normalized:+ }$((10#$s))"
done
[ -n "$normalized" ] || { say "LOCAL_CI_SLOTS が空です (例: LOCAL_CI_SLOTS='0 1')"; exit "$EXIT_USAGE"; }
SLOT_CANDIDATES="$normalized"
SLOT_WAIT_SECONDS="${LOCAL_CI_SLOT_WAIT_SECONDS:-$SLOT_WAIT_SECONDS_DEFAULT}"
SLOT_MEMORY_MIB="${LOCAL_CI_SLOT_MEMORY_MIB:-$SLOT_MEMORY_MIB_DEFAULT}"
for v in "$SLOT_WAIT_SECONDS" "$SLOT_MEMORY_MIB"; do
  [[ "$v" =~ ^[0-9]+$ ]] || { say "LOCAL_CI_SLOT_WAIT_SECONDS / LOCAL_CI_SLOT_MEMORY_MIB は 0 以上の整数: $v"; exit "$EXIT_USAGE"; }
done
LEGACY_LOCK="${LOCAL_CI_LEGACY_LOCK:-}"

for c in git node npm curl; do
  command -v "$c" >/dev/null 2>&1 || { say "$c が見つかりません"; exit "$EXIT_RED"; }
done

SRC_ROOT="$(cd "$(dirname "$0")" && git rev-parse --show-toplevel)" || { say "git リポジトリの中で実行してください"; exit "$EXIT_RED"; }
HEAD_SHA="$(git -C "$SRC_ROOT" rev-parse HEAD)"
HEAD_SHORT="$(git -C "$SRC_ROOT" rev-parse --short HEAD)"
BASE_SHA=""
MERGE_STATE=""
NODE_VERSION="$(node -p 'process.versions.node' 2>/dev/null || echo '?')"
WT=""

TMP_ROOT="${TMPDIR:-/tmp}"
TMP_ROOT="${TMP_ROOT%/}"
ART="${LOCAL_CI_ARTIFACTS:-$TMP_ROOT/homegohan-local-ci-artifacts/$HEAD_SHORT}"
WORK_PARENT="${LOCAL_CI_WORKDIR:-$TMP_ROOT/homegohan-local-ci}"
WORK_PARENT="${WORK_PARENT%/}"
LOCK_DIR="${LOCAL_CI_LOCK_DIR:-$TMP_ROOT/homegohan-local-ci-locks}"
LOCK_DIR="${LOCK_DIR%/}"
mkdir -p "$ART" "$WORK_PARENT" || { say "作業場所を作れません: $ART / $WORK_PARENT"; exit "$EXIT_RED"; }
chmod 700 "$ART" 2>/dev/null || true

# ロックと見張りに書く持ち主の印を決めてから、終わるときの片付け (cleanup) とシグナルの trap を入れる
init_owner_identity
install_signal_traps

# 同じ HEAD を同時に回すと、既定の結果の置き場 (HEAD の sha ごと) が重なる。使用中なら、既定のときは別の場所に替え、
# LOCAL_CI_ARTIFACTS で指定されたときは止める (他の実行の結果を消さない)。
# 取ってから ART_LOCK に入れ終えるまでのシグナルは後回しにする (そこで終わると、cleanup の知らないロックが残る)
defer_signals
try_lock "$ART/.in-use" && ART_LOCK="$ART/.in-use"
resume_signals
if [ -z "$ART_LOCK" ]; then
  if [ -n "${LOCAL_CI_ARTIFACTS:-}" ]; then
    say "LOCAL_CI_ARTIFACTS ($ART) は、同時に動いている別の local-ci.sh が使っています。別の場所を指定してください"
    exit "$EXIT_USAGE"
  fi
  ART="$ART.$$"
  say "既定の結果の置き場は別の local-ci.sh が使っているので、$ART に出します"
  mkdir -p "$ART" && chmod 700 "$ART" 2>/dev/null
  defer_signals
  try_lock "$ART/.in-use" && ART_LOCK="$ART/.in-use"
  resume_signals
  [ -n "$ART_LOCK" ] || { say "結果の置き場を取れません: $ART"; exit "$EXIT_RED"; }
fi
for s in $(echo "$ONLY" | tr ',' ' '); do rm -rf "$ART/$s"-*; done
rm -f "$ART/slot-leftover.log"
RESULTS="$ART/results.tsv"
: >"$RESULTS"

# 未コミットの変更は検査に入らない (検査するのはコミット済みの HEAD)。止めずに警告して続ける
DIRTY_TRACKED="$(git -C "$SRC_ROOT" status --porcelain --untracked-files=no | wc -l | tr -d ' ')"
DIRTY_UNTRACKED="$(git -C "$SRC_ROOT" status --porcelain | grep -c '^??')"
if [ "$DIRTY_TRACKED" != 0 ] || [ "$DIRTY_UNTRACKED" != 0 ]; then
  say "警告: 未コミットの変更 (変更 $DIRTY_TRACKED / 未追跡 $DIRTY_UNTRACKED) は検査に含まれません。検査するのはコミット済みの HEAD ($HEAD_SHORT) です"
fi

# Node の major は .nvmrc に合わせる (CI の setup-node と同じ版)
REQUIRED_NODE_MAJOR="$(tr -d ' \t\r\nv' <"$SRC_ROOT/.nvmrc" | cut -d. -f1)"
if [ "${NODE_VERSION%%.*}" != "$REQUIRED_NODE_MAJOR" ]; then
  fail_stop preflight "Node $NODE_VERSION では回せない。.nvmrc の $REQUIRED_NODE_MAJOR 系を PATH の先頭に置く (例: nvm install $REQUIRED_NODE_MAJOR && nvm use $REQUIRED_NODE_MAJOR / fnm use / https://nodejs.org/dist/latest-v$REQUIRED_NODE_MAJOR.x/ の tarball を展開して PATH に足す)"
fi

# --base は、マージする (MERGE=1) ときと、secrets 段で「PR で増えるコミット」の起点に使うときに要る
if [ "$MERGE" = 1 ] || want secrets; then
  case "$BASE" in
    origin/*)
      if [ "${LOCAL_CI_FETCH:-1}" = 1 ]; then
        say "git fetch origin ${BASE#origin/}"
        git -C "$SRC_ROOT" fetch --quiet origin "${BASE#origin/}" || fail_stop preflight "git fetch origin ${BASE#origin/} が失敗"
      fi
      ;;
  esac
  BASE_SHA="$(git -C "$SRC_ROOT" rev-parse --verify --quiet "$BASE^{commit}")" || fail_stop preflight "--base $BASE が見つからない"
fi

WT="$(mktemp -d "$WORK_PARENT/wt.XXXXXX")" || fail_stop preflight "作業用ディレクトリを作れない: $WORK_PARENT"
say "まっさらな worktree を作ります: $WT"
git -C "$SRC_ROOT" worktree add --detach --quiet "$WT" "$HEAD_SHA" >"$ART/preflight-worktree.log" 2>&1 \
  || fail_stop preflight "$(tail_hint "git worktree add が失敗" "$ART/preflight-worktree.log")"

if [ "$MERGE" = 1 ]; then
  if git -C "$WT" merge-base --is-ancestor "$BASE_SHA" HEAD; then
    MERGE_STATE="HEAD は $BASE を含む。マージの差分なし"
  elif git -C "$WT" merge --no-ff --no-commit --quiet "$BASE_SHA" >"$ART/preflight-merge.log" 2>&1; then
    MERGE_STATE="HEAD に $BASE をマージした状態"
  else
    conflicts="$(git -C "$WT" diff --name-only --diff-filter=U | tr '\n' ' ')"
    fail_stop preflight "$BASE をマージすると衝突する: ${conflicts:-不明} (main を取り込んで衝突を解いてから再実行する)"
  fi
else
  MERGE_STATE="HEAD そのもの (--no-merge)"
fi
say "検査対象: $MERGE_STATE"

# secrets は npm の依存を使わないので、npm ci の前に回す (npm ci が失敗しても結果が残る)
if want secrets; then say "== secrets (security.yml の gitleaks)"; stage_secrets; fi

if want unit || want mobile || want integration || want e2e; then
  say "npm ci (作業場所ごとに 1 回)"
  t_ci=$(now)
  run_in "$WT" "$ART/preflight-npm-ci.log" npm ci || fail_stop preflight "$(tail_hint "npm ci が失敗" "$ART/preflight-npm-ci.log")"
  say "npm ci: $(($(now) - t_ci)) 秒"
fi

if want unit; then say "== unit (ci.yml)"; stage_unit; fi
if want mobile; then say "== mobile (mobile-test.yml)"; stage_mobile; fi
# Docker を使う段 (integration / e2e) の前に枠を取る。secrets / unit / mobile だけなら取らない
if want integration || want e2e; then
  say "== 枠 (候補: $SLOT_CANDIDATES)"
  if acquire_slot; then
    # 持ち主の死んだロックを回収したときだけ片付ける (回収していなければ何もしない。残っていれば段の前で赤になる)
    clear_slot_leftovers
  else
    SLOT_TIMED_OUT=1
    record slot:wait RED - - - - - "$SLOT_WAIT_SECONDS" "待ちの時間切れ: $SLOT_WAIT_SECONDS 秒待っても枠 ($SLOT_CANDIDATES) が空かなかった。integration / e2e は回していない (検査の失敗ではない。ロック: $LOCK_DIR${LEGACY_LOCK:+ / 外側のロック: $LEGACY_LOCK})"
    finish
  fi
fi
if want integration; then say "== integration (security-regression.yml)"; stage_integration; fi
if want e2e; then say "== e2e (e2e-local.yml)"; stage_e2e; fi

finish
