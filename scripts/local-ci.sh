#!/usr/bin/env bash
# =====================================================================
# PR の CI 検査 (本番に触れない 4 本) をローカルで CI と同じ条件で回す
# =====================================================================
# 対象と CI 上の正本 (コマンド・対象パス・env は各 yml から写している。yml が正):
#   unit         .github/workflows/ci.yml              typecheck → lint → vitest (root の vitest.config.ts)
#   mobile       .github/workflows/mobile-test.yml     apps/mobile の jest → root の vitest (packages/core)
#   integration  .github/workflows/security-regression.yml
#                ローカル Supabase + next dev に対する結合テスト 2 本 (2 本目は 1 本目が落ちても回す)
#   e2e          .github/workflows/e2e-local.yml       ローカル Supabase + 本番ビルドに対する Playwright
#
# yml とこのスクリプトのずれは tests/local-ci-workflow-sync.test.ts が検出する (PR の npm test で落ちる)。
# そのテストは、段の関数名 (stage_unit / stage_mobile / stage_integration / stage_e2e)・run_in / run_in_stdout の引数の形・
# ci_env の export・readonly の定数・配列 ("${NAME[@]}") を手がかりに読む。これらの形を変えるときはテストも合わせる。
#
# 使い方:
#   bash scripts/local-ci.sh [--only unit,mobile,integration,e2e] [--base <ref>] [--keep] [--no-merge]
#     --only      回す段 (カンマ区切り。既定は 4 段すべて)
#     --base      取り込む基準 (既定 origin/main)。「いまの HEAD (コミット済み) に --base をマージした状態」を検査する
#                 (CI の pull_request が PR と main のマージコミットを検査するのと揃える)
#     --no-merge  マージせず HEAD そのものを検査する (main の上で回すとき)
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
# Docker を使う段の直前に、空いている枠のロックを mkdir で取り、終わったら (trap で必ず) 外す。unit / mobile だけなら取らない。
#   LOCAL_CI_SLOTS                 使ってよい枠 (空白区切り。既定 "0")。例: "0 1" なら 2 本まで同時に回せる
#   LOCAL_CI_SLOT                  この枠だけを使う (LOCAL_CI_SLOTS より優先。空くまで待つ)
#   LOCAL_CI_LOCK_DIR              枠のロックの置き場 (既定: ${TMPDIR:-/tmp}/homegohan-local-ci-locks)
#   LOCAL_CI_SLOT_WAIT_SECONDS     空きを待つ上限の秒数 (既定 SLOT_WAIT_SECONDS_DEFAULT)。過ぎたら「待ちの時間切れ」で終了コード 3
#   LOCAL_CI_LEGACY_LOCK           枠 0 を使う前に、このパスが無いことも確かめる (枠を使わずに既定のポートで動く作業の外側のロック。既定は空 = 確かめない)
#   LOCAL_CI_SLOT_MEMORY_MIB       1 枠の Docker のメモリの目安 (MiB。既定 SLOT_MEMORY_MIB_DEFAULT)。空きがこれより少なければ警告する (止めない)
#   LOCAL_CI_PLAYWRIGHT_WITH_DEPS  1 にすると playwright install に --with-deps を付ける (Linux で OS の依存も入れる。root 権限が要る)
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
readonly ALL_STAGES="unit,mobile,integration,e2e"
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
# ロックのディレクトリを作ってから持ち主 (owner) を書き終えるまでの猶予。これを過ぎても owner が無ければ持ち主が死んだとみなす
readonly LOCK_OWNER_GRACE_SEC=60
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

# ---------------------------------------------------------------------
# 共通の関数
# ---------------------------------------------------------------------
say() { printf '[local-ci] %s\n' "$*" >&2; }

