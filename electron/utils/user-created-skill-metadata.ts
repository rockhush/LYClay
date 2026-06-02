import * as fs from 'fs';
import * as path from 'path';
import { getSetting } from './store';
import { readCompanyMarketplaceSidecarSync } from './company-marketplace-installs';

export const DEFAULT_USER_CREATED_SKILL_VERSION = '1.0.0';

/** Full Chinese display name for skill author (e.g. 袁益千, 张三). */
export function resolveSkillAuthorDisplayName(raw: string | null | undefined): string {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return '';

  const segment = trimmed.includes('/')
    ? trimmed.split('/').pop()?.trim() ?? trimmed
    : trimmed;

  const chineseChars = segment.match(/[\u4e00-\u9fff]/gu);
  if (chineseChars?.length) {
    return chineseChars.join('');
  }
  return segment;
}

export async function resolveCurrentSkillAuthorName(): Promise<string | undefined> {
  const user = await getSetting('dingtalkUser');
  const resolved = resolveSkillAuthorDisplayName(user?.name || user?.nickname);
  return resolved || undefined;
}

function shouldReplaceVersion(version: string | undefined): boolean {
  const trimmed = (version ?? '').trim();
  if (!trimmed) return true;
  const lower = trimmed.toLowerCase();
  return lower === 'unknown' || lower === '未知';
}

function formatFrontmatterScalar(value: string): string {
  if (/[:#\[\]{}&*!|>'"%@`]/.test(value) || value.includes(' ')) {
    return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }
  return value;
}

export function upsertSkillManifestFrontmatter(
  raw: string,
  fields: Record<string, string>,
): string {
  const match = raw.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/);
  if (!match) {
    const lines = Object.entries(fields).map(
      ([key, value]) => `${key}: ${formatFrontmatterScalar(value)}`,
    );
    return `---\n${lines.join('\n')}\n---\n\n${raw}`;
  }

  let body = match[1];
  for (const [key, value] of Object.entries(fields)) {
    const nextLine = `${key}: ${formatFrontmatterScalar(value)}`;
    const fieldPattern = new RegExp(`^\\s*${key}\\s*:.*$`, 'm');
    body = fieldPattern.test(body)
      ? body.replace(fieldPattern, nextLine)
      : `${body.replace(/\s*$/, '')}\n${nextLine}`;
  }

  return raw.replace(match[0], `---\n${body}\n---`);
}

function resolveSkillManifestPath(skillDir: string): string | null {
  for (const fileName of ['SKILL.md', 'skill.md']) {
    const candidate = path.join(skillDir, fileName);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function readManifestScalar(body: string, key: string): string | undefined {
  const quoted = body.match(new RegExp(`^\\s*${key}\\s*:\\s*"((?:\\\\.|[^"])*)"\\s*$`, 'm'));
  if (quoted?.[1] != null) {
    return quoted[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\').trim() || undefined;
  }
  const plain = body.match(new RegExp(`^\\s*${key}\\s*:\\s*([^\\n]+?)\\s*$`, 'm'));
  return plain?.[1]?.trim() || undefined;
}

export function isUserCreatedSkillDirectory(skillDir: string): boolean {
  return !readCompanyMarketplaceSidecarSync(skillDir);
}

export async function normalizeUserCreatedSkillMetadata(
  skillDir: string,
  authorName?: string,
): Promise<boolean> {
  if (!isUserCreatedSkillDirectory(skillDir)) {
    return false;
  }

  const manifestPath = resolveSkillManifestPath(skillDir);
  if (!manifestPath) {
    return false;
  }

  const author = (authorName ?? await resolveCurrentSkillAuthorName())?.trim();
  if (!author) {
    return false;
  }

  const raw = fs.readFileSync(manifestPath, 'utf8');
  const frontmatterMatch = raw.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/);
  const body = frontmatterMatch?.[1] ?? '';
  const currentVersion = readManifestScalar(body, 'version');
  const currentAuthor = readManifestScalar(body, 'author');

  const patch: Record<string, string> = {};
  if (shouldReplaceVersion(currentVersion)) {
    patch.version = DEFAULT_USER_CREATED_SKILL_VERSION;
  }
  if (!currentAuthor?.trim()) {
    patch.author = author;
  }

  if (Object.keys(patch).length === 0) {
    return false;
  }

  const nextRaw = upsertSkillManifestFrontmatter(raw, patch);
  if (nextRaw !== raw) {
    fs.writeFileSync(manifestPath, nextRaw, 'utf8');
    return true;
  }
  return false;
}

export async function normalizeUserCreatedSkillsUnderRoot(skillsRoot: string): Promise<number> {
  if (!fs.existsSync(skillsRoot)) {
    return 0;
  }

  const authorName = await resolveCurrentSkillAuthorName();
  if (!authorName) {
    return 0;
  }

  let updated = 0;
  const entries = fs.readdirSync(skillsRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillDir = path.join(skillsRoot, entry.name);
    const manifestPath = resolveSkillManifestPath(skillDir);
    if (manifestPath) {
      if (await normalizeUserCreatedSkillMetadata(skillDir, authorName)) {
        updated += 1;
      }
      continue;
    }
    // Nested skill directories
    const nestedEntries = fs.readdirSync(skillDir, { withFileTypes: true });
    for (const nested of nestedEntries) {
      if (!nested.isDirectory()) continue;
      const nestedDir = path.join(skillDir, nested.name);
      if (resolveSkillManifestPath(nestedDir)
        && await normalizeUserCreatedSkillMetadata(nestedDir, authorName)) {
        updated += 1;
      }
    }
  }
  return updated;
}
