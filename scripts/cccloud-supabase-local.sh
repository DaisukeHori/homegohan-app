#!/usr/bin/env bash
# =====================================================
# Claude Code Cloud 用: ローカル Supabase 起動スクリプト
# =====================================================
# supabase/migrations を空 DB に全適用したローカル Supabase を Docker で起動し、
# 接続情報を .env.local に書き出す。本番 Supabase には一切接続しない。
#
# 使い方: integration test / dev server の前に 1 回実行
#   bash scripts/cccloud-supabase-local.sh
#   npm run dev
#   npx vitest run --config vitest.integration.config.ts
#
# 注意: クラウド環境の「環境変数」に NEXT_PUBLIC_SUPABASE_URL 等を設定していると
#       そちらが .env.local より優先されるため、Supabase 系の変数は環境変数に入れないこと。
# ローカル(Mac)では no-op。強制実行は FORCE_SETUP=1。
# =====================================================

set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ] && [ "${FORCE_SETUP:-0}" != "1" ]; then
  echo "[supabase-local] ローカル環境のため skip (FORCE_SETUP=1 で強制実行可)"
  exit 0
fi

if ! command -v supabase >/dev/null 2>&1; then
  echo "[supabase-local] supabase CLI が見つかりません。環境のセットアップスクリプトを確認してください" >&2
  exit 1
fi

# Docker デーモン起動 (環境キャッシュには実行中プロセスは残らないため毎セッション必要)
if ! docker info >/dev/null 2>&1; then
  echo "[supabase-local] dockerd を起動"
  (dockerd >/tmp/dockerd.log 2>&1 &)
  for i in $(seq 1 60); do
    docker info >/dev/null 2>&1 && break
    sleep 1
  done
  if ! docker info >/dev/null 2>&1; then
    echo "[supabase-local] dockerd の起動に失敗しました。/tmp/dockerd.log を確認してください" >&2
    exit 1
  fi
fi

# ローカル Supabase 起動 (初回はイメージ pull があるため数分かかる)
supabase start

# 接続情報を取得 (API_URL / ANON_KEY / SERVICE_ROLE_KEY など)
eval "$(supabase status -o env)"

if [ -f .env.local ]; then
  cp .env.local ".env.local.bak.$(date +%s)"
fi

cat > .env.local <<ENVFILE
# scripts/cccloud-supabase-local.sh により自動生成 (ローカル Supabase 向け)
NEXT_PUBLIC_SUPABASE_URL=${API_URL}
SUPABASE_URL=${API_URL}
NEXT_PUBLIC_SUPABASE_ANON_KEY=${ANON_KEY}
SUPABASE_ANON_KEY=${ANON_KEY}
SUPABASE_SERVICE_ROLE_KEY=${SERVICE_ROLE_KEY}
SUPABASE_INTEGRATION_TEST=1
ENVFILE

# Edge Functions をローカルで動かす (supabase functions serve) 用の env。
# Deno.env は Next.js の環境変数を読まないため別ファイルが必要。
# AI キーはクラウド環境変数のダミー値をそのまま渡し、実キーは API認証情報のプロキシが付与する。
# Stripe は本番でも未設定 (mock モード) のため渡さない。
cat > supabase/functions/.env <<FNENV
GOOGLE_AI_STUDIO_API_KEY=${GOOGLE_AI_STUDIO_API_KEY:-}
XAI_API_KEY=${XAI_API_KEY:-}
OPENAI_API_KEY=${OPENAI_API_KEY:-}
GEMINI_IMAGE_MODEL=${GEMINI_IMAGE_MODEL:-}
FNENV

echo "[supabase-local] 起動完了: ${API_URL}"
echo "  Edge Functions: supabase functions serve --env-file supabase/functions/.env"
echo "  次: npm run dev  /  npx vitest run --config vitest.integration.config.ts"
