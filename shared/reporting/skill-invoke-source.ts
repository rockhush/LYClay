export type SkillInvokeReportSource =
  | 'builtin'
  | 'marketplace'
  | 'local'
  | 'digital_employee';

const MARKETPLACE_HINTS = new Set([
  'marketplace',
  'openclaw-managed',
  'company',
  'registry',
]);

export function isDigitalEmployeeSkillPath(path: string | undefined | null): boolean {
  const trimmed = (path ?? '').trim();
  if (!trimmed) return false;
  const normalized = trimmed
    .replace(/^~(?=$|[/\\])/, '')
    .replace(/\\/g, '/')
    .toLowerCase();
  return normalized.includes('/digital-employees/');
}

export function normalizeSkillInvokeReportSource(
  raw: string | undefined,
  hints?: {
    isBundled?: boolean;
    isCore?: boolean;
    baseDir?: string;
    numericMarketplaceId?: boolean;
    hasDownloads?: boolean;
  },
): SkillInvokeReportSource {
  const normalized = (raw ?? '').trim().toLowerCase();
  if (normalized === 'builtin' || normalized === 'bundled' || normalized === 'core') {
    return 'builtin';
  }
  if (normalized === 'marketplace' || normalized === 'registry' || normalized === 'company') {
    return 'marketplace';
  }
  if (normalized === 'digital_employee' || normalized === 'digital-employee') {
    return 'digital_employee';
  }
  if (normalized === 'local' || normalized === 'workspace' || normalized === 'custom') {
    return 'local';
  }
  if (hints?.isBundled || hints?.isCore) return 'builtin';
  if (hints?.numericMarketplaceId || hints?.hasDownloads) return 'marketplace';
  if (hints?.baseDir?.replace(/\\/g, '/').toLowerCase().includes('/digital-employees/')) {
    return 'digital_employee';
  }
  if (MARKETPLACE_HINTS.has(normalized)) return 'marketplace';
  return 'local';
}
