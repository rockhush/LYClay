#!/usr/bin/env zx

import 'zx/globals';
import { readFileSync, existsSync, mkdirSync, rmSync, cpSync, writeFileSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const MANIFEST_PATH = join(ROOT, 'resources', 'skills', 'preinstalled-manifest.json');
const OUTPUT_ROOT = join(ROOT, 'build', 'preinstalled-skills');
const TMP_ROOT = join(ROOT, 'build', '.tmp-preinstalled-skills');
const DEFAULT_GITHUB_BASE_URL = 'https://github.com';
const DEFAULT_GIT_REMOTE_TEMPLATES = [
  'https://github.com/{repo}.git',
  'https://gitclone.com/github.com/{repo}.git',
  'https://hub.gitmirror.com/https://github.com/{repo}.git',
  'https://gh-proxy.com/https://github.com/{repo}.git',
  'https://gh.llkk.cc/https://github.com/{repo}.git',
  'https://ghfast.top/https://github.com/{repo}.git',
];

function readArgValue(name) {
  const prefix = `${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);

  const index = process.argv.indexOf(name);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
  return '';
}

function normalizeGitBaseUrl(input) {
  return (input || DEFAULT_GITHUB_BASE_URL).replace(/\/+$/, '');
}

function normalizeGitRemoteTemplate(input) {
  const value = (input || '').trim().replace(/\/+$/, '');
  if (!value) return '';
  return value.includes('{repo}') ? value : `${value}/{repo}.git`;
}

function parseGitBaseUrlList(input) {
  return (input || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => normalizeGitBaseUrl(value));
}

function parseGitRemoteTemplateList(input) {
  return (input || '')
    .split(',')
    .map((value) => normalizeGitRemoteTemplate(value))
    .filter(Boolean);
}

function uniqueValues(values) {
  return [...new Set(values)];
}

function getGitRemoteTemplates() {
  const remoteTemplates = readArgValue('--git-remotes')
    || process.env.PREINSTALLED_SKILLS_GIT_REMOTES;
  if (remoteTemplates) {
    return uniqueValues(parseGitRemoteTemplateList(remoteTemplates));
  }

  const overrideBaseUrl = readArgValue('--github-base-url')
    || process.env.PREINSTALLED_SKILLS_GITHUB_BASE_URL
    || process.env.GITHUB_BASE_URL;
  if (overrideBaseUrl) {
    return [normalizeGitRemoteTemplate(normalizeGitBaseUrl(overrideBaseUrl))];
  }

  const configuredMirrors = parseGitBaseUrlList(process.env.PREINSTALLED_SKILLS_GITHUB_MIRRORS);
  if (configuredMirrors.length > 0) {
    return uniqueValues([
      normalizeGitRemoteTemplate(DEFAULT_GITHUB_BASE_URL),
      ...configuredMirrors.map((baseUrl) => normalizeGitRemoteTemplate(baseUrl)),
    ]);
  }

  return DEFAULT_GIT_REMOTE_TEMPLATES;
}

function createRemoteUrl(template, repo) {
  return template.replaceAll('{repo}', repo);
}

const GIT_REMOTE_TEMPLATES = getGitRemoteTemplates();

function loadManifest() {
  if (!existsSync(MANIFEST_PATH)) {
    throw new Error(`Missing manifest: ${MANIFEST_PATH}`);
  }
  const raw = readFileSync(MANIFEST_PATH, 'utf8');
  const parsed = JSON.parse(raw);
  if (!parsed || !Array.isArray(parsed.skills)) {
    throw new Error('Invalid preinstalled-skills manifest format');
  }
  for (const item of parsed.skills) {
    if (!item.slug || !item.repo || !item.repoPath) {
      throw new Error(`Invalid manifest entry: ${JSON.stringify(item)}`);
    }
  }
  return parsed.skills;
}

function groupByRepoRef(entries) {
  const grouped = new Map();
  for (const entry of entries) {
    const ref = entry.ref || 'main';
    const key = `${entry.repo}#${ref}`;
    if (!grouped.has(key)) grouped.set(key, { repo: entry.repo, ref, entries: [] });
    grouped.get(key).entries.push(entry);
  }
  return [...grouped.values()];
}

