#!/usr/bin/env bash
# =====================================================================
# ローカル Supabase をベースライン方式で起動する (#1116 / #1243)
# =====================================================================
# ローカル / CI では次の順で DB を組み立てる (本番スキーマのスナップショットを起点にする。
# supabase/migrations も #1116 で空 DB から流し直せるようになったが、こちらの方が速く、
# verify (ベースラインと本番カタログの比較) にも使う):
#
#   1) supabase/baseline/ の本番スキーマ (読み取り専用で取得した snapshot) を最初に適用
#   2) ベースライン取得時点の本番台帳の最大 version より新しい migration だけを続けて適用
#
# 専用の作業ディレクトリ .supabase-local/ (git 管理外。枠 n (LOCAL_CI_SLOT が 1 以上) は .supabase-local-s<n>/) を毎回組み立てて
# supabase CLI を動かす。
# リポジトリの supabase/ と本番の migration 台帳には一切手を加えない。本番には接続しない。
#
# 使い方:
#   bash scripts/supabase-local.sh start          起動 (初回はイメージ取得で数分)
#   bash scripts/supabase-local.sh reset          ベースライン + 新規 migration を適用し直す (= db reset)
#   bash scripts/supabase-local.sh stop           停止 (データは破棄。LOCAL_CI_SLOT の枠の作業ディレクトリのスタックだけ)
#   bash scripts/supabase-local.sh status         接続情報を表示
#   bash scripts/supabase-local.sh env [FILE]     アプリ / テスト用の環境変数を出力 (FILE 指定時はそこへ書く)
#   bash scripts/supabase-local.sh migrations     適用対象の migration 一覧を表示
#   bash scripts/supabase-local.sh verify         ベースライン単体が本番カタログと一致するか確認
#                                                 (ベースライン更新時に使う。終了後は reset で戻す)
#   bash scripts/supabase-local.sh stop-leftover  枠 (LOCAL_CI_SLOT。1 以上) の project_id のコンテナ・ボリュームを止めて消す
#                                                 (作業ディレクトリを組み立て直してから止めるので、どのチェックアウトからでも打てる。
#                                                 scripts/local-ci.sh が、持ち主の死んだ枠のロックを回収したときに残骸を片付けるために使う。
#                                                 手で使うときは、その枠のスタックが誰のものかを確かめてから打つ。
#                                                 枠 0 は他の作業と共有しているので受け付けない)
#
# 環境変数:
#   LOCAL_CI_SLOT                    枠 (0〜9。既定 0)。枠 1 以上は project_id とポートをずらして、同じ機械で複数のスタックを
#                                    同時に動かせるようにする (値の表は scripts/lib/local-ci-slot.sh)。枠 0 は今までと同じ。
#                                    作業ディレクトリも枠ごとに分ける (枠 0 は .supabase-local/、枠 n は .supabase-local-s<n>/)。
#                                    stop / status / env は prepare をしないので、組み立てたときと同じ LOCAL_CI_SLOT を付けて打つ
#   SUPABASE_CLI                     supabase CLI の呼び出し方 (既定: npx --yes supabase@2.62.10)
#   SUPABASE_LOCAL_EXCLUDE           supabase start -x に渡すサービス
#                                    (既定: studio,imgproxy,logflare,vector,edge-runtime)
#   SUPABASE_LOCAL_REALTIME_VERSION  Realtime イメージの版を固定する (既定: IPv6 が無効な環境のみ v2.83.1)
#   SUPABASE_LOCAL_RETRY_WAIT_UNIT   start を一過性のエラーでやり直すときの待ち時間の単位秒 (既定: START_RETRY_WAIT_UNIT_DEFAULT。
#                                    イメージの取得の失敗は、どの取得元でも失敗した n 周目のあとに n 倍、Docker の準備待ちは n 回目のあとに n 倍)
#   SUPABASE_IMAGE_REGISTRIES        start がイメージを取る取得元を試す順 (空白区切り。既定: public.ecr.aws ghcr.io。#1523)
#   SUPABASE_IMAGE_PULL_ROUNDS       start が取得元を一巡する回数の上限 (既定: 3)
#   SUPABASE_INTERNAL_IMAGE_REGISTRY CLI の取得元。指定すれば start もそれだけを使う (reset / verify はこれで取得元を替える。
#                                    詳しくは scripts/lib/supabase-image-pull.sh と docs/operations/ci-supabase-image-pull.md)
#   SUPABASE_LOCAL_STOP_RETRY_ATTEMPTS   stop / stop-leftover が prune の衝突で失敗したときに CLI の stop を打つ回数の上限
#                                        (最初の 1 回を含む。既定: STOP_RETRY_ATTEMPTS_DEFAULT。1 以上の整数)
#   SUPABASE_LOCAL_STOP_RETRY_WAIT_UNIT  そのやり直しの待ち時間の単位秒 (既定: STOP_RETRY_WAIT_UNIT_DEFAULT。n 回目は n 倍。0 以上の整数)
#   SUPABASE_LOCAL_KONG_UPSTREAM_KEEPALIVE_POOL_SIZE
#                                    start のあと (と、db reset で Kong を再起動したあと) に、入口の Kong の奥への接続の使い回しの数
#                                    (Kong の upstream_keepalive_pool_size) を入れ直す値 (既定: KONG_UPSTREAM_KEEPALIVE_POOL_SIZE_DEFAULT = 0
#                                    = 使い回さない。0 以上の整数。Kong の既定の 60 を入れると CLI のままの動きに戻る。#1779。tune_kong_keepalive)
#
# IPv6 について: Claude Code Cloud の VM はカーネルで IPv6 が無効 (ipv6.disable=1)。
# CLI 2.62.10 既定の Realtime v2.65.3 は IPv6 での待ち受けがハードコードされており起動に失敗する。
# v2.83.1 以降は IPv6 が使えないとき IPv4 にフォールバックするため、その環境でのみ版を固定する。
# =====================================================================

