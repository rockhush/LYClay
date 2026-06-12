import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MAX_DIGITAL_EMPLOYEE_UNCOMPRESSED_BYTES,
  validateExtractedDigitalEmployeePackage,
  validatePortableRelativePath,
} from '../../electron/utils/digital-employee-package';

const roots: string[] = [];

async function createPackageRoot(): Promise<string> {
  const root = join(tmpdir(), `lyclaw-digital-employee-package-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  roots.push(root);
  await mkdir(join(root, 'agent', 'workspace'), { recursive: true });
  await mkdir(join(root, 'skills', 'document-report'), { recursive: true });
  await mkdir(join(root, 'mcp'), { recursive: true });
  await writeFile(join(root, 'agent', 'workspace', 'AGENTS.md'), '# Document analyst\n', 'utf8');
  await writeFile(
    join(root, 'agent', 'agent.template.json'),
    JSON.stringify({
      id: '${AGENT_ID}',
      name: 'Document Analyst Template',
      workspace: '~/.openclaw/workspace-${AGENT_ID}',
      agentDir: '~/.openclaw/agents/${AGENT_ID}/agent',
      model: 'provider/document-model',
    }),
    'utf8',
  );
  await writeFile(
    join(root, 'skills', 'document-report', 'SKILL.md'),
    [
      '---',
      'name: document-report',
      'description: Analyze authorized documents.',
      '---',
      '',
      '# Document Report',
    ].join('\n'),
    'utf8',
  );
  await writeFile(
    join(root, 'mcp', 'servers.json'),
    JSON.stringify({
      servers: {
        docs: {
          type: 'streamable-http',
          url: 'https://mcp.example.invalid/docs',
          disabled: true,
          tools: { allow: ['search_documents'] },
        },
      },
    }),
    'utf8',
  );
  await writeFile(
    join(root, 'employee.json'),
    JSON.stringify({
      schemaVersion: 1,
      package: {
        id: 'com.lyclaw.employee.document-analyst',
        name: 'Document Analyst',
        version: '1.0.0',
        description: 'Analyze documents.',
      },
      agent: {
        workspaceSource: 'agent/workspace',
        entryTemplate: 'agent/agent.template.json',
      },
      skills: [{
        slug: 'document-report',
        source: 'bundled',
        path: 'skills/document-report',
        required: true,
        enabled: true,
      }],
      mcp: {
        serverTemplate: 'mcp/servers.json',
        bindings: [{
          server: 'docs',
          required: false,
          enabled: false,
        }],
      },
    }),
    'utf8',
  );
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('digital employee package validation', () => {
  it('limits extracted employee packages to 1 GiB', () => {
    expect(MAX_DIGITAL_EMPLOYEE_UNCOMPRESSED_BYTES).toBe(1024 * 1024 * 1024);
  });

  it('accepts a package compatible with the LYClaw Agent workspace and MCP formats', async () => {
    const root = await createPackageRoot();

    const result = await validateExtractedDigitalEmployeePackage(root);

    expect(result.manifest.package.id).toBe('com.lyclaw.employee.document-analyst');
    expect(result.skillDirectories).toEqual([join(root, 'skills', 'document-report')]);
    expect(result.agentTemplate).toMatchObject({
      name: 'Document Analyst Template',
      model: 'provider/document-model',
    });
    expect(result.mcpConfig?.servers.docs.disabled).toBe(true);
  });

  it('rejects Agent templates that request unmanaged paths', async () => {
    const root = await createPackageRoot();
    await writeFile(
      join(root, 'agent', 'agent.template.json'),
      JSON.stringify({
        id: '${AGENT_ID}',
        name: 'Unsafe',
        workspace: 'C:\\publisher\\workspace',
      }),
      'utf8',
    );

    await expect(validateExtractedDigitalEmployeePackage(root))
      .rejects.toThrow('managed Agent workspace pattern');
  });

  it('rejects portable paths that escape the employee package', () => {
    expect(() => validatePortableRelativePath('../outside', 'agent.workspaceSource'))
      .toThrow('must stay inside the package');
    expect(() => validatePortableRelativePath('C:\\secret', 'agent.workspaceSource'))
      .toThrow('portable relative path');
  });

  it('rejects runtime credentials embedded in the package', async () => {
    const root = await createPackageRoot();
    await writeFile(join(root, 'agent', 'auth-profiles.json'), '{}', 'utf8');

    await expect(validateExtractedDigitalEmployeePackage(root))
      .rejects.toThrow('Runtime or sensitive file is not allowed');
  });

  it('rejects unsupported top-level entries', async () => {
    const root = await createPackageRoot();
    await writeFile(join(root, 'unexpected.txt'), 'nope', 'utf8');

    await expect(validateExtractedDigitalEmployeePackage(root))
      .rejects.toThrow('Unsupported top-level package entry');
  });

  it('rejects MCP bindings that reference an undeclared server', async () => {
    const root = await createPackageRoot();
    const manifestPath = join(root, 'employee.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      mcp: { bindings: Array<{ server: string }> };
    };
    manifest.mcp.bindings[0].server = 'missing';
    await writeFile(manifestPath, JSON.stringify(manifest), 'utf8');

    await expect(validateExtractedDigitalEmployeePackage(root))
      .rejects.toThrow('MCP binding references missing server');
  });

  it('rejects missing workflow and resource files', async () => {
    const root = await createPackageRoot();
    const manifestPath = join(root, 'employee.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
    manifest.execution = { workflow: 'workflows/missing.json' };
    manifest.resources = [{
      id: 'missing-template',
      type: 'file',
      path: 'resources/missing.md',
      required: true,
    }];
    await writeFile(manifestPath, JSON.stringify(manifest), 'utf8');

    await expect(validateExtractedDigitalEmployeePackage(root))
      .rejects.toThrow('Execution workflow does not exist');
  });

  it('rejects non-boolean allowMultipleInstances values', async () => {
    const root = await createPackageRoot();
    const manifestPath = join(root, 'employee.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
    manifest.install = { allowMultipleInstances: 'false' };
    await writeFile(manifestPath, JSON.stringify(manifest), 'utf8');

    await expect(validateExtractedDigitalEmployeePackage(root))
      .rejects.toThrow('install.allowMultipleInstances must be a boolean');
  });
});