usage() {
  cat <<'USAGE'
使い方: bash scripts/local-ci.sh [--only unit,mobile,integration,e2e] [--base <ref>] [--keep] [--no-merge]
  --only      回す段 (カンマ区切り。既定は 4 段すべて)
  --base      取り込む基準 (既定 origin/main)。HEAD (コミット済み) にこれをマージした状態を検査する
  --no-merge  マージせず HEAD そのものを検査する
  --keep      作業用の worktree を消さずに残す
同時に複数回すとき: LOCAL_CI_SLOTS='0 1' (使ってよい枠。integration / e2e は空いている枠のポートで回す)
前提: Docker (integration / e2e)、Node は .nvmrc の major。詳しくは CONTRIBUTING.md の「ローカル CI」
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

# lock_held <ロックのディレクトリ>: 生きている持ち主がいる (または作られた直後で持ち主をまだ書いていない) なら真
lock_held() {
  local dir="$1" pid lstart mtime
  [ -d "$dir" ] || return 1
  if [ ! -f "$dir/owner" ]; then
    mtime="$(file_mtime "$dir")" || return 1
    [ "$(($(now) - mtime))" -lt "$LOCK_OWNER_GRACE_SEC" ]
    return
  fi
  pid="$(sed -n 's/^pid=//p' "$dir/owner")"
  lstart="$(sed -n 's/^lstart=//p' "$dir/owner")"
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  [ -n "$lstart" ] && [ "$(proc_lstart "$pid")" = "$lstart" ]
}

write_owner() {
  local dir="$1"
  {
    echo "pid=$$"
    echo "lstart=$(proc_lstart "$$")"
    echo "started=$(date '+%Y-%m-%dT%H:%M:%S%z')"
    echo "head=$HEAD_SHA"
    echo "artifacts=$ART"
  } >"$dir/owner.tmp" && mv "$dir/owner.tmp" "$dir/owner"
}

# reclaim_lock <ロックのディレクトリ>: 持ち主の死んだロックを消す。回収は <dir>.reclaim を取った 1 本だけが行う
reclaim_lock() {
  local dir="$1" guard="$1.reclaim" mtime
  if ! mkdir "$guard" 2>/dev/null; then
    # 回収の途中で死んだ跡なら消しておく (次の回で回収する)
    mtime="$(file_mtime "$guard")" && [ "$(($(now) - mtime))" -ge "$LOCK_OWNER_GRACE_SEC" ] && rm -rf "$guard"
    return 1
  fi
  if lock_held "$dir"; then
    rmdir "$guard"
    return 1
  fi
  say "持ち主のいないロックを回収します: $dir ($(tr "\n" " " 2>/dev/null <"$dir/owner" || echo "owner なし"))"
  rm -rf "$dir"
  rmdir "$guard"
}

# try_lock <ロックのディレクトリ>: mkdir で原子的に取る。持ち主が死んでいれば回収して取り直す。
# 取れたとき、持ち主の死んだロックを回収して取ったなら LOCK_RECLAIMED=1、空いていたのを取ったなら 0 にする
LOCK_RECLAIMED=0
try_lock() {
  local dir="$1"
  LOCK_RECLAIMED=0
  if mkdir "$dir" 2>/dev/null; then write_owner "$dir"; return 0; fi
  lock_held "$dir" && return 1
  reclaim_lock "$dir" || return 1
  if mkdir "$dir" 2>/dev/null; then write_owner "$dir"; LOCK_RECLAIMED=1; return 0; fi
  return 1
}

# release_lock <ロックのディレクトリ>: 自分が持ち主のときだけ外す
release_lock() {
  local dir="$1"
  [ -n "$dir" ] && [ -f "$dir/owner" ] || return 0
  if [ "$(sed -n 's/^pid=//p' "$dir/owner")" = "$$" ]; then rm -rf "$dir"; fi
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
      if try_lock "$LOCK_DIR/slot-$s"; then
        # 外側のロックは別の作業が mkdir するので、取ったあとにもう一度確かめる
        if [ "$s" -eq 0 ] && legacy_lock_held; then release_lock "$LOCK_DIR/slot-$s"; continue; fi
        SLOT_LOCK="$LOCK_DIR/slot-$s"
        SLOT_RECLAIMED="$LOCK_RECLAIMED"
        apply_slot "$s"
        say "枠 $s を取りました (project_id $SLOT_PROJECT_ID / Supabase API $SLOT_API_PORT / Next ${APP_PORT}・${ENFORCED_APP_PORT}・${NOTICE_APP_PORT}。ロック $SLOT_LOCK)"
        return 0
      fi
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

trap cleanup EXIT
trap 'exit "$EXIT_SIGINT"' INT
trap 'exit "$EXIT_SIGTERM"' TERM

# 同じ HEAD を同時に回すと、既定の結果の置き場 (HEAD の sha ごと) が重なる。使用中なら、既定のときは別の場所に替え、
# LOCAL_CI_ARTIFACTS で指定されたときは止める (他の実行の結果を消さない)
if ! try_lock "$ART/.in-use"; then
  if [ -n "${LOCAL_CI_ARTIFACTS:-}" ]; then
    say "LOCAL_CI_ARTIFACTS ($ART) は、同時に動いている別の local-ci.sh が使っています。別の場所を指定してください"
    exit "$EXIT_USAGE"
  fi
  ART="$ART.$$"
  say "既定の結果の置き場は別の local-ci.sh が使っているので、$ART に出します"
  mkdir -p "$ART" && chmod 700 "$ART" 2>/dev/null
  try_lock "$ART/.in-use" || { say "結果の置き場を取れません: $ART"; exit "$EXIT_RED"; }
fi
ART_LOCK="$ART/.in-use"
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

if [ "$MERGE" = 1 ]; then
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

say "npm ci (作業場所ごとに 1 回)"
t_ci=$(now)
run_in "$WT" "$ART/preflight-npm-ci.log" npm ci || fail_stop preflight "$(tail_hint "npm ci が失敗" "$ART/preflight-npm-ci.log")"
say "npm ci: $(($(now) - t_ci)) 秒"

if want unit; then say "== unit (ci.yml)"; stage_unit; fi
if want mobile; then say "== mobile (mobile-test.yml)"; stage_mobile; fi
# Docker を使う段 (integration / e2e) の前に枠を取る。unit / mobile だけなら取らない
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
