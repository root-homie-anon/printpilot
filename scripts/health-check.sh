#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_DIR"

ERRORS=0

echo "=== PrintPilot Health Check ==="
echo ""

# Check Node.js version
echo "--- Node.js ---"
if command -v node &> /dev/null; then
  NODE_VERSION=$(node -v)
  echo "OK: Node.js $NODE_VERSION"
  MAJOR_VERSION=$(echo "$NODE_VERSION" | sed 's/v//' | cut -d. -f1)
  if [ "$MAJOR_VERSION" -lt 20 ]; then
    echo "WARN: Node.js >= 20 recommended, found $NODE_VERSION"
    ERRORS=$((ERRORS + 1))
  fi
else
  echo "FAIL: Node.js not found"
  ERRORS=$((ERRORS + 1))
fi
echo ""

# Check npm dependencies
echo "--- Dependencies ---"
if [ -d "node_modules" ]; then
  echo "OK: node_modules exists"
else
  echo "FAIL: node_modules not found. Run 'npm install'"
  ERRORS=$((ERRORS + 1))
fi
echo ""

# Check required environment variables
echo "--- Environment Variables ---"
if [ -f .env ]; then
  set -a
  source .env
  set +a
  echo "OK: .env file loaded"
else
  echo "FAIL: .env file not found. Copy .env.example to .env and fill in values"
  ERRORS=$((ERRORS + 1))
fi

REQUIRED_VARS=(
  "ANTHROPIC_API_KEY"
  "ETSY_API_KEY"
  "ETSY_API_SECRET"
  "ETSY_SHOP_ID"
  "TELEGRAM_BOT_TOKEN"
  "TELEGRAM_CHAT_ID"
)

for VAR in "${REQUIRED_VARS[@]}"; do
  if [ -n "${!VAR:-}" ]; then
    echo "OK: $VAR is set"
  else
    echo "FAIL: $VAR is not set"
    ERRORS=$((ERRORS + 1))
  fi
done

OPTIONAL_VARS=(
  "PINTEREST_ACCESS_TOKEN"
  "EMAIL_PROVIDER"
  "EMAIL_API_KEY"
  "EMAIL_LIST_ID"
  "BLOG_API_URL"
  "BLOG_API_KEY"
  "DASHBOARD_PORT"
  "DASHBOARD_SECRET"
)

for VAR in "${OPTIONAL_VARS[@]}"; do
  if [ -n "${!VAR:-}" ]; then
    echo "OK: $VAR is set"
  else
    echo "WARN: $VAR is not set (optional)"
  fi
done
echo ""

# Check required directories
echo "--- Directories ---"
REQUIRED_DIRS=(
  "src"
  "scripts"
  "shared"
  "state/queue"
  "state/products"
  "state/listings"
  "state/marketing"
  "state/logs"
  "feedback/daily"
  "feedback/weekly"
  "feedback/synthesized"
)

for DIR in "${REQUIRED_DIRS[@]}"; do
  if [ -d "$DIR" ]; then
    echo "OK: $DIR/"
  else
    echo "FAIL: $DIR/ missing"
    ERRORS=$((ERRORS + 1))
  fi
done
echo ""

# Check key config files
echo "--- Config Files ---"
CONFIG_FILES=(
  "config.json"
  "tsconfig.json"
  "package.json"
  ".prettierrc"
)

for FILE in "${CONFIG_FILES[@]}"; do
  if [ -f "$FILE" ]; then
    echo "OK: $FILE"
  else
    echo "FAIL: $FILE missing"
    ERRORS=$((ERRORS + 1))
  fi
done
echo ""

# Summary
echo "=== Health Check Summary ==="
if [ "$ERRORS" -eq 0 ]; then
  echo "All checks passed."
  exit 0
else
  echo "$ERRORS issue(s) found."
  exit 1
fi
