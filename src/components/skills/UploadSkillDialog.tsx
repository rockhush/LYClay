
import { useState, useCallback, useEffect, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { ModalOverlay } from '@/components/ui/modal-overlay';
import { Upload, X, FileArchive, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { invokeIpc } from '@/lib/api-client';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

interface Finding {
  level: string;
  category: string;
  message: string;
}

/** Extract filename from a finding message like '"setup.exe"' */
function extractFile(f: Finding): string | null {
  const m = f.message.match(/"([^"]+)"/);
  return m ? m[1] : null;
}

/** Extract forbidden extension from message like '(extension .exe)' */
function extractExt(f: Finding): string {
  const m = f.message.match(/\(extension ([^)]+)\)/);
  return m ? m[1] : '';
}

/** Translate an English security finding message to a concise Chinese label */
function translateMessage(f: Finding): string {
  const file = extractFile(f);
  const ext = extractExt(f);

  switch (f.category) {
    case 'file-type': {
      // "Blocked executable file: "setup.exe" (extension .exe)"
      if (file) return ext ? `${file}（${ext} 危险文件）` : `${file}（危险文件类型）`;
      return f.message;
    }
    case 'path-traversal': {
      // "Path traversal detected in ZIP entry: "../../etc/passwd""
      if (file) return `${file}（路径逃逸攻击）`;
      return '检测到路径穿越攻击';
    }
    case 'zip-bomb': {
      // "High compression ratio (500:1) for "payload.dat" — possible ZIP bomb"
      if (file) return `${file}（疑似 ZIP 炸弹）`;
      return '检测到 ZIP 炸弹（压缩比异常）';
    }
    case 'symlink': {
      // "Symlink entry detected: "link" -> "/etc/passwd""
      if (file) return `${file}（含符号链接）`;
      return '包含符号链接';
    }
    case 'file-size': {
      // "File too large: "data.bin" is 120 MB (max 50 MB)"
      if (file) return `${file}（文件过大）`;
      return '文件大小超出限制';
    }
    case 'file-count':
      return '文件数量超出上限（最多 500 个）';
    case 'total-size':
      return '压缩包解压后总大小超出上限（最多 200 MB）';
    case 'nesting-depth': {
      // "Excessive nesting depth (15) in: "a/b/c/.../f""
      if (file) return `${file}（目录嵌套过深）`;
      return '目录嵌套层级过深（最多 10 层）';
    }
    case 'manifest': {
      // Translate common manifest error patterns
      const msg = f.message;
      if (msg.includes('missing YAML frontmatter')) return '缺少 YAML frontmatter（必须以 --- 开头）';
      if (msg.includes('missing required field: "name"')) return 'SKILL.md 缺少必填字段：name（技能名称）';
      if (msg.includes('missing required field: "description"')) return 'SKILL.md 缺少必填字段：description（技能描述）';
      if (msg.includes('phishing indicators')) return 'SKILL.md 描述中包含钓鱼风险关键词';
      if (msg.includes('reserved/impersonation keyword')) {
        // Extract the keyword: "Skill name "X" uses a reserved..."
        const kwMatch = msg.match(/keyword:\s*"([^"]+)"/);
        if (kwMatch) return `技能名使用了保留关键词："${kwMatch[1]}"`;
        return '技能名包含敏感/仿冒关键词';
      }
      if (msg.includes('SKILL.md is empty')) return 'SKILL.md 内容为空';
      if (msg.includes('not found')) return '未找到 SKILL.md 文件';
      if (msg.includes('Cannot read')) return '无法读取 SKILL.md 文件';
      // Fallback: just show the category
      if (file) return `${file}（格式不合法）`;
      return 'SKILL.md 格式不合法';
    }
    case 'dangerous-command': {
      // "Potentially dangerous command in "setup.md": Shell fork bomb pattern"
      if (file) return `${file}（含危险命令）`;
      return '检测到危险命令';
    }
    case 'hidden-dir': {
      // "Hidden directory detected: ".evil""
      if (file) return `${file}（隐藏目录）`;
      return '包含可疑隐藏目录';
    }
    case 'suspicious-url': {
      // "Suspicious URL in "SKILL.md": Non-HTTPS URL (insecure) — http://..."
      if (file) return `${file}（含可疑链接）`;
      return '检测到可疑链接';
    }
    case 'impersonation': {
      // "Name is very similar to official skill "pdf" (typo-squatting)"
      // "Name starts with "pdf" — possible impersonation"
      // "Name matches official skill "pdf" (case-insensitive)"
      const msg = f.message;
      const kwMatch = msg.match(/official skill "([^"]+)"/);
      if (kwMatch) return `技能名仿冒官方技能："${kwMatch[1]}"`;
      return '技能名疑似仿冒';
    }
    case 'homoglyph': {
      // "Invisible/special characters in file name "...""
      // "Potential homoglyph characters in directory name "...""
      if (file) return `${file}（含混淆字符）`;
      return '检测到混淆/不可见字符';
    }
    case 'scan-error':
      return '文件扫描异常';
    default: {
      if (file) return file;
      return f.message;
    }
  }
}

