---
id: mcp-tool-discovery-policy
title: MCP Tool Discovery Policy
type: ai-coding-rule
appliesTo:
  - gateway-backend-communication
requiredProfiles:
  - comms
---

Connector tool inventory must be attributable to one MCP server. Never return an unscoped Gateway/global tool catalog as a per-server inventory.

Prefer an explicit Gateway server bucket or a tool namespace matching the configured server name. When neither exists, remote SSE and streamable HTTP servers may be queried directly with the official MCP client after the existing MCP network-policy preflight succeeds.

Direct discovery must preserve configured headers, enforce bounded timeouts, handle tools/list pagination, and close the MCP client in a finally block. Do not directly spawn stdio MCP commands for UI discovery.

The Host API and connector UI must distinguish successful empty inventories from discovery failures.