set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
BASELINE_DIR="$ROOT/supabase/baseline"
CLI_VERSION="2.62.10"
# 枠 (slot) ごとの project_id とポート。枠 0 (既定。CI はこれ) は project_id = homegohan-local・CLI の既定のポートのまま
# shellcheck source=lib/local-ci-slot.sh
. "$ROOT/scripts/lib/local-ci-slot.sh"
# イメージの取得の一過性の失敗 (レート制限など) のやり直しと取得元の切り替え (#1523)
# shellcheck source=lib/supabase-image-pull.sh
. "$ROOT/scripts/lib/supabase-image-pull.sh"
SLOT="${LOCAL_CI_SLOT:-0}"
if ! local_ci_slot_valid "$SLOT"; then
  echo "[supabase-local] LOCAL_CI_SLOT は 0〜$LCS_SLOT_MAX の整数にしてください: $SLOT" >&2
  exit 2
fi
SLOT="$((10#$SLOT))"
local_ci_slot_apply "$SLOT"
PROJECT_ID="$SLOT_PROJECT_ID"
# 作業ディレクトリは枠ごとに分ける。枠 0 は今までと同じ .supabase-local/ (CI の生成物を変えない)、枠 n は .supabase-local-s<n>/。
# 共有すると、同じチェックアウトで 2 つの枠を使ったときに config.toml・migrations・.temp を互いに書き換え、prepare をしない
# stop / status / env が「最後に組み立てた枠」の config.toml を読んで、指定した枠と別の枠のスタックを止めたり接続先を書いたりする
WORK="$ROOT/$(local_ci_slot_work_dir "$SLOT")"
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

# stop の prune の衝突 (#1616)。CLI の stop は、コンテナを止めたあと project_id のラベルで絞った prune (コンテナ・ボリューム・
# ネットワーク) で消す。dockerd は prune を同時に 1 つしか受け付けないので、同じ dockerd で別の枠の stop の prune と重なると
# 「a prune operation is already running」で失敗し、止まっただけのコンテナとボリュームが残る (2026-10-15 に d256 で実測。
# 止めることは終わっているので、間をおいて CLI の stop を打ち直せば prune だけがやり直される)。
# この文言の失敗だけをやり直す (ほかの失敗は打ち直しても直らないので、そのまま返す)
readonly STOP_PRUNE_CONFLICT_PATTERN='a prune operation is already running'
# 打つ回数の上限の既定 (最初の 1 回を含む)。相手の prune は、1 枠のスタック (コンテナ 8 個前後とそのボリューム) を消すだけなので
# 数秒で終わる見込み。既定の待ち (単位 × 1 + 2 + 3 + 4 = 50 秒) は、それが続けて何本か重なっても足りる長さにした
readonly STOP_RETRY_ATTEMPTS_DEFAULT=5
# やり直しの待ち時間の単位秒の既定 (n 回目の失敗のあとは n 倍待つ)
readonly STOP_RETRY_WAIT_UNIT_DEFAULT=5
STOP_RETRY_ATTEMPTS="${SUPABASE_LOCAL_STOP_RETRY_ATTEMPTS:-$STOP_RETRY_ATTEMPTS_DEFAULT}"
STOP_RETRY_WAIT_UNIT="${SUPABASE_LOCAL_STOP_RETRY_WAIT_UNIT:-$STOP_RETRY_WAIT_UNIT_DEFAULT}"
if ! [[ "$STOP_RETRY_ATTEMPTS" =~ ^[0-9]+$ ]] || [ "$((10#$STOP_RETRY_ATTEMPTS))" -lt 1 ]; then
  log "SUPABASE_LOCAL_STOP_RETRY_ATTEMPTS は 1 以上の整数にしてください: $STOP_RETRY_ATTEMPTS"
  exit 2
