/**
 * OpenClaw workspace context utilities.
 *
 * All file I/O is async (fs/promises) to avoid blocking the Electron
 * main thread.
 */
import { access, readFile, writeFile, readdir, mkdir, unlink } from 'fs/promises';
import { constants } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { logger } from './logger';
import { getResourcesDir, getLyclawScriptsBaseDir } from './paths';
import { readUiState } from './ui-state';
import { ensureWorkspaceMemoryFile } from '../services/workspace-memory-service';

const CLAWX_BEGIN = '<!-- LYClaw:begin -->';
const CLAWX_END = '<!-- LYClaw:end -->';

// ── Helpers ──────────────────────────────────────────────────────

async function fileExists(p: string): Promise<boolean> {
  try { await access(p, constants.F_OK); return true; } catch { return false; }
}

async function ensureDir(dir: string): Promise<void> {
  if (!(await fileExists(dir))) {
    await mkdir(dir, { recursive: true });
  }
}

function shouldRetryMissingBootstrapFile(workspaceDir: string): boolean {
  return workspaceDir === join(homedir(), '.openclaw', 'workspace');
}

// ── Pure helpers (no I/O) ────────────────────────────────────────

/**
 * Merge a LYClaw context section into an existing file's content.
 * If markers already exist, replaces the section in-place.
 * Otherwise appends it at the end.
 */
export function mergeClawXSection(existing: string, section: string): string {
  const wrapped = `${CLAWX_BEGIN}\n${section.trim()}\n${CLAWX_END}`;
  const beginIdx = existing.indexOf(CLAWX_BEGIN);
  const endIdx = existing.indexOf(CLAWX_END);
  if (beginIdx !== -1 && endIdx !== -1) {
    return existing.slice(0, beginIdx) + wrapped + existing.slice(endIdx + CLAWX_END.length);
  }
  return existing.trimEnd() + '\n\n' + wrapped + '\n';
}

/**
 * Strip the "## First Run" section from workspace AGENTS.md content.
 * This section is seeded by the OpenClaw Gateway but is unnecessary
 * for LYClaw-managed workspaces.  Removes everything from the heading
 * line until the next markdown heading (any level) or end of content.
 */
export function stripFirstRunSection(content: string): string {
  const lines = content.split('\n');
  const result: string[] = [];
  let skipping = false;
  let consumedFirstParagraph = false;
  let seenBlankAfterParagraph = false;

  for (const line of lines) {
    const isHeading = /^#{1,6}\s/.test(line);
    const trimmed = line.trim();

    if (line.trim() === '## First Run') {
      skipping = true;
      consumedFirstParagraph = false;
      seenBlankAfterParagraph = false;
      continue;
    }

    if (skipping) {
      // A new heading marks the end of the First Run block.
      if (isHeading) {
        skipping = false;
      } else if (!consumedFirstParagraph) {
        // Drop leading blank lines and the first guidance paragraph.
        if (trimmed.length === 0) {
          continue;
        }
        consumedFirstParagraph = true;
        continue;
      } else if (!seenBlankAfterParagraph) {
        // Keep consuming the same paragraph until a blank line appears.
        if (trimmed.length === 0) {
          seenBlankAfterParagraph = true;
          continue;
        }
        continue;
      } else {
        // After paragraph + blank line, preserve subsequent body content.
        if (trimmed.length === 0) {
          continue;
        }
        skipping = false;
      }
    }

    if (!skipping) {
      result.push(line);
    }
  }

  // Collapse any resulting triple+ blank lines into double
  return result.join('\n').replace(/\n{3,}/g, '\n\n');
}

// ── Workspace directory resolution ───────────────────────────────

/**
 * Collect all unique workspace directories from the openclaw config:
 * the defaults workspace, each agent's workspace, and any workspace-*
 * directories that already exist under ~/.openclaw/.
 */
