#!/bin/sh
set -e
if [ "$(bun --version)" != "1.4.4" ] || [ "$(node --version)" != "v22.23.4" ]; then
    printf '%s\n' 'Web requires Bun 1.4.4 and Node 22.23.4 on PATH; see FORK.md.' >&2
    exit 1
fi
