#!/bin/bash
# E2E test user の DB 状態をテスト前提にリセット
# 要 SUPABASE_SERVICE_ROLE_KEY と NEXT_PUBLIC_SUPABASE_URL (.env.local から読込)
#
# 解決する問題:
#   - issue #636: E2E_USER_03 が onboarding 完了済のため onboarding 系テストが fail
#   - issue #638: E2E_USER_04 が signup 済のため signup 系テストが fail
#
# 使い方:
#   bash apps/mobile/maestro/scripts/reset-test-users.sh
#   npm run test:e2e:reset-data
#
# 前提: リポジトリルートに .env.local が存在し、以下が設定されていること
#   NEXT_PUBLIC_SUPABASE_URL=https://<project>.supabase.co
#   SUPABASE_SERVICE_ROLE_KEY=<service_role_key>
#
# 呼び出す Supabase RPC:
#   reset_e2e_test_users() — supabase/migrations/*_reset_e2e_test_users.sql で定義

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
ENV_FILE="${REPO_ROOT}/.env.local"

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "[reset-test-users] ERROR: .env.local が見つかりません: ${ENV_FILE}" >&2
  exit 1
fi

# .env.local から必要な変数のみ抽出してエクスポート
source <(grep -E '^(NEXT_PUBLIC_SUPABASE_URL|SUPABASE_SERVICE_ROLE_KEY)=' "${ENV_FILE}" | sed 's/^/export /')

if [[ -z "${NEXT_PUBLIC_SUPABASE_URL:-}" ]]; then
  echo "[reset-test-users] ERROR: NEXT_PUBLIC_SUPABASE_URL が未設定です" >&2
  exit 1
fi

if [[ -z "${SUPABASE_SERVICE_ROLE_KEY:-}" ]]; then
  echo "[reset-test-users] ERROR: SUPABASE_SERVICE_ROLE_KEY が未設定です" >&2
  exit 1
fi

echo "[reset-test-users] Supabase: ${NEXT_PUBLIC_SUPABASE_URL}"
echo "[reset-test-users] RPC reset_e2e_test_users() を実行中..."

RESPONSE=$(curl -sS -w "\n%{http_code}" \
  -X POST "${NEXT_PUBLIC_SUPABASE_URL}/rest/v1/rpc/reset_e2e_test_users" \
  -H "apikey: ${SUPABASE_SERVICE_ROLE_KEY}" \
  -H "Authorization: Bearer ${SUPABASE_SERVICE_ROLE_KEY}" \
  -H "Content-Type: application/json" \
  -d '{}')

HTTP_STATUS=$(echo "${RESPONSE}" | tail -n1)
BODY=$(echo "${RESPONSE}" | head -n-1)

if [[ "${HTTP_STATUS}" -ge 200 && "${HTTP_STATUS}" -lt 300 ]]; then
  echo "[reset-test-users] done (HTTP ${HTTP_STATUS})"
else
  echo "[reset-test-users] ERROR: HTTP ${HTTP_STATUS}" >&2
  echo "[reset-test-users] Response: ${BODY}" >&2
  exit 1
fi
