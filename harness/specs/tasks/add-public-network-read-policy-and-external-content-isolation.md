---
id: add-public-network-read-policy-and-external-content-isolation
title: Add public network read policy and external content isolation primitives
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: Reduce confirmation fatigue for ordinary public HTTPS reads while preserving local SSRF checks, outbound secret blocking, suspicious URL confirmation, redirect checks, and reusable untrusted external-content isolation.
touchedAreas:
  - electron/security/network-policy.ts
  - electron/security/network-fetch.ts
  - electron/security/network-preflight.ts
  - electron/security/external-content-policy.ts
  - tests/unit/security-network-policy.test.ts
  - tests/unit/security-network-fetch.test.ts
  - tests/unit/security-network-preflight.test.ts
  - tests/unit/security-external-content-policy.test.ts
expectedUserBehavior:
  - URLs explicitly included in user chat messages may be read without a domain grant when they are ordinary HTTPS GET targets.
  - Private addresses, localhost bypasses, insecure HTTP reads, URL shorteners, raw public IP targets, non-default ports, and executable downloads remain blocked or require confirmation.
  - Outbound requests carrying tokens, credentials, or other recognized secrets are blocked before leaving Main-controlled fetch paths.
  - External text passed through the isolation primitive is redacted, scanned for prompt injection, and wrapped as untrusted reference material before model-context use.
  - OpenClaw-internal browser ingestion is not claimed as covered until its runtime bridge is connected to the isolation primitive.
requiredProfiles:
  - fast
  - comms
requiredTests:
  - pnpm harness validate --spec harness/specs/tasks/add-public-network-read-policy-and-external-content-isolation.md
  - pnpm exec vitest run tests/unit/security-network-policy.test.ts tests/unit/security-network-fetch.test.ts tests/unit/security-network-preflight.test.ts tests/unit/security-external-content-policy.test.ts
  - pnpm run comms:replay
  - pnpm run comms:compare
acceptance:
  - Network policy distinguishes public-read requests from generic connect and send-data requests.
  - Ordinary HTTPS GET public reads are allowed without persistent domain grants.
  - Suspicious public-read URL shapes require confirmation and sensitive outbound payloads are denied.
  - Secure Main-controlled fetch applies initial request and redirect policy checks and writes audit events.
  - External content isolation redacts secrets, performs prompt-injection scanning, emits an audit event, and withholds critical matches.
docs:
  required: false
---

## Notes

This stage adds the local policy primitives without adding synchronous external threat-intelligence lookups. DNS-resolution-based rebinding protection and OpenClaw-internal browser content ingestion remain separate follow-up work.
