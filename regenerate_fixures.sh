#!/usr/bin/env bash
# Regenerate the e2e golden fixtures (the stored STL the Dunedin download test compares
# against). Run this after an INTENTIONAL geometry change, then commit the updated file in
# tests/e2e/fixtures/. Requires the tile server (see .env) to be reachable.
set -euo pipefail
cd "$(dirname "$0")"

UPDATE_GOLDEN=1 npx playwright test dunedin-download
