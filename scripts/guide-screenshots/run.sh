#!/usr/bin/env bash
# =====================================================================
# 使い方ガイド (/guide) の手順の画面 15 枚 (#1852) と、紹介ページ (/) の新しい画面 6 枚・拡大の画像 2 枚 (#1867 段 0) を撮る
# =====================================================================
# ローカルの Supabase (ベースライン + migration) と本番ビルドを立て、テスト用の利用者とデータ (seed.ts) で各画面を開いて撮る。
# 本番には一切つながない (接続先はローカルの Supabase だけ。seed.ts も localhost 以外には書かない)。
# 写すのはテスト用の名前・データだけ。AI の読み取りの結果はテスト用の値で返す (shoot.pw.ts の先頭のコメント)。
#
# 撮るもの (shoot.pw.ts の最後の確認が、撮った画像の名前をこの 23 枚と突き合わせる):
#   - ガイドの画像 15 枚 (src/app/guide/guide-content.ts)        → public/guide/<名前>.png (540×1080)
#   - 紹介ページの新しい画面 6 枚 (landing-screens.ts の LANDING_SCREENS) → public/marketing/screens/<名前>.png (540×1080)
#   - 紹介ページの拡大の画像 2 枚 (landing-screens.ts の LANDING_ZOOMS)   → public/marketing/screens/zoom-*.png (LANDING_ZOOMS の大きさ)
#     拡大の画像は、comment.png・menu-result.png と同じ撮影の回の同じ画面から切り出す。ガイドの画像だけを持ち帰ると、拡大の画像は
#     前の回のまま残るので、comment.png・menu-result.png を置き換えるときは拡大の 2 枚も一緒に持ち帰る
#     (docs/design/marketing/01-landing-site.md §5.4・§24 Q-22)。
#
# 使い方 (Docker と Linux の Chromium がある機械で。開発機の M2 では流さない):
#   offload で 256 の Docker の枠に流し、できた画像を持ち帰る (public/ をまるごと書き換えずに、置き換える画像だけを選んで写す形):
#     OFFLOAD_DOCKER_SLOTS='1 2 3 4 5 6 7 8' ~/claude-work/dev-infra/bin/offload --docker --no-install -e TZ=UTC \
#       -e GUIDE_SHOTS_PUBLIC_DIR=.guide-shots/public --fetch .guide-shots -- \
#       bash -c 'LOCAL_CI_SLOT="$OFFLOAD_DOCKER_SLOT" exec bash scripts/guide-screenshots/run.sh'
#   持ち帰った .guide-shots/public/{guide,marketing/screens}/*.png と撮ったまま (.guide-shots/raw) を目で確かめ
#   (画面の文言とガイドの説明が合っているか・秘密や個人の情報が無いか・紹介ページの画面は設計 §7.1 の表 2・表 3 の受入の条件)、
#   置き換える画像だけを public/ の同じ名前へ写してコミットする。
#   ガイドの 15 枚をまるごと置き換えるなら、GUIDE_SHOTS_PUBLIC_DIR を付けずに --fetch public/guide --fetch public/marketing/screens
#   --fetch .guide-shots/raw で持ち帰ってもよい。
#
# 流れ: npm ci (node_modules が無ければ) → Playwright の Chromium → ローカルの Supabase の起動 → .env.local → seed.ts →
#       next build → next start → shoot.pw.ts (.guide-shots/raw に撮る) → optimize.ts (縮めて置き場に置く) → 片付け
#
# 環境変数 (どれも任意):
#   LOCAL_CI_SLOT              ローカルの Supabase と Next のポートの枠 (scripts/lib/local-ci-slot.sh。既定 0)
#   GUIDE_SHOTS_FONT_MOCK      1 にすると next/font/google のフォントを取りに行かない (e2e と同じモック。既定は取りに行く =
#                              本番と同じ書体で撮る。Google Fonts に届かない機械で使う)
#   GUIDE_SHOTS_RAW_DIR        撮った (縮める前の) 画像の置き場 (既定 .guide-shots/raw)
#   GUIDE_SHOTS_PUBLIC_DIR     縮めた画像の置き場の根 (既定 public。この下の guide/ と marketing/screens/ に置く)
#   GUIDE_SHOTS_KEEP_SUPABASE  1 にすると終わってもローカルの Supabase を止めない (調べるとき)
# =====================================================================

# 本番に届く余地を消す
unset SUPABASE_ACCESS_TOKEN SUPABASE_DB_PASSWORD SUPABASE_PROJECT_REF

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

# shellcheck source=../lib/local-ci-slot.sh
. "$ROOT/scripts/lib/local-ci-slot.sh"

readonly SCRIPT_DIR="scripts/guide-screenshots"
readonly ARTIFACTS_DIR=".guide-shots"
# next start が応答するまで待つ回数と間隔 (scripts/local-ci.sh の START_WAIT_TRIES × WAIT_INTERVAL_SEC と同じ)
readonly START_WAIT_TRIES=60
readonly WAIT_INTERVAL_SEC=2
# next start を止めたあと、消えるのを待つ回数 (× WAIT_INTERVAL_SEC)。過ぎたら SIGKILL
readonly STOP_WAIT_TRIES=15
# 本番ビルドの Node のヒープ (MB)。next build が既定のヒープで足りずに落ちないように
readonly BUILD_HEAP_MB=8192