async function resolveAllWorkspaceDirs(): Promise<string[]> {
  const openclawDir = join(homedir(), '.openclaw');
  const dirs = new Set<string>();

  const configPath = join(openclawDir, 'openclaw.json');
  try {
    if (await fileExists(configPath)) {
      const config = JSON.parse(await readFile(configPath, 'utf-8'));

      const defaultWs = config?.agents?.defaults?.workspace;
      if (typeof defaultWs === 'string' && defaultWs.trim()) {
        dirs.add(defaultWs.replace(/^~/, homedir()));
      }

      const agents = config?.agents?.list;
      if (Array.isArray(agents)) {
        for (const agent of agents) {
          const ws = agent?.workspace;
          if (typeof ws === 'string' && ws.trim()) {
            dirs.add(ws.replace(/^~/, homedir()));
          }
        }
      }
    }
  } catch {
    // ignore config parse errors
  }

  try {
    const uiState = readUiState();
    for (const workspace of uiState.workspaces.temporaryWorkspaces) {
      if (workspace.path.trim()) {
        dirs.add(workspace.path.replace(/^~/, homedir()));
      }
    }
    const currentWorkspacePath = uiState.workspaces.currentWorkspacePath;
    if (currentWorkspacePath?.trim()) {
      dirs.add(currentWorkspacePath.replace(/^~/, homedir()));
    }
  } catch {
    // ignore UI state read errors
  }

  // We intentionally do NOT scan ~/.openclaw/ for any directory starting
  // with 'workspace'. Doing so causes a race condition where a recently deleted
  // agent's workspace (e.g., workspace-code23) is found and resuscitated by
  // the context merge routine before its deletion finishes. Only workspaces
  // explicitly declared in openclaw.json should be seeded.

  if (dirs.size === 0) {
    dirs.add(join(openclawDir, 'workspace'));
  }

  return [...dirs];
}

// ── Bootstrap file repair ────────────────────────────────────────

/**
 * Detect and remove bootstrap .md files that contain only LYClaw markers
 * with no meaningful OpenClaw content outside them.
 */
export async function repairClawXOnlyBootstrapFiles(): Promise<void> {
  const workspaceDirs = await resolveAllWorkspaceDirs();
  for (const workspaceDir of workspaceDirs) {
    if (!(await fileExists(workspaceDir))) continue;

    let entries: string[];
    try {
      entries = (await readdir(workspaceDir)).filter((f) => f.endsWith('.md'));
    } catch {
      continue;
    }

    for (const file of entries) {
      const filePath = join(workspaceDir, file);
      let content: string;
      try {
        content = await readFile(filePath, 'utf-8');
      } catch {
        continue;
      }
      const beginIdx = content.indexOf(CLAWX_BEGIN);
      const endIdx = content.indexOf(CLAWX_END);
      if (beginIdx === -1 || endIdx === -1) continue;

      const before = content.slice(0, beginIdx).trim();
      const after = content.slice(endIdx + CLAWX_END.length).trim();
      if (before === '' && after === '') {
        try {
          await unlink(filePath);
          logger.info(`Removed LYClaw-only bootstrap file for re-seeding: ${file} (${workspaceDir})`);
        } catch {
          logger.warn(`Failed to remove LYClaw-only bootstrap file: ${filePath}`);
        }
      }
    }
  }
}

// ── Context merging ──────────────────────────────────────────────

/**
 * Remove OpenClaw's chat-first BOOTSTRAP.md guidance from LYClaw-managed
 * workspaces. LYClaw provides its own onboarding, so this file otherwise keeps
 * reappearing in the chat context after Gateway seeds workspace templates.
 */
export async function removeChatFirstBootstrapFiles(): Promise<void> {
  const workspaceDirs = await resolveAllWorkspaceDirs();
  for (const workspaceDir of workspaceDirs) {
    const bootstrapPath = join(workspaceDir, 'BOOTSTRAP.md');
    if (!(await fileExists(bootstrapPath))) continue;

    try {
      await unlink(bootstrapPath);
      logger.info(`Removed OpenClaw chat-first bootstrap file (${workspaceDir})`);
    } catch {
      logger.warn(`Failed to remove OpenClaw chat-first bootstrap file: ${bootstrapPath}`);
    }
  }
}

/**
 * Merge LYClaw context snippets into workspace bootstrap files that
 * already exist on disk.  Returns the number of target files that were
 * skipped because they don't exist yet.
 */
