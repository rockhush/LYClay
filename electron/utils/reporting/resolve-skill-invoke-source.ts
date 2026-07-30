import { BUNDLED_SKILL_SLUGS } from '../bundled-skills-slugs';
import { readCompanyMarketplaceInstallRegistry } from '../company-marketplace-installs';
import {
  normalizeSkillInvokeReportSource,
  type SkillInvokeReportSource,
} from '../../../shared/reporting/skill-invoke-source';

export async function resolveSkillInvokeSourceForReport(
  skillId: string,
  skillPath?: string,
): Promise<SkillInvokeReportSource> {
  const trimmed = skillId.trim();
  if (!trimmed) return 'local';

  if (skillPath) {
    const fromPath = normalizeSkillInvokeReportSource(undefined, { baseDir: skillPath });
    if (fromPath === 'digital_employee') return fromPath;
  }

  if (BUNDLED_SKILL_SLUGS.has(trimmed)) {
    return 'builtin';
  }

  try {
    const registry = await readCompanyMarketplaceInstallRegistry();
    for (const [marketplaceId, entry] of Object.entries(registry.byMarketplaceId)) {
      if (marketplaceId === trimmed || entry.packageSlug === trimmed) {
        return 'marketplace';
      }
    }
  } catch {
    // Registry read failure must not block skill-invoke reporting.
  }

  return normalizeSkillInvokeReportSource(undefined, {
    numericMarketplaceId: /^\d+$/.test(trimmed),
    baseDir: skillPath,
  });
}
