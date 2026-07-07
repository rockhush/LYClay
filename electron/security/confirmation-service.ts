import crypto from 'node:crypto';
import type { BrowserWindow, IpcMain } from 'electron';
import { commandToString, evaluateCommandPolicy } from './command-policy';
import { evaluateNetworkPolicy } from './network-policy';
import { evaluateOpenTargetPolicy } from './open-target-policy';
import { evaluatePathPolicy } from './path-policy';
import {
  findCommandGrant,
  findMcpServerGrant,
  findPathGrant,
  grantCommandAccess,
  grantDomainAccess,
  grantMcpServerAccess,
  grantPathAccess,
} from './permission-store';
import { auditConfirmationDecision } from './audit-log';
import { applyCurrentSecurityModeToDecision, getSecurityMode } from './security-mode';
import {
  describeMcpServer,
  getMcpServerConfirmationReasons,
  getMcpServerConfirmationRisk,
  getMcpServerTransport,
} from './mcp-server-policy';
import type { McpServerEntry } from '../utils/mcp-json';
import type {
  CommandPolicyRequest,
  CommandPolicyResult,
  NetworkPolicyRequest,
  NetworkPolicyResult,
  OpenTargetPolicyResult,
  OpenTargetRequest,
  PathPolicyRequest,
  PathPolicyResult,
  SecurityConfirmationRequest,
  SecurityConfirmationResponse,
  SecurityDecision,
} from './types';

const CONFIRMATION_TIMEOUT_MS = 60_000;

let confirmationWindow: BrowserWindow | null = null;
const pending = new Map<string, (response: SecurityConfirmationResponse) => void>();
const openTargetSessionGrants = new Set<string>();

type SecurityConfirmationRequestInput =
  SecurityConfirmationRequest extends infer Request
    ? Request extends SecurityConfirmationRequest
      ? Omit<Request, 'id'>
      : never
    : never;

function networkToError(result: NetworkPolicyResult): Error & { code?: string; decision?: SecurityDecision } {
  const error = new Error(result.decision.reasons.join('; ')) as Error & {
    code?: string;
    decision?: SecurityDecision;
  };
  error.code = result.decision.action === 'deny' ? result.decision.code : 'NETWORK_REQUIRES_CONFIRMATION';
  error.decision = result.decision;
  return error;
}

function commandToError(result: CommandPolicyResult): Error & { code?: string; decision?: SecurityDecision } {
  const error = new Error(result.decision.reasons.join('; ')) as Error & {
    code?: string;
    decision?: SecurityDecision;
  };
  error.code = result.decision.action === 'deny' ? result.decision.code : 'COMMAND_REQUIRES_CONFIRMATION';
  error.decision = result.decision;
  return error;
}

function openTargetToError(result: OpenTargetPolicyResult): Error & { code?: string; decision?: SecurityDecision } {
  const error = new Error(result.decision.reasons.join('; ')) as Error & {
    code?: string;
    decision?: SecurityDecision;
  };
  error.code = result.decision.action === 'deny' ? result.decision.code : 'OPEN_TARGET_REQUIRES_CONFIRMATION';
  error.decision = result.decision;
  return error;
}

export function registerSecurityConfirmationHandlers(ipcMain: IpcMain, mainWindow: BrowserWindow): void {
  confirmationWindow = mainWindow;
  ipcMain.handle('security:confirmation-response', async (_event, response: SecurityConfirmationResponse) => {
    const resolver = pending.get(response?.id);
    if (!resolver) return { success: false, error: 'Unknown security confirmation request' };
    pending.delete(response.id);
    resolver(response);
    return { success: true };
  });
}

export function resetSecurityConfirmationForTests(): void {
  pending.clear();
  confirmationWindow = null;
  openTargetSessionGrants.clear();
}

export async function requestSecurityConfirmation(request: SecurityConfirmationRequestInput): Promise<SecurityConfirmationResponse> {
  const id = crypto.randomUUID();
  const payload: SecurityConfirmationRequest = { ...request, id };

  return await new Promise<SecurityConfirmationResponse>((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      const response: SecurityConfirmationResponse = { id, choice: 'deny' };
      auditConfirmationDecision(payload, response);
      resolve(response);
    }, CONFIRMATION_TIMEOUT_MS);

    pending.set(id, (response) => {
      clearTimeout(timer);
      auditConfirmationDecision(payload, response);
      resolve(response);
    });

    if (!confirmationWindow || confirmationWindow.isDestroyed()) {
      pending.delete(id);
      clearTimeout(timer);
      const response: SecurityConfirmationResponse = { id, choice: 'deny' };
      auditConfirmationDecision(payload, response);
      resolve(response);
      return;
    }

    confirmationWindow.webContents.send('security:confirmation-request', payload);
  });
}

function openTargetFingerprint(request: OpenTargetRequest, result: OpenTargetPolicyResult): string {
  return [
    result.url ?? result.realPath ?? request.target,
    request.capability,
    String(request.source ?? 'unknown'),
  ].join('\n');
}

