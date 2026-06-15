import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

type ShellEntryCategory =
  | 'trusted-internal-command'
  | 'command-policy'
  | 'fixed-launcher-exception'
  | 'security-scanner-pattern';

type ShellEntryRegistration = {
  category: ShellEntryCategory;
  boundary: string;
  reason: string;
};

const ELECTRON_ROOT = path.resolve(process.cwd(), 'electron');

const REGISTERED_SHELL_ENTRYPOINTS: Record<string, ShellEntryRegistration> = {
  'electron/extensions/builtin/company-marketplace.ts': {
    category: 'command-policy',
    boundary: 'assertCommandAllowedWithConfirmation',
    reason: '公司技能市场解压命令来自固定安装流程，但会执行 tar/unzip/PowerShell，因此必须经过命令策略确认和审计。',
  },
  'electron/gateway/clawhub.ts': {
    category: 'command-policy',
    boundary: 'assertCommandAllowedWithConfirmation',
    reason: 'ClawHub CLI 会安装/卸载 Skill，属于可修改本地环境的动态命令，已接入命令策略确认。',
  },
  'electron/gateway/process-launcher.ts': {
    category: 'fixed-launcher-exception',
    boundary: 'assertTrustedInternalCommand + utilityProcess.fork',
    reason: 'Gateway 进程启动器只能启动固定 OpenClaw entry，并在 fork 前校验 gateway:launch；dev preload 只用于限制 runtime child_process。',
  },
  'electron/gateway/supervisor.ts': {
    category: 'trusted-internal-command',
    boundary: 'assertTrustedInternalCommand',
    reason: 'Gateway PID 清理、端口查询、launchctl 和 doctor repair 都属于 LYClaw 内部维护命令，执行前逐项校验固定命令形态并审计。',
  },
  'electron/main/updater.ts': {
    category: 'fixed-launcher-exception',
    boundary: 'signed update installer path',
    reason: '自动更新只启动已经下载好的安装包路径，参数固定为静默安装，不是 Agent/Renderer 可拼接的任意命令通道。',
  },
  'electron/security/command-policy.ts': {
    category: 'security-scanner-pattern',
    boundary: 'policy parser',
    reason: '这里只解析命令字符串里的 shell 风险，不执行本地命令。',
  },
  'electron/security/skill-permission-policy.ts': {
    category: 'security-scanner-pattern',
    boundary: 'permission manifest parser',
    reason: '这里只识别权限声明里的危险命令名，不执行本地命令。',
  },
  'electron/utils/bundled-node.ts': {
    category: 'fixed-launcher-exception',
    boundary: 'bundled node resolver',
    reason: '只用 execFileSync 检测系统 Node 并用 spawnSync 运行固定下载探测脚本，参数不来自 Agent/Skill/MCP。',
  },
  'electron/utils/channel-config.ts': {
    category: 'command-policy',
    boundary: 'assertCommandAllowedWithConfirmation',
    reason: '渠道配置里的外部工具探测会启动本地命令，已通过命令策略确认。',
  },
  'electron/utils/dws-auth.ts': {
    category: 'fixed-launcher-exception',
    boundary: 'DWS auth helper',
    reason: 'DWS 登录/状态/登出命令来自固定认证流程，并通过 execFile/execFileSync 参数数组执行，不再拼接 shell 字符串。',
  },
  'electron/utils/dws-cli-installer.ts': {
    category: 'fixed-launcher-exception',
    boundary: 'DWS installer helper',
    reason: 'DWS CLI 安装器只运行固定 PowerShell 下载/安装辅助命令，入口由设置流程触发；后续可继续接入 trusted-internal-command。',
  },
  'electron/utils/dws-env-setup.ts': {
    category: 'fixed-launcher-exception',
    boundary: 'DWS environment setup helper',
    reason: 'DWS 环境命令通过 execFile/execFileSync 参数数组执行，避免旧的 dwsPath + args shell 拼接。',
  },
  'electron/utils/gemini-cli-oauth.ts': {
    category: 'fixed-launcher-exception',
    boundary: 'Gemini OAuth helper',
    reason: 'Gemini CLI OAuth 只启动固定 OAuth 辅助命令，命令来源不是 Agent/Skill/MCP 动态拼接。',
  },
  'electron/utils/openclaw-cli.ts': {
    category: 'fixed-launcher-exception',
    boundary: 'OpenClaw CLI installer/completion helper',
    reason: 'CLI PATH 修复和补全缓存生成属于打包应用内部维护流程，命令路径和参数由 LYClaw 固定。',
  },
  'electron/utils/openclaw-doctor.ts': {
    category: 'command-policy',
    boundary: 'assertCommandAllowedWithConfirmation + utilityProcess.fork',
    reason: 'Doctor Fix 可能修改本地环境，运行前已接入命令策略确认。',
  },
  'electron/utils/skill-validator.ts': {
    category: 'security-scanner-pattern',
    boundary: 'skill content scanner',
    reason: '这里只扫描 Skill 包内容里的 child_process 危险文本，不执行本地命令。',
  },
  'electron/utils/token-storage.ts': {
    category: 'fixed-launcher-exception',
    boundary: 'environment token helper',
    reason: 'Windows setx 用于固定 DWS token 环境变量维护，已改为 execFileSync 参数数组，避免 token 进入 shell 字符串。',
  },
  'electron/utils/uv-setup.ts': {
    category: 'command-policy',
    boundary: 'assertCommandAllowedWithConfirmation for install path',
    reason: 'uv Python 安装会下载/修改本地环境，安装路径已接入命令策略确认；只读探测为固定维护命令。',
  },
  'electron/utils/win-shell.ts': {
    category: 'security-scanner-pattern',
    boundary: 'spawn argument quoting helper',
    reason: '这里只封装 Windows spawn 参数转义，不执行本地命令。',
  },
};

