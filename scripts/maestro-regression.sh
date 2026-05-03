#!/usr/bin/env bash
# E2E full regression: 全フローを順次実行し結果を CSV 記録
set -uo pipefail

ROOT="/Users/horidaisuke/homegohan"
DEVICE="7286DE50-DBB2-4ACA-95B2-91503630FBEE"
RESULT_FILE="${RESULT_FILE:-/tmp/regression-$(date +%Y%m%d-%H%M%S).csv}"
MAESTRO="${HOME}/.maestro/bin/maestro"
TIMEOUT_SEC=300

# .env.local 読み込み
set -a
source "$ROOT/.env.local"
set +a

# 全フロー収集 (_shared, scripts 除く)
FLOW_LIST=$(find "$ROOT/apps/mobile/maestro/flows" -name "*.yaml" \
    -not -path "*/_shared/*" -not -path "*/scripts/*" | sort)

TOTAL=$(echo "$FLOW_LIST" | wc -l | tr -d ' ')

# CSV ヘッダ
echo "timestamp,flow,result,duration_sec,error" > "$RESULT_FILE"

PASS=0
FAIL=0
COUNT=0

while IFS= read -r f; do
    [ -z "$f" ] && continue
    COUNT=$((COUNT + 1))
    REL="${f#$ROOT/apps/mobile/maestro/flows/}"
    START=$(date +%s)

    OUTPUT=$(gtimeout "$TIMEOUT_SEC" "$MAESTRO" test "$f" --device "$DEVICE" \
        --env E2E_USER_01_EMAIL="$E2E_USER_01_EMAIL" \
        --env E2E_USER_01_PASSWORD="$E2E_USER_01_PASSWORD" \
        --env E2E_USER_02_EMAIL="${E2E_USER_02_EMAIL:-}" \
        --env E2E_USER_02_PASSWORD="${E2E_USER_02_PASSWORD:-}" \
        --env E2E_USER_03_EMAIL="${E2E_USER_03_EMAIL:-}" \
        --env E2E_USER_03_PASSWORD="${E2E_USER_03_PASSWORD:-}" \
        --env E2E_USER_05_EMAIL="${E2E_USER_05_EMAIL:-}" \
        --env E2E_USER_05_PASSWORD="${E2E_USER_05_PASSWORD:-}" \
        --env E2E_USER_07_EMAIL="${E2E_USER_07_EMAIL:-}" \
        --env E2E_USER_07_PASSWORD="${E2E_USER_07_PASSWORD:-}" \
        --env E2E_USER_10_EMAIL="${E2E_USER_10_EMAIL:-}" \
        --env E2E_USER_10_PASSWORD="${E2E_USER_10_PASSWORD:-}" \
        2>&1)
    EXIT=$?
    END=$(date +%s)
    DUR=$((END - START))
    TS=$(date +%Y-%m-%dT%H:%M:%S)

    if [ $EXIT -eq 0 ]; then
        RESULT="PASS"
        PASS=$((PASS + 1))
        ERR=""
    elif [ $EXIT -eq 124 ]; then
        RESULT="TIMEOUT"
        FAIL=$((FAIL + 1))
        ERR="timeout ${TIMEOUT_SEC}s"
    else
        RESULT="FAIL"
        FAIL=$((FAIL + 1))
        ERR=$(echo "$OUTPUT" | grep -oE "(Assertion|Tap|Failed|Error)[^\"]*" | head -1 | tr ',\n' '; ' | head -c 200)
    fi

    # CSV 行 (カンマと改行を escape)
    ERR_ESC=$(printf '%s' "$ERR" | tr ',\n' '; ' | head -c 200)
    echo "${TS},${REL},${RESULT},${DUR},${ERR_ESC}" >> "$RESULT_FILE"

    # 進捗 stdout
    echo "[$COUNT/$TOTAL] $REL = $RESULT (${DUR}s)"
done <<EOF
$FLOW_LIST
EOF

# サマリ
echo "" >> "$RESULT_FILE"
echo "# Summary: ${COUNT} total, ${PASS} pass, ${FAIL} fail" >> "$RESULT_FILE"
echo "Done: ${COUNT} total, ${PASS} pass, ${FAIL} fail"
