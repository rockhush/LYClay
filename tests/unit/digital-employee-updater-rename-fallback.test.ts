import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { renameWithRetry } from '../../electron/services/digital-employee-updater';

describe('renameWithRetry EPERM fallback', () => {
  it('falls back to copy+remove when rename hits persistent EPERM', async () => {
    const source = join(tmpdir(), `rename-src-${Math.random().toString(36).slice(2)}`);
    const target = join(tmpdir(), `rename-dst-${Math.random().toString(36).slice(2)}`);
    await mkdir(join(source, 'sub'), { recursive: true });
    await writeFile(join(source, 'file.txt'), 'hello', 'utf8');
    await writeFile(join(source, 'sub', 'nested.txt'), 'world', 'utf8');

    try {
      const renameFn = vi.fn(async () => {
        const error = new Error('operation not permitted') as NodeJS.ErrnoException;
        error.code = 'EPERM';
        throw error;
      });

      await renameWithRetry(source, target, renameFn);

      // target 已复制过来
      await expect(readFile(join(target, 'file.txt'), 'utf8')).resolves.toBe('hello');
      await expect(readFile(join(target, 'sub', 'nested.txt'), 'utf8')).resolves.toBe('world');
      // source 已删除
      await expect(access(source)).rejects.toThrow();
    } finally {
      await rm(target, { recursive: true, force: true }).catch(() => undefined);
      await rm(source, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('falls back to copy+remove when target exists and rename hits ENOTEMPTY', async () => {
    const source = join(tmpdir(), `rename-src-${Math.random().toString(36).slice(2)}`);
    const target = join(tmpdir(), `rename-dst-${Math.random().toString(36).slice(2)}`);
    await mkdir(join(source, 'sub'), { recursive: true });
    await writeFile(join(source, 'file.txt'), 'new', 'utf8');
    await writeFile(join(source, 'sub', 'nested.txt'), 'new-world', 'utf8');
    // target 已存在（模拟上次 rm 失败后的残留）
    await mkdir(target, { recursive: true });
    await writeFile(join(target, 'old-file.txt'), 'old', 'utf8');

    try {
      const renameFn = vi.fn(async () => {
        const error = new Error('directory not empty') as NodeJS.ErrnoException;
        error.code = 'ENOTEMPTY';
        throw error;
      });

      await renameWithRetry(source, target, renameFn);

      // target 被新版本覆盖
      await expect(readFile(join(target, 'file.txt'), 'utf8')).resolves.toBe('new');
      await expect(readFile(join(target, 'sub', 'nested.txt'), 'utf8')).resolves.toBe('new-world');
      // source 已删除
      await expect(access(source)).rejects.toThrow();
    } finally {
      await rm(target, { recursive: true, force: true }).catch(() => undefined);
      await rm(source, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('rethrows non-EPERM errors without fallback', async () => {
    const source = join(tmpdir(), `rename-src-${Math.random().toString(36).slice(2)}`);
    const target = join(tmpdir(), `rename-dst-${Math.random().toString(36).slice(2)}`);
    await mkdir(source, { recursive: true });
    await writeFile(join(source, 'file.txt'), 'hello', 'utf8');

    try {
      const renameFn = vi.fn(async () => {
        const error = new Error('no such file') as NodeJS.ErrnoException;
        error.code = 'ENOENT';
        throw error;
      });

      await expect(renameWithRetry(source, target, renameFn)).rejects.toThrow('no such file');
      // 非 EPERM 不回退，source 仍在
      await expect(access(join(source, 'file.txt'))).resolves.toBeUndefined();
    } finally {
      await rm(source, { recursive: true, force: true }).catch(() => undefined);
      await rm(target, { recursive: true, force: true }).catch(() => undefined);
    }
  });
});
