#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
source .env 2>/dev/null || true
npx tsx scripts/scrape-references.ts "$@"
