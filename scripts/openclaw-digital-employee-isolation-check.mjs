const REQUIRED_LABELS = {
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

function findFilesByNameSync(fs, path, rootDir, matcher) {
  const matches = [];
  const stack = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (entry.isFile() && matcher.test(entry.name)) {
        matches.push(fullPath);
      }
    }
  }
  return matches;
}

function someFileIncludes(fs, files, predicate) {
  for (const file of files) {
    try {
      if (predicate(fs.readFileSync(file, 'utf8'))) return true;
    } catch {
      // Ignore unreadable generated chunks; the missing marker report will surface the failure.
    }
  }
  return false;
}

export function inspectOpenClawDigitalEmployeeIsolation(openclawDir, deps = {}) {
  const fs = deps.fs;
  const path = deps.path;
  if (!fs || !path) {
    throw new Error('inspectOpenClawDigitalEmployeeIsolation requires fs and path dependencies');
  }

  const distDir = path.join(openclawDir, 'dist');
  const distExists = fs.existsSync(distDir);
  const chatFiles = distExists ? findFilesByNameSync(fs, path, distDir, /^chat-.*\.js$/) : [];
  const getReplyFiles = distExists ? findFilesByNameSync(fs, path, distDir, /^get-reply-.*\.js$/) : [];
  const protocolFiles = distExists ? findFilesByNameSync(fs, path, distDir, /^(protocol-|schema-).*\.js$/) : [];
  const workspaceFiles = distExists ? findFilesByNameSync(fs, path, distDir, /^workspace-.*\.js$/) : [];

  const details = {
    distExists,
    chatExecutionTarget: someFileIncludes(fs, chatFiles, (source) =>
      source.includes('executeAsAgentId') && source.includes('executedByAgentName'),
    ),
    protocolExecutionTarget: someFileIncludes(fs, protocolFiles, (source) =>
      source.includes('executeAsAgentId') && source.includes('executedByAgentName'),
    ),
    getReplyExecutionContext: someFileIncludes(fs, getReplyFiles, (source) =>
      source.includes('resolveDigitalEmployeeExecutionContext')
      && source.includes('opts?.executeAsAgentId'),
    ),
    getReplyMcpEmployeeOnly: someFileIncludes(fs, getReplyFiles, (source) =>
      source.includes('buildDigitalEmployeeMcpServers')
      && source.includes('mcp: { ...cfg?.mcp, servers: await buildDigitalEmployeeMcpServers(employeeDir) }'),
    ),
    getReplySkillsEmployeeOnly: someFileIncludes(fs, getReplyFiles, (source) =>
      source.includes('__digitalEmployeeOnly: true')
      && source.includes('extraDirs: [employeeSkillsDir]'),
    ),
    getReplyWorkflowPrompt: someFileIncludes(fs, getReplyFiles, (source) =>
      source.includes('loadDigitalEmployeeWorkflows')
      && source.includes('Digital employee isolation:')
      && source.includes('extraSystemPrompt: digitalEmployeeExecution.workflowPrompt'),
    ),
    getReplyClearsSkillsSnapshot: someFileIncludes(fs, getReplyFiles, (source) =>
      source.includes('digitalEmployeeExecution)')
      && source.includes('sessionEntry?.skillsSnapshot')
      && source.includes('skillsSnapshot: void 0')
      && source.includes('sessionStore[sessionKey]'),
    ),
    workspaceSkipsPluginSkills: someFileIncludes(fs, workspaceFiles, (source) =>
      source.includes('opts?.config?.skills?.__digitalEmployeeOnly')
      && source.includes('resolvePluginSkillDirs'),
    ),
    workspaceReturnsOnlyEmployeeSkills: someFileIncludes(fs, workspaceFiles, (source) => {
      const guardIndex = source.indexOf('opts?.config?.skills?.__digitalEmployeeOnly === true');
      if (guardIndex < 0) return false;
      const bundledMergeIndex = source.indexOf('for (const record of bundledSkills)', guardIndex);
      const returnIndex = source.indexOf('return Array.from(merged.values())', guardIndex);
      return returnIndex >= 0 && (bundledMergeIndex < 0 || returnIndex < bundledMergeIndex);
    }),
  };

  const missing = Object.entries(details)
    .filter(([, value]) => !value)
    .map(([key]) => REQUIRED_LABELS[key] ?? key);

  return {
    ok: missing.length === 0,
    openclawDir,
    missing,
    details,
  };
}
