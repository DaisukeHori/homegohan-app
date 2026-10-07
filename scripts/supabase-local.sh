#!/usr/bin/env bash
# =====================================================================
# ローカル Supabase をベースライン方式で起動する (#1116 / #1243)
# =====================================================================
# supabase/migrations は空 DB から再生できない (基盤テーブルが migration 外で作られた
# 経緯のため。#1116)。そこでローカル / CI では次の順で DB を組み立てる:
#
#   1) supabase/baseline/ の本番スキーマ (読み取り専用で取得した snapshot) を最初に適用
#   2) ベースライン取得時点の本番台帳の最大 version より新しい migration だけを続けて適用
#
# 専用の作業ディレクトリ .supabase-local/ (git 管理外) を毎回組み立てて supabase CLI を動かす。
# リポジトリの supabase/ と本番の migration 台帳には一切手を加えない。本番には接続しない。
#
# 使い方:
#   bash scripts/supabase-local.sh start          起動 (初回はイメージ取得で数分)
#   bash scripts/supabase-local.sh reset          ベースライン + 新規 migration を適用し直す (= db reset)
#   bash scripts/supabase-local.sh stop           停止 (データは破棄)
#   bash scripts/supabase-local.sh status         接続情報を表示
#   bash scripts/supabase-local.sh env [FILE]     アプリ / テスト用の環境変数を出力 (FILE 指定時はそこへ書く)
#   bash scripts/supabase-local.sh migrations     適用対象の migration 一覧を表示
#   bash scripts/supabase-local.sh verify         ベースライン単体が本番カタログと一致するか確認
#                                                 (ベースライン更新時に使う。終了後は reset で戻す)
#
# 環境変数:
#   SUPABASE_CLI                     supabase CLI の呼び出し方 (既定: npx --yes supabase@2.62.10)
#   SUPABASE_LOCAL_EXCLUDE           supabase start -x に渡すサービス
#                                    (既定: studio,imgproxy,logflare,vector,edge-runtime)
#   SUPABASE_LOCAL_REALTIME_VERSION  Realtime イメージの版を固定する (既定: IPv6 が無効な環境のみ v2.83.1)
#   SUPABASE_LOCAL_RETRY_WAIT_UNIT   start を一過性のエラーでやり直すときの待ち時間の単位秒 (既定: 30。n 回目は n 倍)
#
# IPv6 について: Claude Code Cloud の VM はカーネルで IPv6 が無効 (ipv6.disable=1)。
# CLI 2.62.10 既定の Realtime v2.65.3 は IPv6 での待ち受けがハードコードされており起動に失敗する。
# v2.83.1 以降は IPv6 が使えないとき IPv4 にフォールバックするため、その環境でのみ版を固定する。
# =====================================================================

set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
WORK="$ROOT/.supabase-local"
BASELINE_DIR="$ROOT/supabase/baseline"
CLI_VERSION="2.62.10"
if [ -z "${SUPABASE_CLI:-}" ]; then
  # 同じ版の supabase が入っていればそれを使い、無ければ CI と同じく npx で実行する
  # (CLI は実行ディレクトリの supabase/.temp/cli-latest を書き換えるため、リポジトリ外で版を確認する)
  if command -v supabase >/dev/null 2>&1 && [ "$(cd /tmp && supabase --version 2>/dev/null)" = "$CLI_VERSION" ]; then
    SUPABASE_CLI="supabase"
  else
    SUPABASE_CLI="npx --yes supabase@$CLI_VERSION"
  fi
fi
SUPABASE_LOCAL_EXCLUDE="${SUPABASE_LOCAL_EXCLUDE-studio,imgproxy,logflare,vector,edge-runtime}"

log() { echo "[supabase-local] $*" >&2; }

cli() {
  # shellcheck disable=SC2086
  $SUPABASE_CLI "$@" --workdir "$WORK"
}

baseline_version() {
  python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["ledger_max_version"])' \
    "$BASELINE_DIR/manifest.json"
}

ensure_docker() {
  if docker info >/dev/null 2>&1; then
    return
  fi
  # Claude Code Cloud ではセッションごとに dockerd を起動する必要がある
  if [ "$(id -u)" = "0" ] && command -v dockerd >/dev/null 2>&1; then
    log "dockerd を起動します"
    setsid nohup dockerd >/tmp/dockerd.log 2>&1 </dev/null &
    for _ in $(seq 1 60); do
      docker info >/dev/null 2>&1 && return
      sleep 1
    done
  fi
  log "Docker デーモンに接続できません (dockerd のログ: /tmp/dockerd.log)"
  exit 1
}

