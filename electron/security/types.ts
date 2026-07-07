export type FileCapability = 'metadata' | 'read' | 'write' | 'delete' | 'execute' | 'stage' | 'open';
export type NetworkCapability = 'connect';
export type CommandCapability = 'execute';
export type McpServerCapability = 'enable';
export type SkillCapability = string;
export type PromptScanSource = 'skill' | 'memory' | 'mcp' | 'knowledge' | 'transcript' | 'attachment' | 'unknown';

export type SecurityRisk = 'low' | 'medium' | 'high' | 'critical';
export type SecurityMode = 'standard' | 'trusted' | 'off';

export interface SecurityModeOverride {
  mode: SecurityMode;
  originalAction: 'allow' | 'prompt' | 'deny';
  effectiveAction: 'allow' | 'prompt' | 'deny';
  originalRisk: SecurityRisk;
  originalCode?: string;
  hardDeny: boolean;
}

export interface SecurityDecisionBase {
  risk: SecurityRisk;
  reasons: string[];
  hardDeny?: boolean;
  modeOverride?: SecurityModeOverride;
}

export interface SecurityAllowDecision extends SecurityDecisionBase {
  action: 'allow';
}

export interface SecurityPromptDecision extends SecurityDecisionBase {
  action: 'prompt';
  promptLevel: 'normal' | 'high';
  allowRememberChoice: boolean;
}

export interface SecurityDenyDecision extends SecurityDecisionBase {
  action: 'deny';
  code: string;
}

export type SecurityDecision = SecurityAllowDecision | SecurityPromptDecision | SecurityDenyDecision;

export interface ResolvedPathInfo {
  inputPath: string;
  absolutePath: string;
  realPath: string;
  parentRealPath?: string;
  exists: boolean;
}

export interface PathPolicyRequest {
  path: string;
  capability: FileCapability;
  source?: string;
  baseDir?: string;
  allowedRoots?: string[];
}

export interface PathPolicyResult {
  decision: SecurityDecision;
  pathInfo?: ResolvedPathInfo;
  matchedRoot?: string;
}

export interface PathGrant {
  id: string;
  subject: 'user' | 'renderer' | 'agent' | 'skill' | 'mcp' | 'gateway' | 'plugin' | 'system';
  resourceType: 'workspace' | 'file' | 'directory';
  path: string;
  realPath: string;
  recursive: boolean;
  capabilities: FileCapability[];
  scope: 'once' | 'session' | 'persistent';
  source: string;
  expiresAt?: number;
  revokedAt?: number;
  createdAt: number;
}

export interface DomainGrant {
  id: string;
  subject: 'user' | 'renderer' | 'agent' | 'skill' | 'mcp' | 'gateway' | 'plugin' | 'system';
  resourceType: 'domain';
  domain: string;
  includeSubdomains: boolean;
  capabilities: NetworkCapability[];
  scope: 'once' | 'session' | 'persistent';
  source: string;
  expiresAt?: number;
  revokedAt?: number;
  createdAt: number;
}

export interface CommandGrant {
  id: string;
  subject: 'user' | 'renderer' | 'agent' | 'skill' | 'mcp' | 'gateway' | 'plugin' | 'system';
  resourceType: 'command';
  command: string;
  fingerprint: string;
  cwd?: string;
  capabilities: CommandCapability[];
  scope: 'once' | 'session' | 'persistent';
  source: string;
  expiresAt?: number;
  revokedAt?: number;
  createdAt: number;
}

export interface McpServerGrant {
  id: string;
  subject: 'user' | 'renderer' | 'agent' | 'skill' | 'mcp' | 'gateway' | 'plugin' | 'system';
  resourceType: 'mcpServer';
  serverName: string;
  transport: string;
  fingerprint: string;
  capabilities: McpServerCapability[];
  scope: 'once' | 'session' | 'persistent';
  source: string;
  expiresAt?: number;
  revokedAt?: number;
  createdAt: number;
}

export interface SkillGrant {
  id: string;
  subject: 'skill';
  resourceType: 'skill';
  skillId: string;
  manifestDigest: string;
  permissions: {
    filesystem: string[];
    network: string[];
    commands: string[];
    secrets: string[];
  };
  capabilities: SkillCapability[];
  scope: 'persistent';
  source: string;
  revokedAt?: number;
  invalidatedAt?: number;
  createdAt: number;
}

export interface SkillRuntimeSecurityContext {
  skillId: string;
  manifestDigest: string;
  source?: string;
}

export interface CommandPolicyRequest {
  command?: string;
  executable?: string;
  args?: string[];
  cwd?: string;
  shell?: string | boolean;
  source?: 'renderer' | 'agent' | 'skill' | 'mcp' | 'gateway' | 'plugin' | 'system' | string;
  allowedRoots?: string[];
  confirmed?: boolean;
  allowCwdOutsideWorkspace?: boolean;
}

export interface CommandSegmentDecision {
  segment: string;
  action: SecurityDecision['action'];
  risk: SecurityRisk;
  reasons: string[];
  matchedRules: string[];
  code?: string;
  hardDeny?: boolean;
}

export interface CommandPolicyResult {
  decision: SecurityDecision;
  segments: CommandSegmentDecision[];
  command: string;
  cwd?: string;
}

export interface NetworkPolicyRequest {
  url: string;
  source?: 'renderer' | 'agent' | 'skill' | 'mcp' | 'gateway' | 'plugin' | 'system' | string;
  allowedDomains?: string[];
  allowLocalhostPorts?: number[];
  confirmed?: boolean;
  intent?: 'connect' | 'public-read' | 'send-data' | 'download';
  method?: string;
  headers?: HeadersInit;
  body?: unknown;
}