async function mergeClawXContextOnce(): Promise<number> {
  const contextDir = join(getResourcesDir(), 'context');
  if (!(await fileExists(contextDir))) {
    logger.debug('LYClaw context directory not found, skipping context merge');
    return 0;
  }

  let files: string[];
  try {
    files = (await readdir(contextDir)).filter((f) => (
      f.endsWith('.LYClaw.md') || f.endsWith('.clawx.md')
    ));
  } catch {
    return 0;
  }

  const workspaceDirs = await resolveAllWorkspaceDirs();
  let skipped = 0;

  for (const workspaceDir of workspaceDirs) {
    await ensureDir(workspaceDir);
    try {
      await ensureWorkspaceMemoryFile(workspaceDir);
    } catch (error) {
      logger.warn(`Failed to ensure workspace memory file (${workspaceDir}):`, error);
    }

    for (const file of files) {
      const targetName = file
        .replace('.LYClaw.md', '.md')
        .replace('.clawx.md', '.md');
      const targetPath = join(workspaceDir, targetName);

      // Resolve the `<lyclaw-app>` placeholder to a real absolute base dir so
      // the agent can `exec node "<base>/scripts/lyclaw-marketplace-cli.mjs"`.
      // Packaged builds resolve to process.resourcesPath (where extraResources
      // ships the CLI); dev resolves to the repo root. Without this the agent
      // would run the literal `<lyclaw-app>` path and skill download fails.
      const section = (await readFile(join(contextDir, file), 'utf-8'))
        .split('<lyclaw-app>')
        .join(getLyclawScriptsBaseDir());
      let existing: string;
      let originalExisting: string;

      if (!(await fileExists(targetPath))) {
        // For the default workspace, retry later so the Gateway can seed a
        // full template first (AGENTS.md, SOUL.md, etc.). For other workspaces
        // (including temporary ones), create the file immediately with just the
        // LYClaw context section — this ensures a consistent system prompt prefix
        // so vLLM can reuse the KV cache across conversations.
        if (shouldRetryMissingBootstrapFile(workspaceDir)) {
          logger.debug(`Skipping ${targetName} in ${workspaceDir} (file does not exist yet, will be seeded by gateway)`);
          skipped++;
          continue;
        }
        existing = '';
        originalExisting = '';
        await ensureDir(workspaceDir);
      } else {
        originalExisting = await readFile(targetPath, 'utf-8');
        existing = originalExisting;

        // Strip unwanted Gateway-seeded sections before merging
        if (targetName === 'AGENTS.md') {
          const stripped = stripFirstRunSection(existing);
          if (stripped !== existing) {
            existing = stripped;
            logger.info(`Stripped First Run section from ${targetName} (${workspaceDir})`);
          }
        }
      }

      const merged = mergeClawXSection(existing, section);
      if (merged !== originalExisting) {
        await writeFile(targetPath, merged, 'utf-8');
        logger.info(`Merged LYClaw context into ${targetName} (${workspaceDir})`);
      }
    }
  }

  await removeChatFirstBootstrapFiles();

  return skipped;
}

const RETRY_INTERVAL_MS = 2000;
const MAX_RETRIES = 15;

/**
 * Ensure LYClaw context snippets are merged into the openclaw workspace
 * bootstrap files.
 */
export async function ensureClawXContext(): Promise<void> {
  let skipped = await mergeClawXContextOnce();
  if (skipped === 0) return;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    await new Promise((r) => setTimeout(r, RETRY_INTERVAL_MS));
    skipped = await mergeClawXContextOnce();
    if (skipped === 0) {
      logger.info(`LYClaw context merge completed after ${attempt} retry(ies)`);
      return;
    }
    logger.debug(`LYClaw context merge: ${skipped} file(s) still missing (retry ${attempt}/${MAX_RETRIES})`);
  }

  logger.warn(`LYClaw context merge: ${skipped} file(s) still missing after ${MAX_RETRIES} retries`);
}
// ── DingTalk User Info ─────────────────────────────────────────

export interface DingTalkUserMinimal {
  name: string;
  userId: string;
  unionId: string;
  email: string;
  mobile: string;
  orgEmail: string;
  jobNumber: string;
  title: string;
  workPlace: string;
  nickname: string;
  admin: boolean;
  boss: boolean;
  senior: boolean;
  active: boolean;
  disableStatus: boolean;
  hideMobile: boolean;
  realAuthed: boolean;
  createTime: string;
  hiredDate: number;
  loginId: string;
  managerUserId: string;
  exclusiveAccount: boolean;
  exclusiveAccountType: string;
  exclusiveAccountCorpId: string;
  exclusiveAccountCorpName: string;
  deptIdList: number[];
  roleList: Array<{ group_name: string; id: number; name: string }>;
}

/**
 * Returns true when workspace USER.md should be updated: first login (no
 * previous stored user) or a different DingTalk identity than before.
 */
export function shouldWriteDingTalkUserToWorkspace(
  previous: { unionId?: string; userId?: string } | null | undefined,
  next: { unionId?: string; userId?: string },
): boolean {
  if (!previous) return true;
  const prevUnion = (previous.unionId ?? '').trim();
  const nextUnion = (next.unionId ?? '').trim();
  if (prevUnion.length > 0 && nextUnion.length > 0) {
    return prevUnion !== nextUnion;
  }
  return (previous.userId ?? '') !== (next.userId ?? '');
}

