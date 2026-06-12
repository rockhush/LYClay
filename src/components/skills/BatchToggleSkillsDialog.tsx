import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  formatSkillVersionLabel,
  resolveSkillDisplayNameForInstalled,
  resolveSkillListVersionForDisplay,
  findMarketplaceSkillMatch,
  buildMarketplaceLookupMaps,
} from '@/lib/skill-metadata';
import { lookupCachedSkillDisplayMetadata } from '@/lib/skill-display-cache';
import type { Skill } from '@/types/skill';
import { BatchSelectSkillsDialog } from '@/components/skills/BatchSelectSkillsDialog';

interface BatchToggleSkillsDialogProps {
  open: boolean;
  mode: 'enable' | 'disable';
  onOpenChange: (open: boolean) => void;
  skills: Skill[];
  marketplaceLookup: ReturnType<typeof buildMarketplaceLookupMaps>;
  onConfirm: (skills: Skill[]) => void;
  busy?: boolean;
  progress?: { current: number; total: number } | null;
}

function getSkillKey(skill: Skill): string {
  return skill.id?.trim() || skill.slug?.trim() || skill.name.trim();
}

export function BatchToggleSkillsDialog({
  open,
  mode,
  onOpenChange,
  skills,
  marketplaceLookup,
  onConfirm,
  busy = false,
  progress = null,
}: BatchToggleSkillsDialogProps) {
  const { t } = useTranslation('skills');
  const copyPrefix = mode === 'enable' ? 'batchEnable' : 'batchDisable';

  const items = useMemo(() => skills.map((skill) => {
    const marketplaceMatch = findMarketplaceSkillMatch(skill, marketplaceLookup);
    const cached = lookupCachedSkillDisplayMetadata({
      installedSkill: skill,
      marketplaceSkill: marketplaceMatch,
    });
    const name = resolveSkillDisplayNameForInstalled(skill, marketplaceMatch, cached?.name);
    const version = resolveSkillListVersionForDisplay(skill, marketplaceMatch, cached?.version);
    return {
      key: getSkillKey(skill),
      name,
      versionLabel: formatSkillVersionLabel(
        version,
        t('card.versionUnknown', { defaultValue: '未知' }),
      ),
    };
  }), [skills, marketplaceLookup, t]);

  const skillByKey = useMemo(
    () => new Map(skills.map((skill) => [getSkillKey(skill), skill])),
    [skills],
  );

  return (
    <BatchSelectSkillsDialog
      open={open}
      dialogId={`batch-${mode}-skills-dialog-title`}
      title={t(`${copyPrefix}.title`)}
      subtitle={t(`${copyPrefix}.subtitle`, { count: skills.length })}
      progressText={progress ? t(`${copyPrefix}.progress`, { current: progress.current, total: progress.total }) : undefined}
      selectAllLabel={t(`${copyPrefix}.selectAllLabel`)}
      selectAllAria={t(`${copyPrefix}.selectAll`)}
      deselectAllAria={t(`${copyPrefix}.deselectAll`)}
      cancelLabel={t(`${copyPrefix}.cancel`)}
      confirmLabel={t(`${copyPrefix}.confirm`)}
      items={items}
      onOpenChange={onOpenChange}
      onConfirm={(selectedKeys) => {
        const selected = selectedKeys
          .map((key) => skillByKey.get(key))
          .filter((skill): skill is Skill => skill != null);
        onConfirm(selected);
      }}
      onEmptySelection={() => {
        toast.error(t(mode === 'enable' ? 'toast.batchEnableSelectRequired' : 'toast.batchDisableSelectRequired'));
      }}
      busy={busy}
      progress={progress}
    />
  );
}
