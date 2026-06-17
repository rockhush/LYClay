/**
 * Chat Input Component
 * Textarea with send button and universal file upload support.
 * Enter to send, Shift+Enter for new line.
 * Supports: native file picker, clipboard paste, drag & drop.
 * Files are staged to disk via IPC — only lightweight path references
 * are sent with the message (no base64 over WebSocket).
 */
import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { SendHorizontal, Square, X, Paperclip, FileText, Film, Music, FileArchive, File, Loader2, AtSign, Zap, Brain, Sparkles, Check, Puzzle, Upload, ChevronDown, Search, ShieldAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { WorkspacePicker } from '@/components/workspace/WorkspacePicker';
import { ModelPicker } from '@/components/workspace/ModelPicker';
import { hostApiFetch } from '@/lib/host-api';
import { invokeIpc } from '@/lib/api-client';
import { cn } from '@/lib/utils';
import { reportSkillInvoke } from '@/lib/usage-reporter';
import { detectMentionedSkillIds } from '@/stores/chat/usage-report-extract';
import { buildSkillMentionWithHint } from '@/pages/Chat/welcome-quick-actions';

// 统一使用品牌橙色作为技能图标背景（与技能页一致）
const SKILL_COLORS = [
  'bg-[#FF922B]',
];

// 根据技能名称生成哈希值
function getSkillHash(name: string): number {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    const char = name.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash);
}

// 获取技能名称的首字母
function getSkillInitial(name: string): string {
  if (!name) return 'S';
  const trimmed = name.trim();
  const firstChar = trimmed.charAt(0).toUpperCase();
  return firstChar.match(/[A-Za-z一-龥]/) ? firstChar : 'S';
}

// 根据技能名称获取颜色
function getSkillColor(name: string): string {
  const hash = getSkillHash(name);
  return SKILL_COLORS[hash % SKILL_COLORS.length];
}
import { useGatewayStore } from '@/stores/gateway';
import { useAgentsStore } from '@/stores/agents';
import { useDigitalEmployeesStore } from '@/stores/digital-employees';
import { useChatStore } from '@/stores/chat';
import type { ReasoningMode } from '@/stores/chat';
import { useTranslation } from 'react-i18next';
import { useSkillsStore } from '@/stores/skills';
import { UploadSkillDialog } from '@/components/skills/UploadSkillDialog';

// ── Types ────────────────────────────────────────────────────────

export interface FileAttachment {
  id: string;
  fileName: string;
  mimeType: string;
  fileSize: number;
  stagedPath: string;        // disk path for gateway
  preview: string | null;    // data URL for images, null for others
  status: 'staging' | 'ready' | 'error';
  error?: string;
}

function normalizeAttachmentError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error || '');
  const lower = raw.toLowerCase();
  if (lower.includes('sensitive path blocked')) {
    return '安全策略已阻止此附件：该路径可能包含密钥、凭据或登录数据。';
  }
  if (lower.includes('outside authorized workspaces') || lower.includes('outside authorized roots')) {
    return '无法添加此附件：文件不在已授权的工作区或已选择的文件范围内。';
  }
  if (lower.includes('outside its authorized root') || lower.includes('symlink')) {
    return '无法添加此附件：路径通过软链接指向授权范围外。';
  }
  if (lower.includes('file_access_denied') || lower.includes('path access denied')) {
    return '无法添加此附件：文件访问被安全策略拒绝。';
  }
  return raw.replace(/^Error:\s*/i, '') || '附件处理失败。';
}

export interface SkillAttachment {
  id: string;
  skillId: string;
  skillName: string;
  skillDescription: string;
  skillIcon: string;
  baseDir?: string;
}

interface ChatInputProps {
  onSend: (text: string, attachments?: FileAttachment[], targetAgentId?: string | null) => void;
  onStop?: () => void;
  disabled?: boolean;
  sending?: boolean;
  isEmpty?: boolean;
  initialText?: string;
  onTextChange?: (text: string) => void;
}

interface MentionableDigitalEmployee {
  id: string;
  name: string;
  description?: string;
  instanceId?: string;
}

// ── Helpers ──────────────────────────────────────────────────────

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function resolveLeadingAgentMention(
  text: string,
  agents: Array<{ id: string }> | undefined,
): { text: string; targetAgentId: string | null } {
  const match = /^\s*@([a-zA-Z0-9][\w-]{0,63})(?=\s|$)/.exec(text);
  if (!match) return { text, targetAgentId: null };

  const mention = match[1];
  const agent = (agents ?? []).find((candidate) => candidate.id === mention);
  if (!agent) return { text, targetAgentId: null };

  return {
    text: text.slice(match[0].length).trimStart(),
    targetAgentId: agent.id,
  };
}

function FileIcon({ mimeType, className }: { mimeType: string; className?: string }) {
  if (mimeType.startsWith('video/')) return <Film className={className} />;
  if (mimeType.startsWith('audio/')) return <Music className={className} />;
  if (mimeType.startsWith('text/') || mimeType === 'application/json' || mimeType === 'application/xml') return <FileText className={className} />;
  if (mimeType.includes('zip') || mimeType.includes('compressed') || mimeType.includes('archive') || mimeType.includes('tar') || mimeType.includes('rar') || mimeType.includes('7z')) return <FileArchive className={className} />;
  if (mimeType === 'application/pdf') return <FileText className={className} />;
  return <File className={className} />;
}

/**
 * Read a browser File object as base64 string (without the data URL prefix).
 */
function readFileAsBase64(file: globalThis.File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      if (!dataUrl || !dataUrl.includes(',')) {
        reject(new Error(`Invalid data URL from FileReader for ${file.name}`));
        return;
      }
      const base64 = dataUrl.split(',')[1];
      if (!base64) {
        reject(new Error(`Empty base64 data for ${file.name}`));
        return;
      }
      resolve(base64);
    };
    reader.onerror = () => reject(new Error(`Failed to read file: ${file.name}`));
    reader.readAsDataURL(file);
  });
}