fi
if ! [[ "$STOP_RETRY_WAIT_UNIT" =~ ^[0-9]+$ ]]; then
  log "SUPABASE_LOCAL_STOP_RETRY_WAIT_UNIT は 0 以上の整数にしてください: $STOP_RETRY_WAIT_UNIT"
  exit 2
fi
STOP_RETRY_ATTEMPTS="$((10#$STOP_RETRY_ATTEMPTS))"
STOP_RETRY_WAIT_UNIT="$((10#$STOP_RETRY_WAIT_UNIT))"

# 入口の Kong の、奥への接続の使い回し (#1779)。
# CLI 2.62.10 の Kong (public.ecr.aws/supabase/kong:2.8.1) は Kong の既定のまま、奥 (PostgREST など) への接続を使い回す
# (upstream_keepalive_pool_size = 60・upstream_keepalive_idle_timeout = 60 秒。2026-10-17 に d256 でコンテナの .kong_env を読んで確認)。
# 確かめた事実 (どれも 2026-10-17 に d256 で):
#   - 結合テスト 1 回 (Kong への要求 28,388 件) で 502 が 1 件 (POST /rest/v1/rpc/create_org_invite)。Kong の error.log は
#     「upstream prematurely closed connection while reading response header from upstream」= PostgREST がその要求に応答する前に
#     接続を閉じた。同じ時刻の PostgREST のログには再起動・スキーマの読み直し・接続の失敗のどれも無く、コンテナの die / oom も無かった。
#     呼び出し側には 502 (An invalid response was received from the upstream server。エラーの code は無い) が返る
#   - nginx は送り直しても安全な要求 (GET・HEAD など) だけを別の接続で送り直し、POST・PATCH は送り直さない。そのため結合テストでは
#     準備の INSERT・UPDATE・RPC・/pg/query (どれも POST か PATCH) だけが落ちていた
#   - PostgREST 13.0.5 は HEAD に応答したあと、その接続をすぐ閉じる (直接つないで HEAD → 0.5 秒待つ → GET を送ると、0.5 秒の時点で
#     こちら側が CLOSE_WAIT で、2 本目に応答が無い。5 回とも。GET → GET は 5 回とも ESTABLISHED のまま 2 本とも応答した。
#     HEAD の応答には Content-Length が無い)。nginx の proxy は HEAD の応答を本文なしとして扱い、その接続を使い回しの候補に戻す
#     (nginx のソースの読み。ここは測っていない)
#   - Kong の access.log では、落ちた POST の 5 ms 前に HEAD /rest/v1/membership_audit (件数だけを数える select の head: true) が
#     応答を返し終えていた。PostgREST が起動してから 28 秒・最初の /rest/v1 の要求から 8 秒しか経っておらず (使い回された接続は
#     古くても約 8 秒)、使われていない接続の時間切れではない
# 落ちた POST が、HEAD のあと PostgREST が閉じた接続を Kong が使い回したものだという見立ては、上の事実とつじつまが合うが、
# 再現はしていない (Kong 経由で同じ接続に HEAD → POST を続けて 300 回送っても 502 は 0 件。Kong が閉じた接続を候補から外すのが、
# ほとんどの場合は次の要求より早いと見られる)。ほかに、使われていない PostgREST への接続が約 58 秒で PostgREST の側から消えた
# のも 1 度見ている (要求を 6 本ずつ同時に送ってから 2 秒ごとに Kong の中の netstat を見た。57 秒の時点ではあり、59 秒の時点では
# Kong の側に TIME_WAIT を残さずに消えていた)。こちらは Kong の 60 秒の時間切れと重なる別の競合になりうる。
# どちらの引き金でも「奥が閉じた接続を Kong が使い回して POST を送る」という型は同じで、使い回しを止めればこの型ごと起きない。
# ローカルでは使い回しの得がほとんど無い (同じ Docker のネットワークの中の TCP 接続) ので、起動したあとに使い回しを止める。
# CLI を上げるときもこの止め方を保つ (tune_kong_keepalive は .kong_env の値を確かめ、入らなければ start を失敗にする)。
# 0 = 使い回さない (要求ごとに新しい接続を開き、使い終わったら閉じる)。Kong の既定の 60 を入れると CLI のままの動きに戻る
readonly KONG_UPSTREAM_KEEPALIVE_POOL_SIZE_DEFAULT=0
KONG_UPSTREAM_KEEPALIVE_POOL_SIZE="${SUPABASE_LOCAL_KONG_UPSTREAM_KEEPALIVE_POOL_SIZE:-$KONG_UPSTREAM_KEEPALIVE_POOL_SIZE_DEFAULT}"
if ! [[ "$KONG_UPSTREAM_KEEPALIVE_POOL_SIZE" =~ ^[0-9]+$ ]]; then
  log "SUPABASE_LOCAL_KONG_UPSTREAM_KEEPALIVE_POOL_SIZE は 0 以上の整数にしてください: $KONG_UPSTREAM_KEEPALIVE_POOL_SIZE"
  exit 2