# 作業ディレクトリ .supabase-local/supabase を組み立てる
prepare() {
  local version
  version="$(baseline_version)"
  if ! [[ "$version" =~ ^[0-9]{14}$ ]]; then
    log "supabase/baseline/manifest.json の ledger_max_version が不正です: $version"
    exit 1
  fi

  rm -rf "$WORK/supabase/migrations"
  mkdir -p "$WORK/supabase/migrations" "$WORK/supabase/.temp"

  # config.toml: リポジトリのものに project_id とローカル専用の設定を足す
  {
    echo '# scripts/supabase-local.sh が生成 (編集しない)'
    echo 'project_id = "homegohan-local"'
    echo
    cat "$ROOT/supabase/config.toml"
    echo
    echo '# ローカル専用: テストで多数のユーザーがサインインするため認証のレート制限を緩める'
    echo '[auth.rate_limit]'
    echo 'sign_in_sign_ups = 1000'
    echo 'token_refresh = 1000'
    echo 'token_verifications = 1000'
  } > "$WORK/supabase/config.toml"

  # イメージの版は本番に合わせたもの (supabase/.temp/*-version) を使う。
  # project-ref / pooler-url はコピーしない (ローカルを本番に紐付けない)
  rm -f "$WORK/supabase/.temp/"*
  for f in postgres-version gotrue-version rest-version storage-version storage-migration; do
    if [ -f "$ROOT/supabase/.temp/$f" ]; then
      cp "$ROOT/supabase/.temp/$f" "$WORK/supabase/.temp/$f"
    fi
  done
  local realtime_version="${SUPABASE_LOCAL_REALTIME_VERSION:-}"
  if [ -z "$realtime_version" ] && [ ! -e /proc/net/if_inet6 ]; then
    realtime_version="v2.83.1"
  fi
  if [ -n "$realtime_version" ]; then
    echo "$realtime_version" > "$WORK/supabase/.temp/realtime-version"
    log "Realtime の版を $realtime_version に固定します (IPv6 非対応環境向け)"
  fi

  # Edge Functions はリポジトリのものを参照する
  ln -sfn "$ROOT/supabase/functions" "$WORK/supabase/functions"

  # 1) ベースライン: 本番スキーマ → 関数の EXECUTE 権限 → テーブルの権限 → storage 設定 → マスタデータ。
  #    pg_dump 由来の SET (search_path='' 等) が後続 migration のセッションに残らないよう最後に RESET ALL
  local baseline_file="$WORK/supabase/migrations/${version}_prod_baseline.sql"
  {
    echo "-- supabase/baseline から scripts/supabase-local.sh が生成したベースライン (本番 snapshot)"
    echo "-- 本番台帳の最大 version $version までを含む。このファイルを編集しないこと。"
    for part in prod_schema.sql prod_function_acl.sql prod_table_acl.sql prod_storage.sql prod_reference_data.sql; do
      if [ -f "$BASELINE_DIR/$part" ]; then
        echo
        echo "-- ===== $part ====="
        cat "$BASELINE_DIR/$part"
      fi
    done
    echo
    echo "RESET ALL;"
  } > "$baseline_file"

  # 2) 本番台帳より新しい migration (= まだ本番に無いもの) だけを続けて適用する
  #    (verify はベースライン単体を検証するため SUPABASE_LOCAL_BASELINE_ONLY=1 で省く)
  local count=0 name v
  if [ "${SUPABASE_LOCAL_BASELINE_ONLY:-0}" = "1" ]; then
    log "ベースライン ($version) のみを適用対象にしました (新規 migration は適用しない)"
    return
  fi
  for path in "$ROOT"/supabase/migrations/*.sql; do
    name="$(basename "$path")"
    v="${name%%_*}"
    if [[ "$v" =~ ^[0-9]{14}$ ]] && [[ "$v" > "$version" ]]; then
      cp "$path" "$WORK/supabase/migrations/$name"
      count=$((count + 1))
    fi
  done
  log "ベースライン ($version) + 新規 migration $count 本を適用対象にしました"
}

cmd_start() {
  ensure_docker
  prepare
  local args=()
  if [ -n "$SUPABASE_LOCAL_EXCLUDE" ]; then
    args+=(-x "$SUPABASE_LOCAL_EXCLUDE")
  fi
  # 次の一過性の失敗に限り、間隔を空けて最大 3 回まで起動をやり直す (それ以外のエラーは再実行しない)。
  #   - イメージの取得に失敗する ("failed to pull docker image")。public.ecr.aws は未認証の pull が
  #     1 秒あたり 1 回までのため、CI で複数のジョブが同時に取得するとレート制限 ("toomanyrequests")
  #     や接続のタイムアウトになる
  #   - Docker デーモンの再起動直後で、自動再起動中のコンテナがまだ準備できていない ("is not ready")
  # CLI のエラーは stderr に出るため、stderr だけを画面に流しつつファイルにも残して判定する。
  local err status attempt
  err="$(mktemp)"
  for attempt in 1 2 3; do
    status=0
    { cli start "${args[@]}" 2>&1 1>&3 | tee "$err" >&2; } 3>&1 || status=$?
    if [ "$status" -eq 0 ]; then
      break
    fi
    if [ "$attempt" -eq 3 ] || ! grep -qE 'failed to pull docker image|toomanyrequests|is not ready' "$err"; then
      break
    fi
    log "一過性のエラーで supabase start が失敗したため、$((attempt * ${SUPABASE_LOCAL_RETRY_WAIT_UNIT:-30})) 秒待ってやり直します"
    sleep $((attempt * ${SUPABASE_LOCAL_RETRY_WAIT_UNIT:-30}))
  done
  rm -f "$err"
  return "$status"
}

cmd_reset() {
  ensure_docker
  prepare
  db_reset_with_retry
}

db_reset_with_retry() {
  # db reset は最後にコンテナを再起動し、Kong 経由で Storage API (バケット一覧) を呼ぶ。
  # Storage の起動が間に合わないと Kong が 502 等を返し、DB への適用は終わっているのに
  # 非ゼロで終了する。このときに限り 1 回だけやり直す (migration の失敗などは再実行しない)。
  # CLI のエラーは stderr に出るため、stderr だけを画面に流しつつファイルにも残して判定する。
  local err status attempt
  err="$(mktemp)"
  for attempt in 1 2; do
    status=0
    { cli db reset 2>&1 1>&3 | tee "$err" >&2; } 3>&1 || status=$?
    if [ "$status" -eq 0 ]; then
      break
    fi
    if [ "$attempt" -eq 2 ] || ! grep -qE 'Error status 50[234]' "$err"; then
      break
    fi
    log "Storage の再起動待ちで db reset が失敗したため、もう一度実行します"
    sleep 5
  done
  rm -f "$err"
  return "$status"
}

cmd_stop() {
  if [ -d "$WORK/supabase" ]; then
    cli stop --no-backup
  fi
}

cmd_status() {
  cli status
}

# アプリ (.env.local) / integration テストが読む変数名で出力する
cmd_env() {
  local out="${1:-}"
  local status_env
  status_env="$(cli status -o env 2>/dev/null)"
  get() { printf '%s\n' "$status_env" | sed -n "s/^$1=\"\{0,1\}\([^\"]*\)\"\{0,1\}$/\1/p" | head -n1; }
  local api anon service jwt db
  api="$(get API_URL)"
  anon="$(get ANON_KEY)"
  service="$(get SERVICE_ROLE_KEY)"
  jwt="$(get JWT_SECRET)"
  db="$(get DB_URL)"
  if [ -z "$api" ] || [ -z "$anon" ] || [ -z "$service" ]; then
    log "ローカル Supabase の接続情報を取得できません (起動していますか?)"
    exit 1
  fi
  local body
  body="$(cat <<ENVFILE
NEXT_PUBLIC_SUPABASE_URL=$api
SUPABASE_URL=$api
NEXT_PUBLIC_SUPABASE_ANON_KEY=$anon
SUPABASE_ANON_KEY=$anon
SUPABASE_SERVICE_ROLE_KEY=$service
SUPABASE_JWT_SECRET=$jwt
SUPABASE_DB_URL=$db
SUPABASE_INTEGRATION_TEST=1
ENVFILE
)"
  if [ -n "$out" ]; then
    if [ -f "$out" ] && [ "$out" != "${GITHUB_ENV:-}" ]; then
      cp "$out" "$out.bak.$(date +%s)"
    fi
    if [ "$out" = "${GITHUB_ENV:-}" ]; then
      printf '%s\n' "$body" >> "$out"
    else
      { echo "# scripts/supabase-local.sh env が生成 (ローカル Supabase 向け)"; printf '%s\n' "$body"; } > "$out"
    fi
    log "環境変数を $out に書き出しました"
  else
    printf '%s\n' "$body"
  fi
}

cmd_migrations() {
  prepare
  ls -1 "$WORK/supabase/migrations"
}

# ベースラインだけを適用した DB を作り、本番カタログ (supabase/baseline/catalog) と一致するか確認する。
# ベースラインを取り直したときに使う。終了後は `reset` で新規 migration を含む状態に戻すこと。
cmd_verify() {
  ensure_docker
  SUPABASE_LOCAL_BASELINE_ONLY=1 prepare
  if ! cli status >/dev/null 2>&1; then
    local args=()
    if [ -n "$SUPABASE_LOCAL_EXCLUDE" ]; then
      args+=(-x "$SUPABASE_LOCAL_EXCLUDE")
    fi
    cli start "${args[@]}"
  else
    db_reset_with_retry
  fi
  local db_url out
  db_url="$(cli status -o env 2>/dev/null | sed -n 's/^DB_URL="\{0,1\}\([^"]*\)"\{0,1\}$/\1/p')"
  out="$(mktemp -d)"
  docker run --rm --network host --user "$(id -u):$(id -g)" -e HOME=/tmp \
    -v "$out:/out" -v "$ROOT/scripts/baseline:/q:ro" -w /out \
    "public.ecr.aws/supabase/postgres:$(cat "$ROOT/supabase/.temp/postgres-version")" \
    psql "$db_url?sslmode=disable" -X -q -f /q/snapshot_catalog.sql
  python3 "$ROOT/scripts/baseline/verify_baseline.py" "$BASELINE_DIR/catalog" "$out"
}

case "${1:-}" in
  start) cmd_start ;;
  reset) cmd_reset ;;
  stop) cmd_stop ;;
  status) cmd_status ;;
  env) cmd_env "${2:-}" ;;
  migrations) cmd_migrations ;;
  verify) cmd_verify ;;
  *)
    awk 'NR > 1 && /^#/ { print; next } NR > 1 { exit }' "$0"
    exit 1
    ;;
esac
