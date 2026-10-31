#!/bin/sh
set -e
cd "$(dirname "$0")/../web"
npm install --legacy-peer-deps --no-audit --no-fund