fi
KONG_UPSTREAM_KEEPALIVE_POOL_SIZE="$((10#$KONG_UPSTREAM_KEEPALIVE_POOL_SIZE))"
# CLI 2.62.10 が Kong を起動するときに渡す nginx の雛形 (コンテナの起動コマンドの
# `kong docker-start --nginx-conf /home/kong/custom_nginx.template`)。reload でも同じ雛形を渡す (渡さないと Kong の既定の雛形で作り直す)
readonly KONG_NGINX_TEMPLATE="/home/kong/custom_nginx.template"
# Kong が設定を書き出す場所 (Kong の既定の prefix /usr/local/kong の .kong_env)。reload のあとに値が入ったかをここで確かめる
readonly KONG_ENV_FILE="/usr/local/kong/.kong_env"

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

# 枠 1 以上の config.toml に足す設定: CLI が開くポートをすべて枠の値にずらし、認証のリダイレクト先を枠の Next に向ける。
# 枠 0 では何も足さない (CLI の既定のまま。生成する config.toml は今までと同じ)
slot_config() {
  local table
  # リポジトリの config.toml が同じ表を持っていると TOML の表が 2 回になって CLI が読めないので、先に止める
  for table in api db db.pooler studio inbucket analytics edge_runtime auth; do
    if grep -qE "^[[:space:]]*\[$table\][[:space:]]*(#.*)?$" "$ROOT/supabase/config.toml"; then
      log "supabase/config.toml に [$table] があるため、枠 $SLOT のポートを足せません (scripts/supabase-local.sh の slot_config を直す)"
      exit 1
    fi
  done
  echo
  echo "# ローカル専用: 枠 $SLOT (LOCAL_CI_SLOT)。同じ機械の他の枠と重ならないポート (scripts/lib/local-ci-slot.sh)"
  echo '[api]'
  echo "port = $SLOT_API_PORT"
  echo '[db]'
  echo "port = $SLOT_DB_PORT"
  echo "shadow_port = $SLOT_SHADOW_PORT"
  echo '[db.pooler]'
  echo "port = $SLOT_POOLER_PORT"
  echo '[studio]'
  echo "port = $SLOT_STUDIO_PORT"
  echo '[inbucket]'
  echo "port = $SLOT_INBUCKET_PORT"
  echo "smtp_port = $SLOT_INBUCKET_SMTP_PORT"
  echo "pop3_port = $SLOT_INBUCKET_POP3_PORT"
  echo '[analytics]'
  echo "port = $SLOT_ANALYTICS_PORT"
  echo "vector_port = $SLOT_VECTOR_PORT"
  echo '[edge_runtime]'
  echo "inspector_port = $SLOT_INSPECTOR_PORT"
  # CLI の既定 (site_url = http://127.0.0.1:3000) と同じ形で、ポートだけ枠の Next に合わせる
  echo '[auth]'
  echo "site_url = \"http://127.0.0.1:$SLOT_APP_PORT\""
  echo "additional_redirect_urls = [\"https://127.0.0.1:$SLOT_APP_PORT\"]"
}

