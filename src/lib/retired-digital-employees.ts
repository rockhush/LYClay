export type RetiredDigitalEmployeeRecord = {
  agentId: string;
  name: string;
  marketEmployeeId?: string;
  retiredAt: string;
  /** When false, the agent id is reactivated but the display name mapping is kept. */
  readOnly?: boolean;
};

export type RetiredDigitalEmployeesState = {
  retiredAgents: Record<string, RetiredDigitalEmployeeRecord>;
};

type AgentNameSource = {
  id: string;
  name?: string | null;
  isDigitalEmployee?: boolean;
};

type DigitalEmployeeNameSource = {
  agentId: string;
  name: string;
  marketEmployeeId?: string;
};

export type ActiveDigitalEmployeeExecution = {
  agentId: string;
  name: string;
};

let retiredAgents: Record<string, RetiredDigitalEmployeeRecord> = {};

function normalizeAgentId(agentId: string | null | undefined): string | null {
  const trimmed = agentId?.trim();
  return trimmed || null;
}

function normalizeMarketEmployeeId(marketEmployeeId: string | number | null | undefined): string | null {
  if (marketEmployeeId == null) return null;
  const trimmed = String(marketEmployeeId).trim();
  return trimmed || null;
}

function extractDigitalEmployeePackageSlug(agentId: string): string | null {
  if (!agentId.startsWith('employee-')) return null;
  const body = agentId.slice('employee-'.length);
  const match = body.match(/^(.+)-[a-z0-9]{4,12}$/i);
  return match?.[1]?.trim() || null;
}

export function loadRetiredDigitalEmployees(state: RetiredDigitalEmployeesState | undefined): void {
  retiredAgents = { ...(state?.retiredAgents ?? {}) };
}

export function getRetiredDigitalEmployeesSnapshot(): RetiredDigitalEmployeesState {
  return { retiredAgents: { ...retiredAgents } };
}

export function listRetiredReadOnlyAgentIds(): string[] {
  return Object.entries(retiredAgents)
    .filter(([, record]) => record.readOnly !== false)
    .map(([agentId]) => agentId);
}

export function getRetiredDigitalEmployee(
  agentId: string | null | undefined,
): RetiredDigitalEmployeeRecord | undefined {
  const normalized = normalizeAgentId(agentId);
  if (!normalized) return undefined;
  const entry = retiredAgents[normalized];
  return entry ? { ...entry } : undefined;
}

function isRetiredReadOnly(record: RetiredDigitalEmployeeRecord | undefined): boolean {
  return record != null && record.readOnly !== false;
}

export function isRetiredDigitalEmployeeAgent(agentId: string | null | undefined): boolean {
  return isRetiredReadOnly(getRetiredDigitalEmployee(agentId));
}

export function retireDigitalEmployee(record: {
  agentId: string;
  name: string;
  marketEmployeeId?: string;
  retiredAt?: string;
}): boolean {
  const agentId = normalizeAgentId(record.agentId);
  const name = record.name.trim();
  if (!agentId || !name) return false;

  const next: RetiredDigitalEmployeeRecord = {
    agentId,
    name,
    ...(normalizeMarketEmployeeId(record.marketEmployeeId)
      ? { marketEmployeeId: normalizeMarketEmployeeId(record.marketEmployeeId)! }
      : {}),
    retiredAt: record.retiredAt ?? new Date().toISOString(),
    readOnly: true,
  };
  const existing = retiredAgents[agentId];
  if (
    existing
    && existing.name === next.name
    && existing.marketEmployeeId === next.marketEmployeeId
    && existing.retiredAt === next.retiredAt
    && isRetiredReadOnly(existing) === isRetiredReadOnly(next)
  ) {
    return false;
  }
  retiredAgents[agentId] = next;
  return true;
}

export function unretireDigitalEmployee(agentId: string | null | undefined): boolean {
  const normalized = normalizeAgentId(agentId);
  if (!normalized) return false;
  const existing = retiredAgents[normalized];
  if (!existing || existing.readOnly === false) return false;
  retiredAgents[normalized] = { ...existing, readOnly: false };
  return true;
}

/** Reactivate all sessions for the same marketplace employee while keeping display-name mappings. */
export function unretireDigitalEmployeesByMarketId(
  marketEmployeeId: string | number | null | undefined,
): boolean {
  const normalizedMarketEmployeeId = normalizeMarketEmployeeId(marketEmployeeId);
  if (!normalizedMarketEmployeeId) return false;

  let changed = false;
  for (const [agentId, record] of Object.entries(retiredAgents)) {
    if (record.marketEmployeeId === normalizedMarketEmployeeId && record.readOnly !== false) {
      retiredAgents[agentId] = { ...record, readOnly: false };
      changed = true;
    }
  }
  return changed;
}

