const MEDIA_ATTACHED_BLOCK_PATTERN = /\[media attached:\s*([\s\S]*?)\s*\]/g;
const MEDIA_PIPE_SEPARATOR = ' | ';
const STAGED_DISK_NAME_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-(.+)$/i;

export type MediaRef = { filePath: string; mimeType: string };

export function basenameFromPath(filePath: string): string {
  return filePath.split(/[\\/]/).pop() || 'file';
}

export function isVirtualMediaUri(filePath: string): boolean {
  return /^media:\/\//i.test(filePath.trim());
}

function parseMediaAttachedBlock(inner: string): MediaRef[] {
  const trimmed = inner.trim();
  if (!trimmed) return [];

  const pipeIdx = trimmed.lastIndexOf(MEDIA_PIPE_SEPARATOR);
  const left = pipeIdx >= 0 ? trimmed.slice(0, pipeIdx) : trimmed;
  const rightPath = pipeIdx >= 0 ? trimmed.slice(pipeIdx + MEDIA_PIPE_SEPARATOR.length).trim() : '';

  const parenIdx = left.lastIndexOf(' (');
  const filePath = (parenIdx >= 0 ? left.slice(0, parenIdx) : left).trim();
  const mimeType = parenIdx >= 0
    ? left.slice(parenIdx + 2).replace(/\)\s*$/, '').trim()
    : 'application/octet-stream';

  const refs: MediaRef[] = [];
  if (filePath) refs.push({ filePath, mimeType });
  if (rightPath && rightPath !== filePath) refs.push({ filePath: rightPath, mimeType });
  return refs;
}

/** Parse `[media attached: path (mime) | path]` blocks from message text. */
export function extractMediaAttachedRefs(text: string): MediaRef[] {
  const refs: MediaRef[] = [];
  for (const match of text.matchAll(MEDIA_ATTACHED_BLOCK_PATTERN)) {
    refs.push(...parseMediaAttachedBlock(match[1]));
  }
  return refs;
}

/** Prefer real disk paths over gateway `media://` URIs; prefer outbound staging copies. */
export function preferAuthoritativeMediaRefs(refs: MediaRef[]): MediaRef[] {
  const local = refs.filter((ref) => !isVirtualMediaUri(ref.filePath));
  if (local.length === 0) return refs;

  const outbound = local.filter((ref) => /[\\/]outbound[\\/]/i.test(ref.filePath));
  const chosen = outbound.length > 0 ? outbound : local;

  const seen = new Set<string>();
  return chosen.filter((ref) => {
    if (seen.has(ref.filePath)) return false;
    seen.add(ref.filePath);
    return true;
  });
}

export function sanitizeStagedFileNameSegment(fileName: string): string {
  const base = basenameFromPath(fileName).trim() || 'file';
  return base
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/\s+/g, ' ')
    .slice(0, 120);
}

/** Disk name under ~/.openclaw/media/outbound — keeps original basename for humans and agents. */
export function buildStagedDiskFileName(id: string, originalFileName: string): string {
  const safe = sanitizeStagedFileNameSegment(originalFileName);
  const dot = safe.lastIndexOf('.');
  const ext = dot > 0 ? safe.slice(dot) : '';
  const stem = ext ? safe.slice(0, -ext.length) : safe;
  return `${id}-${stem || 'file'}${ext}`;
}

export function displayNameFromStagedDiskFileName(diskFileName: string): string {
  const match = diskFileName.match(STAGED_DISK_NAME_PATTERN);
  return match?.[1] ?? diskFileName;
}

export function buildStagedMediaSystemPrompt(
  media: Array<{ filePath: string; fileName: string; mimeType: string }>,
): string {
  if (!media.length) return '';
  const lines = media.map(
    (item) => `- ${item.fileName} (${item.mimeType}): ${item.filePath}`,
  );
  return [
    '## Staged attachments (authoritative — use exact paths)',
    ...lines,
    'Use only these filesystem paths for message/file tools. Do not merge UUIDs, invent paths, or use media:// URIs.',
  ].join('\n');
}
