
import { useState, useCallback, useEffect, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { ModalOverlay } from '@/components/ui/modal-overlay';
import { Upload, X, FileArchive, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { invokeIpc } from '@/lib/api-client';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

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

      const result = await invokeIpc('skill:uploadZip', {
        fileName: selectedFile.name,
        base64Data,
      });

      if (result.success) {
        toast.success(t('upload.successDesc', { name: result.skillName || selectedFile.name }));

        setSelectedFile(null);
        onOpenChange(false);
        onUploadComplete?.();
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
            className="h-8 rounded-lg px-4 text-[13px] font-medium bg-[#FF922B] hover:bg-[#FF6A00] text-white shadow-sm shadow-[#FF922B]/25 disabled:opacity-50"
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
