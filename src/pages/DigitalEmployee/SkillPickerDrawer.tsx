import { useEffect, useMemo, useState } from 'react';
import { Check, Loader2, Search, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useSkillsStore } from '@/stores/skills';
import { isPlaceholderSkillDescription, shouldIncludeInMySkills } from '@/lib/skill-metadata';
import type { Skill } from '@/types/skill';
import { cn } from '@/lib/utils';

function getSkillInitial(name: string): string {
  if (!name) return 'S';
  const trimmed = name.trim();
  const firstChar = trimmed.charAt(0).toUpperCase();
  return firstChar.match(/[A-Za-z一-龥]/) ? firstChar : 'S';
}

interface SkillPickerDrawerProps {
  open: boolean;
  selectedIds: Set<string>;
  onSelectedIdsChange: (ids: Set<string>) => void;
  onConfirm: () => void;
  onCancel: () => void;
}

function SkillPickerRow({
  skill,
  checked,
  onToggle,
}: {
  skill: Skill;
  checked: boolean;
  onToggle: () => void;
}) {
  const description = isPlaceholderSkillDescription(skill.description)
    ? ''
    : (skill.description?.trim() || '');

  return (
    <button
      type="button"
      onClick={onToggle}
      className="flex w-full items-start gap-3 rounded-xl px-1 py-2 text-left transition-colors hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
    >
      <span
        className={cn(
          'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors',
          checked
            ? 'border-[#FF922B] bg-[#FF922B] text-white'
            : 'border-black/20 bg-white dark:border-white/20 dark:bg-transparent',
        )}
        aria-hidden
      >
        {checked ? <Check className="h-3 w-3" strokeWidth={3} /> : null}
      </span>
      <div className="flex min-w-0 flex-1 items-start gap-2.5">
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-[#FF922B] text-[12px] font-semibold text-white">
          {getSkillInitial(skill.name)}
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-medium text-foreground">{skill.name}</div>
          {description ? (
            <p className="mt-0.5 line-clamp-2 text-[11px] leading-[1.5] text-muted-foreground">
              {description}
            </p>
          ) : null}
        </div>
      </div>
    </button>
  );
}

export function SkillPickerDrawer({
  open,
  selectedIds,
  onSelectedIdsChange,
  onConfirm,
  onCancel,
}: SkillPickerDrawerProps) {
  const { skills, loading, fetchSkills } = useSkillsStore();
  const [searchQuery, setSearchQuery] = useState('');

  useEffect(() => {
    if (!open) return;
    setSearchQuery('');
    void fetchSkills();
  }, [open, fetchSkills]);

  const enabledSkills = useMemo(
    () => (Array.isArray(skills) ? skills : []).filter(
      (skill) => skill.enabled && shouldIncludeInMySkills(skill),
    ),
    [skills],
  );

  const filteredSkills = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return enabledSkills;
    return enabledSkills.filter((skill) => {
      const nameMatch = skill.name.toLowerCase().includes(q);
      const descMatch = skill.description?.toLowerCase().includes(q) ?? false;
      const idMatch = skill.id.toLowerCase().includes(q);
      const slugMatch = (skill.slug || '').toLowerCase().includes(q);
      return nameMatch || descMatch || idMatch || slugMatch;
    });
  }, [enabledSkills, searchQuery]);

  const toggleSkill = (skillId: string) => {
    const next = new Set(selectedIds);
    if (next.has(skillId)) {
      next.delete(skillId);
    } else {
      next.add(skillId);
    }
    onSelectedIdsChange(next);
  };

  return (
    <div
      className={cn(
        'absolute inset-0 z-20 flex flex-col bg-white transition-transform duration-300 ease-out dark:bg-card',
        open ? 'translate-x-0' : 'pointer-events-none translate-x-full',
      )}
      aria-hidden={!open}
    >
      <div className="flex items-center justify-between border-b border-black/[0.06] px-6 py-4 dark:border-white/10">
        <h3 className="text-[16px] font-bold text-foreground">选择技能</h3>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={onCancel}
          className="h-8 w-8 rounded-lg text-muted-foreground hover:text-foreground hover:bg-black/5 dark:hover:bg-white/5"
        >
          <X className="h-4 w-4" />
        </Button>
      </div>

      <div className="px-6 pt-4 pb-2">
        <p className="mb-3 text-[11px] font-medium text-muted-foreground/80">选择要使用的技能</p>
        <div className="relative flex items-center rounded-full border border-transparent bg-[#FFF2E5] px-3 py-1.5 transition-colors focus-within:border-[#FF922B]/40 dark:bg-[#FF922B]/15">
          <Search className="h-3.5 w-3.5 shrink-0 text-[#FF922B]" />
          <input
            placeholder="搜索技能"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="ml-2 w-full bg-transparent text-[13px] text-foreground outline-none placeholder:text-[#FF922B]/80"
          />
          {searchQuery ? (
            <button
              type="button"
              onClick={() => setSearchQuery('')}
              className="ml-1 shrink-0 text-[#FF922B]/70 hover:text-[#FF922B]"
            >
              <X className="h-3 w-3" />
            </button>
          ) : null}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-6 pb-4 min-h-0">
        {loading ? (
          <div className="flex items-center justify-center py-16 text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            <span className="text-[13px]">加载中...</span>
          </div>
        ) : filteredSkills.length === 0 ? (
          <div className="flex items-center justify-center py-16 text-[13px] text-muted-foreground">
            {enabledSkills.length === 0 ? '暂无已启用的技能' : '未找到匹配的技能'}
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-x-3 gap-y-1">
            {filteredSkills.map((skill) => (
              <SkillPickerRow
                key={skill.id}
                skill={skill}
                checked={selectedIds.has(skill.id)}
                onToggle={() => toggleSkill(skill.id)}
              />
            ))}
          </div>
        )}
      </div>

      <div className="flex items-center justify-end gap-2 border-t border-black/[0.06] px-6 py-4 dark:border-white/10">
        <Button
          type="button"
          variant="outline"
          onClick={onCancel}
          className="h-8 rounded-lg px-4 text-[13px] border-black/10 dark:border-white/10"
        >
          取消
        </Button>
        <Button
          type="button"
          onClick={onConfirm}
          className="h-8 rounded-lg px-4 text-[13px] bg-[#FF922B] hover:bg-[#FE7B00] text-white shadow-sm"
        >
          确定
        </Button>
      </div>
    </div>
  );
}
