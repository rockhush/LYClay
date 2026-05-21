
import { useState, useCallback, useEffect, useRef } from 'react';
import { Button } from '@/components/ui/button';
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
      // Read file as base64
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

      // Call IPC to extract zip to skills directory
      const result = await invokeIpc('skill:uploadZip', {
        fileName: selectedFile.name,
        base64Data,
      });

      if (result.success) {
        toast.success(t('upload.successDesc', { name: result.skillName || selectedFile.name }));
        
        // Reset and close
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

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      role="dialog"
      aria-modal="true"
      aria-labelledby="upload-skill-dialog-title"
      onKeyDown={handleKeyDown}
    >
      <div
        className={cn(
          'mx-4 max-w-md rounded-lg border bg-card p-6 shadow-lg',
          'focus:outline-none'
        )}
        tabIndex={-1}
      >
        {/* Header */}
        <div className="flex items-start justify-between">
          <div>
            <h2 id="upload-skill-dialog-title" className="text-lg font-semibold">
              {t('upload.title')}
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {t('upload.subtitle')}
            </p>
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 -mr-2 -mt-2"
            onClick={handleClose}
            disabled={uploading}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>

        {/* Content */}
        <div className="py-4">
          {/* Drag & Drop Area */}
          <div
            className={cn(
              'flex flex-col items-center justify-center rounded-lg border-2 border-dashed p-8 transition-colors',
              dragActive
                ? 'border-primary bg-primary/5'
                : 'border-muted-foreground/25 hover:border-primary/50',
              selectedFile && 'border-primary bg-primary/5'
            )}
            onDragEnter={handleDrag}
            onDragLeave={handleDrag}
            onDragOver={handleDrag}
            onDrop={handleDrop}
          >
            {selectedFile ? (
              <div className="flex items-center gap-3">
                <FileArchive className="h-10 w-10 text-primary" />
                <div className="flex flex-col items-start">
                  <span className="text-sm font-medium">{selectedFile.name}</span>
                  <span className="text-xs text-muted-foreground">
                    {(selectedFile.size / 1024 / 1024).toFixed(2)} MB
                  </span>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  onClick={() => setSelectedFile(null)}
                  disabled={uploading}
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
            ) : (
              <>                <Upload className="h-10 w-10 text-muted-foreground mb-4" />
                <p className="text-sm text-muted-foreground mb-2">
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
                >
                  {t('upload.browse')}
                </Button>
              </>
            )}
          </div>

          {/* Requirements */}
          <div className="mt-6">
            <h4 className="text-sm font-medium mb-2">{t('upload.requirements')}</h4>
            <ul className="text-xs text-muted-foreground space-y-1 list-disc list-inside">
              <li>{t('upload.requirement1')}</li>
              <li>{t('upload.requirement2')}</li>
            </ul>
          </div>
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2">
          <Button
            ref={cancelRef}
            variant="outline"
            size="sm"
            onClick={handleClose}
            disabled={uploading}
          >
            {t('upload.cancel')}
          </Button>
          <Button 
            size="sm"
            onClick={handleUpload} 
            disabled={!selectedFile || uploading}
          >
            {uploading ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                {t('upload.uploading')}
              </>
            ) : (
              t('upload.upload')
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}