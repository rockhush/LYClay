import { useEffect, useRef, useState, type ChangeEvent, type Dispatch, type SetStateAction } from 'react';
import {
  FolderOpen,
  Plus,
  Trash2,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { useSkillsStore } from '@/stores/skills';
import { useConnectorsStore } from '@/stores/connectors';
import { toast } from 'sonner';
import { SkillPickerDrawer } from './SkillPickerDrawer';
import { McpPickerDrawer } from './McpPickerDrawer';
import type { DigitalEmployeeFormData, ToggleRowItem } from './types';
import { cn } from '@/lib/utils';
import {
  DEFAULT_KEYWORDS,
} from './types';

interface DigitalEmployeeDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  employee?: DigitalEmployeeFormData | null;
  onSave: (data: DigitalEmployeeFormData) => void;
}

function getItemInitial(name: string): string {
  if (!name) return 'S';
  const trimmed = name.trim();
  const firstChar = trimmed.charAt(0).toUpperCase();
  return firstChar.match(/[A-Za-z一-龥]/) ? firstChar : 'S';
}

function SectionHeader({
  title,
  actionLabel,
  onAction,
}: {
  title: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <h4 className="text-[13px] font-semibold text-foreground">{title}</h4>
      {actionLabel && onAction ? (
        <button
          type="button"
          onClick={onAction}
          className="inline-flex items-center gap-1 text-[12px] font-medium text-[#FF922B] hover:text-[#FE7B00] transition-colors"
        >
          <Plus className="h-3.5 w-3.5" />
          {actionLabel}
        </button>
      ) : null}
    </div>
  );
}

