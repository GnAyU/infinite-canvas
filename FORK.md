# Fork notes — GnAyU/infinite-canvas

- Source: https://github.com/basketikun/infinite-canvas (MIT, see LICENSE — retained verbatim)
- Baseline: upstream v0.20.0, commit 9cd3dea, tagged `baseline-upstream-v0.20.0`
- Route (decided 2026-10-31): INDEPENDENT fork for personal, non-commercial use. `main` is our own trunk; we do not track upstream releases. `upstream` remote is read-only reference; security fixes are cherry-picked manually after review.
- No refactoring: changes are additive/config-first; core edits are isolated in their own commits.

## Local standard (this machine)
- Install: `./scripts/setup.sh`  (npm install --legacy-peer-deps — upstream pins antd 6 with a pro-components beta that still peers antd 5; bun install hangs on this machine)
- Develop: `./scripts/dev.sh`    (vite dev on http://localhost:3000)
- Daily use: `./scripts/serve.sh` (production build + preview on http://localhost:3000)

## Our changes
- 2026-10-31: baseline adoption — this file, scripts/, npm-generated package-lock.json.
