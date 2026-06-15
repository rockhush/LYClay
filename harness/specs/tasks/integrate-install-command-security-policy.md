---
id: integrate-install-command-security-policy
title: 接入 Skill 与安装类命令安全策略
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: 将 Skill 市场、公司插件市场和 uv Python 安装入口接入命令安全确认，避免安装类命令绕过 Main 进程安全边界。
touchedAreas:
  - electron/security/command-policy.ts
  - electron/gateway/clawhub.ts
  - electron/extensions/builtin/company-marketplace.ts
  - electron/utils/uv-setup.ts
  - tests/unit/security-command-policy.test.ts
  - tests/unit/clawhub-command-security.test.ts
  - tests/unit/company-marketplace-command-security.test.ts
  - tests/unit/uv-setup.test.ts
expectedUserBehavior:
  - Skill 市场安装命令需要经过命令安全策略。
  - 用户拒绝 Skill 安装确认时，不启动 ClawHub 子进程。
  - 公司市场下载后的本地解压命令需要经过命令安全策略。
  - uv Python 安装命令需要经过命令安全策略。
  - npx、pnpm dlx 等远程包运行器被识别为高风险确认项。
requiredProfiles:
  - fast
  - comms
requiredTests:
  - pnpm harness validate --spec harness/specs/tasks/integrate-install-command-security-policy.md
  - pnpm exec vitest run tests/unit/security-command-policy.test.ts tests/unit/clawhub-command-security.test.ts tests/unit/company-marketplace-command-security.test.ts tests/unit/uv-setup.test.ts
acceptance:
  - command-policy 能识别 clawhub install/uninstall 类 Skill 市场变更。
  - command-policy 能识别 npx/pnpm dlx 等远程包运行器为高风险。
  - ClawHub install 在 spawn 前调用 assertCommandAllowedWithConfirmation。
  - 公司市场 archive 命令在 spawn 前调用 assertCommandAllowedWithConfirmation。
  - uv python install 在 spawn 前调用 assertCommandAllowedWithConfirmation。
  - 拒绝确认时不会启动对应子进程。
docs:
  required: false
---

## Notes

本阶段先覆盖安装类入口中风险最高的 ClawHub、公司市场和 uv Python 安装。OpenClaw CLI PATH helper、DWS/Gemini 登录、updater 安装器和更细粒度包管理器策略会在后续阶段继续处理。
