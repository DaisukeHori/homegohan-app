#!/bin/bash
# 埋め込み進捗レポートを表示

if [ -f "/tmp/embedding-report-terminal.log" ]; then
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "📊 最新の進捗レポート"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  tail -30 /tmp/embedding-report-terminal.log
else
  echo "⏸️  ログファイルが見つかりません"
  echo "   進捗レポートがまだ実行されていないか、"
  echo "   ログファイルが作成されていません"
fi