function ToggleRowList({
  items,
  onToggle,
}: {
  items: ToggleRowItem[];
  onToggle: (id: string, enabled: boolean) => void;
}) {
  return (
    <div className="space-y-1">
      {items.map((item) => (
        <div
          key={item.id}
          className="flex items-center justify-between gap-3 py-2"
        >
          <div className="flex min-w-0 flex-1 items-center gap-2.5">
            <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-[#FF922B] text-[12px] font-semibold text-white">
              {getItemInitial(item.label)}
            </div>
            <span className="min-w-0 truncate text-[13px] text-foreground">{item.label}</span>
          </div>
          <Switch
            checked={item.enabled}
            onCheckedChange={(checked) => onToggle(item.id, checked)}
            size="sm"
          />
        </div>
      ))}
    </div>
  );
}

export function DigitalEmployeeDrawer({ open, onOpenChange, employee = null, onSave }: DigitalEmployeeDrawerProps) {
  const [name, setName] = useState('');
  const [nameError, setNameError] = useState('');
  const [prompt, setPrompt] = useState('');
  const [keywords, setKeywords] = useState(DEFAULT_KEYWORDS);
  const [skills, setSkills] = useState<ToggleRowItem[]>([]);
  const [skillPickerOpen, setSkillPickerOpen] = useState(false);
  const [draftSkillIds, setDraftSkillIds] = useState<Set<string>>(new Set());
  const [mcpItems, setMcpItems] = useState<ToggleRowItem[]>([]);
  const [mcpPickerOpen, setMcpPickerOpen] = useState(false);
  const [draftMcpIds, setDraftMcpIds] = useState<Set<string>>(new Set());
  const [knowledgeDocs, setKnowledgeDocs] = useState<string[]>([]);
  const knowledgeFileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) {
      setSkillPickerOpen(false);
      setMcpPickerOpen(false);
      return;
    }

    if (employee) {
      setName(employee.name);
      setPrompt(employee.prompt);
      setKeywords(employee.keywords);
      setSkills(employee.skills.map((item) => ({ ...item })));
      setMcpItems(employee.mcpItems.map((item) => ({ ...item })));
      setKnowledgeDocs([...employee.knowledgeDocs]);
    } else {
      setName('');
      setPrompt('');
      setKeywords(DEFAULT_KEYWORDS);
      setSkills([]);
      setMcpItems([]);
      setKnowledgeDocs([]);
    }

    setDraftSkillIds(new Set());
    setDraftMcpIds(new Set());
    setNameError('');
  }, [open, employee]);

  const handleClose = () => onOpenChange(false);

  const openSkillPicker = () => {
    setMcpPickerOpen(false);
    setDraftSkillIds(new Set(skills.map((skill) => skill.id)));
    setSkillPickerOpen(true);
  };

  const cancelSkillPicker = () => {
    setSkillPickerOpen(false);
  };

  const confirmSkillPicker = () => {
    const storeSkills = useSkillsStore.getState().skills;
    const skillById = new Map(
      (Array.isArray(storeSkills) ? storeSkills : []).map((skill) => [skill.id, skill]),
    );
    const previousById = new Map(skills.map((skill) => [skill.id, skill]));
    const orderedIds = [
      ...skills.map((skill) => skill.id).filter((id) => draftSkillIds.has(id)),
      ...[...draftSkillIds].filter((id) => !previousById.has(id)),
    ];

    const nextSkills: ToggleRowItem[] = orderedIds
      .map((skillId) => {
        const skill = skillById.get(skillId);
        if (!skill) return null;
        const previous = previousById.get(skillId);
        return {
          id: skill.id,
          label: skill.name,
          enabled: previous?.enabled ?? true,
        };
      })
      .filter((item): item is ToggleRowItem => item != null);

    setSkills(nextSkills);
    setSkillPickerOpen(false);
  };

  const openMcpPicker = () => {
    setSkillPickerOpen(false);
    setDraftMcpIds(new Set(mcpItems.map((item) => item.id)));
    setMcpPickerOpen(true);
  };

  const cancelMcpPicker = () => {
    setMcpPickerOpen(false);
  };

  const confirmMcpPicker = () => {
    const storeServers = useConnectorsStore.getState().mcpServers;
    const serverByName = new Map(
      (Array.isArray(storeServers) ? storeServers : []).map((server) => [server.name, server]),
    );
    const previousById = new Map(mcpItems.map((item) => [item.id, item]));
    const orderedIds = [
      ...mcpItems.map((item) => item.id).filter((id) => draftMcpIds.has(id)),
      ...[...draftMcpIds].filter((id) => !previousById.has(id)),
    ];

    const nextMcpItems: ToggleRowItem[] = orderedIds
      .map((serverName) => {
        const server = serverByName.get(serverName);
        if (!server) return null;
        const previous = previousById.get(serverName);
        return {
          id: server.name,
          label: server.name,
          enabled: previous?.enabled ?? server.enabled,
        };
      })
      .filter((item): item is ToggleRowItem => item != null);

    setMcpItems(nextMcpItems);
    setMcpPickerOpen(false);
  };

  const updateToggle = (
    setter: Dispatch<SetStateAction<ToggleRowItem[]>>,
    id: string,
    enabled: boolean,
  ) => {
    setter((prev) => prev.map((item) => (item.id === id ? { ...item, enabled } : item)));
  };

  const openKnowledgeUpload = () => {
    knowledgeFileInputRef.current?.click();
  };

  const handleKnowledgeFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    if (!files?.length) return;

    const uploadedNames = Array.from(files).map((file) => file.name);
    setKnowledgeDocs((prev) => {
      const existing = new Set(prev);
      const next = [...prev];
      for (const name of uploadedNames) {
        if (!existing.has(name)) {
          next.push(name);
          existing.add(name);
        }
      }
      return next;
    });
    event.target.value = '';
  };

  const buildFormData = (): DigitalEmployeeFormData => ({
    id: employee?.id ?? `employee-${Date.now()}`,
    name: name.trim(),
    prompt: prompt.trim(),
    keywords: keywords.trim(),
    skills: skills.map((item) => ({ ...item })),
    mcpItems: mcpItems.map((item) => ({ ...item })),
    knowledgeDocs: [...knowledgeDocs],
  });

  const handleSave = () => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      setNameError('请输入数字员工名称');
      toast.warning('请输入数字员工名称');
      return;
    }

    setNameError('');
    onSave(buildFormData());
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="flex w-full flex-col gap-0 overflow-hidden p-0 sm:max-w-[30rem] bg-white dark:bg-card"
      >
        <div className="relative flex h-full min-h-0 flex-col overflow-hidden">
          <SheetHeader className="flex-row items-center justify-between space-y-0 border-b border-black/[0.06] px-6 py-4 dark:border-white/10">
            <SheetTitle className="!text-[16px] font-sans font-bold text-foreground leading-tight tracking-normal">
              数字员工
            </SheetTitle>
            <SheetDescription className="sr-only">配置数字员工</SheetDescription>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={handleClose}
              className="h-8 w-8 rounded-lg text-muted-foreground hover:text-foreground hover:bg-black/5 dark:hover:bg-white/5"
            >
              <X className="h-4 w-4" />
            </Button>
          </SheetHeader>

          <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5 min-h-0">
          <div className="space-y-2">
            <Label htmlFor="digital-employee-name" className="text-[13px] font-medium text-foreground">
              数字员工名称
            </Label>
            <Input
              id="digital-employee-name"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                if (nameError) setNameError('');
              }}
              placeholder="请输入数字员工名称"
              className={cn(
                'h-10 rounded-xl border-black/10 bg-white text-[13px] dark:border-white/10',
                nameError && 'border-yellow-500 focus-visible:ring-yellow-500/30',
              )}
            />
            {nameError ? (
              <p className="text-[12px] text-yellow-700 dark:text-yellow-400">{nameError}</p>
            ) : null}
          </div>

          <div className="space-y-2">
            <Label htmlFor="digital-employee-prompt" className="text-[13px] font-medium text-foreground">
              提示词（选项）
            </Label>
            <Textarea
              id="digital-employee-prompt"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="描述数字员工的角色、工作流程、注意事项等..."
              className="min-h-[120px] rounded-xl border-black/10 bg-white text-[13px] leading-relaxed dark:border-white/10"
            />
          </div>

          {/*
          <div className="space-y-2">
            <Label htmlFor="digital-employee-keywords" className="text-[13px] font-medium text-foreground">
              关键词标签（AI生成可修改）
            </Label>
            <Input
              id="digital-employee-keywords"
              value={keywords}
              onChange={(e) => setKeywords(e.target.value)}
              className="h-10 rounded-xl border-black/10 bg-white text-[13px] dark:border-white/10"
            />
          </div>
          */}

          <section className="space-y-3">
            <SectionHeader title="技能" actionLabel="添加" onAction={openSkillPicker} />
            {skills.length > 0 ? (
              <ToggleRowList
                items={skills}
                onToggle={(id, enabled) => updateToggle(setSkills, id, enabled)}
              />
            ) : null}
          </section>

          <section className="space-y-3">
            <SectionHeader title="MCP" actionLabel="添加" onAction={openMcpPicker} />
            {mcpItems.length > 0 ? (
              <ToggleRowList
                items={mcpItems}
                onToggle={(id, enabled) => updateToggle(setMcpItems, id, enabled)}
              />
            ) : null}
          </section>

          <section className="space-y-3">
            <SectionHeader title="知识库" actionLabel="添加" onAction={openKnowledgeUpload} />
            <input
              ref={knowledgeFileInputRef}
              type="file"
              multiple
              className="hidden"
              accept=".pdf,.doc,.docx,.txt,.md,.csv,.xlsx,.xls,.ppt,.pptx"
              onChange={handleKnowledgeFileChange}
            />
            {knowledgeDocs.length > 0 ? (
              <div className="space-y-1">
                {knowledgeDocs.map((doc) => (
                  <div
                    key={doc}
                    className="py-2 text-[13px] text-foreground"
                  >
                    {doc}
                  </div>
                ))}
              </div>
            ) : null}
          </section>
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-black/[0.06] px-6 py-4 dark:border-white/10">
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              className="h-8 rounded-lg px-3 text-[13px] border-black/10 text-red-600 hover:text-red-700 hover:bg-red-50 dark:border-white/10 dark:hover:bg-red-500/10"
            >
              <Trash2 className="mr-1.5 h-3.5 w-3.5" />
              删除
            </Button>
            <Button
              type="button"
              variant="outline"
              className="h-8 rounded-lg px-3 text-[13px] border-black/10 dark:border-white/10"
            >
              <FolderOpen className="mr-1.5 h-3.5 w-3.5" />
              打开
            </Button>
          </div>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={handleClose}
              className="h-8 rounded-lg px-4 text-[13px] border-black/10 dark:border-white/10"
            >
              取消
            </Button>
            <Button
              type="button"
              onClick={handleSave}
              className="h-8 rounded-lg px-4 text-[13px] bg-[#FF922B] hover:bg-[#FE7B00] text-white shadow-sm"
            >
              保存
            </Button>
          </div>
          </div>

          <SkillPickerDrawer
            open={skillPickerOpen}
            selectedIds={draftSkillIds}
            onSelectedIdsChange={setDraftSkillIds}
            onConfirm={confirmSkillPicker}
            onCancel={cancelSkillPicker}
          />
          <McpPickerDrawer
            open={mcpPickerOpen}
            selectedIds={draftMcpIds}
            onSelectedIdsChange={setDraftMcpIds}
            onConfirm={confirmMcpPicker}
            onCancel={cancelMcpPicker}
          />
        </div>
      </SheetContent>
    </Sheet>
  );
}
