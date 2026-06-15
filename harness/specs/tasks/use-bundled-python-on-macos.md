---
id: use-bundled-python-on-macos
title: Use bundled Python in packaged macOS builds
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: Prefer the packaged managed Python runtime and avoid unnecessary downloads after installation.
touchedAreas:
  - electron/utils/uv-setup.ts
  - electron-builder.yml
  - .github/workflows/build-mac.yml
expectedUserBehavior:
  - A packaged macOS app detects and uses its bundled Python runtime.
  - Python setup does not download another runtime when a valid bundled runtime exists.
  - Each macOS architecture receives matching uv and Python binaries.
requiredProfiles:
  - fast
  - comms
requiredTests:
  - tests/unit/uv-setup.test.ts
acceptance:
  - Bundled Python lookup uses the installed app resources path.
  - User-managed Python remains the fallback when bundled Python is unavailable.
  - Python installation writes only to the user-managed uv directory.
  - macOS x64 and arm64 packages contain matching Python runtimes.
docs:
  required: false
---

This task fixes packaged Python discovery and macOS architecture-specific runtime bundling.