function createRepoDirName(repo, ref) {
  return `${repo.replace(/[\\/]/g, '__')}__${ref.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
}

function toGitPath(inputPath) {
  if (process.platform !== 'win32') return inputPath;
  // Git on Windows accepts forward slashes and avoids backslash escape quirks.
  return inputPath.replace(/\\/g, '/');
}

function normalizeRepoPath(repoPath) {
  return repoPath.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
}

function shouldCopySkillFile(srcPath) {
  const base = basename(srcPath);
  if (base === '.git') return false;
  if (base === '.subset.tar') return false;
  return true;
}

async function extractArchive(archiveFileName, cwd) {
  const prevCwd = $.cwd;
  $.cwd = cwd;
  try {
    try {
      await $`tar -xf ${archiveFileName}`;
      return;
    } catch (tarError) {
      if (process.platform === 'win32') {
        // Some Windows images expose bsdtar instead of tar.
        await $`bsdtar -xf ${archiveFileName}`;
        return;
      }
      throw tarError;
    }
  } finally {
    $.cwd = prevCwd;
  }
}

async function fetchSparseRepo(repo, ref, paths, checkoutDir) {
  mkdirSync(checkoutDir, { recursive: true });
  const gitCheckoutDir = toGitPath(checkoutDir);
  const archiveFileName = '.subset.tar';
  const archivePath = join(checkoutDir, archiveFileName);
  const archivePaths = [...new Set(paths.map(normalizeRepoPath))];

  await $`git init ${gitCheckoutDir}`;
  let lastFetchError;
  for (let index = 0; index < GIT_REMOTE_TEMPLATES.length; index += 1) {
    const remote = createRemoteUrl(GIT_REMOTE_TEMPLATES[index], repo);
    if (index === 0) {
      await $`git -C ${gitCheckoutDir} remote add origin ${remote}`;
    } else {
      await $`git -C ${gitCheckoutDir} remote set-url origin ${remote}`;
    }

    try {
      echo`   fetching from ${remote}`;
      await $`git -C ${gitCheckoutDir} fetch --depth 1 origin ${ref}`;
      lastFetchError = null;
      break;
    } catch (error) {
      lastFetchError = error;
      echo`   fetch failed from ${remote}`;
    }
  }

  if (lastFetchError) {
    throw lastFetchError;
  }

  // Do not checkout working tree on Windows: upstream repos may contain
  // Windows-invalid paths. Export only requested directories via git archive.
  await $`git -C ${gitCheckoutDir} archive --format=tar --output ${archiveFileName} FETCH_HEAD ${archivePaths}`;
  await extractArchive(archiveFileName, checkoutDir);
  rmSync(archivePath, { force: true });

  const commit = (await $`git -C ${gitCheckoutDir} rev-parse FETCH_HEAD`).stdout.trim();
  return commit;
}

echo`Bundling preinstalled skills...`;

if (process.env.SKIP_PREINSTALLED_SKILLS === '1') {
  echo`⏭  SKIP_PREINSTALLED_SKILLS=1 set, skipping skills fetch.`;
  process.exit(0);
}

const manifestSkills = loadManifest();

rmSync(OUTPUT_ROOT, { recursive: true, force: true });
mkdirSync(OUTPUT_ROOT, { recursive: true });
rmSync(TMP_ROOT, { recursive: true, force: true });
mkdirSync(TMP_ROOT, { recursive: true });

const lock = {
  generatedAt: new Date().toISOString(),
  skills: [],
};

const groups = groupByRepoRef(manifestSkills);
for (const group of groups) {
  const repoDir = join(TMP_ROOT, createRepoDirName(group.repo, group.ref));
  const sparsePaths = [...new Set(group.entries.map((entry) => entry.repoPath))];

  echo`Fetching ${group.repo} @ ${group.ref}`;
  const commit = await fetchSparseRepo(group.repo, group.ref, sparsePaths, repoDir);
  echo`   commit ${commit}`;

  for (const entry of group.entries) {
    const sourceDir = join(repoDir, entry.repoPath);
    const targetDir = join(OUTPUT_ROOT, entry.slug);

    if (!existsSync(sourceDir)) {
      throw new Error(`Missing source path in repo checkout: ${entry.repoPath}`);
    }

    rmSync(targetDir, { recursive: true, force: true });
    cpSync(sourceDir, targetDir, { recursive: true, dereference: true, filter: shouldCopySkillFile });

    const skillManifest = join(targetDir, 'SKILL.md');
    if (!existsSync(skillManifest)) {
      throw new Error(`Skill ${entry.slug} is missing SKILL.md after copy`);
    }

    const requestedVersion = (entry.version || '').trim();
    const resolvedVersion = !requestedVersion || requestedVersion === 'main'
      ? commit
      : requestedVersion;
    lock.skills.push({
      slug: entry.slug,
      version: resolvedVersion,
      repo: entry.repo,
      repoPath: entry.repoPath,
      ref: group.ref,
      commit,
    });

    echo`   OK ${entry.slug}`;
  }
}

writeFileSync(join(OUTPUT_ROOT, '.preinstalled-lock.json'), `${JSON.stringify(lock, null, 2)}\n`, 'utf8');
rmSync(TMP_ROOT, { recursive: true, force: true });
echo`Preinstalled skills ready: ${OUTPUT_ROOT}`;
