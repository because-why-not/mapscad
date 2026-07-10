#!/usr/bin/env bash
# Regenerate the golden fixtures. Run this after an INTENTIONAL geometry change or a change of the
# shared test area (tests/testArea.ts — also used by the scenario walkthrough). Requires the tile
# server (see .env) to be reachable. Two parts:
#   1. the golden STL (tests/e2e/fixtures/dunedin-128.stl) — written by the e2e via the app;
#   2. the headless twin's DEM tile fixtures + manifest meta (tests/unit/fixtures/dunedin/) —
#      cleared first (an area change would otherwise leave stale tiles behind), refreshed from the
#      live server, then verified against the golden the e2e just wrote.
set -euo pipefail
cd "$(dirname "$0")"

UPDATE_GOLDEN=1 npx playwright test dunedin-download
rm -f tests/unit/fixtures/dunedin/*
UPDATE_TILES=1 npx vitest run dunedinGolden
