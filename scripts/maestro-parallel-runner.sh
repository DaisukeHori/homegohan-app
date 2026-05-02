#!/usr/bin/env bash
# scripts/maestro-parallel-runner.sh
#
# Maestro flow を 10 並列 sim で実行し結果を集計するスクリプト。
# 5 分 timeout で stuck flow を強制終了し次へ進む。

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FLOWS_DIR="$REPO_ROOT/apps/mobile/maestro/flows"
RESULT_DIR="${RESULT_DIR:-/tmp/maestro-results}"
PARALLEL_COUNT="${PARALLEL_COUNT:-10}"
PER_FLOW_TIMEOUT="${PER_FLOW_TIMEOUT:-300}"  # 5 min

mkdir -p "$RESULT_DIR"

# .env.local 読み込み
if [ -f "$REPO_ROOT/.env.local" ]; then
  set -a
  source "$REPO_ROOT/.env.local"
  set +a
fi

# Sim UDID 取得 (iPhone-E2E-01..PARALLEL_COUNT)
SIMS=()
for i in $(seq 1 "$PARALLEL_COUNT"); do
  N=$(printf "%02d" "$i")
  UDID=$(xcrun simctl list devices | grep "iPhone-E2E-$N " | grep -oE '[A-F0-9-]{36}' | head -1)
  [ -n "$UDID" ] && SIMS+=("$UDID")
done
[ ${#SIMS[@]} -eq 0 ] && echo "ERROR: no iPhone-E2E sims found" >&2 && exit 1
echo "Using ${#SIMS[@]} sims"

# 全 flow を列挙
mapfile -t FLOWS < <(find "$FLOWS_DIR" -name '*.yaml' ! -name 'login.yaml' ! -name 'config.yaml' | sort)
echo "Total flows: ${#FLOWS[@]}"

# キュー作成 (sim 数に分散)
for i in $(seq 0 $((${#SIMS[@]} - 1))); do
  > "$RESULT_DIR/queue-$i.txt"
  > "$RESULT_DIR/sim-$i.log"
done
for idx in "${!FLOWS[@]}"; do
  echo "${FLOWS[$idx]}" >> "$RESULT_DIR/queue-$((idx % ${#SIMS[@]})).txt"
done

# 並列ジョブ起動 (各 sim ごとに subshell)
export PATH="$HOME/.maestro/bin:$PATH"

for sim_idx in "${!SIMS[@]}"; do
  (
    udid="${SIMS[$sim_idx]}"
    log="$RESULT_DIR/sim-$sim_idx.log"
    queue="$RESULT_DIR/queue-$sim_idx.txt"

    while IFS= read -r flow; do
      [ -z "$flow" ] && continue

      # 5 分 timeout で flow 実行 (gtimeout は brew install coreutils で導入されてる前提)
      TIMEOUT_CMD=$(command -v gtimeout || command -v timeout)
      if [ -z "$TIMEOUT_CMD" ]; then
        # timeout コマンド無し: そのまま実行 (危険だが macOS のデフォルト)
        TIMEOUT_CMD="cat"
        TIMEOUT_ARGS=""
      else
        TIMEOUT_ARGS="--kill-after=10 $PER_FLOW_TIMEOUT"
      fi

      START=$(date +%s)
      if [ "$TIMEOUT_CMD" = "cat" ]; then
        if maestro --device "$udid" test \
             --env E2E_USER_EMAIL="${E2E_USER_01_EMAIL:-}" \
             --env E2E_USER_PASSWORD="${E2E_USER_01_PASSWORD:-}" \
             --env E2E_USER_01_EMAIL="${E2E_USER_01_EMAIL:-}" \
             --env E2E_USER_01_PASSWORD="${E2E_USER_01_PASSWORD:-}" \
             --env E2E_USER_02_EMAIL="${E2E_USER_02_EMAIL:-}" \
             --env E2E_USER_02_PASSWORD="${E2E_USER_02_PASSWORD:-}" \
             "$flow" >/dev/null 2>&1; then
          STATUS=PASS
        else
          STATUS=FAIL
        fi
      else
        if "$TIMEOUT_CMD" $TIMEOUT_ARGS maestro --device "$udid" test \
             --env E2E_USER_EMAIL="${E2E_USER_01_EMAIL:-}" \
             --env E2E_USER_PASSWORD="${E2E_USER_01_PASSWORD:-}" \
             --env E2E_USER_01_EMAIL="${E2E_USER_01_EMAIL:-}" \
             --env E2E_USER_01_PASSWORD="${E2E_USER_01_PASSWORD:-}" \
             --env E2E_USER_02_EMAIL="${E2E_USER_02_EMAIL:-}" \
             --env E2E_USER_02_PASSWORD="${E2E_USER_02_PASSWORD:-}" \
             "$flow" >/dev/null 2>&1; then
          STATUS=PASS
        elif [ $? -eq 124 ]; then
          STATUS="FAIL (TIMEOUT)"
        else
          STATUS=FAIL
        fi
      fi
      ELAPSED=$(($(date +%s) - START))
      echo "$STATUS [${ELAPSED}s]: $flow" >> "$log"
    done < "$queue"
    echo "DONE $sim_idx" >> "$log"
  ) &
done

# 完了待ち + 進捗表示
START=$(date +%s)
DEADLINE=$((START + 5400))  # 90 min
while [ $(date +%s) -lt $DEADLINE ]; do
  DONE=$(grep -l '^DONE' "$RESULT_DIR"/sim-*.log 2>/dev/null | wc -l | tr -d ' ')
  PASS=$(grep -h '^PASS' "$RESULT_DIR"/sim-*.log 2>/dev/null | wc -l | tr -d ' ')
  FAIL=$(grep -h '^FAIL' "$RESULT_DIR"/sim-*.log 2>/dev/null | wc -l | tr -d ' ')
  echo "[$(date +%H:%M:%S)] done=$DONE/${#SIMS[@]} pass=$PASS fail=$FAIL"
  [ "$DONE" -eq "${#SIMS[@]}" ] && break
  sleep 30
done

# 集計
echo ""
echo "=== TOTAL ==="
echo "PASS: $(grep -h '^PASS' "$RESULT_DIR"/sim-*.log 2>/dev/null | wc -l)"
echo "FAIL: $(grep -h '^FAIL' "$RESULT_DIR"/sim-*.log 2>/dev/null | wc -l)"
echo "TIMEOUT: $(grep -h 'TIMEOUT' "$RESULT_DIR"/sim-*.log 2>/dev/null | wc -l)"

echo ""
echo "=== BY DOMAIN ==="
for d in auth onboarding home menus-weekly meals favorites shopping pantry recipes badges health ai settings profile comparison; do
  total=$(grep -h "$d/" "$RESULT_DIR"/sim-*.log 2>/dev/null | wc -l)
  pass=$(grep -h "^PASS.*$d/" "$RESULT_DIR"/sim-*.log 2>/dev/null | wc -l)
  printf "%-15s %3d / %3d\n" "$d" "$pass" "$total"
done
