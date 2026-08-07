import type { TFunction } from 'i18next';

export function resolveSkillFolderOpenError(
  error: unknown,
  t: TFunction<'skills'>,
): string {
  const message = error instanceof Error ? error.message : String(error ?? '');
  const normalized = message.toLowerCase();
  if (
    normalized.includes('outside authorized workspaces')
    || normalized.includes('outside authorized roots')
    || normalized.includes('outside authorized') && normalized.includes('session grants')
  ) {
    return t('toast.skillFolderUnauthorized');
  }
  return `${t('toast.failedOpenActualFolder')}: ${message || t('details.pathUnavailable')}`;
}