export interface NetworkPolicyResult {
  decision: SecurityDecision;
  url?: string;
  protocol?: string;
  hostname?: string;
  port?: number | null;
  matchedRule?: string;
  intent?: NetworkPolicyRequest['intent'];
  method?: string;
}

export type OpenTargetCapability = 'open-external' | 'open-path' | 'show-item';

export interface OpenTargetRequest {
  target: string;
  capability: OpenTargetCapability;
  source?: string;
  allowedRoots?: string[];
}

export interface OpenTargetPolicyResult {
  decision: SecurityDecision;
  targetType?: 'url' | 'file';
  action?: 'open-url' | 'open-path' | 'show-item';
  url?: string;
  protocol?: string;
  hostname?: string;
  path?: string;
  realPath?: string;
  matchedRule?: string;
}

export type SecurityConfirmationKind = 'network' | 'command' | 'open-target' | 'model-secret' | 'mcp-server' | 'file';
export type SecurityConfirmationChoice = 'deny' | 'allow-once' | 'allow-session' | 'allow-persistent';

export interface NetworkSecurityConfirmationRequest {
  id: string;
  kind: 'network';
  source: string;
  risk: SecurityRisk;
  target: {
    url: string;
    hostname: string;
  };
  reasons: string[];
}

export interface CommandSecurityConfirmationRequest {
  id: string;
  kind: 'command';
  source: string;
  risk: SecurityRisk;
  target: {
    command: string;
    cwd?: string;
    segments: CommandSegmentDecision[];
  };
  reasons: string[];
}

export interface OpenTargetSecurityConfirmationRequest {
  id: string;
  kind: 'open-target';
  source: string;
  risk: SecurityRisk;
  target: {
    url: string;
    protocol: string;
    hostname?: string;
  };
  reasons: string[];
}

export interface ModelSecretSecurityConfirmationRequest {
  id: string;
  kind: 'model-secret';
  source: string;
  risk: SecurityRisk;
  target: {
    summary: string;
    secretTypes: string[];
    excerpts: string[];
  };
  reasons: string[];
}

export interface McpServerSecurityConfirmationRequest {
  id: string;
  kind: 'mcp-server';
  source: string;
  risk: SecurityRisk;
  target: {
    serverName: string;
    transport: string;
    summary: string;
  };
  reasons: string[];
}

export interface FileSecurityConfirmationRequest {
  id: string;
  kind: 'file';
  source: string;
  risk: SecurityRisk;
  target: {
    path: string;
    capability: FileCapability;
  };
  reasons: string[];
}

export type SecurityConfirmationRequest =
  | NetworkSecurityConfirmationRequest
  | CommandSecurityConfirmationRequest
  | OpenTargetSecurityConfirmationRequest
  | ModelSecretSecurityConfirmationRequest
  | McpServerSecurityConfirmationRequest
  | FileSecurityConfirmationRequest;

export interface SecurityConfirmationResponse {
  id: string;
  choice: SecurityConfirmationChoice;
}

export interface PromptScanRequest {
  source: PromptScanSource;
  text: string;
  name?: string;
}

export interface PromptScanRuleMatch {
  id: string;
  category: 'instruction-override' | 'policy-bypass' | 'credential-theft' | 'data-exfiltration' | 'hidden-behavior' | 'identity-hijack';
  risk: SecurityRisk;
  reason: string;
  excerpt: string;
}

export interface PromptScanResult {
  decision: SecurityDecision;
  source: PromptScanSource;
  name?: string;
  matchedRules: string[];
  matches: PromptScanRuleMatch[];
  excerpts: string[];
}

export type SecurityPolicyRequest =
  | {
      kind: 'file';
      path: string;
      operation: FileCapability;
      source?: string;
      baseDir?: string;
      allowedRoots?: string[];
    }
  | ({
      kind: 'command';
    } & CommandPolicyRequest)
  | ({
      kind: 'network';
    } & NetworkPolicyRequest)
  | ({
      kind: 'open-target';
    } & OpenTargetRequest)
  | ({
      kind: 'prompt-scan';
    } & PromptScanRequest);

export type SecurityPolicyResult =
  | {
      kind: 'file';
      decision: SecurityDecision;
      result: PathPolicyResult;
    }
  | {
      kind: 'command';
      decision: SecurityDecision;
      result: CommandPolicyResult;
    }
  | {
      kind: 'network';
      decision: SecurityDecision;
      result: NetworkPolicyResult;
    }
  | {
      kind: 'open-target';
      decision: SecurityDecision;
      result: OpenTargetPolicyResult;
    }
  | {
      kind: 'prompt-scan';
      decision: SecurityDecision;
      result: PromptScanResult;
    };

export type SecurityAuditCapability =
  | 'file'
  | 'command'
  | 'network'
  | 'model-secret'
  | 'open-target'
  | 'prompt-scan'
  | 'permission'
  | 'skill-runtime'
  | 'internal-command'
  | 'confirmation';

export type SecurityAuditDecision =
  | SecurityDecision['action']
  | 'grant'
  | 'revoke'
  | 'invalidate'
  | 'confirm'
  | 'expire';

export interface SecurityAuditEvent {
  id: string;
  ts: number;
  source: string;
  subject?: PathGrant['subject'] | DomainGrant['subject'] | CommandGrant['subject'] | string;
  capability: SecurityAuditCapability;
  operation?: string;
  target?: string;
  decision: SecurityAuditDecision;
  risk?: SecurityRisk;
  reasons?: string[];
  code?: string;
  metadata?: Record<string, unknown>;
}
