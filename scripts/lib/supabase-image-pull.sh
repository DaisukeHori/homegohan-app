#!/usr/bin/env bash
# =====================================================================
# Supabase CLI の Docker イメージの取得の一過性の失敗に強くする (#1523)
# (scripts/supabase-local.sh と scripts/supabase-image-fallback.sh が source する)
# =====================================================================
# 背景: Supabase CLI はローカルのスタック (supabase start) と db diff のシャドウ DB のイメージを、既定で
# public.ecr.aws (Amazon ECR Public) から認証なしで取る。GitHub のランナーは IP を多くの利用者と共有しているため、
# ECR の認証なしの上限 (「toomanyrequests: Data limit exceeded」) に日中くり返し当たり、security-regression・e2e-local・
# Deploy Supabase Migrations の db diff が検査の中身と関係なく赤になっていた (2026-10-14〜15 に 3 回以上)。
#
# していること:
#   1. 取得元を切り替えてやり直す。CLI は環境変数 SUPABASE_INTERNAL_IMAGE_REGISTRY で取得元を替えられる
#      (CLI 2.62.10 の internal/utils/docker.go の GetRegistry / GetRegistryImageUrl。既定は public.ecr.aws。
#      docker.io 以外を指定すると <取得元>/supabase/<イメージ名>:<版> を取る)。Supabase は同じイメージを ghcr.io/supabase/ にも
#      置いている (2026-10-15 に、CLI 2.62.10 と supabase/.temp の版で使うイメージがすべて ghcr.io にあることを確かめた)。
#      既定の順は public.ecr.aws → ghcr.io (ローカルの機械に取得済みのイメージは public.ecr.aws の名前で残っているので、
#      先に public.ecr.aws を試せば取り直しにならない)
#   2. どの取得元でも失敗したら、間を空けて次の周に入る (n 周目のあとは 待ちの単位 × n 秒待つ)
#   3. それでも取れなかったら、検査の赤と区別できるよう「[image-pull-unavailable] <段の名前>: ...」の 1 行を出し
#      (GitHub Actions では ::error の注記にもする)、SIP_EXIT_PULL_UNAVAILABLE で終わる
#   取得以外の失敗 (migration が流せない・差分の計算に失敗した など) はやり直さず、そのままの終了コードを返す。
#
# 使い方 (呼ぶ側は set -o pipefail にしておく。stderr を画面とファイルに分ける pipe の終了コードを取るため):
#   source scripts/lib/supabase-image-pull.sh
#   sip_init <待ちの単位秒>     環境変数を読んで検査し、SIP_REGISTRIES (配列)・SIP_ROUNDS・SIP_WAIT_UNIT を決める。不正なら 2 を返す
#   sip_run <段の名前> <stdout の行き先 (- なら画面)> <stderr の写し> <同じ取得元でやり直す失敗の正規表現 (無ければ空)> <コマンド...>
#                              コマンドを取得元ごとに SUPABASE_INTERNAL_IMAGE_REGISTRY を付けて打ち、上の 1〜3 をする
#   sip_is_pull_error <ファイル>  ファイルが取得の一過性の失敗 (SIP_PULL_ERROR_PATTERN) を含めば真
#
# 環境変数:
#   SUPABASE_INTERNAL_IMAGE_REGISTRY  呼ぶ側が指定していれば、その取得元だけを使う (切り替えない)
#   SUPABASE_IMAGE_REGISTRIES         試す取得元 (空白区切り。既定: SIP_REGISTRIES_DEFAULT)
#   SUPABASE_IMAGE_PULL_ROUNDS        取得元を一巡する回数の上限 (既定: SIP_ROUNDS_DEFAULT。1 以上の整数)
# 運用の手順 (CI で上限に当たったときの扱い) は docs/operations/ci-supabase-image-pull.md
# =====================================================================

# 取得の一過性の失敗とみなすエラーの文言。CLI は取得の失敗をすべて「failed to pull docker image」で包む
# (internal/utils/docker.go の DockerImagePull)。toomanyrequests は ECR / Docker Hub の上限、残りは接続の時間切れ
readonly SIP_PULL_ERROR_PATTERN='toomanyrequests|failed to pull docker image|Client\.Timeout exceeded|context deadline exceeded|TLS handshake timeout'
# 既定の取得元の順。public.ecr.aws は CLI の既定 (ローカルの機械の取得済みのイメージもこの名前)、ghcr.io は Supabase の写し
readonly SIP_REGISTRIES_DEFAULT='public.ecr.aws ghcr.io'
# 既定の周回の上限。取得元が 2 つなら計 6 回打つ。CLI 自身も 1 回の取得の中で 2 回やり直す (4 秒・8 秒待つ)
readonly SIP_ROUNDS_DEFAULT=3
# 取れなかったときの終了コード。sysexits.h の EX_TEMPFAIL (一時的な失敗。あとでやり直せば通りうる) に合わせた。
# CI の yml はこの値で「取得できなかった」と「検査が落ちた」を分ける (source して名前で比べる)
readonly SIP_EXIT_PULL_UNAVAILABLE=75
# 取れなかったときの 1 行の先頭に付ける目印 (ログの検索と、検査の赤との区別に使う)
readonly SIP_UNAVAILABLE_TAG='[image-pull-unavailable]'
# 運用の手順書 (取れなかったときの 1 行に載せる)
readonly SIP_RUNBOOK='docs/operations/ci-supabase-image-pull.md'

sip_log() { echo "[supabase-image-pull] $*" >&2; }

