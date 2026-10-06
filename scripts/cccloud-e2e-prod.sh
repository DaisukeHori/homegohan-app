#!/usr/bin/env bash
# =====================================================
# Claude Code Cloud 用: 本番 (Vercel) に対する Playwright E2E
# =====================================================
# クラウド環境変数の PROD_* を、この実行の間だけ Playwright 用の変数に割り当てる。
# (環境変数欄に NEXT_PUBLIC_SUPABASE_URL 等を直接入れるとローカル Supabase 開発が
#  本番を向いてしまうため、PROD_ 接頭辞で分離している)
#
# 本番の service_role キーはクラウドに置かない方針のため、
# service_role で fixture を作る spec (membership/ family/ tour/ fresh-* 等 24 ファイル) は
# 本番では実行できない。既定では MVP スイート (tests/e2e/01〜05) のみ実行する。
#
# 使い方:
#   bash scripts/cccloud-e2e-prod.sh                         # MVP スイート
#   bash scripts/cccloud-e2e-prod.sh tests/e2e/01-login.spec.ts  # 任意の spec
#
# 必要なクラウド環境変数:
#   PROD_E2E_USER_EMAIL / PROD_E2E_USER_PASSWORD / PROD_SUPABASE_ANON_KEY
# 任意:
#   PROD_BASE_URL (既定 https://homegohan-app.vercel.app)
# =====================================================

set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

: "${PROD_E2E_USER_EMAIL:?PROD_E2E_USER_EMAIL が未設定です}"
: "${PROD_E2E_USER_PASSWORD:?PROD_E2E_USER_PASSWORD が未設定です}"
: "${PROD_SUPABASE_ANON_KEY:?PROD_SUPABASE_ANON_KEY が未設定です}"

export PLAYWRIGHT_BASE_URL="${PROD_BASE_URL:-https://homegohan-app.vercel.app}"
export NEXT_PUBLIC_SUPABASE_URL="https://flmeolcfutuwwbjmzyoz.supabase.co"
export NEXT_PUBLIC_SUPABASE_ANON_KEY="${PROD_SUPABASE_ANON_KEY}"
export E2E_USER_EMAIL="${PROD_E2E_USER_EMAIL}"
export E2E_USER_PASSWORD="${PROD_E2E_USER_PASSWORD}"

# playwright.config.ts は .env.local を dotenv で読むが、既存の環境変数は上書きしない。
# ローカル Supabase の service_role / 個別パスワードが本番に送られないよう空で固定する。
export SUPABASE_SERVICE_ROLE_KEY=""
export SUPABASE_URL=""
for i in 01 02 03 04 05 06 07 08 09 10; do
  export "E2E_USER_${i}_PASSWORD=${PROD_E2E_USER_PASSWORD}"
done

# ローカル実行時の認証状態 (storageState) を本番実行に持ち込まない
rm -rf tests/e2e/.auth

if [ "$#" -eq 0 ]; then
  set -- tests/e2e/0[1-5]-*.spec.ts
fi

echo "[e2e-prod] target: ${PLAYWRIGHT_BASE_URL}"
npx playwright test "$@" --reporter=list
