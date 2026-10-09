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
#   LOCAL_CI_SUPABASE_PORTS        空いていることを確かめるローカル Supabase のポート (空白区切り)
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
readonly EXIT_SIGINT=130    # 128 + SIGINT(2)
readonly EXIT_SIGTERM=143   # 128 + SIGTERM(15)
readonly ALL_STAGES="unit,mobile,integration,e2e"
# 結合テスト (tests/integration/helpers/api.ts の既定) と e2e の yml が前提にするアプリの URL。CI と同じく固定
readonly APP_ORIGIN="http://localhost:3000"
readonly APP_PORT=3000
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
# supabase/config.toml はポートを指定していないので supabase CLI 2.62.10 の既定を使う
# (54320 shadow DB / 54321 API / 54322 DB / 54323 studio / 54324-54326 inbucket / 54327 analytics / 54329 pooler)
SUPABASE_PORTS="${LOCAL_CI_SUPABASE_PORTS:-54320 54321 54322 54323 54324 54325 54326 54327 54328 54329}"
PLAYWRIGHT_WITH_DEPS="${LOCAL_CI_PLAYWRIGHT_WITH_DEPS:-0}"

# CI の実行対象 (yml から写す。ずれは tests/local-ci-workflow-sync.test.ts が検出する)
# security-regression.yml の 1 本目 (セキュリティ回帰 + handson-tour)
INTEG1_ARGS=(--config vitest.integration.config.ts --passWithNoTests tests/integration/rls tests/integration/security tests/integration/handson-tour)
# security-regression.yml の 2 本目 (運営コンソール。--passWithNoTests は付けない)
INTEG2_ARGS=(--config vitest.integration.config.ts tests/integration/operator/admin- tests/integration/operator/auth-boundary tests/integration/operator/super-admin-)
# e2e-local.yml の Playwright
PW_ARGS=(--trace off tests/e2e/01-login.spec.ts tests/e2e/04-menu-page.spec.ts tests/e2e/05-shopping-list.spec.ts tests/e2e/public-policy-pages.spec.ts)

# 子プロセスへ持ち込む環境変数 (これ以外は外す。CI のランナーに無いものを持ち込まない)
readonly ENV_ALLOWLIST="PATH HOME USER LOGNAME SHELL TMPDIR TERM XDG_CACHE_HOME XDG_CONFIG_HOME DOCKER_HOST DOCKER_CONTEXT DOCKER_CONFIG PLAYWRIGHT_BROWSERS_PATH HTTP_PROXY HTTPS_PROXY NO_PROXY http_proxy https_proxy no_proxy SUPABASE_CLI SUPABASE_LOCAL_EXCLUDE SUPABASE_LOCAL_REALTIME_VERSION SUPABASE_LOCAL_RETRY_WAIT_UNIT"
# 段の中だけで追加で持ち込む変数名 (e2e のパスワード)
ENV_EXTRA=""

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
前提: Docker (integration / e2e)、Node は .nvmrc の major。詳しくは CONTRIBUTING.md の「ローカル CI」
USAGE
}

now() { date +%s; }

# サブシェルの中で呼ぶ: 環境変数を CI ランナー相当まで絞り、CI と同じ値を足す
ci_env() {
  local name
  for name in $(compgen -e); do
    case " $ENV_ALLOWLIST $ENV_EXTRA " in
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
stop_server() {
  [ -n "$SERVER_PID" ] || return 0
  local pids alive="" p
  pids="$SERVER_PID $(descendants "$SERVER_PID" | tr '\n' ' ')"
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

# integration / e2e の前に、使うポートが空いているかを確かめる (他のプロセスやコンテナは止めない)
check_ports() {
  local stage="$1" busy="" p
  for p in $APP_PORT $SUPABASE_PORTS; do
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
  ( ci_env && cd "$WT" && exec nohup npm run dev ) >"$log" 2>&1 &
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
  check_ports e2e || return 0
  check_docker e2e || return 0

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
  ( ci_env && cd "$WT" && exec nohup npm run start ) >"$log" 2>&1 &
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
  # yml が artifact に上げるのと同じもの (失敗時のスクリーンショット・動画・エラー内容) を残す
  if [ -d "$WT/tests/e2e/.output" ]; then
    cp -R "$WT/tests/e2e/.output" "$ART/e2e-output" 2>/dev/null || true
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
  local stage v p f s files exp secs note red=0 rows=0 mark md
  md="$ART/summary.md"

  printf '\n%-22s %-6s %8s %8s %8s %13s %6s  %s\n' stage result passed failed skipped files secs note
  while IFS=$'\t' read -r stage v p f s files exp secs note; do
    [ -n "$stage" ] || continue
    rows=$((rows + 1))
    [ "$v" = GREEN ] || red=1
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
  exit "$EXIT_RED"
}

CLEANED=0
cleanup() {
  [ "$CLEANED" = 1 ] && return 0
  CLEANED=1
  stop_server
  stop_supabase
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
mkdir -p "$ART" "$WORK_PARENT" || { say "作業場所を作れません: $ART / $WORK_PARENT"; exit "$EXIT_RED"; }
chmod 700 "$ART" 2>/dev/null || true
for s in $(echo "$ONLY" | tr ',' ' '); do rm -rf "$ART/$s"-*; done
RESULTS="$ART/results.tsv"
: >"$RESULTS"

trap cleanup EXIT
trap 'exit "$EXIT_SIGINT"' INT
trap 'exit "$EXIT_SIGTERM"' TERM

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
if want integration; then say "== integration (security-regression.yml)"; stage_integration; fi
if want e2e; then say "== e2e (e2e-local.yml)"; stage_e2e; fi

finish
