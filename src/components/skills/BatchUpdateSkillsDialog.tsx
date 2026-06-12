import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { formatSkillVersionLabel, getMarketplaceSkillKey } from '@/lib/skill-metadata';
import { resolveCachedSkillDisplayMetadata } from '@/lib/skill-display-cache';
import type { MarketplaceSkill } from '@/types/skill';
import { BatchSelectSkillsDialog } from '@/components/skills/BatchSelectSkillsDialog';

interface BatchUpdateSkillsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  skills: MarketplaceSkill[];
  onConfirm: (skills: MarketplaceSkill[]) => void;
  busy?: boolean;
  progress?: { current: number; total: number } | null;
}

export function BatchUpdateSkillsDialog({
  open,
  onOpenChange,
  skills,
  onConfirm,
  busy = false,
  progress = null,
}: BatchUpdateSkillsDialogProps) {
  const { t } = useTranslation('skills');

  const items = useMemo(() => skills.map((skill) => {
    const key = getMarketplaceSkillKey(skill);
    const cached = resolveCachedSkillDisplayMetadata({ marketplaceSkill: skill });
    return {
      key,
      name: cached?.name ?? skill.name,
      versionLabel: formatSkillVersionLabel(
        cached?.version ?? skill.version,
        t('card.versionUnknown', { defaultValue: '未知' }),
      ),
    };
  }), [skills, t]);

  const skillByKey = useMemo(
    () => new Map(skills.map((skill) => [getMarketplaceSkillKey(skill), skill])),
    [skills],
  );

  return (
    <BatchSelectSkillsDialog
      open={open}
      dialogId="batch-update-skills-dialog-title"
      title={t('batchUpdate.title')}
      subtitle={t('batchUpdate.subtitle', { count: skills.length })}
      progressText={progress ? t('batchUpdate.progress', { current: progress.current, total: progress.total }) : undefined}
      selectAllLabel={t('batchUpdate.selectAllLabel')}
      selectAllAria={t('batchUpdate.selectAll')}
      deselectAllAria={t('batchUpdate.deselectAll')}
      cancelLabel={t('batchUpdate.cancel')}
      confirmLabel={t('batchUpdate.confirm')}
      items={items}
      onOpenChange={onOpenChange}
      onConfirm={(selectedKeys) => {
        const selected = selectedKeys
          .map((key) => skillByKey.get(key))
          .filter((skill): skill is MarketplaceSkill => skill != null);
        onConfirm(selected);
      }}
      onEmptySelection={() => {
        toast.error(t('toast.batchUpdateSelectRequired'));
      }}
      busy={busy}
      progress={progress}
    />
  );
}
