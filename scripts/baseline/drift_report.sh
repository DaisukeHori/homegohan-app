#!/usr/bin/env bash
# =====================================================================
# #1243 本番 RLS ドリフト調査 (ローカル専用。本番には接続しない)
# =====================================================================
# 本番カタログ (supabase/baseline/catalog/) と「migration ファイルが定義する認可状態」を比較する。
#
# 2026-10-07 の #1116 で、台帳の最大 version 以下の migration はベースラインに統合した
# (20251126124224_create_meal_planner_tables.sql)。統合後は本番の全体を `supabase db diff --linked` (CI) で
# 比べられるため、このスクリプトは認可まわりを詳しく見たいときの補助として残す。後者は次の方法で再現する:
#   1) ベースライン (本番スキーマ) だけを適用したローカル DB を作る
#   2) drift_reset_security.sql で RLS ポリシー・RLS 有効化・GRANT を白紙に戻す
#      (テーブル / 型 / 関数の構造は本番のまま)
#   3) supabase/migrations を全て順に再適用する (既存オブジェクトとの衝突エラーは許容し、
#      トランザクション内でも文単位で続行する)
#   4) カタログを取り出し、drift_compare.py で本番カタログと比較する
#
# 使い方: bash scripts/supabase-local.sh start (起動済みであること) の後に
#   bash scripts/baseline/drift_report.sh [出力ディレクトリ]
# 枠 (LOCAL_CI_SLOT。scripts/lib/local-ci-slot.sh) を指定して起動したスタックに対して回すときは、
# 起動したときと同じ LOCAL_CI_SLOT を付けて打つ (DB のポートも scripts/supabase-local.sh と同じく枠で決まる)。
# 終了時にローカル DB を通常状態 (ベースライン + 新規 migration) に戻す。
# =====================================================================

set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
# 繋ぐ DB のポートと結果の既定の置き場は、scripts/supabase-local.sh と同じく LOCAL_CI_SLOT の枠で決める
# (枠 0 は今までと同じ: DB は CLI の既定 54322、結果は .supabase-local/drift)。DB のポートを決め打ちにすると、枠 1 以上の
# スタックを reset しておきながら、別の枠 (同時に回っている local-ci.sh など) の DB の認可状態を白紙化してしまう
# shellcheck source=../lib/local-ci-slot.sh
. "$ROOT/scripts/lib/local-ci-slot.sh"
SLOT="${LOCAL_CI_SLOT:-0}"
if ! local_ci_slot_valid "$SLOT"; then
  echo "[drift] LOCAL_CI_SLOT は 0〜$LCS_SLOT_MAX の整数にしてください: $SLOT" >&2
  exit 2
fi
local_ci_slot_apply "$SLOT"
OUT="${1:-$ROOT/$(local_ci_slot_work_dir "$SLOT")/drift}"
PG_IMAGE="public.ecr.aws/supabase/postgres:$(cat "$ROOT/supabase/.temp/postgres-version")"
DB_URL="postgresql://postgres:postgres@127.0.0.1:$SLOT_DB_PORT/postgres?sslmode=disable"

rm -rf "$OUT"
mkdir -p "$OUT/replay"

psql_local() {
  docker run --rm --network host --user "$(id -u):$(id -g)" -e HOME=/tmp \
    -v "$ROOT:/repo:ro" -v "$OUT:/out" -w /out \
    "$PG_IMAGE" psql "$DB_URL" -X "$@"
}

echo "[drift] 1/4 ベースラインだけの DB を作成"
SUPABASE_LOCAL_BASELINE_ONLY=1 bash "$ROOT/scripts/supabase-local.sh" reset >/dev/null

echo "[drift] 2/4 認可状態を白紙化"
psql_local -q -v ON_ERROR_STOP=1 -f /repo/scripts/baseline/drift_reset_security.sql

echo "[drift] 3/4 migration を全て再適用"
errors=0
for path in "$ROOT"/supabase/migrations/*.sql; do
  name="$(basename "$path")"
  psql_local -q -v ON_ERROR_STOP=0 -v ON_ERROR_ROLLBACK=on \
    -f "/repo/supabase/migrations/$name" > "$OUT/replay/$name.log" 2>&1 || true
  n=$(grep -c "ERROR:" "$OUT/replay/$name.log" || true)
  errors=$((errors + n))
done
echo "[drift]     再適用時のエラー (既存オブジェクトとの衝突等) 合計: $errors"

echo "[drift] 4/4 カタログを取得して本番と比較"
mkdir -p "$OUT/catalog"
docker run --rm --network host --user "$(id -u):$(id -g)" -e HOME=/tmp \
  -v "$ROOT:/repo:ro" -v "$OUT/catalog:/out" -w /out \
  "$PG_IMAGE" psql "$DB_URL" -X -q -f /repo/scripts/baseline/snapshot_catalog.sql
python3 "$ROOT/scripts/baseline/drift_compare.py" \
  "$ROOT/supabase/baseline/catalog" "$OUT/catalog" "$ROOT/supabase/migrations" > "$OUT/drift.json"
echo "[drift] 結果: $OUT/drift.json"

echo "[drift] ローカル DB を通常状態に戻す"
bash "$ROOT/scripts/supabase-local.sh" reset >/dev/null
