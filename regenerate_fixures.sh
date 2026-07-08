#!/usr/bin/env bash
# Regenerate the dunedin golden fixtures. Run this after an INTENTIONAL geometry change, then
# commit the updated files. Requires the tile server (see .env) to be reachable. Two parts:
#   1. the golden STL (tests/e2e/fixtures/dunedin-128.stl) — written by the e2e via the app;
#   2. the headless twin's DEM tile fixtures + manifest meta (tests/unit/fixtures/dunedin/) —
#      refreshed from the live server, then verified against the golden the e2e just wrote.
set -euo pipefail
cd "$(dirname "$0")"

UPDATE_GOLDEN=1 npx playwright test dunedin-download
UPDATE_TILES=1 npx vitest run dunedinGolden
