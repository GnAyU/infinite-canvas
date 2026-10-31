#!/bin/sh
set -e
cd "$(dirname "$0")/../web"
[ -d node_modules ] || npm install --legacy-peer-deps --no-audit --no-fund
npm run build
npm run start