const commandExecutionPatterns = [
  /\bfrom\s+['"](?:node:)?child_process['"]/,
  /\bimport\(['"](?:node:)?child_process['"]\)/,
  /\brequire\(['"](?:node:)?child_process['"]\)/,
  /\bchild_process\b/,
  /\butilityProcess\.fork\(/,
  /\bcmd\.exe\b/i,
  /\bpowershell(?:\.exe)?\b/i,
  /\bpwsh(?:\.exe)?\b/i,
];

function collectFiles(dir: string): string[] {
  const result: string[] = [];
  for (const entry of readdirSync(dir)) {
    const fullPath = path.join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      result.push(...collectFiles(fullPath));
      continue;
    }
    if (entry.endsWith('.ts')) {
      result.push(fullPath);
    }
  }
  return result;
}

function toRepoPath(filePath: string): string {
  return path.relative(process.cwd(), filePath).replace(/\\/g, '/');
}

function hasShellEntrypoint(content: string): boolean {
  return commandExecutionPatterns.some((pattern) => pattern.test(content));
}

describe('Electron Main shell entrypoint boundary', () => {
  it('requires every electron shell entrypoint file to be classified', () => {
    const detected = collectFiles(ELECTRON_ROOT)
      .filter((filePath) => hasShellEntrypoint(readFileSync(filePath, 'utf8')))
      .map(toRepoPath)
      .sort();

    const registered = Object.keys(REGISTERED_SHELL_ENTRYPOINTS).sort();

    expect(detected).toEqual(registered);
  });

  it('keeps each registered entrypoint tied to an explicit security boundary', () => {
    for (const [filePath, registration] of Object.entries(REGISTERED_SHELL_ENTRYPOINTS)) {
      expect(registration.boundary, `${filePath} missing boundary`).toBeTruthy();
      expect(registration.reason, `${filePath} missing reason`).toBeTruthy();
      expect(registration.reason.length, `${filePath} reason is too vague`).toBeGreaterThan(20);
    }
  });

  it('does not import raw execSync shell execution in electron runtime code', () => {
    const violations: string[] = [];

    for (const filePath of collectFiles(ELECTRON_ROOT)) {
      const repoPath = toRepoPath(filePath);
      const lines = readFileSync(filePath, 'utf8').split(/\r?\n/);
      lines.forEach((line, index) => {
        if (
          /\bimport\s*\{[^}]*\bexecSync\b[^}]*\}\s*from\s*['"](?:node:)?child_process['"]/.test(line)
          || /\bconst\s*\{[^}]*\bexecSync\b[^}]*\}\s*=\s*(?:await\s*)?import\(['"](?:node:)?child_process['"]\)/.test(line)
          || /\bconst\s*\{[^}]*\bexecSync\b[^}]*\}\s*=\s*require\(['"](?:node:)?child_process['"]\)/.test(line)
        ) {
          violations.push(`${repoPath}:${index + 1}: ${line.trim()}`);
        }
      });
    }

    expect(violations).toEqual([]);
  });

  it('does not allow unreviewed fixed-launcher exceptions to dominate the boundary', () => {
    const fixedExceptions = Object.values(REGISTERED_SHELL_ENTRYPOINTS)
      .filter((registration) => registration.category === 'fixed-launcher-exception');
    const commandPolicyEntries = Object.values(REGISTERED_SHELL_ENTRYPOINTS)
      .filter((registration) => registration.category === 'command-policy' || registration.category === 'trusted-internal-command');

    expect(commandPolicyEntries.length).toBeGreaterThan(0);
    expect(fixedExceptions.length).toBeLessThanOrEqual(10);
  });
});
