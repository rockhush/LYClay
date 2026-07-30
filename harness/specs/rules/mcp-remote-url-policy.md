---
id: mcp-remote-url-policy
title: MCP Remote URL Policy
type: ai-coding-rule
appliesTo:
  - gateway-backend-communication
requiredProfiles:
  - comms
---

Remote MCP configuration must retain the exact user-provided URL for the OpenClaw runtime, including query parameters required by the MCP provider.

Remote SSE and streamable HTTP configuration accepts `http`, `https`, `ws`, and `wss`. Every accepted protocol must run through the shared network policy; structural validation must not silently skip policy evaluation for HTTP or WS.

MCP configuration preflight must evaluate a query-free and fragment-free copy of the URL through the shared network policy. This keeps protocol, hostname, domain grant, private-address, metadata-address, and port checks active without treating an explicitly configured MCP credential as generic secret exfiltration.

Do not add a general-purpose secret-scan bypass to `NetworkPolicyRequest`. Agent, Skill, host-api, Gateway proxy, redirect, and other ordinary outbound requests must continue to reject detected secrets.

Network security audit and confirmation summaries must not introduce new plaintext exposure of MCP query credentials.
