import * as fs from 'fs';
import * as path from 'path';

export interface SkillManifestFields {
  name?: string;
  slug?: string;
  description?: string;
  version?: string;
}

export function readFrontmatterScalar(body: string, key: string): string | undefined {
  const quoted = body.match(new RegExp(`^\\s*${key}\\s*:\\s*"((?:\\\\.|[^"])*)"\\s*$`, 'm'));
  if (quoted?.[1] != null) {
    const value = quoted[1]
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\')
      .trim();
    return value || undefined;
  }

  const singleQuoted = body.match(new RegExp(`^\\s*${key}\\s*:\\s*'([^']*)'\\s*$`, 'm'));
  if (singleQuoted?.[1] != null) {
    const value = singleQuoted[1].replace(/''/g, "'").trim();
    return value || undefined;
  }

  const plain = body.match(new RegExp(`^\\s*${key}\\s*:\\s*([^\\n]+?)\\s*$`, 'm'));
  const value = plain?.[1]?.trim();
  return value || undefined;
}

export function parseSkillManifestFields(raw: string): SkillManifestFields {
  const frontmatterMatch = raw.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!frontmatterMatch) return {};

  const body = frontmatterMatch[1];

  return {
    name: readFrontmatterScalar(body, 'name'),
    slug: readFrontmatterScalar(body, 'slug'),
    description: readFrontmatterScalar(body, 'description'),
    version: readFrontmatterScalar(body, 'version'),
  };
}

export function resolveLocalUploadSkillMetadata(
  manifest: SkillManifestFields,
  packageDirName: string,
): { name: string; version: string } {
  const name = manifest.name?.trim() || packageDirName;
  const version = manifest.version?.trim() || 'unknown';
  return { name, version };
}

/** Read `version` from SKILL.md / skill.md frontmatter in a skill directory. */
export function readSkillManifestVersionFromDir(skillDir: string): string | undefined {
  for (const fileName of ['SKILL.md', 'skill.md']) {
    const manifestPath = path.join(skillDir, fileName);
    if (!fs.existsSync(manifestPath)) continue;
    try {
      const raw = fs.readFileSync(manifestPath, 'utf8');
      const version = parseSkillManifestFields(raw).version?.trim();
      if (version) return version;
    } catch {
      // try next candidate
    }
  }
  return undefined;
}

export function normalizeSkillMdVersionForUpdateCheck(version: string | undefined): string {
  const trimmed = version?.trim();
  if (!trimmed) return '';
  if (trimmed.toLowerCase() === 'unknown' || trimmed === '未知') return '';
  return trimmed;
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
