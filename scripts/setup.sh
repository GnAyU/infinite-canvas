#!/bin/sh
set -e
"$(dirname "$0")/check-web-toolchain.sh"
cd "$(dirname "$0")/../web"
bun install --frozen-lockfile --registry=https://registry.npmjs.org