export async function assertNetworkAllowedWithConfirmation(request: NetworkPolicyRequest): Promise<NetworkPolicyResult> {
  const rawResult = await evaluateNetworkPolicy(request);
  const result = {
    ...rawResult,
    decision: await applyCurrentSecurityModeToDecision(rawResult.decision),
  };
  if (result.decision.action === 'allow') return result;
  if (result.decision.action === 'deny') throw networkToError(result);

  const hostname = result.hostname;
  const url = result.url;
  if (!hostname || !url) throw networkToError(result);

  const response = await requestSecurityConfirmation({
    kind: 'network',
    source: request.source ?? 'unknown',
    risk: result.decision.risk,
    target: { url, hostname },
    reasons: result.decision.reasons,
  });

  if (response.choice === 'deny') {
    const error = new Error(`Network access denied: ${hostname}`) as Error & {
      code?: string;
      decision?: SecurityDecision;
    };
    error.code = 'NETWORK_ACCESS_DENIED_BY_USER';
    error.decision = result.decision;
    throw error;
  }

  if (response.choice === 'allow-session' || response.choice === 'allow-persistent') {
    await grantDomainAccess(hostname, {
      persistent: response.choice === 'allow-persistent',
      source: 'security-confirmation',
    });
  }

  return {
    ...result,
    matchedRule: response.choice === 'allow-once' ? 'confirmed-once' : 'confirmed-domain-grant',
    decision: {
      action: 'allow',
      risk: result.decision.risk,
      reasons: [`Allowed by user confirmation for ${hostname}`],
    },
  };
}

export async function assertCommandAllowedWithConfirmation(request: CommandPolicyRequest): Promise<CommandPolicyResult> {
  const rawResult = await evaluateCommandPolicy(request);
  const result = {
    ...rawResult,
    decision: await applyCurrentSecurityModeToDecision(rawResult.decision),
  };
  if (result.decision.action === 'allow') return result;
  if (result.decision.action === 'deny') throw commandToError(result);

  const command = result.command || commandToString(request);
  const source = request.source ?? 'unknown';
  const existingGrant = await findCommandGrant({
    command,
    cwd: request.cwd,
    source,
  });
  if (existingGrant) {
    const confirmedResult = await evaluateCommandPolicy({ ...request, confirmed: true });
    return {
      ...confirmedResult,
      decision: await applyCurrentSecurityModeToDecision(confirmedResult.decision),
    };
  }

  const response = await requestSecurityConfirmation({
    kind: 'command',
    source,
    risk: result.decision.risk,
    target: {
      command,
      cwd: result.cwd,
      segments: result.segments,
    },
    reasons: result.decision.reasons,
  });

  if (response.choice === 'deny') {
    const error = new Error(`Command execution denied: ${command}`) as Error & {
      code?: string;
      decision?: SecurityDecision;
    };
    error.code = 'COMMAND_EXECUTION_DENIED_BY_USER';
    error.decision = result.decision;
    throw error;
  }

  if (response.choice === 'allow-session' || response.choice === 'allow-persistent') {
    await grantCommandAccess(command, {
      cwd: request.cwd,
      persistent: response.choice === 'allow-persistent',
      source,
    });
  }

  const confirmedResult = await evaluateCommandPolicy({ ...request, confirmed: true });
  return {
    ...confirmedResult,
    decision: await applyCurrentSecurityModeToDecision(confirmedResult.decision),
  };
}

