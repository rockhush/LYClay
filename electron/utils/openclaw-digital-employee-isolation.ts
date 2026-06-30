import type { Dirent } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { getOpenClawResolvedDir } from './paths';

export type OpenClawDigitalEmployeeIsolationDetails = {
  distExists: boolean;
  chatExecutionTarget: boolean;
  protocolExecutionTarget: boolean;
  getReplyExecutionContext: boolean;
  getReplyMcpEmployeeOnly: boolean;
  getReplySkillsEmployeeOnly: boolean;
  getReplyWorkflowPrompt: boolean;
  getReplyClearsSkillsSnapshot: boolean;
  workspaceSkipsPluginSkills: boolean;
  workspaceReturnsOnlyEmployeeSkills: boolean;
};

export type OpenClawDigitalEmployeeIsolationStatus = {
  ok: boolean;
  openclawDir: string;
  missing: string[];
  details: OpenClawDigitalEmployeeIsolationDetails;
};

async function fileExists(path: string): Promise<boolean> {
  try {
    const stats = await stat(path);
    return stats.isDirectory() || stats.isFile();
  } catch {
    return false;
  }
}

async function findFilesByName(rootDir: string, matcher: RegExp): Promise<string[]> {
  const matches: string[] = [];
  const stack = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    let entries: Dirent[];
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile() && matcher.test(entry.name)) {
        matches.push(fullPath);
      }
    }
  }
  return matches;
}

async function someFileIncludes(files: string[], predicate: (source: string) => boolean): Promise<boolean> {
  for (const file of files) {
    try {
      if (predicate(await readFile(file, 'utf8'))) return true;
    } catch {
      // Ignore unreadable generated chunks; the missing marker report will surface the failure.
    }
  }
  return false;
}

export async function inspectOpenClawDigitalEmployeeIsolation(
  openclawDir = getOpenClawResolvedDir(),
): Promise<OpenClawDigitalEmployeeIsolationStatus> {
  const distDir = join(openclawDir, 'dist');
  const distExists = await fileExists(distDir);
  const [chatFiles, getReplyFiles, protocolFiles, workspaceFiles] = distExists
    ? await Promise.all([
      findFilesByName(distDir, /^chat-.*\.js$/),
      findFilesByName(distDir, /^get-reply-.*\.js$/),
      findFilesByName(distDir, /^(protocol-|schema-).*\.js$/),
      findFilesByName(distDir, /^workspace-.*\.js$/),
    ])
    : [[], [], [], []];

  const details: OpenClawDigitalEmployeeIsolationDetails = {
    distExists,
    chatExecutionTarget: await someFileIncludes(chatFiles, (source) =>
      source.includes('executeAsAgentId') && source.includes('executedByAgentName'),
    ),
    protocolExecutionTarget: await someFileIncludes(protocolFiles, (source) =>
      source.includes('executeAsAgentId') && source.includes('executedByAgentName'),
    ),
    getReplyExecutionContext: await someFileIncludes(getReplyFiles, (source) =>
      source.includes('resolveDigitalEmployeeExecutionContext')
      && source.includes('opts?.executeAsAgentId'),
    ),
    getReplyMcpEmployeeOnly: await someFileIncludes(getReplyFiles, (source) =>
      source.includes('buildDigitalEmployeeMcpServers')
      && source.includes('mcp: { ...cfg?.mcp, servers: await buildDigitalEmployeeMcpServers(employeeDir) }'),
    ),
    getReplySkillsEmployeeOnly: await someFileIncludes(getReplyFiles, (source) =>
      source.includes('__digitalEmployeeOnly: true')
      && source.includes('extraDirs: [employeeSkillsDir]'),
    ),
    getReplyWorkflowPrompt: await someFileIncludes(getReplyFiles, (source) =>
      source.includes('loadDigitalEmployeeWorkflows')
      && source.includes('Digital employee isolation:')
      && source.includes('extraSystemPrompt: digitalEmployeeExecution.workflowPrompt'),
    ),
    getReplyClearsSkillsSnapshot: await someFileIncludes(getReplyFiles, (source) =>
      source.includes('digitalEmployeeExecution)')
      && source.includes('sessionEntry?.skillsSnapshot')
      && source.includes('skillsSnapshot: void 0')
      && source.includes('sessionStore[sessionKey]')
      && source.includes('skillsSnapshot: void 0'),
    ),
    workspaceSkipsPluginSkills: await someFileIncludes(workspaceFiles, (source) =>
      source.includes('opts?.config?.skills?.__digitalEmployeeOnly')
      && source.includes('resolvePluginSkillDirs'),
    ),
    workspaceReturnsOnlyEmployeeSkills: await someFileIncludes(workspaceFiles, (source) => {
      const guardIndex = source.indexOf('opts?.config?.skills?.__digitalEmployeeOnly === true');
      if (guardIndex < 0) return false;
      const bundledMergeIndex = source.indexOf('for (const record of bundledSkills)', guardIndex);
      const returnIndex = source.indexOf('return Array.from(merged.values())', guardIndex);
      return returnIndex >= 0 && (bundledMergeIndex < 0 || returnIndex < bundledMergeIndex);
    }),
  };

  const labels: Record<keyof OpenClawDigitalEmployeeIsolationDetails, string> = {
    distExists: 'dist directory exists',
    chatExecutionTarget: 'chat.send forwards executeAsAgentId/executedByAgentName',
    protocolExecutionTarget: 'protocol schema accepts executeAsAgentId/executedByAgentName',
    getReplyExecutionContext: 'get-reply resolves digital employee execution context',
    getReplyMcpEmployeeOnly: 'get-reply replaces MCP servers with employee-local MCP servers',
    getReplySkillsEmployeeOnly: 'get-reply enables employee-only skill loading',
    getReplyWorkflowPrompt: 'get-reply injects employee-local workflow/prompt context',
    getReplyClearsSkillsSnapshot: 'get-reply clears stale skillsSnapshot for employee execution',
    workspaceSkipsPluginSkills: 'workspace loader disables plugin skills in employee-only mode',
    workspaceReturnsOnlyEmployeeSkills: 'workspace loader returns only employee-local skills before global merges',
  };
  const missing = (Object.keys(details) as Array<keyof OpenClawDigitalEmployeeIsolationDetails>)
    .filter((key) => !details[key])
    .map((key) => labels[key]);

  return {
    ok: missing.length === 0,
    openclawDir,
    missing,
    details,
  };
}
