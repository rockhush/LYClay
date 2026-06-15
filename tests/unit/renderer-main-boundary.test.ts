import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const SRC_ROOT = path.resolve(process.cwd(), 'src');

const allowedDirectIpcFiles = new Set([
  path.normalize('src/lib/api-client.ts'),
  path.normalize('src/lib/host-events.ts'),
]);

const directIpcPattern = /window\.electron\.ipcRenderer\.(invoke|send|on|once|removeListener)|ipcRenderer\.(invoke|send|on|once)/;
const directExternalPattern = /window\.electron\??\.openExternal/;
const directLocalHttpPattern = /fetch\(\s*["']https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?/;

function collectSourceFiles(dir: string): string[] {
  const result: string[] = [];
  for (const entry of readdirSync(dir)) {
    const fullPath = path.join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      result.push(...collectSourceFiles(fullPath));
    } else if (/\.(ts|tsx)$/.test(entry)) {
      result.push(fullPath);
    }
  }
  return result;
}

function toRepoPath(filePath: string): string {
  return path.normalize(path.relative(process.cwd(), filePath));
}

describe('Renderer/Main security boundary', () => {
  it('keeps direct IPC access inside shared renderer bridge wrappers', () => {
    const violations: string[] = [];

    for (const filePath of collectSourceFiles(SRC_ROOT)) {
      const repoPath = toRepoPath(filePath);
      if (allowedDirectIpcFiles.has(repoPath)) continue;

      const lines = readFileSync(filePath, 'utf8').split(/\r?\n/);
      lines.forEach((line, index) => {
        if (directIpcPattern.test(line)) {
          violations.push(`${repoPath}:${index + 1}: ${line.trim()}`);
        }
      });
    }

    expect(violations).toEqual([]);
  });

  it('does not bypass Main-owned URL handling from renderer files', () => {
    const violations: string[] = [];

    for (const filePath of collectSourceFiles(SRC_ROOT)) {
      const repoPath = toRepoPath(filePath);
      const lines = readFileSync(filePath, 'utf8').split(/\r?\n/);
      lines.forEach((line, index) => {
        if (directExternalPattern.test(line) || directLocalHttpPattern.test(line)) {
          violations.push(`${repoPath}:${index + 1}: ${line.trim()}`);
        }
      });
    }

    expect(violations).toEqual([]);
  });
});
