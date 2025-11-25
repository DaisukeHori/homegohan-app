#!/bin/bash
echo "🔍 .env.localファイルのチェック"
echo ""

if [ ! -f ".env.local" ]; then
  echo "❌ .env.localファイルが見つかりません"
  echo "   プロジェクトルートに.env.localファイルを作成してください"
  exit 1
fi

echo "✅ .env.localファイルが見つかりました"
echo ""

# 必須環境変数のリスト
required_vars=(
  "NEXT_PUBLIC_SUPABASE_URL"
  "NEXT_PUBLIC_SUPABASE_ANON_KEY"
  "SUPABASE_URL"
  "SUPABASE_SERVICE_ROLE_KEY"
  "OPENAI_API_KEY"
  "NEXT_PUBLIC_APP_NAME"
)

missing_vars=()
found_vars=()

for var in "${required_vars[@]}"; do
  if grep -q "^${var}=" .env.local 2>/dev/null; then
    value=$(grep "^${var}=" .env.local | cut -d'=' -f2- | tr -d ' ')
    if [ -z "$value" ]; then
      echo "⚠️  $var: 設定されていますが値が空です"
      missing_vars+=("$var")
    else
      # セキュリティのため、値の一部のみ表示
      if [[ "$var" == *"KEY"* ]] || [[ "$var" == *"SECRET"* ]]; then
        display_value="${value:0:10}..."
      else
        display_value="$value"
      fi
      echo "✅ $var: $display_value"
      found_vars+=("$var")
    fi
  else
    echo "❌ $var: 設定されていません"
    missing_vars+=("$var")
  fi
done

echo ""
echo "=" | head -c 50
echo ""

if [ ${#missing_vars[@]} -eq 0 ]; then
  echo ""
  echo "✅ すべての必須環境変数が正しく設定されています！"
  echo "   設定済み: ${#found_vars[@]}個"
  exit 0
else
  echo ""
  echo "❌ 以下の環境変数が設定されていません:"
  for var in "${missing_vars[@]}"; do
    echo "   - $var"
  done
  echo ""
  echo "💡 ENV_CHECKLIST.mdを参照して設定してください"
  exit 1
fi
