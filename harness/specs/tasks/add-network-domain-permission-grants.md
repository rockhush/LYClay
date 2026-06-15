---
id: add-network-domain-permission-grants
title: 添加网络域名授权记录
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: 扩展安全授权记录中心，支持 session 和 persistent 域名授权，让网络策略可以在用户确认后复用域名 grant，同时保持私网、localhost 非授权端口和危险协议的拒绝优先级。
touchedAreas:
  - electron/security/**
  - tests/unit/security-network-policy.test.ts
  - tests/unit/security-permission-store.test.ts
expectedUserBehavior:
  - 未知公网域名默认仍然返回需要确认。
  - 用户确认后写入的 session 域名授权可以在当前会话内放行对应域名。
  - persistent 域名授权可以在权限 store 重新加载后继续生效。
  - 撤销或过期的域名授权不再放行网络访问。
  - 私网地址、metadata 地址、危险协议和未授权 localhost 端口即使存在授权记录也继续拒绝。
requiredProfiles:
  - fast
  - comms
requiredTests:
  - pnpm harness validate --spec harness/specs/tasks/add-network-domain-permission-grants.md
  - pnpm exec vitest run tests/unit/security-network-policy.test.ts tests/unit/security-permission-store.test.ts
acceptance:
  - Permission store 支持 domain grants，并可区分 session 和 persistent scope。
  - persistent domain grants 会写入 security-permissions.json，且不会覆盖已有 path grants。
  - Network policy 在默认白名单之后查询 domain grants。
  - 网络危险拒绝项优先于 domain grants。
  - domain grant 的持久化、撤销、过期和子域名匹配都有单元测试覆盖。
docs:
  required: false
---

## Notes

本阶段仍不实现最终确认弹窗 UI。后续 UI 可以在用户选择“本次 / 本会话 / 永久允许”后调用 domain grant 写入函数。
