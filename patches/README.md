# OpenClaw patches

LYClaw no longer uses `pnpm.patchedDependencies` on hashed `dist/*.js` bundles
(those patches break whenever OpenClaw republishes the same semver).

Runtime changes are applied by:

- `scripts/openclaw-lyclaw-patches.mjs` — core LYClaw behavior (digital employees, chat.send fields, skill workshop, context window)
- `scripts/patch-openclaw-dev.mjs` — postinstall runner (lyclaw + transport/usage/silent-reply/web-fetch/shell snapshot)
- `scripts/bundle-openclaw.mjs` — same patches when packaging for electron-builder

`openclaw@2026.6.5.patch` is kept for historical reference only.
