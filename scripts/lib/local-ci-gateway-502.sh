#!/usr/bin/env bash
# =====================================================================
# ローカル Supabase の入口 (Kong) のログから、502 を返した要求の数とその理由を数える (scripts/local-ci.sh が source する。#1779)
# =====================================================================
# 背景 (#1779): 結合テストの準備の INSERT・UPDATE・RPC・/pg/query が、Kong の 502 (An invalid response was received from the
# upstream server) で間欠的に落ちていた。原因は、Kong が使い回していた奥 (PostgREST) への接続を PostgREST が先に閉じ、
# その接続で送った POST・PATCH が「upstream prematurely closed connection」になること。scripts/supabase-local.sh が起動したあとに
# Kong の使い回しを止める (tune_kong_keepalive) ようにした。
# 再発の見張りとして、結合テストの段の終わりに Kong のログ (docker logs。access.log が標準出力・error.log が標準エラー) を読み、
# 502 の件数と、error.log の奥とのやりとりの失敗の文言ごとの件数を出す。テストが緑でも (準備のやり直しで救われていても) 数える。
#
# 使い方:
#   source scripts/lib/local-ci-gateway-502.sh
#   local_ci_gateway_502 <Kong のログ>
#     標準出力に「<502 の件数><TAB><理由の内訳>」の 1 行を出して真を返す。理由の内訳は、error.log の行のうち奥 (upstream) との
#     やりとりの失敗の文言を「<文言> × <件数>」で「 / 」区切りに並べたもの (件数の多い順。無ければ「なし」)。
#     ログのファイルが無ければ、何も出さずに偽を返す
#
# 数え方:
#   - 502: access.log の行 (`<client> - <user> [<時刻>] "<要求>" <状態> <バイト数> ...`) で、状態が 502 のもの。
#     要求の文字列 ("..." の中) に 502 が入っていても数えない (状態の欄だけを見る)
#   - 理由: nginx の error.log の行 (`... [error] <pid>#<tid>: *<接続> <文言>, client: ...`) で、文言に upstream を含むもの。
#     文言は「*<接続> 」の後ろから「, client:」の前まで。行ごとに違う値 (接続番号・時刻) は文言に入らない
# =====================================================================

# access.log の行の「"<要求>" <状態> 」の、状態の欄の 502 (Bad Gateway。Kong が奥から正しい応答を得られなかった)
readonly LCG_BAD_GATEWAY_PATTERN='^[^ ]+ - [^ ]+ \[[^]]+\] "[^"]*" 502 '
# error.log の、奥とのやりとりの失敗の行 (nginx のログの重さが error 以上で、文言に upstream を含む)
readonly LCG_UPSTREAM_ERROR_PATTERN='\[(error|crit|alert|emerg)\] [0-9]+#[0-9]+: \*[0-9]+ [^,]*upstream'
# 理由が 1 件も無いときの内訳
readonly LCG_NO_REASON='なし'

local_ci_gateway_502() {
  local log="$1" count reasons
  [ -f "$log" ] || return 1
  count="$(grep -cE "$LCG_BAD_GATEWAY_PATTERN" "$log" || true)"
  reasons="$(grep -E "$LCG_UPSTREAM_ERROR_PATTERN" "$log" \
    | sed -E 's/^.*: \*[0-9]+ //; s/, client: .*$//' \
    | sort | uniq -c | sort -k1,1nr -k2 \
    | awk '{ n = $1; sub(/^ *[0-9]+ /, ""); printf "%s%s × %d", (NR > 1 ? " / " : ""), $0, n }' || true)"
  printf '%s\t%s\n' "${count:-0}" "${reasons:-$LCG_NO_REASON}"
}

# 単体で実行したとき (bash scripts/lib/local-ci-gateway-502.sh <Kong のログ>) は local_ci_gateway_502 を呼ぶ (tests/local-ci-gateway-502.test.ts が使う)
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  set -u -o pipefail
  local_ci_gateway_502 "$@"
fi
