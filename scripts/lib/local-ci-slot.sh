#!/usr/bin/env bash
# =====================================================================
# ローカル CI の「枠 (slot)」ごとの値を決める (scripts/local-ci.sh と scripts/supabase-local.sh が source する)
# =====================================================================
# 同じ機械で local-ci.sh を同時に複数回すため、ローカル Supabase と Next のポート・コンテナ名を枠ごとにずらす。
#   - 枠 0 は今までと同じ値 (CI の .github/workflows/* は枠を指定しないので枠 0 になる。生成物も変えない)
#   - 枠 n (1 以上) は、Supabase のポートを n × LCS_SUPABASE_PORT_STRIDE、Next のポートを n × LCS_NEXT_PORT_STRIDE ずらし、
#     project_id (コンテナ・ボリューム・ネットワークの名前の元) に -s<n> を付ける
#
# 使い方:
#   source scripts/lib/local-ci-slot.sh
#   local_ci_slot_valid <枠>      0 から LCS_SLOT_MAX までの整数なら真
#   local_ci_slot_apply <枠>      SLOT_* の変数 (下の LCS_SLOT_VARS) を決める
#   local_ci_slot_work_dir <枠>   scripts/supabase-local.sh の作業ディレクトリ (リポジトリの直下からの相対パス) を出す
#   bash scripts/lib/local-ci-slot.sh <枠>   SLOT_*=値 を 1 行ずつ出す (tests/local-ci-slot.test.ts が値の表を検査する)
# =====================================================================

# 枠の番号の上限。Supabase のポートは 54329 + 上限 × 刻み が 65535 を超えないこと (tests/local-ci-slot.test.ts が検査する)。
# 1 枠でローカル Supabase 一式 (Docker のメモリ約 1 GiB) を使うので、実際に同時に回せる数はメモリで決まる (CONTRIBUTING.md)
readonly LCS_SLOT_MAX=9
# 枠ごとに Supabase のポートをずらす幅。CLI の既定は 54320〜54329 の 10 個 (+ 8083) なので、100 ずつずらせば枠どうしが重ならない
readonly LCS_SUPABASE_PORT_STRIDE=100
# 枠ごとに Next のポートをずらす幅。1 枠で 3 つ (既定 / 同意の強制あり / お知らせあり) 使うので、10 ずつずらす
readonly LCS_NEXT_PORT_STRIDE=10

# 枠 0 の project_id (scripts/supabase-local.sh が今まで使ってきた名前)
readonly LCS_PROJECT_ID_BASE="homegohan-local"
# 枠 0 の scripts/supabase-local.sh の作業ディレクトリ (今まで使ってきた場所。枠 n は <これ>-s<n>)
readonly LCS_WORK_DIR_BASE=".supabase-local"

# Supabase CLI 2.62.10 の既定のポート (`npx supabase@2.62.10 init` が生成する config.toml の値と、生成する config.toml には
# 書かれない既定 ([analytics] vector_port))。CLI のポートの設定は、CLI の本体の設定の型の toml タグ
# (port / shadow_port / smtp_port / pop3_port / inspector_port / vector_port) をすべて拾って列挙した。版を上げるときは同じ方法で数え直す。
# supabase/config.toml はポートを指定していないので、枠 0 ではこの値のまま CLI に任せる
readonly LCS_API_PORT_BASE=54321              # [api] port (Kong。REST / Auth / Storage の入口)
readonly LCS_DB_PORT_BASE=54322               # [db] port
readonly LCS_SHADOW_PORT_BASE=54320           # [db] shadow_port (db diff などの作業用 DB)
readonly LCS_STUDIO_PORT_BASE=54323           # [studio] port
readonly LCS_INBUCKET_PORT_BASE=54324         # [inbucket] port (メールの受信箱の画面)
readonly LCS_INBUCKET_SMTP_PORT_BASE=54325    # [inbucket] smtp_port (既定では公開しない。枠 1 以上では明示する)
readonly LCS_INBUCKET_POP3_PORT_BASE=54326    # [inbucket] pop3_port (既定では公開しない。枠 1 以上では明示する)
readonly LCS_ANALYTICS_PORT_BASE=54327        # [analytics] port (logflare)
readonly LCS_VECTOR_PORT_BASE=54328           # [analytics] vector_port (vector。analytics がコンテナのログを受ける口をホストに開く)
readonly LCS_POOLER_PORT_BASE=54329           # [db.pooler] port
readonly LCS_INSPECTOR_PORT_BASE=8083         # [edge_runtime] inspector_port (functions serve --inspect のときだけ開く)
# 上の 54xxx のポートが収まる範囲 (54320〜54329。10 個すべてが上のどれかのポート)。枠 0 では今までの local-ci.sh と同じく、この 10 個が空いているかを確かめる
readonly LCS_SUPABASE_PORT_BLOCK_START=54320
readonly LCS_SUPABASE_PORT_BLOCK_SIZE=10