# 作業ディレクトリ ($WORK/supabase) を組み立てる
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
    echo "project_id = \"$PROJECT_ID\""
    echo
    cat "$ROOT/supabase/config.toml"
    echo
    echo '# ローカル専用: テストで多数のユーザーがサインインするため認証のレート制限を緩める'
    echo '[auth.rate_limit]'
    echo 'sign_in_sign_ups = 1000'
    echo 'token_refresh = 1000'
    echo 'token_verifications = 1000'
    echo '# ローカル専用: 運営の MFA (docs/design/cross/12-operator-mfa.md) の結合テストが TOTP の登録と確認を使う。CLI の既定に依らないよう明示する'
    echo '[auth.mfa.totp]'
    echo 'enroll_enabled = true'
    echo 'verify_enabled = true'
    if [ "$SLOT" -ne 0 ]; then
      slot_config
    fi
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

# start のやり直しの待ち時間の単位秒の既定 (SUPABASE_LOCAL_RETRY_WAIT_UNIT で上書き)。public.ecr.aws の認証なしの取得は
# 1 秒あたり 1 回までなので、CI で複数のジョブが同時に取得して当たった上限が解けるまでの間をとる
readonly START_RETRY_WAIT_UNIT_DEFAULT=30
# start を同じ取得元で間をおいてやり直す失敗: Docker デーモンの再起動直後で、自動再起動中のコンテナがまだ準備できていない
readonly START_NOT_READY_PATTERN='is not ready'

cmd_start() {
  ensure_docker
  prepare
  local args=()
  if [ -n "$SUPABASE_LOCAL_EXCLUDE" ]; then
    args+=(-x "$SUPABASE_LOCAL_EXCLUDE")
  fi
  # 次の一過性の失敗に限り、間隔を空けて起動をやり直す (それ以外のエラーは再実行しない。scripts/lib/supabase-image-pull.sh)。
  #   - イメージの取得に失敗する ("failed to pull docker image" / "toomanyrequests" など)。取得元を
  #     public.ecr.aws → ghcr.io の順に替えてやり直し、どれでも失敗したら間を空けて次の周に入る。
  #     public.ecr.aws は認証なしの取得に上限があり、GitHub のランナーでは日中くり返し当たる (#1523)。
  #     最後まで取れなかったら「[image-pull-unavailable] ...」を出して SIP_EXIT_PULL_UNAVAILABLE で終わる (検査の赤と区別する)
  #   - Docker デーモンの再起動直後で、自動再起動中のコンテナがまだ準備できていない ("is not ready")。同じ取得元でやり直す
  local err status=0
  sip_init "${SUPABASE_LOCAL_RETRY_WAIT_UNIT:-$START_RETRY_WAIT_UNIT_DEFAULT}" || exit 2
  err="$(mktemp "${TMPDIR:-/tmp}/supabase-local-start.XXXXXX")"
  sip_run "supabase start" - "$err" "$START_NOT_READY_PATTERN" cli start "${args[@]}" || status=$?
  rm -f "$err"
  if [ "$status" -eq 0 ] && ! tune_kong_keepalive; then
    status=1
  fi
  return "$status"
}