/** Format a security finding as a concise, fully-Chinese one-liner */
function formatFinding(f: Finding): string {
  const icon = f.level === 'error' ? '❌' : '⚠️';
  const label = translateMessage(f);
  return `${icon} ${label}`;
}

interface UploadResult {
  success: boolean;
  skillName?: string;
  error?: string;
  errorCode?: string;
  securityBlocked?: boolean;
  validationResult?: {
    riskLevel: string;
    findings: Array<{ level: string; category: string; message: string }>;
    summary: { errors: number; warnings: number };
    stage: string;
  };
}

/** Translate backend error codes to user-friendly Chinese messages */
function translateErrorCode(errorCode: string, fallback: string): string {
  const map: Record<string, string> = {
    ZIP_EMPTY: 'ZIP 文件为空，请检查文件是否正确',
    ZIP_READ_FAILED: 'ZIP 文件读取失败，文件可能已损坏或不是有效的格式',
    SECURITY_BLOCKED: '安全检查未通过',
    CONTENT_BLOCKED: '技能内容安全检查未通过',
  };
  return map[errorCode] || fallback;
}

interface UploadSkillDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onUploadComplete?: () => void;
}

export function UploadSkillDialog({ open, onOpenChange, onUploadComplete }: UploadSkillDialogProps) {
  const { t } = useTranslation('skills');
  const [dragActive, setDragActive] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open && cancelRef.current) {
      cancelRef.current.focus();
    }
  }, [open]);

  const handleFile = useCallback((file: File) => {
    if (file.type !== 'application/zip' && !file.name.endsWith('.zip')) {
      toast.error(t('upload.zipOnly'));
      return;
    }
    setSelectedFile(file);
  }, [t]);

  const handleDrag = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === 'dragenter' || e.type === 'dragover') {
      setDragActive(true);
    } else if (e.type === 'dragleave') {
      setDragActive(false);
    }
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);

    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      handleFile(e.dataTransfer.files[0]);
    }
  }, [handleFile]);

  const handleFileInput = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      handleFile(e.target.files[0]);
    }
  }, [handleFile]);

  const handleUpload = useCallback(async () => {
    if (!selectedFile) return;

    setUploading(true);
    try {
      const base64Data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const result = reader.result as string;
          const data = result.split(',')[1];
          if (data) {
            resolve(data);
          } else {
            reject(new Error('Failed to read file as base64'));
          }
        };
        reader.onerror = () => reject(new Error('Failed to read file'));
        reader.readAsDataURL(selectedFile);
      });

      const result = await invokeIpc<UploadResult>('skill:uploadZip', {
        fileName: selectedFile.name,
        base64Data,
        autoInstall: true,
      });

      if (result.success) {
        toast.success(t('upload.successDesc', { name: result.skillName || selectedFile.name }));

        // If there were warnings, show them with Chinese-friendly format
        if (result.validationResult && result.validationResult.summary.warnings > 0) {
          const warnings = result.validationResult.findings.filter(f => f.level === 'warning');
          const warningLines = warnings.slice(0, 2).map(f => formatFinding(f)).join('\n');
          toast.warning(
            `${t('upload.securityWarning', 'Security warnings found')}\n${warningLines}`,
            { duration: 6000 },
          );
        }

        setSelectedFile(null);
        onOpenChange(false);
        onUploadComplete?.();
      } else if (result.securityBlocked) {
        // Security violation — show detailed reason in Chinese
        const findings = result.validationResult?.findings;
        if (findings && findings.length > 0) {
          const errorFindings = findings.filter(f => f.level === 'error');
          const warningFindings = findings.filter(f => f.level === 'warning');
          const lines: string[] = [];
          if (errorFindings.length > 0) {
            lines.push(...errorFindings.slice(0, 3).map(f => formatFinding(f)));
          }
          if (warningFindings.length > 0) {
            lines.push(...warningFindings.slice(0, 1).map(f => formatFinding(f)));
          }
          toast.error(
            `${t('upload.securityBlocked')}\n${lines.join('\n')}`,
            { duration: 8000 },
          );
        } else {
          // No detailed findings — show translated error by code
          const msg = result.errorCode
            ? translateErrorCode(result.errorCode, result.error || t('upload.failed'))
            : result.error || t('upload.failed');
          toast.error(msg);
        }
      } else {
        throw new Error(result.error || t('upload.failed'));
      }
    } catch (error) {
      console.error('Upload skill error:', error);
      toast.error(error instanceof Error ? error.message : t('upload.failedDesc'));
    } finally {
      setUploading(false);
    }
  }, [selectedFile, onOpenChange, onUploadComplete, t]);

  const handleClose = useCallback(() => {
    setSelectedFile(null);
    onOpenChange(false);
  }, [onOpenChange]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape' && !uploading) {
      e.preventDefault();
      handleClose();
    }
  };

  if (!open) return null;

  const dropZoneActive = dragActive || Boolean(selectedFile);

  return (
    <ModalOverlay
      className="p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="upload-skill-dialog-title"
      onKeyDown={handleKeyDown}
    >
      <div
        className="relative w-full max-w-md rounded-2xl border-0 shadow-2xl bg-white dark:bg-card overflow-hidden focus:outline-none"
        tabIndex={-1}
      >
        <div className="relative px-6 pt-6 pb-2">
          <h2 id="upload-skill-dialog-title" className="!text-[16px] font-sans font-bold text-foreground leading-tight tracking-normal">
            {t('upload.title')}
          </h2>
          <p className="mt-1 text-[13px] font-sans text-muted-foreground">
            {t('upload.subtitle')}
          </p>
          <Button
            variant="ghost"
            size="icon"
            className="absolute right-4 top-4 rounded-full h-8 w-8 text-muted-foreground hover:text-foreground hover:bg-black/5 dark:hover:bg-white/5"
            onClick={handleClose}
            disabled={uploading}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div className="px-6 py-4">
          <div
            className={cn(
              'flex flex-col items-center justify-center rounded-2xl border-2 border-dashed p-8 transition-colors',
              dropZoneActive
                ? 'border-[#FFD79A] bg-[#FFF7EC] dark:bg-[#FF922B]/10'
                : 'border-black/10 dark:border-white/10 bg-[#FFF7EC]/40 dark:bg-white/[0.03] hover:border-[#FFD79A]/70 hover:bg-[#FFF7EC]/80 dark:hover:bg-[#FF922B]/10',
            )}
            onDragEnter={handleDrag}
            onDragLeave={handleDrag}
            onDragOver={handleDrag}
            onDrop={handleDrop}
          >
            {selectedFile ? (
              <div className="flex w-full items-center gap-3 rounded-xl border border-[#FFD79A]/50 bg-white/80 dark:bg-card/80 px-3 py-2.5">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[#FFF2E5] text-[#FF922B] dark:bg-[#FF922B]/15">
                  <FileArchive className="h-5 w-5" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] font-medium text-foreground">{selectedFile.name}</p>
                  <p className="text-[12px] text-muted-foreground">
                    {(selectedFile.size / 1024 / 1024).toFixed(2)} MB
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 shrink-0 rounded-lg !text-[#FF922B] hover:!text-[#FF922B] hover:bg-[#FFF2E5] dark:hover:bg-[#FF922B]/15"
                  onClick={() => setSelectedFile(null)}
                  disabled={uploading}
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
            ) : (
              <>
                <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-[#FFF2E5] text-[#FF922B] dark:bg-[#FF922B]/15">
                  <Upload className="h-6 w-6" />
                </div>
                <p className="mb-3 text-[13px] text-muted-foreground">
                  {t('upload.dragDrop')}
                </p>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".zip"
                  onChange={handleFileInput}
                  className="hidden"
                  id="skill-upload-input"
                  disabled={uploading}
                />
                <Button
                  variant="outline"
                  type="button"
                  disabled={uploading}
                  onClick={() => fileInputRef.current?.click()}
                  className="h-8 rounded-lg px-3 text-[13px] font-medium border-[#FFD79A]/60 bg-[#FFF2E5] !text-[#FF922B] hover:!text-[#FF922B] hover:bg-[#FFD79A]/40 dark:bg-[#FF922B]/15 dark:hover:bg-[#FF922B]/25"
                >
                  {t('upload.browse')}
                </Button>
              </>
            )}
          </div>

          <div className="mt-5 rounded-xl border border-[#FFD79A]/30 bg-[#FFF7EC]/60 px-4 py-3 dark:border-[#FF922B]/20 dark:bg-[#FF922B]/10">
            <h4 className="text-[13px] font-sans font-semibold text-foreground mb-2">
              {t('upload.requirements')}
            </h4>
            <ul className="space-y-1.5 text-[12px] text-muted-foreground">
              <li className="flex gap-2">
                <span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-[#FF922B]" />
                <span>{t('upload.requirement1')}</span>
              </li>
              <li className="flex gap-2">
                <span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-[#FF922B]" />
                <span>{t('upload.requirement2')}</span>
              </li>
              <li className="flex gap-2">
                <span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-[#DC2626]" />
                <span>{t('upload.requirement3')}</span>
              </li>
              <li className="flex gap-2">
                <span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-[#DC2626]" />
                <span>{t('upload.requirement4')}</span>
              </li>
            </ul>
          </div>
        </div>

        <div className="flex justify-end gap-2 border-t border-black/5 dark:border-white/10 px-6 py-4">
          <Button
            ref={cancelRef}
            variant="outline"
            onClick={handleClose}
            disabled={uploading}
            className="h-8 rounded-lg px-3 text-[13px] font-medium border-black/10 dark:border-white/10 bg-white dark:bg-transparent hover:bg-black/5 dark:hover:bg-white/5 text-foreground/80 hover:text-foreground"
          >
            {t('upload.cancel')}
          </Button>
          <Button
            onClick={handleUpload}
            disabled={!selectedFile || uploading}
            className="h-8 rounded-lg px-4 text-[13px] font-medium bg-[#FF922B] hover:bg-[#FE7B00] text-white shadow-sm shadow-[#FF922B]/25 disabled:opacity-50"
          >
            {uploading ? (
              <>
                <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                {t('upload.uploading')}
              </>
            ) : (
              t('upload.upload')
            )}
          </Button>
        </div>
      </div>
    </ModalOverlay>
  );
}