export async function assertOpenTargetAllowedWithConfirmation(request: OpenTargetRequest): Promise<OpenTargetPolicyResult> {
  const rawResult = await evaluateOpenTargetPolicy(request);
  const result = {
    ...rawResult,
    decision: await applyCurrentSecurityModeToDecision(rawResult.decision),
  };
  if (result.decision.action === 'allow') return result;
  if (result.decision.action === 'deny') throw openTargetToError(result);

  const fingerprint = openTargetFingerprint(request, result);
  if (openTargetSessionGrants.has(fingerprint)) {
    return {
      ...result,
      matchedRule: 'confirmed-open-target-session',
      decision: {
        action: 'allow',
        risk: result.decision.risk,
        reasons: ['Allowed by this app session confirmation'],
      },
    };
  }

  const response = await requestSecurityConfirmation({
    kind: 'open-target',
    source: request.source ?? 'unknown',
    risk: result.decision.risk,
    target: {
      url: result.url ?? request.target,
      protocol: result.protocol ?? 'unknown:',
      hostname: result.hostname,
    },
    reasons: result.decision.reasons,
  });

  if (response.choice === 'deny') {
    const error = new Error(`Open target denied: ${result.url ?? request.target}`) as Error & {
      code?: string;
      decision?: SecurityDecision;
    };
    error.code = 'OPEN_TARGET_DENIED_BY_USER';
    error.decision = result.decision;
    throw error;
  }

  if (response.choice === 'allow-session' || response.choice === 'allow-persistent') {
    if (
      result.hostname
      && (result.protocol === 'http:' || result.protocol === 'https:')
    ) {
      await grantDomainAccess(result.hostname, {
        persistent: response.choice === 'allow-persistent',
        includeSubdomains: false,
        source: 'security-confirmation',
      });
    } else {
      openTargetSessionGrants.add(fingerprint);
    }
  }

  return {
    ...result,
    matchedRule: response.choice === 'allow-once' ? 'confirmed-open-target-once' : 'confirmed-open-target-session',
    decision: {
      action: 'allow',
      risk: result.decision.risk,
      reasons: ['Allowed by user confirmation'],
    },
  };
}
export async function assertMcpServerAllowedWithConfirmation(input: {
  serverName: string;
  server: McpServerEntry;
  source?: string;
}): Promise<void> {
  const source = input.source ?? 'unknown';
  if (await findMcpServerGrant(input.serverName, input.server)) return;

  const mode = await getSecurityMode();
  if (mode === 'trusted' || mode === 'off') return;

  const risk = getMcpServerConfirmationRisk(input.server);
  const reasons = getMcpServerConfirmationReasons(input.server);
  const response = await requestSecurityConfirmation({
    kind: 'mcp-server',
    source,
    risk,
    target: {
      serverName: input.serverName,
      transport: getMcpServerTransport(input.server),
      summary: describeMcpServer(input.server),
    },
    reasons,
  });

  if (response.choice === 'deny') {
    const error = new Error(`MCP server enable denied: ${input.serverName}`) as Error & { code?: string };
    error.code = 'MCP_SERVER_ENABLE_DENIED_BY_USER';
    throw error;
  }

  if (response.choice === 'allow-session' || response.choice === 'allow-persistent') {
    await grantMcpServerAccess(input.serverName, input.server, {
      persistent: response.choice === 'allow-persistent',
      source,
    });
  }
}

function pathPolicyToError(result: PathPolicyResult): Error & { code?: string; decision?: SecurityDecision } {
  const error = new Error(result.decision.reasons.join('; ')) as Error & {
    code?: string;
    decision?: SecurityDecision;
  };
  error.code = result.decision.action === 'deny' ? result.decision.code : 'FILE_OPERATION_REQUIRES_CONFIRMATION';
  error.decision = result.decision;
  return error;
}

export async function assertFileOperationAllowedWithConfirmation(
  request: PathPolicyRequest,
): Promise<PathPolicyResult> {
  const rawResult = await evaluatePathPolicy(request);
  const promptLikeDecision = rawResult.decision.action === 'deny' && rawResult.decision.code === 'DELETE_REQUIRES_CONFIRMATION'
    ? {
      action: 'prompt' as const,
      risk: rawResult.decision.risk,
      reasons: rawResult.decision.reasons,
      promptLevel: 'high' as const,
      allowRememberChoice: true,
    }
    : rawResult.decision;
  const result = {
    ...rawResult,
    decision: await applyCurrentSecurityModeToDecision(promptLikeDecision),
  };
  if (result.decision.action === 'allow') return result;

  // For delete/write operations that need confirmation
  if (rawResult.decision.action === 'deny' && rawResult.decision.code === 'DELETE_REQUIRES_CONFIRMATION') {
    // Check if there's already a path grant
    if (rawResult.pathInfo) {
      const existingGrant = await findPathGrant(rawResult.pathInfo.realPath, request.capability);
      if (existingGrant) {
        return {
          ...rawResult,
          decision: {
            action: 'allow',
            risk: result.decision.risk,
            reasons: ['Allowed by existing path grant'],
          },
        };
      }
    }

    const source = request.source ?? 'unknown';
    const path = request.path;
    const response = await requestSecurityConfirmation({
      kind: 'file',
      source,
      risk: result.decision.risk,
      target: {
        path,
        capability: request.capability,
      },
      reasons: result.decision.reasons,
    });

    if (response.choice === 'deny') {
      const error = new Error(`File operation denied: ${path}`) as Error & {
        code?: string;
        decision?: SecurityDecision;
      };
      error.code = 'FILE_OPERATION_DENIED_BY_USER';
      error.decision = result.decision;
      throw error;
    }

    if (response.choice === 'allow-session' || response.choice === 'allow-persistent') {
      if (rawResult.pathInfo) {
        await grantPathAccess(rawResult.pathInfo.realPath, {
          capabilities: [request.capability],
          persistent: response.choice === 'allow-persistent',
          source: 'security-confirmation',
        });
      }
    }

    return {
      ...rawResult,
      decision: {
        action: 'allow',
        risk: result.decision.risk,
        reasons: [`Allowed by user confirmation for ${path}`],
      },
    };
  }

  // For other denials (not DELETE_REQUIRES_CONFIRMATION), throw
  throw pathPolicyToError(result);
}