sip_init() {
  local unit="$1" rounds reg
  if [ -n "${SUPABASE_INTERNAL_IMAGE_REGISTRY:-}" ]; then
    # 呼ぶ側が取得元を決めている (手で試すときなど)。それだけを使う
    SIP_REGISTRIES=("$SUPABASE_INTERNAL_IMAGE_REGISTRY")
  else
    # 空白で区切る (read -a はパス名の展開をしないので、* などがファイル名に化けない)
    read -r -a SIP_REGISTRIES <<< "${SUPABASE_IMAGE_REGISTRIES:-$SIP_REGISTRIES_DEFAULT}"
  fi
  if [ "${#SIP_REGISTRIES[@]}" -eq 0 ]; then
    sip_log "SUPABASE_IMAGE_REGISTRIES に取得元が 1 つもありません"
    return 2
  fi
  for reg in "${SIP_REGISTRIES[@]}"; do
    if ! [[ "$reg" =~ ^[A-Za-z0-9.-]+(:[0-9]+)?(/[A-Za-z0-9._-]+)*$ ]]; then
      sip_log "取得元の形が正しくありません (ホスト名[:ポート][/パス]): $reg"
      return 2
    fi
  done
  rounds="${SUPABASE_IMAGE_PULL_ROUNDS:-$SIP_ROUNDS_DEFAULT}"
  if ! [[ "$rounds" =~ ^[0-9]+$ ]] || [ "$((10#$rounds))" -lt 1 ]; then
    sip_log "SUPABASE_IMAGE_PULL_ROUNDS は 1 以上の整数にしてください: $rounds"
    return 2
  fi
  if ! [[ "$unit" =~ ^[0-9]+$ ]]; then
    sip_log "待ちの単位秒は 0 以上の整数にしてください: $unit"
    return 2
  fi
  SIP_ROUNDS="$((10#$rounds))"
  SIP_WAIT_UNIT="$((10#$unit))"
}

sip_is_pull_error() {
  grep -qE "$SIP_PULL_ERROR_PATTERN" "$1"
}

# 取れなかったことを、検査の赤と区別できる形で出す。<段の名前> <stderr の写し> <打った回数>
sip_report_unavailable() {
  local step="$1" errlog="$2" attempts="$3" reason msg
  reason="$(grep -E "$SIP_PULL_ERROR_PATTERN" "$errlog" | tail -n 1 || true)"
  msg="$SIP_UNAVAILABLE_TAG $step: Supabase の Docker イメージを取得できませんでした (取得元 ${SIP_REGISTRIES[*]} を最大 $SIP_ROUNDS 周・計 $attempts 回)。レート制限などの一過性の理由で、検査の結果ではありません。扱いは $SIP_RUNBOOK"
  echo "$msg" >&2
  echo "$SIP_UNAVAILABLE_TAG 最後のエラー: $reason" >&2
  if [ "${GITHUB_ACTIONS:-}" = "true" ]; then
    echo "::error title=$step: イメージを取得できない (検査の赤ではない)::$msg" >&2
  fi
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    {
      echo "## $step: Supabase の Docker イメージを取得できませんでした (検査の赤ではない)"
      echo ""
      echo "$msg"
      echo ""
      echo '```'
      echo "$reason"
      echo '```'
    } >> "$GITHUB_STEP_SUMMARY"
  fi
}

sip_run() {
  local step="$1" out="$2" errlog="$3" same_pattern="$4"
  shift 4
  local n="${#SIP_REGISTRIES[@]}" max attempt=1 idx=0 status reg next secs
  max=$((SIP_ROUNDS * n))
  while :; do
    reg="${SIP_REGISTRIES[$((idx % n))]}"
    status=0
    # stderr だけを画面に流しつつ errlog にも残して判定する (CLI のエラーは stderr に出る)。stdout は out へ (毎回書き直す)
    if [ "$out" = "-" ]; then
      { SUPABASE_INTERNAL_IMAGE_REGISTRY="$reg" "$@" 2>&1 1>&3 | tee "$errlog" >&2; } 3>&1 || status=$?
    else
      { SUPABASE_INTERNAL_IMAGE_REGISTRY="$reg" "$@" 2>&1 1>&3 | tee "$errlog" >&2; } 3>"$out" || status=$?
    fi
    if [ "$status" -eq 0 ]; then
      return 0
    fi
    if [ "$attempt" -ge "$max" ]; then
      break
    fi
    if sip_is_pull_error "$errlog"; then
      idx=$((idx + 1))
      next="${SIP_REGISTRIES[$((idx % n))]}"
      if [ $((idx % n)) -eq 0 ]; then
        # どの取得元でも失敗した。間を空けて次の周に入る
        secs=$(((idx / n) * SIP_WAIT_UNIT))
        sip_log "$step: どの取得元 (${SIP_REGISTRIES[*]}) でもイメージを取得できなかったため、$secs 秒待って $next からやり直します ($attempt / $max 回目)"
        sleep "$secs"
      else
        sip_log "$step: $reg からイメージを取得できなかったため、取得元を $next に替えてやり直します ($attempt / $max 回目)"
      fi
    elif [ -n "$same_pattern" ] && grep -qE "$same_pattern" "$errlog"; then
      secs=$((attempt * SIP_WAIT_UNIT))
      sip_log "$step: 一過性のエラーで失敗したため、$secs 秒待って同じ取得元 ($reg) でやり直します ($attempt / $max 回目)"
      sleep "$secs"
    else
      return "$status"
    fi
    attempt=$((attempt + 1))
  done
  if sip_is_pull_error "$errlog"; then
    sip_report_unavailable "$step" "$errlog" "$attempt"
    return "$SIP_EXIT_PULL_UNAVAILABLE"
  fi
  return "$status"
}