/**
 * Write DingTalk user info to the OpenClaw workspace USER.md file.
 * The user info is wrapped in LYClaw markers so it can be merged/updated
 * without affecting other user-edited content in the file.
 */
export async function writeDingTalkUserToWorkspace(user: DingTalkUserMinimal): Promise<void> {
  const workspaceDirs = await resolveAllWorkspaceDirs();
  if (workspaceDirs.length === 0) {
    logger.warn('[DingTalkUser] No workspace directories found, skipping USER.md write');
    return;
  }

  const loginTime = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });

  const hiredDateStr = user.hiredDate ? new Date(user.hiredDate).toLocaleDateString('zh-CN') : '未知';

  const rolesStr = user.roleList && user.roleList.length > 0
    ? user.roleList.map(r => r.name).join('、')
    : '无';

  const deptStr = user.deptIdList && user.deptIdList.length > 0
    ? user.deptIdList.join('、')
    : '未知';

  const userSection = `## 当前用户身份

### 基本信息
- **姓名**: ${user.name || '未知'}
- **昵称**: ${user.nickname || '未知'}
- **钉钉用户 ID**: ${user.userId || '未知'}
- **Union ID**: ${user.unionId || '未知'}
- **登录 ID**: ${user.loginId || '未知'}
- **邮箱**: ${user.email || '未设置'}
- **企业邮箱**: ${user.orgEmail || '未设置'}
- **手机号**: ${user.mobile ? maskMobile(user.mobile) : '未设置'}

### 职位信息
- **职位**: ${user.title || '未设置'}
- **工号**: ${user.jobNumber || '未设置'}
- **办公地点**: ${user.workPlace || '未设置'}
- **入职日期**: ${hiredDateStr}
- **部门 ID**: ${deptStr}

### 角色与权限
- **角色**: ${rolesStr}
- **管理员**: ${user.admin ? '是' : '否'}
- **老板**: ${user.boss ? '是' : '否'}
- **高管**: ${user.senior ? '是' : '否'}

### 账号状态
- **激活状态**: ${user.active ? '已激活' : '未激活'}
- **禁用状态**: ${user.disableStatus ? '已禁用' : '正常'}
- **实名认证**: ${user.realAuthed ? '已认证' : '未认证'}
- **隐藏手机号**: ${user.hideMobile ? '是' : '否'}

### 企业账号信息
- **企业账号**: ${user.exclusiveAccount ? '是' : '否'}
- **账号类型**: ${user.exclusiveAccountType || '未知'}
- **企业 ID**: ${user.exclusiveAccountCorpId || '未知'}
- **企业名称**: ${user.exclusiveAccountCorpName || '未知'}

### 其他信息
- **直属主管 ID**: ${user.managerUserId || '未知'}
- **创建时间**: ${user.createTime || '未知'}
- **登录时间**: ${loginTime}`;

  const wrappedSection = `${CLAWX_BEGIN}\n${userSection}\n${CLAWX_END}`;

  for (const workspaceDir of workspaceDirs) {
    const targetPath = join(workspaceDir, 'USER.md');

    try {
      let existing = '';
      if (await fileExists(targetPath)) {
        existing = await readFile(targetPath, 'utf-8');
      }

      const merged = mergeUserSection(existing, wrappedSection);
      await writeFile(targetPath, merged, 'utf-8');
      logger.info(`[DingTalkUser] Wrote user info to USER.md (${workspaceDir})`);
    } catch (error) {
      logger.warn(`[DingTalkUser] Failed to write USER.md in ${workspaceDir}:`, error);
    }
  }
}

/**
 * Merge or replace the LYClaw user section in USER.md content.
 * If markers exist, replace the section in-place.
 * Otherwise, append at the end.
 */
function mergeUserSection(existing: string, wrappedSection: string): string {
  const beginIdx = existing.indexOf(CLAWX_BEGIN);
  const endIdx = existing.indexOf(CLAWX_END);

  if (beginIdx !== -1 && endIdx !== -1 && endIdx > beginIdx) {
    return existing.slice(0, beginIdx) + wrappedSection + existing.slice(endIdx + CLAWX_END.length);
  }

  const trimmed = existing.trimEnd();
  return trimmed + (trimmed ? '\n\n' : '') + wrappedSection + '\n';
}

/**
 * Mask mobile number for privacy (show first 3 and last 4 digits).
 */
function maskMobile(mobile: string): string {
  if (mobile.length <= 7) return mobile;
  return mobile.slice(0, 3) + '****' + mobile.slice(-4);
}

