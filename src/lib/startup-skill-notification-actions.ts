/**
 * Silent install/update actions for the startup skill notification toast.
 * Mirrors Skills page handleInstall / handleUpdate without showing toasts.
 */
import {
  checkSkillUpdateForMarketplace,
  resolveMarketplaceSkillBySlug,
} from '@/lib/skill-update-check';
import {
  hasSkillVersionMismatch,
  SKILL_UPDATE_VERIFICATION_FAILED,
} from '@/lib/skill-update-verification';
import { useSkillsStore } from '@/stores/skills';

export type StartupSkillActionResult = 'success' | 'failed';

async function enableInstalledSkill(slug: string, packageSlug: string | undefined): Promise<void> {
  const { enableSkill } = useSkillsStore.getState();
  if (packageSlug) {
    const installed = useSkillsStore.getState().skills.find(
      (skill) => skill.slug === packageSlug || skill.id === packageSlug,
    );
    await enableSkill(installed?.id || packageSlug);
    return;
  }
  await enableSkill(slug);
}

/** Same core flow as Skills page handleInstall, without toast side effects. */
export async function runSilentSkillInstall(slug: string): Promise<StartupSkillActionResult> {
  try {
    const { installSkill, fetchSkills } = useSkillsStore.getState();
    const packageSlug = await installSkill(slug);
    await fetchSkills();
    await enableInstalledSkill(slug, packageSlug);
    await fetchSkills();
    return 'success';
  } catch (error) {
    console.warn('[StartupSkillNotification] install failed:', { slug, error });
    return 'failed';
  }
}

/** Same core flow as Skills page handleUpdate + performSkillUpdate, without toast side effects. */
export async function runSilentSkillUpdate(slug: string): Promise<StartupSkillActionResult> {
  const marketplaceSkill = resolveMarketplaceSkillBySlug(slug);
  if (!marketplaceSkill) {
    return 'failed';
  }

  const checkResult = await checkSkillUpdateForMarketplace(marketplaceSkill);
  if (checkResult.status === 'failed') {
    return 'failed';
  }

  if (checkResult.status === 'skipped') {
    const { skills, companyInstallMap, companyInstallEntries } = useSkillsStore.getState();
    if (hasSkillVersionMismatch(
      marketplaceSkill,
      skills,
      companyInstallMap,
      companyInstallEntries,
      checkResult.latestVersion,
    )) {
      return 'failed';
    }
    return 'success';
  }

  const latestVersion = checkResult.latestVersion;
  try {
    const { updateSkill, fetchSkills } = useSkillsStore.getState();
    const packageSlug = await updateSkill(slug, latestVersion);
    await fetchSkills();

    if (latestVersion.trim()) {
      const { skills, companyInstallMap, companyInstallEntries } = useSkillsStore.getState();
      if (hasSkillVersionMismatch(
        marketplaceSkill,
        skills,
        companyInstallMap,
        companyInstallEntries,
        latestVersion,
      )) {
        throw new Error(SKILL_UPDATE_VERIFICATION_FAILED);
      }
    }

    await enableInstalledSkill(slug, packageSlug);
    return 'success';
  } catch (error) {
    console.warn('[StartupSkillNotification] update failed:', { slug, error });
    return 'failed';
  }
}

export async function runSilentSkillNotificationAction(
  variant: 'update' | 'new',
  slug: string,
): Promise<StartupSkillActionResult> {
  return variant === 'update'
    ? runSilentSkillUpdate(slug)
    : runSilentSkillInstall(slug);
}
