export type DigitalEmployeeInstallStatus =
  | 'preparing'
  | 'active'
  | 'degraded'
  | 'repair-required';

export interface DigitalEmployeePackageSkill {
  slug: string;
  source: 'bundled' | 'dependency';
  path?: string;
  version?: string;
  required: boolean;
  enabled: boolean;
}

export interface DigitalEmployeeMcpBinding {
  server: string;
  required: boolean;
  enabled: boolean;
  allowedTools?: string[];
}

export interface DigitalEmployeeAgentTemplate {
  id?: string;
  name?: string;
  workspace?: string;
  agentDir?: string;
  model?: string;
}

export interface DigitalEmployeePackageManifest {
  schemaVersion: 1;
  package: {
    id: string;
    name: string;
    version: string;
    description: string;
    category?: string;
    tags?: string[];
    publisher?: {
      id?: string;
      name?: string;
    };
  };
  agent: {
    workspaceSource: string;
    entryTemplate?: string;
    inheritMainWorkspace?: boolean;
    modelRef?: string | null;
  };
  execution?: {
    mode?: string;
    workflow?: string;
    defaultOutputTypes?: string[];
  };
  skills?: DigitalEmployeePackageSkill[];
  mcp?: {
    serverTemplate: string;
    bindings?: DigitalEmployeeMcpBinding[];
  };
  resources?: Array<{
    id: string;
    type: 'file';
    path: string;
    required: boolean;
  }>;
  install?: {
    createAgent?: boolean;
    agentOwnership?: 'exclusive';
    allowMultipleInstances?: boolean;
    requiresUserConfirmation?: boolean;
  };
}

export interface InstalledDigitalEmployeeMcpServer {
  sourceName: string;
  runtimeName: string;
}

export interface DigitalEmployeeInstallRecord {
  schemaVersion: 1;
  instanceId: string;
  marketEmployeeId: string;
  packageId: string;
  packageVersion: string;
  installPath: string;
  agentId: string;
  agentWorkspace: string;
  packagedSkills: Array<{
    slug: string;
    path?: string;
    required: boolean;
  }>;
  installedMcpServers: InstalledDigitalEmployeeMcpServer[];
  status: DigitalEmployeeInstallStatus;
  /** User-controlled enable switch; defaults to enabled when omitted. */
  userEnabled?: boolean;
  installedAt: string;
  updatedAt?: string;
  updateHistory?: Array<{
    fromVersion: string;
    toVersion: string;
    updatedAt: string;
  }>;
  warnings: string[];
}

export interface LocalDigitalEmployee {
  instanceId: string;
  marketEmployeeId: string;
  packageId: string;
  packageVersion: string;
  name: string;
  description: string;
  category?: string;
  tags: string[];
  installPath: string;
  agentId: string;
  sessionKey: string;
  status: Exclude<DigitalEmployeeInstallStatus, 'preparing'>;
  enabled: boolean;
  warnings: string[];
}

export interface SetDigitalEmployeeEnabledInput {
  enabled: boolean;
}

export interface SetDigitalEmployeeEnabledResult {
  success: boolean;
  instanceId: string;
  enabled: boolean;
}

export interface InstallDigitalEmployeeInput {
  marketEmployeeId: string | number;
  packageSha256?: string;
}

export interface InstallDigitalEmployeeResult {
  instanceId: string;
  agentId: string;
  sessionKey: string;
  status: 'active' | 'degraded';
  warnings: string[];
}

export interface UpdateDigitalEmployeeInput {
  packageSha256?: string;
}

export interface UpdateDigitalEmployeeResult {
  instanceId: string;
  agentId: string;
  sessionKey: string;
  fromVersion: string;
  toVersion: string;
  status: 'active' | 'degraded';
  warnings: string[];
}

export interface UninstallDigitalEmployeeInput {
  marketEmployeeId?: string | number;
  instanceId?: string;
}

export interface UninstallDigitalEmployeeResult {
  instanceId: string;
  agentId: string;
  marketEmployeeId: string;
}
