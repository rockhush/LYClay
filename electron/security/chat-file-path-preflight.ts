import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { evaluatePathPolicy } from './path-policy';
import { grantPathAccess } from './permission-store';
import { requestSecurityConfirmation } from './confirmation-service';

const TRAILING_PUNCTUATION = /[)\]),.;!?，。！？；、]+$/;
const WRAPPING_BRACKETS = /^[[(](.*?)[)\]]$/;
const FILE_URL_PATTERN = /\bfile:\/\/[^\s<>"'`]+/gi;
const QUOTED_PATH_PATTERN = /["'`]([^"'`]*(?:[A-Za-z]:[\\/]|file:\/\/|\/(?:Users|home|etc|var|tmp)\/)[^"'`]*)["'`]/gi;
const WINDOWS_FILE_PATH_PATTERN = /\b[A-Za-z]:[\\/](?:[^\\/:*?"<>|\r\n\s,;!?，。！？；、"'`()]+[\\/])*[^\\/:*?"<>|\r\n\s,;!?，。！？；、"'`()]*?\.[A-Za-z0-9][A-Za-z0-9_-]{0,15}\b/g;
const WINDOWS_DIRECTORY_PATH_PATTERN = /\b[A-Za-z]:[\\/](?:[^\\/:*?"<>|\r\n,;!?，。！？；、"'`()]+[\\/])+[^\\/:*?"<>|\r\n\s,;!?，。！？；、"'`()]*/g;
const MEDIA_ATTACHED_BLOCK_PATTERN = /\[media attached:\s*([\s\S]*?)\s*\]/g;
const MEDIA_PIPE_SEPARATOR = ' | ';
const POSIX_FILE_PATH_PATTERN = /(?:^|[\s(["'`])((?:\/Users|\/home|\/etc|\/var|\/tmp)\/[^\s<>"'`]*?\.[A-Za-z0-9][A-Za-z0-9_-]{0,15}\b)/g;

function toError(message: string, code: string): Error & { code?: string } {
  const error = new Error(message) as Error & { code?: string };
  error.code = code;
  return error;
}

function trimCandidate(raw: string): string {
  // 模型常用 [路径] 或 (路径) 包裹路径，先去掉成对的方/圆括号，再清理结尾标点，
  // 避免把闭合的 ] / ) 吞进路径（否则会得到 ...clawx-sec-test] 这种不存在的脏路径）。
  const unwrapped = raw.trim().replace(WRAPPING_BRACKETS, '$1');
  return unwrapped.replace(TRAILING_PUNCTUATION, '');
}

function trimNaturalLanguageAfterExtension(candidate: string): string {
  const match = candidate.match(/^(.+\.[A-Za-z0-9][A-Za-z0-9_-]{0,15})([^\x00-\x7F].*)$/);
  return match ? match[1] : candidate;
}

function trimTrailingMimeAnnotation(candidate: string): string {
  const match = candidate.match(/^(.+\.[A-Za-z0-9][A-Za-z0-9_-]{0,15})(\s*\(.*)?$/);
  return match ? match[1] : candidate;
}

function normalizeCandidate(raw: string): string | null {
  const trimmed = trimTrailingMimeAnnotation(trimNaturalLanguageAfterExtension(trimCandidate(raw)));
  if (!trimmed) return null;
  if (/^media:\/\//i.test(trimmed)) return null;
  if (/^file:\/\//i.test(trimmed)) {
    try {
      return fileURLToPath(trimmed);
    } catch {
      return null;
    }
  }
  if (/^[A-Za-z]:[\\/]/.test(trimmed)) {
    return path.normalize(trimmed);
  }
  return trimmed;
}

function addCandidate(paths: string[], raw: string): void {
  const normalized = normalizeCandidate(raw);
  if (normalized) paths.push(normalized);
}

function dedupePathCandidates(paths: string[]): string[] {
  const unique = [...new Set(paths)];
  return unique.filter((candidate) => !unique.some((other) => {
    if (other === candidate) return false;
    if (!other.startsWith(candidate)) return false;
    const next = other[candidate.length];
    return next === '\\' || next === '/';
  }));
}

function stripMediaAttachedBlocks(text: string): string {
  return text.replace(/\s*\[media attached:[^\]]*\]/g, '');
}

function parseMediaAttachedBlock(inner: string): string[] {
  const trimmed = inner.trim();
  if (!trimmed) return [];

  const pipeIdx = trimmed.lastIndexOf(MEDIA_PIPE_SEPARATOR);
  if (pipeIdx < 0) {
    const parenIdx = trimmed.lastIndexOf(' (');
    if (parenIdx < 0) return [trimmed];
    return [trimmed.slice(0, parenIdx).trim()];
  }

  const rightPath = trimmed.slice(pipeIdx + MEDIA_PIPE_SEPARATOR.length).trim();
  const left = trimmed.slice(0, pipeIdx);
  const parenIdx = left.lastIndexOf(' (');
  const leftPath = parenIdx < 0 ? left.trim() : left.slice(0, parenIdx).trim();
  return [leftPath, rightPath].filter(Boolean);
}

function extractMediaAttachedPaths(text: string): string[] {
  const paths: string[] = [];
  for (const match of text.matchAll(MEDIA_ATTACHED_BLOCK_PATTERN)) {
    for (const rawPath of parseMediaAttachedBlock(match[1])) {
      addCandidate(paths, rawPath);
    }
  }
  return paths;
}

export function extractLocalFilePathReferences(text: string): string[] {
  const paths: string[] = [];

  for (const path of extractMediaAttachedPaths(text)) {
    paths.push(path);
  }

  const stripped = stripMediaAttachedBlocks(text);

  for (const match of stripped.matchAll(FILE_URL_PATTERN)) {
    addCandidate(paths, match[0]);
  }

  for (const match of stripped.matchAll(QUOTED_PATH_PATTERN)) {
    addCandidate(paths, match[1]);
  }

  for (const match of stripped.matchAll(WINDOWS_FILE_PATH_PATTERN)) {
    addCandidate(paths, match[0]);
  }

  for (const match of stripped.matchAll(WINDOWS_DIRECTORY_PATH_PATTERN)) {
    addCandidate(paths, match[0]);
  }

  for (const match of stripped.matchAll(POSIX_FILE_PATH_PATTERN)) {
    addCandidate(paths, match[1]);
  }

  return dedupePathCandidates(paths);
}

async function assertResolvedFilePathsAllowed(paths: string[], source: string): Promise<void> {
  for (const filePath of paths) {
    // 这里拦截的是“用户消息里明写本地路径 -> Gateway runtime 可能直接 read”的旁路。
    // 真正的文件访问判断仍交给 path-policy，确保 workspace、显式授权和敏感路径规则一致。
    const result = await evaluatePathPolicy({
      path: filePath,
      capability: 'read',
      source,
    });

    if (result.decision.action !== 'allow') {
      const reason = result.decision.reasons.join('; ') || 'Local file path is not allowed';
      const denyCode = result.decision.action === 'deny' ? result.decision.code : '';
      if (denyCode === 'SENSITIVE_PATH') {
        throw toError(`Sensitive local file path access blocked: ${filePath}. ${reason}`, denyCode);
      }
      if (denyCode !== 'PATH_OUTSIDE_AUTHORIZED_ROOTS') {
        continue;
      }

      const response = await requestSecurityConfirmation({
        kind: 'file',
        source,
        risk: result.decision.risk,
        target: {
          path: result.pathInfo?.absolutePath ?? filePath,
          capability: 'read',
        },
        reasons: result.decision.reasons,
      });

      if (response.choice === 'deny') {
        throw toError(`Local file path access denied by user: ${filePath}`, 'FILE_PATH_ACCESS_DENIED_BY_USER');
      }

      if (response.choice === 'allow-session' || response.choice === 'allow-persistent') {
        await grantPathAccess(result.pathInfo?.absolutePath ?? filePath, {
          capabilities: ['read'],
          persistent: response.choice === 'allow-persistent',
          source,
        });
      }
    }
  }
}

export async function assertTextFilePathsAllowed(text: string, source: string): Promise<void> {
  await assertResolvedFilePathsAllowed(extractLocalFilePathReferences(text), source);
}

export async function assertMediaFilePathsAllowed(filePaths: string[], source: string): Promise<void> {
  const normalized = filePaths
    .map((filePath) => path.normalize(filePath.trim()))
    .filter(Boolean);
  await assertResolvedFilePathsAllowed(normalized, source);
}

export async function assertGatewayRpcFilePathsAllowed(method: string, params: unknown): Promise<void> {
  if (method !== 'chat.send') return;
  if (!params || typeof params !== 'object') return;
  const message = (params as Record<string, unknown>).message;
  if (typeof message !== 'string' || !message.trim()) return;
  const source = 'gateway:rpc:chat.send';
  await assertMediaFilePathsAllowed(extractMediaAttachedPaths(message), source);
  await assertTextFilePathsAllowed(stripMediaAttachedBlocks(message), source);
}