# 入口の Kong の、奥への接続の使い回しの数を KONG_UPSTREAM_KEEPALIVE_POOL_SIZE に入れ直す (#1779。理由は上の定数の説明)。
# CLI は Kong の環境変数を決め打ちで起動するので、起動したあとにコンテナの中で `kong reload` を打ち、その 1 回だけ
# KONG_UPSTREAM_KEEPALIVE_POOL_SIZE を渡す (reload は設定を書き出し直して nginx に HUP を送る。受け付け中の要求は古い worker が
# 最後まで返すので、入れ直しの間に要求を落とさない)。コンテナを docker restart すると CLI の起動時の設定に戻るので、
# Kong を再起動したら (restart_kong_and_wait) もう一度呼ぶ。
# 入れ直したあと、Kong が書き出した設定 (.kong_env) に値が入ったかを確かめ、入っていなければ失敗にする
# (黙って使い回しのまま結合テストを流すと、間欠的な 502 が戻ってきても気付けない)
tune_kong_keepalive() {
  local container="supabase_kong_$PROJECT_ID" kong_env actual
  if ! docker exec -e "KONG_UPSTREAM_KEEPALIVE_POOL_SIZE=$KONG_UPSTREAM_KEEPALIVE_POOL_SIZE" "$container" \
      kong reload --nginx-conf "$KONG_NGINX_TEMPLATE" >&2; then
    log "Kong ($container) の奥への接続の使い回しを $KONG_UPSTREAM_KEEPALIVE_POOL_SIZE に入れ直せませんでした (kong reload が失敗)"
    return 1
  fi
  if ! kong_env="$(docker exec "$container" cat "$KONG_ENV_FILE")"; then
    log "Kong ($container) の設定 ($KONG_ENV_FILE) を読めませんでした"
    return 1
  fi
  actual="$(printf '%s\n' "$kong_env" | sed -n 's/^upstream_keepalive_pool_size = \([0-9]*\)$/\1/p' | head -n1)"
  if [ "$actual" != "$KONG_UPSTREAM_KEEPALIVE_POOL_SIZE" ]; then
    log "Kong ($container) の upstream_keepalive_pool_size が ${actual:-(無い)} のままです (入れ直そうとした値: $KONG_UPSTREAM_KEEPALIVE_POOL_SIZE)"
    return 1
  fi
  log "Kong ($container) の奥への接続の使い回しを $KONG_UPSTREAM_KEEPALIVE_POOL_SIZE にしました (upstream_keepalive_pool_size。0 = 使い回さない。#1779)"
}

cmd_reset() {
  ensure_docker
  prepare
  db_reset_with_retry
}

db_reset_with_retry() {
  # db reset は DB に適用したあと Storage などのコンテナを再起動し、Kong 経由で Storage API
  # (バケット一覧) を呼ぶ。再起動したコンテナは IP アドレスが変わることがあるが、Kong は起動時に
  # 解決した古い IP に接続し続けるため 502 (古い IP が空いていれば接続のタイムアウト) になり、
  # 待っても直らない (db reset をやり直しても同じ)。DB への適用は終わっているので、このときに限り
  # Kong を再起動して Storage API の応答を待つ (migration の失敗などは対象外)。
  # CLI のエラーは stderr に出るため、stderr だけを画面に流しつつファイルにも残して判定する。
  local err status=0
  err="$(mktemp)"
  { cli db reset 2>&1 1>&3 | tee "$err" >&2; } 3>&1 || status=$?
  if [ "$status" -ne 0 ] && grep -qE 'Error status 50[234]|request: Get "[^"]*/storage/v1/bucket"' "$err"; then
    log "Kong が再起動前の Storage の IP に接続して失敗したため、Kong を再起動して待ちます"
    if restart_kong_and_wait; then
      status=0
    fi
  fi
  rm -f "$err"
  return "$status"
}

