import { access, cp, mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { getOpenClawConfigDir } from './paths';
import * as logger from './logger';

const RETIRED_AGENTS_DIR = '_retired';

export function getActiveAgentSessionsDir(agentId: string): string {
  return join(getOpenClawConfigDir(), 'agents', agentId, 'sessions');
}

export function getRetiredAgentSessionsDir(agentId: string): string {
  return join(getOpenClawConfigDir(), 'agents', RETIRED_AGENTS_DIR, agentId, 'sessions');
}

function isSessionArtifactFileName(name: string): boolean {
  return name === 'sessions.json'
    || name.endsWith('.jsonl')
    || name.includes('.jsonl.');
}

export async function directoryHasSessionArtifacts(dir: string): Promise<boolean> {
  try {
    const entries = await readdir(dir);
    return entries.some((name) => isSessionArtifactFileName(name));
  } catch {
    return false;
  }
}

/**
 * Prefer the live agent sessions directory when it still has transcript files.
 * Fall back to the retired archive created during digital-employee uninstall.
 */
export async function resolveAgentSessionsDir(agentId: string): Promise<string> {
  const activeDir = getActiveAgentSessionsDir(agentId);
  if (await directoryHasSessionArtifacts(activeDir)) {
    return activeDir;
  }

  const retiredDir = getRetiredAgentSessionsDir(agentId);
  if (await directoryHasSessionArtifacts(retiredDir)) {
    return retiredDir;
  }

  return activeDir;
}

/**
 * Copy session transcripts to a retired archive before the agent runtime tree is removed.
 * Only used by digital-employee uninstall so normal agent deletion behavior stays unchanged.
 */
export async function archiveAgentSessionsBeforeRemoval(agentId: string): Promise<boolean> {
  const normalizedAgentId = agentId.trim();
  if (!normalizedAgentId || normalizedAgentId === 'main') {
    return false;
  }

  const sourceDir = getActiveAgentSessionsDir(normalizedAgentId);
  if (!(await directoryHasSessionArtifacts(sourceDir))) {
    return false;
  }

  const destDir = getRetiredAgentSessionsDir(normalizedAgentId);
  await mkdir(join(getOpenClawConfigDir(), 'agents', RETIRED_AGENTS_DIR, normalizedAgentId), { recursive: true });
  await cp(sourceDir, destDir, { recursive: true, force: true });

  logger.info('Archived agent sessions before removal', {
    agentId: normalizedAgentId,
    sourceDir,
    destDir,
  });
  return true;
}
