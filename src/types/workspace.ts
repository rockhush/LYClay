export interface WorkspaceEntry {
  id: string;
  name: string;
  agentId: string;
  agentName: string;
  path: string;
  createdAt: number;
  lastAccessedAt: number;
}

export interface WorkspacesSnapshot {
  workspaces: WorkspaceEntry[];
  currentWorkspaceId: string | null;
}
