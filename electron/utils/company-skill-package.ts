import * as fs from 'fs';
import * as path from 'path';

export interface SkillManifestFields {
  name?: string;
  slug?: string;
}

export function parseSkillManifestFields(raw: string): SkillManifestFields {
  const frontmatterMatch = raw.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!frontmatterMatch) return {};

  const body = frontmatterMatch[1];
  const readScalar = (key: string): string | undefined => {
    const quoted = body.match(new RegExp(`^\\s*${key}\\s*:\\s*"([^"]*)"\\s*$`, 'm'));
    if (quoted?.[1] != null) {
      const value = quoted[1].trim();
      return value || undefined;
    }
    const plain = body.match(new RegExp(`^\\s*${key}\\s*:\\s*([^\\n]+?)\\s*$`, 'm'));
    const value = plain?.[1]?.trim();
    return value || undefined;
  };

  return {
    name: readScalar('name'),
    slug: readScalar('slug'),
  };
}

export async function findSkillManifestPath(rootDir: string, maxDepth = 4): Promise<string | null> {
  const queue: Array<{ dir: string; depth: number }> = [{ dir: rootDir, depth: 0 }];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) break;

    const manifestPath = path.join(current.dir, 'SKILL.md');
    if (fs.existsSync(manifestPath)) {
      return manifestPath;
    }

    if (current.depth >= maxDepth) continue;

    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(current.dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        queue.push({ dir: path.join(current.dir, entry.name), depth: current.depth + 1 });
      }
    }
  }

  return null;
}

export function resolvePackageDirNameFromManifest(
  manifest: SkillManifestFields,
  zipBasename?: string,
): string | undefined {
  const fromManifest = manifest.slug?.trim() || manifest.name?.trim();
  if (fromManifest) return fromManifest;

  if (zipBasename?.trim()) {
    const base = path.basename(zipBasename.trim(), path.extname(zipBasename.trim()));
    if (base) return base;
  }

  return undefined;
}

export async function resolvePackageDirName(
  extractDir: string,
  zipBasename?: string,
): Promise<string> {
  const manifestPath = await findSkillManifestPath(extractDir);
  if (manifestPath) {
    const raw = await fs.promises.readFile(manifestPath, 'utf8');
    const manifest = parseSkillManifestFields(raw);
    const fromManifest = resolvePackageDirNameFromManifest(manifest, zipBasename);
    if (fromManifest) return fromManifest;
  }

  const entries = await fs.promises.readdir(extractDir, { withFileTypes: true });
  const directories = entries.filter((entry) => entry.isDirectory());
  const files = entries.filter((entry) => entry.isFile());

  if (directories.length === 1 && files.length === 0) {
    return directories[0].name;
  }

  const zipFallback = zipBasename?.trim()
    ? path.basename(zipBasename.trim(), path.extname(zipBasename.trim()))
    : '';
  if (zipFallback) return zipFallback;

  throw new Error('Cannot determine skill package directory name from archive');
}

export async function locateSkillContentDir(extractDir: string): Promise<string> {
  const manifestPath = await findSkillManifestPath(extractDir);
  if (!manifestPath) {
    throw new Error('SKILL.md not found in downloaded archive');
  }
  return path.dirname(manifestPath);
}

export function parseZipBasenameFromContentDisposition(header: string | null): string | undefined {
  if (!header?.trim()) return undefined;

  const starMatch = header.match(/filename\*=(?:UTF-8''|utf-8'')([^;]+)/i);
  if (starMatch?.[1]) {
    try {
      const decoded = decodeURIComponent(starMatch[1].trim().replace(/^"|"$/g, ''));
      if (decoded) return decoded;
    } catch {
      // fall through
    }
  }

  const plainMatch = header.match(/filename="?([^";]+)"?/i);
  const plain = plainMatch?.[1]?.trim();
  return plain || undefined;
}
