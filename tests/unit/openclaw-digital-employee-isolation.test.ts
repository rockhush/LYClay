import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { inspectOpenClawDigitalEmployeeIsolation } from '@electron/utils/openclaw-digital-employee-isolation';

async function createRuntime(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'lyclaw-openclaw-isolation-'));
  const dist = join(root, 'dist');
  await mkdir(dist, { recursive: true });
  await Promise.all(Object.entries(files).map(([name, content]) => writeFile(join(dist, name), content, 'utf8')));
  return root;
}

const isolatedFiles = {
  'chat-runtime.js': 'executeAsAgentId executedByAgentName',
  'schema-runtime.js': 'executeAsAgentId executedByAgentName',
  'get-reply-runtime.js': [
    'async function resolveDigitalEmployeeExecutionContext(cfg, opts) {',
    'const requestedAgentId = normalizeOptionalString(opts?.executeAsAgentId);',
    'mcp: { ...cfg?.mcp, servers: await buildDigitalEmployeeMcpServers(employeeDir) }',
    '__digitalEmployeeOnly: true',
    'extraDirs: [employeeSkillsDir]',
    'loadDigitalEmployeeWorkflows(employeeDir)',
    'Digital employee isolation:',
    'extraSystemPrompt: digitalEmployeeExecution.workflowPrompt',
    'if (digitalEmployeeExecution) {',
    'if (sessionEntry?.skillsSnapshot) {',
    'sessionState.sessionEntry = { ...sessionEntry, skillsSnapshot: void 0 };',
    'sessionStore[sessionKey] = { ...sessionStore[sessionKey], skillsSnapshot: void 0 };',
  ].join('\n'),
  'workspace-runtime.js': [
    'const pluginSkillDirs = (workspaceOnly || opts?.config?.skills?.__digitalEmployeeOnly) ? [] : resolvePluginSkillDirs({});',
    'const merged = new Map();',
    'if (opts?.config?.skills?.__digitalEmployeeOnly === true) {',
    'return Array.from(merged.values());',
    '}',
    'for (const record of bundledSkills) merged.set(record.skill.name, record);',
  ].join('\n'),
};

describe('OpenClaw digital employee isolation verifier', () => {
  it('accepts runtime chunks that enforce employee-local resources', async () => {
    const root = await createRuntime(isolatedFiles);
    try {
      const status = await inspectOpenClawDigitalEmployeeIsolation(root);
      expect(status.ok).toBe(true);
      expect(status.missing).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reports missing workspace employee-only skill guard', async () => {
    const root = await createRuntime({
      ...isolatedFiles,
      'workspace-runtime.js': [
        'const pluginSkillDirs = resolvePluginSkillDirs({});',
        'for (const record of bundledSkills) merged.set(record.skill.name, record);',
      ].join('\n'),
    });
    try {
      const status = await inspectOpenClawDigitalEmployeeIsolation(root);
      expect(status.ok).toBe(false);
      expect(status.missing).toContain('workspace loader disables plugin skills in employee-only mode');
      expect(status.missing).toContain('workspace loader returns only employee-local skills before global merges');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reports missing dist directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lyclaw-openclaw-no-dist-'));
    try {
      const status = await inspectOpenClawDigitalEmployeeIsolation(root);
      expect(status.ok).toBe(false);
      expect(status.missing).toContain('dist directory exists');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