# Next のポート (scripts/local-ci.sh の 3 つのサーバー。CI の yml と同じ値)
readonly LCS_APP_PORT_BASE=3000               # 既定のサーバー (integration の next dev / e2e の next start)
readonly LCS_ENFORCED_APP_PORT_BASE=3001      # e2e の 2 つ目 (LEGAL_CONSENT_ENFORCE=on)
readonly LCS_NOTICE_APP_PORT_BASE=3002        # e2e の 3 つ目 (LEGAL_CONSENT_NOTICE=on)

# local_ci_slot_apply が決める変数 (この順で出力する)
readonly LCS_SLOT_VARS="SLOT_PROJECT_ID SLOT_API_PORT SLOT_DB_PORT SLOT_SHADOW_PORT SLOT_STUDIO_PORT SLOT_INBUCKET_PORT SLOT_INBUCKET_SMTP_PORT SLOT_INBUCKET_POP3_PORT SLOT_ANALYTICS_PORT SLOT_VECTOR_PORT SLOT_POOLER_PORT SLOT_INSPECTOR_PORT SLOT_SUPABASE_PORTS SLOT_APP_PORT SLOT_ENFORCED_APP_PORT SLOT_NOTICE_APP_PORT"

local_ci_slot_valid() {
  [[ "${1:-}" =~ ^[0-9]+$ ]] && [ "$((10#$1))" -le "$LCS_SLOT_MAX" ]
}

local_ci_slot_apply() {
  local slot="$((10#$1))"
  local sp="$((slot * LCS_SUPABASE_PORT_STRIDE))" np="$((slot * LCS_NEXT_PORT_STRIDE))"
  if [ "$slot" -eq 0 ]; then
    SLOT_PROJECT_ID="$LCS_PROJECT_ID_BASE"
  else
    SLOT_PROJECT_ID="$LCS_PROJECT_ID_BASE-s$slot"
  fi
  SLOT_API_PORT="$((LCS_API_PORT_BASE + sp))"
  SLOT_DB_PORT="$((LCS_DB_PORT_BASE + sp))"
  SLOT_SHADOW_PORT="$((LCS_SHADOW_PORT_BASE + sp))"
  SLOT_STUDIO_PORT="$((LCS_STUDIO_PORT_BASE + sp))"
  SLOT_INBUCKET_PORT="$((LCS_INBUCKET_PORT_BASE + sp))"
  SLOT_INBUCKET_SMTP_PORT="$((LCS_INBUCKET_SMTP_PORT_BASE + sp))"
  SLOT_INBUCKET_POP3_PORT="$((LCS_INBUCKET_POP3_PORT_BASE + sp))"
  SLOT_ANALYTICS_PORT="$((LCS_ANALYTICS_PORT_BASE + sp))"
  SLOT_VECTOR_PORT="$((LCS_VECTOR_PORT_BASE + sp))"
  SLOT_POOLER_PORT="$((LCS_POOLER_PORT_BASE + sp))"
  SLOT_INSPECTOR_PORT="$((LCS_INSPECTOR_PORT_BASE + sp))"
  # 空いていることを確かめる Supabase のポート (local-ci.sh の check_ports)。54xxx の範囲をまるごと確かめる。
  # inspector_port は supabase start では開かない (functions serve --inspect のときだけ) ので入れない
  local p ports=""
  for ((p = LCS_SUPABASE_PORT_BLOCK_START + sp; p < LCS_SUPABASE_PORT_BLOCK_START + sp + LCS_SUPABASE_PORT_BLOCK_SIZE; p++)); do
    ports="$ports${ports:+ }$p"
  done
  SLOT_SUPABASE_PORTS="$ports"
  SLOT_APP_PORT="$((LCS_APP_PORT_BASE + np))"
  SLOT_ENFORCED_APP_PORT="$((LCS_ENFORCED_APP_PORT_BASE + np))"
  SLOT_NOTICE_APP_PORT="$((LCS_NOTICE_APP_PORT_BASE + np))"
}

# scripts/supabase-local.sh の作業ディレクトリ (リポジトリの直下からの相対パス)。枠 0 は今までと同じ .supabase-local、
# 枠 n は .supabase-local-s<n> (枠ごとに分ける理由は scripts/supabase-local.sh)。
# scripts/baseline/drift_report.sh も、枠の結果の既定の置き場をここに作る
local_ci_slot_work_dir() {
  local slot="$((10#$1))"
  if [ "$slot" -eq 0 ]; then
    echo "$LCS_WORK_DIR_BASE"
  else
    echo "$LCS_WORK_DIR_BASE-s$slot"
  fi
}

# 直接実行したとき: 枠の値を SLOT_*=値 で出す
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  set -eu
  if ! local_ci_slot_valid "${1:-}"; then
    echo "使い方: bash scripts/lib/local-ci-slot.sh <枠 (0〜$LCS_SLOT_MAX)>" >&2
    exit 2
  fi
  local_ci_slot_apply "$1"
  for name in $LCS_SLOT_VARS; do
    printf '%s=%s\n' "$name" "${!name}"
  done
fi