// ── Component ────────────────────────────────────────────────────

export function ChatInput({ onSend, onStop, disabled = false, sending = false, isEmpty = false, initialText, onTextChange }: ChatInputProps) {
  const { t } = useTranslation('chat');
  const [input, setInput] = useState(initialText || '');

  // Sync initialText changes to input
  useEffect(() => {
    if (initialText !== undefined) {
      setInput(initialText);
    }
  }, [initialText]);

  const handleInputChange = (value: string) => {
    setInput(value);
    onTextChange?.(value);
  };
  const [attachments, setAttachments] = useState<FileAttachment[]>([]);
  const [skillAttachments, setSkillAttachments] = useState<SkillAttachment[]>([]);
  const [targetAgentId, setTargetAgentId] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [reasoningOpen, setReasoningOpen] = useState(false);
  const [skillPickerOpen, setSkillPickerOpen] = useState(false);
  const [skillSearchQuery, setSkillSearchQuery] = useState('');
  const [uploadSkillOpen, setUploadSkillOpen] = useState(false);
  const skillPickerRef = useRef<HTMLDivElement>(null);
  
  // 斜杠搜索模式状态
  const [slashSearchOpen, setSlashSearchOpen] = useState(false);
  const slashSearchRef = useRef<HTMLDivElement>(null);

  const skills = useSkillsStore((s) => s.skills);
  const skillsLoading = useSkillsStore((s) => s.loading);
  const fetchSkills = useSkillsStore((s) => s.fetchSkills);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const messages = useChatStore((s) => s.messages);
  const pickerRef = useRef<HTMLDivElement>(null);
  const reasoningRef = useRef<HTMLDivElement>(null);
  const isComposingRef = useRef(false);
  const gatewayStatus = useGatewayStore((s) => s.status);
  const gatewayReady = gatewayStatus.state === 'running' && gatewayStatus.gatewayReady === true;
  const composerPlaceholder = disabled
    ? gatewayStatus.state !== 'running'
      ? t('composer.gatewayDisconnectedPlaceholder')
      : !gatewayReady
        ? t('composer.gatewayInitializingPlaceholder')
        : gatewayStatus.warmupStatus === 'warming'
          ? t('composer.gatewayWarmingPlaceholder')
          : t('composer.gatewayPreparingPlaceholder')
    : '';
  const agents = useAgentsStore((s) => s.agents);
  const digitalEmployees = useDigitalEmployeesStore((s) => s.employees);
  const digitalEmployeesLoading = useDigitalEmployeesStore((s) => s.loading);
  const fetchDigitalEmployees = useDigitalEmployeesStore((s) => s.fetchEmployees);
  const currentAgentId = useChatStore((s) => s.currentAgentId);
  const reasoningMode = useChatStore((s) => s.reasoningMode);
  const setReasoningMode = useChatStore((s) => s.setReasoningMode);
  const reasoningOptions = useMemo(
    () => [
      {
        mode: 'fast' as const,
        label: t('composer.reasoning.fast'),
        description: t('composer.reasoning.fastDesc'),
        icon: Zap,
      },
      {
        mode: 'thinking' as const,
        label: t('composer.reasoning.thinking'),
        description: t('composer.reasoning.thinkingDesc'),
        icon: Brain,
      },
      {
        mode: 'expert' as const,
        label: t('composer.reasoning.expert'),
        description: t('composer.reasoning.expertDesc'),
        icon: Sparkles,
      },
    ],
    [t],
  );
  const currentReasoning = reasoningOptions.find((option) => option.mode === reasoningMode) ?? reasoningOptions[1]!;
  const CurrentReasoningIcon = currentReasoning.icon;
  const currentAgentName = useMemo(
    () => (agents ?? []).find((agent) => agent.id === currentAgentId)?.name ?? currentAgentId,
    [agents, currentAgentId],
  );
  const mentionableAgents = useMemo(
    (): MentionableDigitalEmployee[] => (digitalEmployees ?? [])
      .filter((employee) => employee.status === 'active' || employee.status === 'degraded')
      .map((employee) => ({
        id: employee.agentId,
        name: employee.name || employee.agentId,
        description: employee.description,
        instanceId: employee.instanceId,
      })),
    [digitalEmployees],
  );
  const selectedTarget = useMemo(
    () => mentionableAgents.find((agent) => agent.id === targetAgentId) ?? null,
    [mentionableAgents, targetAgentId],
  );
  const showAgentPicker = true;

  // Auto-resize textarea
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 240)}px`;
    }
  }, [input]);

  // Focus textarea on mount (avoids Windows focus loss after session delete + native dialog)
  useEffect(() => {
    if (!disabled && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [disabled]);

  useEffect(() => {
    if (!targetAgentId) return;
    if (!mentionableAgents.some((agent) => agent.id === targetAgentId)) {
      setTargetAgentId(null);
      setPickerOpen(false);
    }
  }, [mentionableAgents, targetAgentId]);

  useEffect(() => {
    void fetchDigitalEmployees();
  }, [fetchDigitalEmployees]);

  useEffect(() => {
    if (!pickerOpen) return;
    const handlePointerDown = (event: MouseEvent) => {
      if (!pickerRef.current?.contains(event.target as Node)) {
        setPickerOpen(false);
      }
    };
    document.addEventListener('mousedown', handlePointerDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
    };
  }, [pickerOpen]);

  useEffect(() => {
    if (!reasoningOpen) return;
    const handlePointerDown = (event: MouseEvent) => {
      if (!reasoningRef.current?.contains(event.target as Node)) {
        setReasoningOpen(false);
      }
    };
    document.addEventListener('mousedown', handlePointerDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
    };
  }, [reasoningOpen]);

  useEffect(() => {
    if (!skillPickerOpen) return;
    const handlePointerDown = (event: MouseEvent) => {
      if (!skillPickerRef.current?.contains(event.target as Node)) {
        setSkillPickerOpen(false);
        setSkillSearchQuery('');
      }
    };
    document.addEventListener('mousedown', handlePointerDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
    };
  }, [skillPickerOpen]);

  // 斜杠搜索的外部点击关闭
  useEffect(() => {
    if (!slashSearchOpen) return;
    const handlePointerDown = (event: MouseEvent) => {
      if (!slashSearchRef.current?.contains(event.target as Node)) {
        setSlashSearchOpen(false);
      }
    };
    document.addEventListener('mousedown', handlePointerDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
    };
  }, [slashSearchOpen]);

  // 监听输入变化，检测斜杠搜索
  useEffect(() => {
    if (input.startsWith('/') && input.length >= 1) {
      setSlashSearchOpen(true);
    } else {
      setSlashSearchOpen(false);
    }
  }, [input]);

  useEffect(() => {
    if (!skillPickerOpen) return;
    if (skills.length > 0 || skillsLoading) return;
    void fetchSkills();
  }, [fetchSkills, skillPickerOpen, skills.length, skillsLoading]);

  // 监听消息变化，当skill-creator工具执行完成后自动刷新技能列表
  useEffect(() => {
    if (messages.length === 0) return;
    
    // 获取最后一条消息
    const lastMessage = messages[messages.length - 1];
    
    // 检查是否是工具结果消息
    if (lastMessage.role === 'toolresult' || lastMessage.role === 'tool_result') {
      // 检查是否包含skill-creator相关的工具调用
      const content = lastMessage.content;
      if (typeof content === 'object' && content !== null) {
        // 检查工具名称
        if ('toolName' in content && content.toolName === 'skill-creator') {
          // 延迟刷新，确保技能已经保存到磁盘
          setTimeout(() => {
            void hostApiFetch<{ success: boolean }>('/api/clawhub/normalize-user-skills', {
              method: 'POST',
            })
              .catch(() => {})
              .finally(() => {
                void fetchSkills();
              });
          }, 1000);
        }
      }
    }
  }, [messages, fetchSkills]);

  // ── File staging via native dialog ─────────────────────────────

  const pickFiles = useCallback(async () => {
    try {
      const result = await invokeIpc('dialog:open', {
        properties: ['openFile', 'multiSelections'],
      }) as { canceled: boolean; filePaths?: string[] };
      if (result.canceled || !result.filePaths?.length) return;

      // Add placeholder entries immediately
      const tempIds: string[] = [];
      for (const filePath of result.filePaths) {
        const tempId = crypto.randomUUID();
        tempIds.push(tempId);
        // Handle both Unix (/) and Windows (\) path separators
        const fileName = filePath.split(/[\\/]/).pop() || 'file';
        setAttachments(prev => [...prev, {
          id: tempId,
          fileName,
          mimeType: '',
          fileSize: 0,
          stagedPath: '',
          preview: null,
          status: 'staging' as const,
        }]);
      }

      // Stage all files via IPC
      console.log('[pickFiles] Staging files:', result.filePaths);
      const staged = await hostApiFetch<Array<{
        id: string;
        fileName: string;
        mimeType: string;
        fileSize: number;
        stagedPath: string;
        preview: string | null;
      }>>('/api/files/stage-paths', {
        method: 'POST',
        body: JSON.stringify({ filePaths: result.filePaths }),
      });
      console.log('[pickFiles] Stage result:', staged?.map(s => ({ id: s?.id, fileName: s?.fileName, mimeType: s?.mimeType, fileSize: s?.fileSize, stagedPath: s?.stagedPath, hasPreview: !!s?.preview })));

      // Update each placeholder with real data
      setAttachments(prev => {
        let updated = [...prev];
        for (let i = 0; i < tempIds.length; i++) {
          const tempId = tempIds[i];
          const data = staged[i];
          if (data) {
            updated = updated.map(a =>
              a.id === tempId
                ? { ...data, status: 'ready' as const }
                : a,
            );
          } else {
            console.warn(`[pickFiles] No staged data for tempId=${tempId} at index ${i}`);
            updated = updated.map(a =>
              a.id === tempId
                ? { ...a, status: 'error' as const, error: 'Staging failed' }
                : a,
            );
          }
        }
        return updated;
      });
    } catch (err) {
      console.error('[pickFiles] Failed to stage files:', err);
      const message = normalizeAttachmentError(err);
      // Mark any stuck 'staging' attachments as 'error' so the user can remove them
      // and the send button isn't permanently blocked
      setAttachments(prev => prev.map(a =>
        a.status === 'staging'
          ? { ...a, status: 'error' as const, error: message }
          : a,
      ));
    }
  }, []);

  // ── Stage browser File objects (paste / drag-drop) ─────────────

  const stageBufferFiles = useCallback(async (files: globalThis.File[]) => {
    for (const file of files) {
      const tempId = crypto.randomUUID();
      setAttachments(prev => [...prev, {
        id: tempId,
        fileName: file.name,
        mimeType: file.type || 'application/octet-stream',
        fileSize: file.size,
        stagedPath: '',
        preview: null,
        status: 'staging' as const,
      }]);

      try {
        console.log(`[stageBuffer] Reading file: ${file.name} (${file.type}, ${file.size} bytes)`);
        const base64 = await readFileAsBase64(file);
        console.log(`[stageBuffer] Base64 length: ${base64?.length ?? 'null'}`);
        const staged = await hostApiFetch<{
          id: string;
          fileName: string;
          mimeType: string;
          fileSize: number;
          stagedPath: string;
          preview: string | null;
        }>('/api/files/stage-buffer', {
          method: 'POST',
          body: JSON.stringify({
            base64,
            fileName: file.name,
            mimeType: file.type || 'application/octet-stream',
          }),
        });
        console.log(`[stageBuffer] Staged: id=${staged?.id}, path=${staged?.stagedPath}, size=${staged?.fileSize}`);
        setAttachments(prev => prev.map(a =>
          a.id === tempId ? { ...staged, status: 'ready' as const } : a,
        ));
      } catch (err) {
        console.error(`[stageBuffer] Error staging ${file.name}:`, err);
        const message = normalizeAttachmentError(err);
        setAttachments(prev => prev.map(a =>
          a.id === tempId
            ? { ...a, status: 'error' as const, error: message }
            : a,
        ));
      }
    }
  }, []);

  // ── Attachment management ──────────────────────────────────────

  const removeAttachment = useCallback((id: string) => {
    setAttachments(prev => prev.filter(a => a.id !== id));
  }, []);

  const removeSkillAttachment = useCallback((id: string) => {
    setSkillAttachments(prev => prev.filter(s => s.id !== id));
  }, []);

  const addSkillAttachment = useCallback((skillId: string) => {
    const skill = skills.find(s => s.id === skillId);
    if (!skill) return;

    // Insert `@<skillName> 请使用这个技能，帮我` into the textarea instead of pinning a chip
    // card above the input, so the puzzle-icon picker matches the
    // slash-search behaviour the user already knows.
    const mention = `${buildSkillMentionWithHint(skill.name)} `;
    const textarea = textareaRef.current;
    let nextInput = input;
    if (textarea) {
      const start = textarea.selectionStart ?? input.length;
      const end = textarea.selectionEnd ?? input.length;
      const needsLeadingSpace = start > 0
        && !/\s/.test(input.charAt(start - 1))
        && input.charAt(start - 1) !== '@';
      const insertion = (needsLeadingSpace ? ' ' : '') + mention;
      nextInput = input.slice(0, start) + insertion + input.slice(end);
      const caret = start + insertion.length;
      // Defer caret restoration until after React rerenders.
      window.setTimeout(() => {
        if (textareaRef.current) {
          textareaRef.current.selectionStart = caret;
          textareaRef.current.selectionEnd = caret;
          textareaRef.current.focus();
        }
      }, 0);
    } else {
      nextInput = input + (input && !input.endsWith(' ') ? ' ' : '') + mention;
    }
    handleInputChange(nextInput);
    setSkillPickerOpen(false);
    setSkillSearchQuery('');
  }, [input, skills]);

  // 斜杠搜索选择技能后插入到输入框
  const handleSlashSkillSelect = useCallback((skill: Skill) => {
    // 替换 /xxx 为 @技能名 + 技能调用提示词
    const newInput = input.replace(/^\/[^\s]*/, `${buildSkillMentionWithHint(skill.name)} `);
    handleInputChange(newInput);
    setSlashSearchOpen(false);
  }, [input]);

  const allReady = attachments.length === 0 || attachments.every(a => a.status === 'ready');
  const hasFailedAttachments = attachments.some((a) => a.status === 'error');
  const canSend = (input.trim() || attachments.length > 0 || skillAttachments.length > 0) && allReady && !disabled && !sending;
  const canStop = sending && !disabled && !!onStop;

  const handleSend = useCallback(() => {
    if (!canSend) return;
    const readyAttachments = attachments.filter(a => a.status === 'ready');
    // Capture values before clearing — clear input immediately for snappy UX,
    // but keep attachments available for the async send
    const textToSend = input.trim();
    const attachmentsToSend = readyAttachments.length > 0 ? readyAttachments : undefined;
    
    // 如果有选中的技能，构建技能提示文本
    let skillPrompt = '';
    if (skillAttachments.length > 0) {
      const skillNames = skillAttachments.map(s => s.skillName).join(', ');
      skillPrompt = `\n\n请使用以下技能进行问答：${skillNames}`;
      
      // 如果有技能描述，添加到提示中
      skillAttachments.forEach(skill => {
        if (skill.skillDescription) {
          skillPrompt += `\n\n${skill.skillName}: ${skill.skillDescription}`;
        }
      });
    }
    
    const resolvedAgentMention = targetAgentId
      ? { text: textToSend, targetAgentId: null }
      : resolveLeadingAgentMention(textToSend, mentionableAgents);
    const effectiveTargetAgentId = targetAgentId ?? resolvedAgentMention.targetAgentId;
    const effectiveTextToSend = resolvedAgentMention.targetAgentId ? resolvedAgentMention.text : textToSend;
    const finalText = effectiveTextToSend + skillPrompt;
    
    console.log(`[handleSend] text="${finalText.substring(0, 50)}", attachments=${attachments.length}, ready=${readyAttachments.length}, skills=${skillAttachments.length}, targetAgent=${effectiveTargetAgentId ?? '(none)'}, sending=${!!attachmentsToSend}`);
    if (attachmentsToSend) {
      console.log('[handleSend] Attachment details:', attachmentsToSend.map(a => ({
        id: a.id, fileName: a.fileName, mimeType: a.mimeType, fileSize: a.fileSize,
        stagedPath: a.stagedPath, status: a.status, hasPreview: !!a.preview,
      })));
    }
    if (skillAttachments.length > 0) {
      console.log('[handleSend] Skill details:', skillAttachments.map(s => ({
        id: s.id, skillId: s.skillId, skillName: s.skillName,
      })));
    }
    // Skill invocation reporting — count every skill the user signaled they
    // want to use on this turn. Three sources are merged + de-duped:
    //   1. Explicit skillAttachments (added via the puzzle-icon picker)
    //   2. `@<skillName>` mentions in the final text (slash-search path
    //      replaces text but does NOT call addSkillAttachment, and users may
    //      type @-mentions by hand — both leave skillAttachments empty)
    //   3. (future) tool_use blocks in assistant response — handled by the
    //      runtime event handler, deduped via a separate `(runId, toolCallId)` key
    const skillInvocationIds = new Set<string>();
    for (const s of skillAttachments) {
      const id = (s.skillId || '').trim();
      if (id) skillInvocationIds.add(id);
    }
    for (const id of detectMentionedSkillIds(finalText, skills)) {
      skillInvocationIds.add(id);
    }
    if (skillInvocationIds.size > 0) {
      console.log('[handleSend] reporting skill invocations:', [...skillInvocationIds]);
      // Fire-and-forget — telemetry must never block sending.
      for (const id of skillInvocationIds) {
        void reportSkillInvoke(id, 1);
      }
    }
    handleInputChange('');
    setAttachments([]);
    setSkillAttachments([]);
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
    onSend(finalText, attachmentsToSend, effectiveTargetAgentId);
    setTargetAgentId(null);
    setPickerOpen(false);
  }, [input, attachments, skillAttachments, canSend, onSend, targetAgentId, mentionableAgents]);

  const handleStop = useCallback(() => {
    if (!canStop) return;
    onStop?.();
  }, [canStop, onStop]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Backspace' && !input && targetAgentId) {
        setTargetAgentId(null);
        return;
      }
      // 输入 / 时，不做特殊处理，让输入正常显示在输入框中
      // 斜杠搜索框会通过 useEffect 监听 input 变化自动显示
      if (e.key === '/') {
        // 确保原有技能选择器被关闭
        setSkillPickerOpen(false);
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        const nativeEvent = e.nativeEvent as KeyboardEvent;
        if (isComposingRef.current || nativeEvent.isComposing || nativeEvent.keyCode === 229) {
          return;
        }
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend, input, targetAgentId],
  );

  // Handle paste (Ctrl/Cmd+V with files)
  const handlePaste = useCallback(
    (e: React.ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;

      const pastedFiles: globalThis.File[] = [];
      for (const item of Array.from(items)) {
        if (item.kind === 'file') {
          const file = item.getAsFile();
          if (file) pastedFiles.push(file);
        }
      }
      if (pastedFiles.length > 0) {
        e.preventDefault();
        stageBufferFiles(pastedFiles);
      }
    },
    [stageBufferFiles],
  );

  // Handle drag & drop
  const [dragOver, setDragOver] = useState(false);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setDragOver(false);
      if (e.dataTransfer?.files?.length) {
        stageBufferFiles(Array.from(e.dataTransfer.files));
      }
    },
    [stageBufferFiles],
  );

  // 获取斜杠搜索的关键词（去掉开头的 /）
  const slashSearchKeyword = input.startsWith('/') ? input.slice(1) : '';

  return (
    <div
      className={cn(
        "p-4 pb-6 w-full mx-auto transition-all duration-300",
        isEmpty ? "max-w-3xl" : "max-w-4xl"
      )}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div className="w-full">
        {/* 斜杠搜索技能列表 */}
        {slashSearchOpen && (
          <div ref={slashSearchRef} className="mb-3 w-full max-w-4xl mx-auto">
            <div className="rounded-xl border border-black/10 bg-white p-1.5 shadow-xl dark:border-white/10 dark:bg-card">
              <div className="px-3 py-1.5 text-[11px] font-medium text-muted-foreground/80 border-b border-black/5">
                Skills
              </div>
              <div className="max-h-48 overflow-y-auto">
                {skillsLoading ? (
                  <div className="flex items-center justify-center py-4 text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin mr-2" />
                    <span className="text-xs">加载中...</span>
                  </div>
                ) : Array.isArray(skills) && skills.length === 0 ? (
                  <div className="flex items-center justify-center py-4 text-muted-foreground">
                    <span className="text-xs">暂无可用技能</span>
                  </div>
                ) : (
                  skills.filter(s => s.enabled).filter(skill => {
                    const q = slashSearchKeyword.toLowerCase().trim();
                    if (!q) {
                      return true;
                    }
                    const nameMatch = skill.name.toLowerCase().includes(q);
                    const descMatch = skill.description ? skill.description.toLowerCase().includes(q) : false;
                    return nameMatch || descMatch;
                  }).map((skill, index) => (
                    <button
                      key={skill.id}
                      type="button"
                      onClick={() => handleSlashSkillSelect(skill)}
                      className={cn(
                        'flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors',
                        index === 0 ? 'bg-primary/5' : 'hover:bg-black/5 dark:hover:bg-white/5'
                      )}
                    >
                      <div className={`w-5 h-5 flex-shrink-0 flex items-center justify-center text-xs font-bold text-white rounded-md ${getSkillColor(skill.name)}`}>
                        {getSkillInitial(skill.name)}
                      </div>
                      <div className="flex-1 min-w-0">
                        <span className="text-sm font-medium text-foreground">{skill.name}</span>
                        {skill.description && (
                          <p className="text-xs text-muted-foreground truncate mt-0.5">{skill.description}</p>
                        )}
                      </div>
                      <span className="text-xs text-muted-foreground">@</span>
                    </button>
                  ))
                )}
              </div>
            </div>
          </div>
        )}

        {/* Attachment Previews */}
        {attachments.length > 0 && (
          <div className="flex gap-2 mb-3 flex-wrap">
            {attachments.map((att) => (
              <AttachmentPreview
                key={att.id}
                attachment={att}
                onRemove={() => removeAttachment(att.id)}
              />
            ))}
          </div>
        )}

        {/* Skill Previews */}
        {skillAttachments.length > 0 && (
          <div className="flex gap-2 mb-3 flex-wrap">
            {skillAttachments.map((skillAtt) => (
              <SkillAttachmentPreview
                key={skillAtt.id}
                skill={skillAtt}
                onRemove={() => removeSkillAttachment(skillAtt.id)}
              />
            ))}
          </div>
        )}

        {/* Input Container */}
        <div className={`relative bg-white dark:bg-card rounded-2xl shadow-sm border px-3 pt-2.5 pb-1.5 transition-all ${dragOver ? 'border-[#FF922B] ring-1 ring-[#FF922B]' : 'border-[#FF922B]/40 dark:border-white/10'}`}>
          {selectedTarget && (
            <div className="pb-1.5">
              <button
                type="button"
                onClick={() => setTargetAgentId(null)}
                className="inline-flex items-center gap-1.5 rounded-lg border border-primary/20 bg-primary/5 px-2.5 py-1 text-[13px] font-medium text-foreground transition-colors hover:bg-primary/10"
                title={t('composer.clearTarget')}
              >
                <span>{t('composer.targetChip', { agent: selectedTarget.name })}</span>
                <X className="h-3 w-3 text-muted-foreground" />
              </button>
            </div>
          )}

          {/* Text Row — flush-left */}
          <Textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => handleInputChange(e.target.value)}
            onKeyDown={handleKeyDown}
            onCompositionStart={() => {
              isComposingRef.current = true;
            }}
            onCompositionEnd={() => {
              isComposingRef.current = false;
            }}
            onPaste={handlePaste}
            placeholder={composerPlaceholder}
            disabled={disabled}
            data-testid="chat-composer-input"
            className="min-h-[48px] max-h-[240px] resize-none border-0 focus-visible:ring-0 focus-visible:ring-offset-0 shadow-none bg-transparent p-0 text-[15px] placeholder:text-muted-foreground/60 leading-relaxed"
            rows={1}
          />

          {/* Action Row — icons on their own line */}
          <div className="mt-1.5 flex items-center gap-1">
            {/* Attach Button */}
            <Button
              variant="ghost"
              size="icon"
              className="shrink-0 h-8 w-8 rounded-lg text-muted-foreground hover:bg-black/5 dark:hover:bg-white/10 hover:text-foreground transition-colors"
              onClick={pickFiles}
              disabled={disabled || sending}
              title={t('composer.attachFiles')}
            >
              <Paperclip className="h-3.5 w-3.5" />
            </Button>

            {/* Skill Picker */}
            <div ref={skillPickerRef} className="relative shrink-0">
              <Button
                variant="ghost"
                size="icon"
                className={cn(
                  'h-8 w-8 rounded-lg text-muted-foreground hover:bg-black/5 dark:hover:bg-white/10 hover:text-foreground transition-colors',
                  skillPickerOpen && 'bg-primary/10 text-primary hover:bg-primary/20'
                )}
                onClick={() => {
                  setSkillPickerOpen((open) => !open);
                  if (!skillPickerOpen) {
                    setSkillSearchQuery('');
                  }
                }}
                disabled={disabled || sending}
                title={t('composer.pickSkill')}
                data-testid="chat-composer-skill"
              >
                <Puzzle className="h-3.5 w-3.5" />
              </Button>
              {skillPickerOpen && (
                <div className="absolute left-0 bottom-full z-20 mb-2 w-72 overflow-hidden rounded-2xl border border-black/10 bg-white p-1.5 shadow-xl dark:border-white/10 dark:bg-card">
                  <div className="px-3 py-2 text-[11px] font-medium text-muted-foreground/80">
                    {t('composer.skillPickerTitle')}
                  </div>
                  <div className="px-3 pb-2">
                    <div className="relative flex items-center rounded-full border border-transparent bg-[#FFF2E5] px-3 py-1.5 transition-colors focus-within:border-[#FF922B]/40 dark:bg-[#FF922B]/15">
                      <Search className="h-3.5 w-3.5 shrink-0 text-[#FF922B]" />
                      <input
                        placeholder={t('search', { ns: 'skills' })}
                        value={skillSearchQuery}
                        onChange={(e) => setSkillSearchQuery(e.target.value)}
                        className="ml-2 w-full bg-transparent text-[13px] text-foreground outline-none placeholder:text-[#FF922B]/80"
                      />
                      {skillSearchQuery ? (
                        <button
                          type="button"
                          onClick={() => setSkillSearchQuery('')}
                          className="ml-1 shrink-0 text-[#FF922B]/70 hover:text-[#FF922B]"
                        >
                          <X className="h-3 w-3" />
                        </button>
                      ) : null}
                    </div>
                  </div>
                  <div className="max-h-64 overflow-y-auto">
                    {skillsLoading ? (
                      <div className="flex items-center justify-center py-8 text-muted-foreground">
                        <Loader2 className="h-4 w-4 animate-spin mr-2" />
                        <span className="text-xs">加载中...</span>
                      </div>
                    ) : Array.isArray(skills) && skills.length === 0 ? (
                      <div className="flex items-center justify-center py-8 text-muted-foreground">
                        <span className="text-xs">暂无可用技能</span>
                      </div>
                    ) : (
                      skills.filter(s => s.enabled).filter(skill => {
                        const q = skillSearchQuery.toLowerCase().trim();
                        if (!q) {
                          return true;
                        }
                        const nameMatch = skill.name.toLowerCase().includes(q);
                        const descMatch = skill.description ? skill.description.toLowerCase().includes(q) : false;
                        return nameMatch || descMatch;
                      }).map((skill) => (
                        <SkillPickerItem
                          key={skill.id}
                          skill={skill}
                          selected={skillAttachments.some(s => s.skillId === skill.id)}
                          onSelect={() => addSkillAttachment(skill.id)}
                        />
                      ))
                    )}
                  </div>
                </div>
              )}
            </div>

            {/* Workspace Picker */}
            <WorkspacePicker disabled={disabled || sending} />

            {/* Reasoning mode picker */}
            <div ref={reasoningRef} className="relative shrink-0">
              <Button
                variant="ghost"
                size="sm"
                className={cn(
                  'h-8 rounded-lg px-2.5 text-muted-foreground hover:bg-black/5 dark:hover:bg-white/10 hover:text-foreground transition-colors',
                  reasoningOpen && 'bg-primary/10 text-primary hover:bg-primary/20',
                )}
                onClick={() => setReasoningOpen((open) => !open)}
                disabled={disabled || sending}
                title={t('composer.reasoning.title')}
                data-testid="chat-reasoning-mode-button"
              >
                <CurrentReasoningIcon className="h-3.5 w-3.5" />
                <span className="ml-1.5 hidden text-xs font-medium sm:inline">{currentReasoning.label}</span>
                <ChevronDown className="ml-1 h-3 w-3 shrink-0 opacity-60" />
              </Button>
              {reasoningOpen && (
                <div
                  className="absolute left-0 bottom-full z-20 mb-2 w-64 overflow-hidden rounded-2xl border border-black/10 bg-white p-1.5 shadow-xl dark:border-white/10 dark:bg-card"
                  data-testid="chat-reasoning-mode-menu"
                >
                  {reasoningOptions.map((option) => {
                    const OptionIcon = option.icon;
                    const selected = option.mode === reasoningMode;
                    return (
                      <button
                        key={option.mode}
                        type="button"
                        onClick={() => {
                          void setReasoningMode(option.mode as ReasoningMode);
                          setReasoningOpen(false);
                          textareaRef.current?.focus();
                        }}
                        className={cn(
                          'flex w-full items-start gap-3 rounded-xl px-3 py-2.5 text-left transition-colors',
                          selected ? 'bg-primary/10 text-foreground' : 'hover:bg-black/5 dark:hover:bg-white/5',
                        )}
                        data-testid={`chat-reasoning-mode-${option.mode}`}
                      >
                        <OptionIcon className="mt-0.5 h-4 w-4 shrink-0 text-foreground" />
                        <span className="min-w-0 flex-1">
                          <span className="block text-[14px] font-medium text-foreground">{option.label}</span>
                          <span className="block text-[11px] text-muted-foreground">{option.description}</span>
                        </span>
                        {selected && <Check className="mt-0.5 h-4 w-4 shrink-0 text-foreground" />}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            {showAgentPicker && (
              <div ref={pickerRef} className="relative shrink-0">
                <Button
                  variant="ghost"
                  size="icon"
                  className={cn(
                    'h-8 w-8 rounded-lg text-muted-foreground hover:bg-black/5 dark:hover:bg-white/10 hover:text-foreground transition-colors',
                    (pickerOpen || selectedTarget) && 'bg-primary/10 text-primary hover:bg-primary/20'
                  )}
                  onClick={() => {
                    setPickerOpen((open) => !open);
                    void fetchDigitalEmployees();
                  }}
                  disabled={disabled || sending}
                  title={t('composer.pickAgent')}
                  data-testid="chat-composer-agent"
                >
                  <AtSign className="h-3.5 w-3.5" />
                </Button>
                {pickerOpen && (
                  <div className="absolute left-0 bottom-full z-20 mb-2 w-72 overflow-hidden rounded-2xl border border-black/10 bg-white p-1.5 shadow-xl dark:border-white/10 dark:bg-card">
                    <div className="px-3 py-2 text-[11px] font-medium text-muted-foreground/80">
                      {t('composer.agentPickerTitle', { currentAgent: currentAgentName })}
                    </div>
                    <div className="max-h-64 overflow-y-auto">
                      {digitalEmployeesLoading ? (
                        <div className="flex items-center justify-center px-3 py-3 text-[12px] text-muted-foreground">
                          <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                          加载中...
                        </div>
                      ) : mentionableAgents.length === 0 ? (
                        <div className="px-3 py-3 text-[12px] text-muted-foreground">
                          暂无可用数字员工
                        </div>
                      ) : mentionableAgents.map((agent) => (
                        <AgentPickerItem
                          key={agent.id}
                          agent={agent}
                          selected={agent.id === targetAgentId}
                          onSelect={() => {
                            setTargetAgentId(agent.id);
                            setPickerOpen(false);
                            textareaRef.current?.focus();
                          }}
                        />
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            <ModelPicker disabled={disabled || sending} />

            {/* Right cluster: send */}
            <div className="ml-auto flex items-center gap-1">
              <Button
                onClick={sending ? handleStop : handleSend}
                disabled={sending ? !canStop : !canSend}
                size="icon"
                data-testid="chat-composer-send"
                className={cn(
                  'shrink-0 h-8 w-8 rounded-full border-0 shadow-none transition-colors',
                  sending || canSend
                    ? 'bg-[#FF922B] text-white hover:bg-[#FE7B00] hover:text-white focus-visible:ring-[#FF922B]/40 dark:bg-white/10 dark:text-white dark:hover:bg-white/20 dark:hover:text-white'
                    : 'bg-[#FF922B]/15 text-[#FF922B]/60 hover:bg-[#FF922B]/15 hover:text-[#FF922B]/60 dark:bg-white/5 dark:text-muted-foreground/60 dark:hover:bg-white/5 dark:hover:text-muted-foreground/60',
                )}
                title={sending ? t('composer.stop') : t('composer.send')}
              >
                {sending ? (
                  <Square className="h-3.5 w-3.5" fill="currentColor" />
                ) : (
                  <SendHorizontal className="h-4 w-4" strokeWidth={2} />
                )}
              </Button>
            </div>

            {/* Upload Skill Button - temporarily disabled */}
            {/* <Button
              variant="ghost"
              size="icon"
              className="shrink-0 h-8 w-8 rounded-lg text-muted-foreground hover:bg-black/5 dark:hover:bg-white/10 hover:text-foreground transition-colors"
              onClick={() => setUploadSkillOpen(true)}
              disabled={disabled || sending}
              title={t('actions.uploadSkill')}
            >
              <Upload className="h-3.5 w-3.5" />
            </Button> */}
          </div>
        </div>
        <div className="mt-2.5 flex items-center justify-between gap-2 text-[11px] text-muted-foreground/60 px-4">
          <div className="flex items-center gap-1.5">
            <div className={cn("w-1.5 h-1.5 rounded-full", gatewayStatus.state === 'running' ? "bg-green-500/80" : "bg-red-500/80")} />
            <span>
              {t('composer.gatewayStatus', {
                state: gatewayStatus.state === 'running'
                  ? t('composer.gatewayConnected')
                  : gatewayStatus.state,
                port: gatewayStatus.port,
                pid: gatewayStatus.pid ? `| pid: ${gatewayStatus.pid}` : '',
              })}
            </span>
          </div>
          {hasFailedAttachments && (
            <Button
              variant="link"
              size="sm"
              className="h-auto p-0 text-[11px]"
              onClick={() => {
                setAttachments((prev) => prev.filter((att) => att.status !== 'error'));
              }}
            >
              {t('composer.removeFailedAttachments', { defaultValue: '移除失败附件' })}
            </Button>
          )}
        </div>
      </div>

      {/* Upload Skill Dialog */}
      <UploadSkillDialog
        open={uploadSkillOpen}
        onOpenChange={setUploadSkillOpen}
        onUploadComplete={() => {
          // Refresh skills after upload
          void fetchSkills();
        }}
      />
    </div>
  );
}

// ── Attachment Preview ───────────────────────────────────────────

function AttachmentPreview({
  attachment,
  onRemove,
}: {
  attachment: FileAttachment;
  onRemove: () => void;
}) {
  const isImage = attachment.mimeType.startsWith('image/') && attachment.preview;
  const errorMessage = attachment.error || '附件处理失败。';

  return (
    <div className="relative group pt-1 pr-1" title={attachment.status === 'error' ? errorMessage : attachment.fileName}>
      <div className={cn(
        "relative rounded-lg overflow-hidden border",
        attachment.status === 'error' ? "border-destructive/40 bg-destructive/5" : "border-border",
      )}>
        {isImage ? (
          // Image thumbnail
          <div className="w-16 h-16">
            <img
              src={attachment.preview!}
              alt={attachment.fileName}
              className="w-full h-full object-cover"
            />
          </div>
        ) : (
          // Generic file card
          <div className="flex items-center gap-2 px-3 py-2 bg-muted/50 max-w-[260px] min-w-[180px]">
            {attachment.status === 'error'
              ? <ShieldAlert className="h-5 w-5 shrink-0 text-destructive" />
              : <FileIcon mimeType={attachment.mimeType} className="h-5 w-5 shrink-0 text-muted-foreground" />}
            <div className="min-w-0 overflow-hidden">
              <p className="text-xs font-medium truncate">{attachment.fileName}</p>
              <p className={cn(
                "text-[10px] truncate",
                attachment.status === 'error' ? "text-destructive" : "text-muted-foreground",
              )}>
                {attachment.status === 'error'
                  ? errorMessage
                  : attachment.fileSize > 0 ? formatFileSize(attachment.fileSize) : '...'}
              </p>
            </div>
          </div>
        )}

        {/* Staging overlay */}
        {attachment.status === 'staging' && (
          <div className="absolute inset-0 bg-black/40 flex items-center justify-center">
            <Loader2 className="h-4 w-4 text-white animate-spin" />
          </div>
        )}

      </div>

      {/* Remove button */}
      <button
        onClick={onRemove}
        aria-label="Remove"
        className="absolute top-0 right-0 z-10 flex h-4 w-4 items-center justify-center rounded-full bg-destructive text-destructive-foreground shadow-sm opacity-0 group-hover:opacity-100 transition-opacity"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}

function AgentPickerItem({
  agent,
  selected,
  onSelect,
}: {
  agent: MentionableDigitalEmployee;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        'flex w-full flex-col items-start rounded-xl px-3 py-2 text-left transition-colors',
        selected ? 'bg-primary/10 text-foreground' : 'hover:bg-black/5 dark:hover:bg-white/5'
      )}
    >
      <span className="text-[14px] font-medium text-foreground">{agent.name}</span>
      <span className="text-[11px] text-muted-foreground">
        {agent.description || agent.id}
      </span>
    </button>
  );
}

// ── Skill Attachment Preview ──────────────────────────────────────

function SkillAttachmentPreview({
  skill,
  onRemove,
}: {
  skill: SkillAttachment;
  onRemove: () => void;
}) {
  return (
    <div className="relative group max-w-[200px] pt-1 pr-1">
      <div className="rounded-lg border border-primary/20 bg-primary/5 px-3 py-2">
        <div className="flex items-center gap-2">
          <div className={`w-6 h-6 flex-shrink-0 flex items-center justify-center text-xs font-bold text-white rounded-md ${getSkillColor(skill.skillName)}`}>
            {getSkillInitial(skill.skillName)}
          </div>
          <div className="min-w-0 overflow-hidden">
            <p className="text-xs font-medium truncate text-foreground">{skill.skillName}</p>
            <p className="text-[10px] text-muted-foreground truncate">{skill.skillDescription}</p>
          </div>
        </div>
      </div>

      {/* Remove button */}
      <button
        onClick={onRemove}
        aria-label="Remove"
        className="absolute top-0 right-0 z-10 flex h-4 w-4 items-center justify-center rounded-full bg-destructive text-destructive-foreground shadow-sm opacity-0 group-hover:opacity-100 transition-opacity"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}

// ── Skill Picker Item ────────────────────────────────────────────

function SkillPickerItem({
  skill,
  selected,
  onSelect,
}: {
  skill: Skill;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      data-testid={`chat-composer-skill-option-${skill.id}`}
      className={cn(
        'relative flex w-full flex-col items-start rounded-xl px-3 py-2 text-left transition-colors',
        selected
          ? 'bg-[#FFF2E5] dark:bg-[#FF922B]/15'
          : 'hover:bg-black/5 dark:hover:bg-white/5'
      )}
    >
      <div className="flex items-center gap-2">
        <div className={`w-5 h-5 flex-shrink-0 flex items-center justify-center text-xs font-bold text-white rounded-md ${getSkillColor(skill.name)}`}>
          {getSkillInitial(skill.name)}
        </div>
        <span
          className={cn(
            'text-[14px] font-medium',
            selected ? 'text-[#FE7B00] dark:text-primary' : 'text-foreground',
          )}
        >
          {skill.name}
        </span>
      </div>
      {skill.description && (
        <p
          className={cn(
            'mt-0.5 line-clamp-2 text-[11px] leading-[1.5]',
            selected ? 'text-[#FE7B00]/80 dark:text-primary/80' : 'text-muted-foreground',
          )}
          style={{
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
          }}
          title={skill.description}
        >
          {skill.description}
        </p>
      )}
      {selected && (
        <div className="absolute right-3 top-1/2 -translate-y-1/2">
          <Check className="h-4 w-4 text-[#FE7B00] dark:text-primary" />
        </div>
      )}
    </button>
  );
}