/** Mark all historical sessions for the same marketplace employee as read-only on uninstall. */
export function retireDigitalEmployeesByMarketId(
  marketEmployeeId: string | number | null | undefined,
  options?: { retiredAt?: string },
): boolean {
  const normalizedMarketEmployeeId = normalizeMarketEmployeeId(marketEmployeeId);
  if (!normalizedMarketEmployeeId) return false;

  const retiredAt = options?.retiredAt ?? new Date().toISOString();
  let changed = false;
  for (const [agentId, record] of Object.entries(retiredAgents)) {
    if (record.marketEmployeeId === normalizedMarketEmployeeId && record.readOnly === false) {
      retiredAgents[agentId] = { ...record, readOnly: true, retiredAt };
      changed = true;
    }
  }
  return changed;
}

export function refreshRetiredDigitalEmployeeNamesForMarketId(
  marketEmployeeId: string | number | null | undefined,
  name: string,
): boolean {
  const normalizedMarketEmployeeId = normalizeMarketEmployeeId(marketEmployeeId);
  const trimmedName = name.trim();
  if (!normalizedMarketEmployeeId || !trimmedName) return false;

  let changed = false;
  for (const [agentId, record] of Object.entries(retiredAgents)) {
    if (record.marketEmployeeId === normalizedMarketEmployeeId && record.name !== trimmedName) {
      retiredAgents[agentId] = { ...record, name: trimmedName };
      changed = true;
    }
  }
  return changed;
}

function findInstalledDigitalEmployeeAgent(
  agentId: string,
  sources?: {
    agents?: readonly AgentNameSource[];
    digitalEmployees?: readonly DigitalEmployeeNameSource[];
  },
): ActiveDigitalEmployeeExecution | null {
  const agents = sources?.agents ?? [];
  const digitalEmployees = sources?.digitalEmployees ?? [];
  const employee = digitalEmployees.find((entry) => entry.agentId === agentId);
  if (employee) {
    const agentName = agents.find((entry) => entry.id === agentId)?.name?.trim();
    const name = employee.name?.trim() || agentName || agentId;
    return { agentId, name };
  }

  const agent = agents.find((entry) => entry.id === agentId && entry.isDigitalEmployee);
  if (!agent) return null;

  const agentName = agent.name?.trim();
  const name = agentName || agentId;
  return { agentId, name };
}

/**
 * Resolve the currently installed digital employee that should execute messages
 * for a session bound to `sessionAgentId` (which may be a historical agent id).
 */
export function resolveActiveDigitalEmployeeExecutionAgent(
  sessionAgentId: string | null | undefined,
  sources?: {
    agents?: readonly AgentNameSource[];
    digitalEmployees?: readonly DigitalEmployeeNameSource[];
  },
): ActiveDigitalEmployeeExecution | null {
  const normalized = normalizeAgentId(sessionAgentId);
  if (!normalized || normalized === 'main') return null;

  const exact = findInstalledDigitalEmployeeAgent(normalized, sources);
  if (exact) return exact;

  if (!normalized.startsWith('employee-')) return null;
  if (isRetiredReadOnly(getRetiredDigitalEmployee(normalized))) return null;

  const digitalEmployees = sources?.digitalEmployees ?? [];

  const retired = getRetiredDigitalEmployee(normalized);
  if (retired?.marketEmployeeId) {
    const siblingEmployee = digitalEmployees.find(
      (employee) => employee.marketEmployeeId === retired.marketEmployeeId,
    );
    if (siblingEmployee) {
      const mapped = findInstalledDigitalEmployeeAgent(siblingEmployee.agentId, sources);
      if (mapped) return mapped;
    }
  }

  const packageSlug = extractDigitalEmployeePackageSlug(normalized);
  if (packageSlug) {
    const siblingEmployee = digitalEmployees.find(
      (employee) => employee.agentId.startsWith(`employee-${packageSlug}-`),
    );
    if (siblingEmployee) {
      const mapped = findInstalledDigitalEmployeeAgent(siblingEmployee.agentId, sources);
      if (mapped) return mapped;
    }
  }

  return null;
}

export function resolveAgentDisplayName(
  agentId: string | null | undefined,
  sources?: {
    agents?: readonly AgentNameSource[];
    digitalEmployees?: readonly DigitalEmployeeNameSource[];
  },
): string {
  const normalized = normalizeAgentId(agentId);
  if (!normalized || normalized === 'main') return normalized ?? 'main';

  const fromAgent = sources?.agents?.find((agent) => agent.id === normalized)?.name?.trim();
  if (fromAgent) return fromAgent;

  const fromEmployee = sources?.digitalEmployees?.find((employee) => employee.agentId === normalized)?.name?.trim();
  if (fromEmployee) return fromEmployee;

  const retired = getRetiredDigitalEmployee(normalized);
  if (retired?.name) return retired.name;

  const packageSlug = extractDigitalEmployeePackageSlug(normalized);
  if (packageSlug) {
    const siblingEmployee = sources?.digitalEmployees?.find(
      (employee) => employee.agentId.startsWith(`employee-${packageSlug}-`),
    )?.name?.trim();
    if (siblingEmployee) return siblingEmployee;
  }

  return normalized;
}
