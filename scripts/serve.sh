#!/bin/sh
set -e
"$(dirname "$0")/setup.sh"
cd "$(dirname "$0")/../web"
bun run build
bun run start "$@"
