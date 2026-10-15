#!/usr/bin/env bash
# =====================================================================
# Supabase CLI のコマンドを、Docker イメージの取得の一過性の失敗に強くして打つ (#1523)
# =====================================================================
# CI の `supabase db diff --linked` (シャドウ DB のイメージを取る) のように、scripts/supabase-local.sh を通さずに CLI を打つ
# ところで使う。取得の失敗 (レート制限・時間切れ) のときだけ、取得元を public.ecr.aws → ghcr.io の順に替えてやり直し、
# どれでも失敗したら間を空けて次の周に入る。それ以外の失敗はやり直さず、そのままの終了コードで終わる。
# 最後まで取れなかったら「[image-pull-unavailable] <段の名前>: ...」の 1 行 (GitHub Actions では ::error の注記) を出し、
# SIP_EXIT_PULL_UNAVAILABLE (scripts/lib/supabase-image-pull.sh) で終わる。
#
# 使い方:
#   bash scripts/supabase-image-fallback.sh --step <段の名前> [--stdout <ファイル>] [--stderr <ファイル>] -- <コマンド> [引数...]
#     --step    取れなかったときの 1 行に載せる段の名前 (CI のステップ名)
#     --stdout  コマンドの stdout の書き先 (打つたびに書き直す)。無ければ画面
#     --stderr  コマンドの stderr の写し (最後に打った回のもの)。stderr は画面にも流す。無ければ一時ファイル (終わったら消す)
#
# 環境変数:
#   SUPABASE_IMAGE_PULL_WAIT_UNIT  どの取得元でも失敗した n 周目のあとに待つ秒の単位 (n 倍。既定: WAIT_UNIT_DEFAULT。0 以上の整数)
#   SUPABASE_IMAGE_REGISTRIES / SUPABASE_IMAGE_PULL_ROUNDS / SUPABASE_INTERNAL_IMAGE_REGISTRY  scripts/lib/supabase-image-pull.sh
# 運用の手順は docs/operations/ci-supabase-image-pull.md
# =====================================================================

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=lib/supabase-image-pull.sh
. "$ROOT/scripts/lib/supabase-image-pull.sh"

# 周のあとの待ちの単位秒の既定。以前の db diff のやり直し (deploy-supabase-migrations.yml の 60 秒・120 秒) と同じ長さにした
readonly WAIT_UNIT_DEFAULT=60
# 使い方の誤りの終了コード (supabase-local.sh の引数の誤りと同じ)
readonly EXIT_USAGE=2

usage() {
  awk 'NR > 1 && /^#/ { print; next } NR > 1 { exit }' "$0" >&2
  exit "$EXIT_USAGE"
}

step=""
out="-"
errlog=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --step) [ "$#" -ge 2 ] || usage; step="$2"; shift 2 ;;
    --stdout) [ "$#" -ge 2 ] || usage; out="$2"; shift 2 ;;
    --stderr) [ "$#" -ge 2 ] || usage; errlog="$2"; shift 2 ;;
    --) shift; break ;;
    *) usage ;;
  esac
done
if [ -z "$step" ] || [ "$#" -eq 0 ]; then
  usage
fi

sip_init "${SUPABASE_IMAGE_PULL_WAIT_UNIT:-$WAIT_UNIT_DEFAULT}" || exit "$EXIT_USAGE"

tmp_err=""
if [ -z "$errlog" ]; then
  tmp_err="$(mktemp "${TMPDIR:-/tmp}/supabase-image-fallback.XXXXXX")"
  errlog="$tmp_err"
fi
status=0
sip_run "$step" "$out" "$errlog" "" "$@" || status=$?
if [ -n "$tmp_err" ]; then
  rm -f "$tmp_err"
fi
exit "$status"