restart_kong_and_wait() {
  local env_out api key code=""
  docker restart "supabase_kong_$PROJECT_ID" >/dev/null
  env_out="$(cli status -o env 2>/dev/null)" || return 1
  api="$(printf '%s\n' "$env_out" | sed -n 's/^API_URL="\{0,1\}\([^"]*\)"\{0,1\}$/\1/p')"
  key="$(printf '%s\n' "$env_out" | sed -n 's/^SERVICE_ROLE_KEY="\{0,1\}\([^"]*\)"\{0,1\}$/\1/p')"
  for _ in $(seq 1 60); do
    code="$(curl -s -o /dev/null -w '%{http_code}' -H "apikey: $key" -H "Authorization: Bearer $key" \
      "$api/storage/v1/bucket" || true)"
    if [ "$code" = "200" ]; then
      log "Storage API が応答しました"
      # docker restart で Kong は CLI の起動時の設定 (奥への接続を使い回す) に戻っているので、入れ直す (#1779)
      tune_kong_keepalive
      return
    fi
    sleep 2
  done
  log "Kong を再起動しても Storage API が応答しません (最後の HTTP ステータス: $code)"
  return 1
}

# prepare をしないコマンド (stop / status / env) の前に、作業ディレクトリの config.toml がいま指定された枠のものか確かめる。
# 違えば (作業ディレクトリを枠ごとに分ける前の版が、別の枠の config.toml をここに組み立てていたときなど) 止める。
# 別の枠のスタックを止めたり (stop はボリュームまで消す)、別の枠の接続先を .env.local に書いたりしないため
ensure_work_matches_slot() {
  local cfg="$WORK/supabase/config.toml" actual
  [ -f "$cfg" ] || return 0
  actual="$(sed -n 's/^project_id = "\(.*\)"$/\1/p' "$cfg" | head -n1)"
  if [ "$actual" != "$PROJECT_ID" ]; then
    log "作業ディレクトリ $WORK は project_id \"$actual\" の config.toml を持っていて、枠 $SLOT ($PROJECT_ID) のものではありません。"
    log "別の枠のスタックに触らないよう止めます。その枠の LOCAL_CI_SLOT を付けて打ち直してください"
    log "(枠を分ける前の版が組み立てた枠 n のスタックは LOCAL_CI_SLOT=<n> bash scripts/supabase-local.sh stop-leftover で止まります)"
    exit 2
  fi
}

# CLI の stop --no-backup を打つ。prune の衝突 (STOP_PRUNE_CONFLICT_PATTERN) で失敗したときだけ、間をおいて
# 最大 STOP_RETRY_ATTEMPTS 回まで打ち直す。最後の終了コードを返す (やり直しても失敗したら失敗のまま返す。
# 残ったコンテナ・ボリュームの片付けと確かめは scripts/local-ci.sh の stop_supabase が行う)。
# CLI のエラーは stderr に出るため、stderr だけを画面に流しつつファイルにも残して判定する (stdout はそのまま)
stop_with_retry() {
  local err status attempt=1
  # 置き場は TMPDIR (無ければ /tmp) に明示する (macOS の mktemp は引数が無いと TMPDIR を見ないので、Linux と同じ場所にそろえる)。
  # 終わったら消す (テストは TMPDIR を差し替えて、残っていないことを確かめる)
  err="$(mktemp "${TMPDIR:-/tmp}/supabase-local-stop.XXXXXX")"
  while :; do
    status=0
    { cli stop --no-backup 2>&1 1>&3 | tee "$err" >&2; } 3>&1 || status=$?
    if [ "$status" -eq 0 ]; then
      break
    fi
    if [ "$attempt" -ge "$STOP_RETRY_ATTEMPTS" ] || ! grep -qF "$STOP_PRUNE_CONFLICT_PATTERN" "$err"; then
      break
    fi
    log "supabase stop が別の prune と重なって失敗したため ($STOP_PRUNE_CONFLICT_PATTERN)、$((attempt * STOP_RETRY_WAIT_UNIT)) 秒待ってやり直します ($attempt / $STOP_RETRY_ATTEMPTS 回目)"
    sleep "$((attempt * STOP_RETRY_WAIT_UNIT))"
    attempt=$((attempt + 1))
  done
  rm -f "$err"
  if [ "$status" -ne 0 ]; then
    log "supabase stop が失敗しました (終了コード ${status}。$attempt 回打った)。枠 $SLOT ($PROJECT_ID) のコンテナ / ボリュームが残っているかもしれません"
  fi
  return "$status"
}

cmd_stop() {
  if [ -d "$WORK/supabase" ]; then
    ensure_work_matches_slot
    stop_with_retry
  fi
}

# 枠 (1 以上) の project_id のコンテナ・ボリュームを止めて消す。持ち主が死んで残った枠のスタックを片付ける。
# 枠 0 は、枠を使わない作業 (CI・手で起動したスタック・外側のロックで動く Workflow) と共有しているので止めない
cmd_stop_leftover() {
  if [ "$SLOT" -eq 0 ]; then
    log "stop-leftover は枠 1 以上だけで使えます (枠 0 は他の作業と共有しているため止めません)"
    exit 2
  fi
  ensure_docker
  prepare
  log "枠 $SLOT ($PROJECT_ID) の残ったスタックを止めます"
  stop_with_retry
}

cmd_status() {
  ensure_work_matches_slot
  cli status
}

# アプリ (.env.local) / integration テストが読む変数名で出力する
cmd_env() {
  local out="${1:-}"
  local status_env
  ensure_work_matches_slot
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
  stop-leftover) cmd_stop_leftover ;;
  *)
    awk 'NR > 1 && /^#/ { print; next } NR > 1 { exit }' "$0"
    exit 1
    ;;
esac
