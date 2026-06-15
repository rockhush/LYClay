---
id: integrate-command-argument-path-policy
title: 命令参数路径接入文件安全策略
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: 将命令中的读写删除路径参数和 shell 重定向目标接入 path-policy，避免命令执行入口绕过 workspace 授权和敏感路径拦截。
touchedAreas:
  - electron/security/command-policy.ts
  - electron/utils/openclaw-auth.ts
  - electron/security/path-policy.ts
  - tests/unit/security-command-policy.test.ts
  - tests/unit/openclaw-auth.test.ts
expectedUserBehavior:
  - Shell output redirected to the platform null device is discarded without a file-write confirmation.
  - 读取命令访问 workspace 内普通文件时可继续放行。
  - 读取命令访问 workspace 外文件时会被拒绝。
  - 命令写入 workspace 内普通文件时需要用户确认。
  - 命令写入 .env、.ssh 等敏感路径时直接拒绝。
  - 删除 workspace 内普通文件时需要用户确认。
  - 删除敏感路径时直接拒绝。
  - sanitizeOpenClawConfig 不写入当前 Gateway schema 不支持的 exec approval 字段，避免启动失败。
requiredProfiles:
  - fast
  - comms
requiredTests:
  - pnpm harness validate --spec harness/specs/tasks/integrate-command-argument-path-policy.md
  - pnpm exec vitest run tests/unit/security-command-policy.test.ts
  - pnpm exec vitest run tests/unit/openclaw-auth.test.ts -t "keeps exec config schema-compatible"
acceptance:
  - command-policy 能识别 cat/type/Get-Content 等读取命令的路径参数。
  - command-policy 能识别 rm/del/Remove-Item 等删除命令的路径参数。
  - command-policy 能识别 Set-Content/Out-File/tee 等写入命令的路径参数。
  - command-policy 能识别 >、>>、< shell 重定向目标。
  - 所有命令路径访问都复用 path-policy 的 workspace、敏感路径和 symlink 规则。
  - sanitizeOpenClawConfig 将不兼容的 tools.exec approval 字段清理为当前 OpenClaw runtime 可接受的配置。
docs:
  required: false
---

## Notes

本阶段只增强命令策略中的本地路径参数判断，不改变实际命令执行器。后续接入更多命令入口时应继续调用统一的 command-policy / policy-engine。
