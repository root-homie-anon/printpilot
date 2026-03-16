#!/usr/bin/env bash
set -uo pipefail
# Note: -e intentionally omitted so we can capture and alert on failures

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

# Ensure log and DLQ directories exist
mkdir -p state/logs state/dead-letter-queue

LOG_FILE="state/logs/daily-$(date +%Y-%m-%d).log"

send_telegram() {
  local message="$1"
  if [ -n "${TELEGRAM_BOT_TOKEN:-}" ] && [ -n "${TELEGRAM_CHAT_ID:-}" ]; then
    curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
      -d chat_id="${TELEGRAM_CHAT_ID}" \
      -d text="${message}" \
      -d parse_mode="HTML" > /dev/null 2>&1 || true
  fi
}

echo "=== PrintPilot Daily Run: $(date -Iseconds) ===" | tee -a "$LOG_FILE"

# Run production pipeline
npx tsx src/pipeline/production.ts 2>&1 | tee -a "$LOG_FILE"
PROD_EXIT=${PIPESTATUS[0]}

if [ "$PROD_EXIT" -ne 0 ]; then
  echo "ERROR: Production pipeline exited with code $PROD_EXIT" | tee -a "$LOG_FILE"
  send_telegram "⚠️ <b>PrintPilot Daily Pipeline FAILED</b>%0A%0AExit code: ${PROD_EXIT}%0ACheck logs: ${LOG_FILE}%0ATime: $(date -Iseconds)"
fi

# Run marketing pipeline (even if production failed — processes existing listings)
echo "=== Marketing Pipeline: $(date -Iseconds) ===" | tee -a "$LOG_FILE"
npx tsx src/pipeline/marketing.ts 2>&1 | tee -a "$LOG_FILE"
MKTG_EXIT=${PIPESTATUS[0]}

if [ "$MKTG_EXIT" -ne 0 ]; then
  echo "ERROR: Marketing pipeline exited with code $MKTG_EXIT" | tee -a "$LOG_FILE"
  send_telegram "⚠️ <b>PrintPilot Marketing Pipeline FAILED</b>%0A%0AExit code: ${MKTG_EXIT}%0ACheck logs: ${LOG_FILE}%0ATime: $(date -Iseconds)"
fi

# Check DLQ for accumulated failures
DLQ_COUNT=$(find state/dead-letter-queue -name '*.json' 2>/dev/null | wc -l)
if [ "$DLQ_COUNT" -gt 0 ]; then
  echo "WARNING: ${DLQ_COUNT} items in dead letter queue" | tee -a "$LOG_FILE"
  send_telegram "📬 <b>Dead Letter Queue:</b> ${DLQ_COUNT} failed items need attention"
fi

# Run health check
echo "=== Health Check: $(date -Iseconds) ===" | tee -a "$LOG_FILE"
bash scripts/health-check.sh 2>&1 | tee -a "$LOG_FILE" || true

echo "=== Daily Run Complete: $(date -Iseconds) ===" | tee -a "$LOG_FILE"

# Exit with worst exit code
if [ "$PROD_EXIT" -ne 0 ]; then
  exit "$PROD_EXIT"
elif [ "$MKTG_EXIT" -ne 0 ]; then
  exit "$MKTG_EXIT"
fi

exit 0
