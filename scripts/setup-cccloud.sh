#!/usr/bin/env bash
# =====================================================
# Claude Code Cloud (claude.ai/code) Bootstrap Script
# =====================================================
# CCCloud セッション開始時に自動実行される setup スクリプト。
# - .claude/settings.json の SessionStart hook から呼ばれる場合
# - もしくは CCCloud 環境設定 UI の "Setup Script" に直接登録する場合
# どちらでも動くようにしてある。
#
# ローカル開発時 (CCCloud 以外) は no-op で終了する。
# 強制実行したい場合は環境変数 FORCE_SETUP=1 を渡す。
# =====================================================

set -euo pipefail

# Cloud 環境判定 (CLAUDE_CODE_REMOTE / CODESPACES / CCC_* 等)
IS_CLOUD="${CLAUDE_CODE_REMOTE:-}${CODESPACES:-}${CLOUD_SHELL:-}"
if [ -z "$IS_CLOUD" ] && [ "${FORCE_SETUP:-0}" != "1" ]; then
  echo "[setup-cccloud] ローカル環境のため skip (FORCE_SETUP=1 で強制実行可)"
  exit 0
fi

echo "[setup-cccloud] 開始"

# --- Node 依存解決 ---
if [ -f package-lock.json ]; then
  echo "[setup-cccloud] npm ci"
  npm ci --prefer-offline --no-audit --progress=false
else
  echo "[setup-cccloud] npm install"
  npm install --no-audit --progress=false
fi

# --- 外部 CLI (apt が使える場合のみ) ---
if command -v apt-get >/dev/null 2>&1; then
  if ! command -v gh >/dev/null 2>&1; then
    echo "[setup-cccloud] gh CLI を install"
    (curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      | sudo dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg) || true
    sudo chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg || true
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      | sudo tee /etc/apt/sources.list.d/github-cli.list > /dev/null
    sudo apt-get update -qq && sudo apt-get install -y -qq gh || true
  fi
fi

# Supabase CLI (npx で都度実行する方針なのでグローバル install しない)
echo "[setup-cccloud] supabase CLI は 'npx supabase@2.62.10 ...' で利用"

# EAS CLI (mobile build は CCCloud では実行しない想定だが、念のため)
if [ "${INSTALL_EAS:-0}" = "1" ]; then
  npm install -g eas-cli || true
fi

# --- Playwright ブラウザ (E2E が cloud で必要なら 1 回 install) ---
if [ "${INSTALL_PLAYWRIGHT:-0}" = "1" ]; then
  npx playwright install --with-deps chromium || true
fi

echo "[setup-cccloud] 完了"
