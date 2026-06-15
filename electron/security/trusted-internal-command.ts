import path from 'node:path';
import { auditSecurityEvent } from './audit-log';

export type TrustedInternalCommandOperation =
  | 'gateway:launch'
  | 'gateway:doctor-repair'
  | 'gateway:listener-query'
  | 'gateway:process-tree-kill'
  | 'gateway:launchctl-print'
  | 'gateway:launchctl-bootout';

export interface TrustedInternalCommandRequest {
  operation: TrustedInternalCommandOperation;
  executable: string;
  args: string[];
  cwd?: string;
  source?: string;
}

const SAFE_LAUNCHD_TARGET = /^gui\/\d+\/ai\.openclaw\.gateway$/;

function basenameLower(executable: string): string {
  return path.basename(executable).toLowerCase();
}

function isPositiveInteger(value: string | undefined): boolean {
  return Boolean(value && /^\d+$/.test(value) && Number(value) > 0);
}

function deny(request: TrustedInternalCommandRequest, reason: string): never {
  auditSecurityEvent({
    source: request.source ?? 'system:trusted-internal-command',
    subject: 'system',
    capability: 'internal-command',
    operation: request.operation,
    target: request.executable,
    decision: 'deny',
    risk: 'high',
    reasons: [reason],
    code: 'UNTRUSTED_INTERNAL_COMMAND',
    metadata: {
      executable: request.executable,
      argCount: request.args.length,
      cwd: request.cwd,
    },
  });
  const error = new Error(reason) as Error & { code?: string };
  error.code = 'UNTRUSTED_INTERNAL_COMMAND';
  throw error;
}

function assertGatewayLaunch(request: TrustedInternalCommandRequest): void {
  const portIndex = request.args.indexOf('--port');
  if (
    !/\.(?:js|mjs|cjs)$/i.test(request.executable)
    || request.args[0] !== 'gateway'
    || portIndex < 0
    || !isPositiveInteger(request.args[portIndex + 1])
  ) {
    deny(request, 'Gateway launch must use the bundled entry script and a numeric port');
  }
}

function assertExact(
  request: TrustedInternalCommandRequest,
  executables: string[],
  args: string[],
): void {
  if (
    !executables.includes(basenameLower(request.executable))
    || request.args.length !== args.length
    || request.args.some((value, index) => value !== args[index])
  ) {
    deny(request, `Internal operation ${request.operation} did not match its fixed command shape`);
  }
}

function assertExecutable(request: TrustedInternalCommandRequest, executables: string[]): void {
  if (!executables.includes(basenameLower(request.executable))) {
    deny(request, `Internal operation ${request.operation} must use an allowed executable`);
  }
}

/**
 * 校验由 LYClaw 自身发起的固定维护命令。
 *
 * 这里不是通用命令放行器：每一种静默执行的内部操作都必须有明确名称和参数形状。
 * Agent、Skill、MCP 或 Renderer 传入的动态命令不能使用这个入口绕过 command-policy。
 */
export function assertTrustedInternalCommand(request: TrustedInternalCommandRequest): void {
  switch (request.operation) {
    case 'gateway:launch':
      assertGatewayLaunch(request);
      break;
    case 'gateway:doctor-repair':
      assertExact(request, ['openclaw', 'openclaw.cmd'], ['doctor', '--fix', '--yes', '--non-interactive']);
      break;
    case 'gateway:listener-query':
      assertExecutable(request, ['netstat', 'netstat.exe', 'lsof']);
      if (request.args.length !== 1) {
        deny(request, 'Gateway listener query only accepts the port argument');
      }
      if (!isPositiveInteger(request.args[0])) {
        deny(request, 'Gateway listener query requires a numeric port');
      }
      break;
    case 'gateway:process-tree-kill':
      assertExact(request, ['taskkill', 'taskkill.exe'], ['/F', '/PID', request.args[2] ?? '', '/T']);
      if (!isPositiveInteger(request.args[2])) {
        deny(request, 'Gateway process-tree cleanup requires a numeric PID');
      }
      break;
    case 'gateway:launchctl-print':
      assertExact(request, ['launchctl'], ['print', request.args[1] ?? '']);
      if (!SAFE_LAUNCHD_TARGET.test(request.args[1] ?? '')) {
        deny(request, 'Gateway launchctl query requires the fixed OpenClaw service target');
      }
      break;
    case 'gateway:launchctl-bootout':
      assertExact(request, ['launchctl'], ['bootout', request.args[1] ?? '']);
      if (!SAFE_LAUNCHD_TARGET.test(request.args[1] ?? '')) {
        deny(request, 'Gateway launchctl cleanup requires the fixed OpenClaw service target');
      }
      break;
    default: {
      const exhaustive: never = request.operation;
      deny(request, `Unsupported internal operation: ${String(exhaustive)}`);
    }
  }

  auditSecurityEvent({
    source: request.source ?? 'system:trusted-internal-command',
    subject: 'system',
    capability: 'internal-command',
    operation: request.operation,
    target: request.executable,
    decision: 'allow',
    risk: 'low',
    reasons: ['Allowed fixed LYClaw internal maintenance command'],
    metadata: {
      executable: request.executable,
      argCount: request.args.length,
      cwd: request.cwd,
    },
  });
}
