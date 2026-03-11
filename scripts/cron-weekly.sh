#!/usr/bin/env bash
set -euo pipefail

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

# Ensure log directory exists
mkdir -p state/logs

LOG_FILE="state/logs/weekly-$(date +%Y-%m-%d).log"

echo "=== PrintPilot Weekly Synthesis: $(date -Iseconds) ===" | tee -a "$LOG_FILE"

npx tsx src/synthesizer/run.ts 2>&1 | tee -a "$LOG_FILE"

EXIT_CODE=${PIPESTATUS[0]}

if [ "$EXIT_CODE" -ne 0 ]; then
  echo "ERROR: Weekly synthesis exited with code $EXIT_CODE" | tee -a "$LOG_FILE"
  exit "$EXIT_CODE"
fi

echo "=== Weekly Synthesis Complete: $(date -Iseconds) ===" | tee -a "$LOG_FILE"
