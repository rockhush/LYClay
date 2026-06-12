# Task: MCP Host API & connectors UI

**Scenario:** `harness/specs/scenarios/gateway-backend-communication.md`

## Scope

- Host API routes under `/api/mcp/*` (servers list, enable/disable, config read/write/validate).
- Host API routes under `/api/connectors/*` (install built-in Notion/GitHub, uninstall, enable/disable reserved keys).
- Renderer entry via `hostApiFetch` only (`src/lib/host-api.ts`); Gateway reload triggered from Main Host API context using `GatewayManager.debouncedReload()`.

## Validation

```bash
pnpm harness validate --spec harness/specs/tasks/mcp-host-api-connectors.md
```
