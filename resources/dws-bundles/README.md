# DWS CLI Bundles

This directory stores the pinned DWS CLI archives bundled into packaged apps.
Packaging must use these checked-in archives and must not download the latest
DWS release during CI.

Required files:

```text
darwin/dws-darwin-amd64.tar.gz
darwin/dws-darwin-arm64.tar.gz
win/dws-windows-amd64.zip
win/dws-windows-arm64.zip
linux/dws-linux-amd64.tar.gz
linux/dws-linux-arm64.tar.gz
```

To intentionally refresh the pinned DWS version, run one of the manual download
commands, verify the login flow, then commit the updated archives:

```bash
pnpm run dws:download:mac
pnpm run dws:download:win
pnpm run dws:download:linux
pnpm run dws:verify:mac
pnpm run dws:verify:win
pnpm run dws:verify:linux
```
