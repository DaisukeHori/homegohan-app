#!/bin/bash
# 埋め込み進捗レポートのラッパー
# atコマンドで実行する際に、出力をファイルに保存してターミナルにも表示

cd "$(dirname "$0")/.."
OUTPUT_FILE="/tmp/embedding-report-terminal.log"
node scripts/report-embedding-progress.mjs 2>&1 | tee -a "$OUTPUT_FILE"

# 出力をターミナルに表示（atコマンドで実行された場合でも）
cat "$OUTPUT_FILE" | tail -20