SLOT="${LOCAL_CI_SLOT:-0}"
if ! local_ci_slot_valid "$SLOT"; then
  echo "[guide-shots] LOCAL_CI_SLOT は 0〜$LCS_SLOT_MAX の整数にしてください: $SLOT" >&2
  exit 2
fi
export LOCAL_CI_SLOT="$SLOT"
local_ci_slot_apply "$SLOT"
APP_PORT="$SLOT_APP_PORT"
APP_ORIGIN="http://localhost:$APP_PORT"

mkdir -p "$ARTIFACTS_DIR"
LOG_DIR="$ARTIFACTS_DIR/logs"
mkdir -p "$LOG_DIR"

say() { printf '[guide-shots] %s\n' "$*" >&2; }

SERVER_PID=""
SUPA_STARTED=0
cleanup() {
  local rc=$?
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    say "next start を止めます"
    kill "$SERVER_PID" 2>/dev/null || true
    for _ in $(seq 1 "$STOP_WAIT_TRIES"); do
      kill -0 "$SERVER_PID" 2>/dev/null || break
      sleep "$WAIT_INTERVAL_SEC"
    done
    kill -9 "$SERVER_PID" 2>/dev/null || true
  fi
  if [ "$SUPA_STARTED" = 1 ] && [ "${GUIDE_SHOTS_KEEP_SUPABASE:-0}" != 1 ]; then
    say "ローカルの Supabase を止めます (枠 $SLOT)"
    bash scripts/supabase-local.sh stop >>"$LOG_DIR/supabase.log" 2>&1 || say "supabase-local.sh stop が失敗しました (ログ: $LOG_DIR/supabase.log)"
    if [ "$SLOT" -ne 0 ]; then
      bash scripts/supabase-local.sh stop-leftover >>"$LOG_DIR/supabase.log" 2>&1 || say "supabase-local.sh stop-leftover が失敗しました"
    fi
  fi
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if curl -s -o /dev/null "$APP_ORIGIN/login"; then
  say "ポート $APP_PORT は使用中です (止めずに終わります)"
  exit 1
fi

if [ ! -d node_modules ]; then
  say "npm ci"
  npm ci >"$LOG_DIR/npm-ci.log" 2>&1
fi

say "Playwright の Chromium を入れます"
npx playwright install chromium >"$LOG_DIR/playwright-install.log" 2>&1

say "ローカルの Supabase を起動します (枠 $SLOT)"
SUPA_STARTED=1
bash scripts/supabase-local.sh start >"$LOG_DIR/supabase.log" 2>&1
bash scripts/supabase-local.sh env .env.local >>"$LOG_DIR/supabase.log" 2>&1

say "テスト用のデータを入れます"
npx --yes tsx@4 "$SCRIPT_DIR/seed.ts" 2>&1 | tee "$LOG_DIR/seed.log" >&2

say "next build"
BUILD_ENV=(NODE_OPTIONS="--max-old-space-size=$BUILD_HEAP_MB")
if [ "${GUIDE_SHOTS_FONT_MOCK:-0}" = 1 ]; then
  BUILD_ENV+=(NEXT_FONT_GOOGLE_MOCKED_RESPONSES="$ROOT/tests/e2e/fixtures/google-fonts-mock.cjs")
fi
env "${BUILD_ENV[@]}" npm run build >"$LOG_DIR/build.log" 2>&1

say "next start ($APP_ORIGIN)"
( exec nohup env PORT="$APP_PORT" npm run start ) >"$LOG_DIR/next-start.log" 2>&1 &
SERVER_PID=$!
for _ in $(seq 1 "$START_WAIT_TRIES"); do
  if curl -s -o /dev/null "$APP_ORIGIN/login"; then break; fi
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    say "next start が途中で終了しました (ログ: $LOG_DIR/next-start.log)"
    exit 1
  fi
  sleep "$WAIT_INTERVAL_SEC"
done

say "撮影します"
rm -rf "${GUIDE_SHOTS_RAW_DIR:-$ARTIFACTS_DIR/raw}"
FONTCONFIG_FILE="$ROOT/$SCRIPT_DIR/fonts.conf" PLAYWRIGHT_BASE_URL="$APP_ORIGIN" \
  npx playwright test --config "$SCRIPT_DIR/playwright.config.ts" 2>&1 | tee "$LOG_DIR/shoot.log" >&2

PUBLIC_OUT_DIR="${GUIDE_SHOTS_PUBLIC_DIR:-public}"
say "縮めて $PUBLIC_OUT_DIR/guide/ と $PUBLIC_OUT_DIR/marketing/screens/ に置きます"
npx --yes tsx@4 "$SCRIPT_DIR/optimize.ts" 2>&1 | tee "$LOG_DIR/optimize.log" >&2

say "できました: $PUBLIC_OUT_DIR/guide/・$PUBLIC_OUT_DIR/marketing/screens/ (撮ったままの画像は ${GUIDE_SHOTS_RAW_DIR:-$ARTIFACTS_DIR/raw})"
