#!/bin/bash

echo "=========================================="
echo "環境変数設定ガイド"
echo "=========================================="
echo ""
echo "このスクリプトは .env.local ファイルのテンプレートを作成します。"
echo ""

# .env.local が存在するか確認
if [ -f .env.local ]; then
    echo "⚠️  .env.local が既に存在します。"
    read -p "上書きしますか？ (y/N): " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        echo "キャンセルしました。"
        exit 1
    fi
fi

# テンプレートを作成
cat > .env.local << 'ENVFILE'
# ==========================================
# 環境変数設定ファイル
# ==========================================
# このファイルは .gitignore に含まれているため、Gitにはコミットされません。
# 実際の値を設定してください。

# ==========================================
# Supabase設定
# ==========================================
# Supabase Dashboard (https://app.supabase.com/) から取得
# Settings → API で確認できます
NEXT_PUBLIC_SUPABASE_URL=your_supabase_project_url
NEXT_PUBLIC_SUPABASE_ANON_KEY=your_supabase_anon_key
SUPABASE_SERVICE_ROLE_KEY=your_supabase_service_role_key

# ==========================================
# Google AI (Gemini) 設定
# ==========================================
# Google AI Studio (https://aistudio.google.com/) から取得
# Get API Key で新しいキーを作成
GOOGLE_AI_STUDIO_API_KEY=your_google_ai_api_key
# または
# GOOGLE_GEN_AI_API_KEY=your_google_ai_api_key

# ==========================================
# OpenAI設定（既存機能用）
# ==========================================
# OpenAI Platform (https://platform.openai.com/) から取得
# API keys セクションで確認できます
OPENAI_API_KEY=your_openai_api_key

# ==========================================
# オプション設定
# ==========================================
# 画像生成モデルの選択（デフォルト: gemini-3-pro-image-preview）
# 使用可能な値:
#   - gemini-2.5-flash-image-preview (Nano Banana)
#   - gemini-3-pro-image-preview (Nano Banana Pro - デフォルト)
# GEMINI_IMAGE_MODEL=gemini-3-pro-image-preview
ENVFILE

echo "✅ .env.local テンプレートを作成しました！"
echo ""
echo "次のステップ:"
echo "1. .env.local ファイルを開いて、実際の値を設定してください"
echo "2. 各サービスのダッシュボードからAPIキーを取得してください"
echo "3. 設定後、開発サーバーを再起動してください: npm run dev"
echo ""
echo "詳細は ENV_SETUP.md を参照してください。"
