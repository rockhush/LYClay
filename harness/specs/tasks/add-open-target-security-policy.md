---
id: add-open-target-security-policy
title: 添加打开目标安全策略
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: 统一管控外部链接、本地路径、file URL、资源管理器显示和 Skill 路径打开能力，避免通过 shell.openExternal/openPath 绕过文件与网络安全策略。
touchedAreas:
  - electron/security/open-target-policy.ts
  - electron/security/confirmation-service.ts
  - electron/security/types.ts
  - electron/main/ipc-handlers.ts
  - electron/gateway/clawhub.ts
  - src/components/security/SecurityConfirmationDialog.tsx
  - tests/unit/security-open-target-policy.test.ts
  - tests/unit/security-confirmation-service.test.ts
  - tests/unit/security-confirmation-dialog.test.tsx
expectedUserBehavior:
  - 用户点击普通 HTTPS 外部网页时按公开只读访问直接打开；HTTP、短链接、原始 IP、非默认端口和危险下载仍需确认。
  - 用户对 HTTP/HTTPS 外部目标选择“本次启动允许”后，本次应用启动期间同一精确域名的其他链接不再确认，其他域名仍按策略判断。
  - file: URL 不直接作为外部链接打开，而是转换成本地路径并走文件路径策略。
  - workspace 内普通 file: URL 或本地路径可以打开。
  - 敏感路径、非授权路径和危险协议会被拒绝。
  - 未授权 HTTPS/HTTP 目标需要确认或被网络策略阻断。
  - mailto: 需要确认。
  - 未知自定义协议默认拒绝。
requiredProfiles:
  - fast
  - comms
requiredTests:
  - pnpm harness validate --spec harness/specs/tasks/add-open-target-security-policy.md
  - pnpm exec vitest run tests/unit/security-open-target-policy.test.ts tests/unit/security-confirmation-service.test.ts tests/unit/security-confirmation-dialog.test.tsx
acceptance:
  - shell:openExternal 通过 open-target policy 决定 openExternal 或降级 openPath。
  - shell:openPath 和 shell:showItemInFolder 通过 open-target/path policy。
  - ClawHub openSkillReadme/openSkillPath 通过 open-target/path policy。
  - file: URL 不能绕过 path-policy。
  - javascript/data/vbscript 被直接拒绝。
  - open-target 确认弹窗有单元测试覆盖。
docs:
  required: false
---

## Notes

本阶段不实现自定义协议 allowlist UI，也不实现非 workspace 文件的临时打开授权。后续如需让用户临时打开任意本地文件，可以在文件路径授权 UI 中扩展一次性 open 授权。
