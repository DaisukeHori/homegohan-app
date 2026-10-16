#!/usr/bin/env bash
# =====================================================================
# 結合テストの next dev が「ページを返せる」状態かを、テストを流す前に確かめる (scripts/local-ci.sh が source する。#1792)
# =====================================================================
# 背景 (#1792): Turbopack の next dev で src/app/layout.tsx の next/font/google の解決に失敗すると、dev サーバは応答はするが
# すべてのリクエストに 500 を返す。/login が応答するまで待つだけ (wait_app) では見分けられず、結合テストが数百件の赤になって
# 原因 (next dev のログの冒頭のフォントの解決の失敗) が見えなかった。
# そこで、/login の HTTP のステータスを見て、500 以上 (または応答なし) しか返らなければ「dev サーバの起動の失敗」として止め、
# next dev のログの冒頭を別のファイルに書き出して、原因が分かる形にする。
#
# 使い方:
#   source scripts/lib/local-ci-dev-ready.sh
#   local_ci_dev_ready <URL> <確かめる回数> <間隔 (秒)> <1 回の問い合わせの上限 (秒)> <冒頭の行数> <サーバーのログ> <冒頭の書き出し先>
#     /login などの URL に問い合わせ、ステータスが「ページを返せる」範囲 (LDR_HTTP_STATUS_MIN 以上・LDR_HTTP_SERVER_ERROR_MIN 未満) なら
#     そのステータスを標準出力に出して真を返す。<確かめる回数> 回問い合わせても範囲に入らなければ、サーバーのログの冒頭
#     <冒頭の行数> 行を <冒頭の書き出し先> に書き、最後のステータス (応答なしは curl の 000) を標準出力に出して偽を返す。
#     問い合わせのあいだだけ <間隔> 秒待つ (最後の問い合わせの後は待たない)。
#   local_ci_dev_ready_status_ok <ステータス>
#     ステータスが「ページを返せる」範囲なら真 (数でないもの・000 は偽)
# =====================================================================

# HTTP のステータスの下限 (curl は応答が無いとき 000 を出す。100 未満はステータスでない)
readonly LDR_HTTP_STATUS_MIN=100
# サーバーの誤り (5xx) の下限。これ以上は「ページを返せていない」とみなす (#1792 では全応答が 500)
readonly LDR_HTTP_SERVER_ERROR_MIN=500

local_ci_dev_ready_status_ok() {
  local code="$1"
  [[ "$code" =~ ^[0-9]+$ ]] || return 1
  code=$((10#$code))
  [ "$code" -ge "$LDR_HTTP_STATUS_MIN" ] && [ "$code" -lt "$LDR_HTTP_SERVER_ERROR_MIN" ]
}

local_ci_dev_ready() {
  local url="$1" tries="$2" interval="$3" max_time="$4" head_lines="$5" server_log="$6" head_out="$7" code="000" i
  for ((i = 1; i <= tries; i++)); do
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time "$max_time" "$url" 2>/dev/null) || true
    if local_ci_dev_ready_status_ok "$code"; then
      printf '%s\n' "$code"
      return 0
    fi
    if [ "$i" -lt "$tries" ]; then sleep "$interval"; fi
  done
  if [ -f "$server_log" ]; then
    head -n "$head_lines" "$server_log" >"$head_out"
  else
    printf '(サーバーのログ %s が無い)\n' "$server_log" >"$head_out"
  fi
  printf '%s\n' "${code:-000}"
  return 1
}

# 単体で実行したとき (bash scripts/lib/local-ci-dev-ready.sh <引数...>) は local_ci_dev_ready を呼ぶ (tests/local-ci-dev-server-ready.test.ts が使う)
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  set -u -o pipefail
  local_ci_dev_ready "$@"
fi
