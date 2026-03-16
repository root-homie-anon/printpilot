#!/usr/bin/env bash
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_DIR"

# Load environment variables
if [ -f .env ]; then
  set -a
  source .env
  set +a
else
  echo "ERROR: .env file not found at $PROJECT_DIR/.env"
  exit 1
fi

mkdir -p state/logs

LOG_FILE="state/logs/weekly-$(date +%Y-%m-%d).log"

send_telegram() {
  local message="$1"
  if [ -n "${TELEGRAM_BOT_TOKEN:-}" ] && [ -n "${TELEGRAM_CHAT_ID:-}" ]; then
    curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
      -d chat_id="${TELEGRAM_CHAT_ID}" \
      -d text="${message}" \
      -d parse_mode="HTML" > /dev/null 2>&1 || true
  fi
}

echo "=== PrintPilot Weekly Synthesis: $(date -Iseconds) ===" | tee -a "$LOG_FILE"

npx tsx src/synthesizer/run.ts 2>&1 | tee -a "$LOG_FILE"
EXIT_CODE=${PIPESTATUS[0]}

if [ "$EXIT_CODE" -ne 0 ]; then
  echo "ERROR: Weekly synthesis exited with code $EXIT_CODE" | tee -a "$LOG_FILE"
  send_telegram "⚠️ <b>PrintPilot Weekly Synthesis FAILED</b>%0A%0AExit code: ${EXIT_CODE}%0ACheck logs: ${LOG_FILE}%0ATime: $(date -Iseconds)"
  exit "$EXIT_CODE"
fi

echo "=== Weekly Synthesis Complete: $(date -Iseconds) ===" | tee -a "$LOG_FILE"
