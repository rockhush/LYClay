import { useState } from 'react';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Select } from '@/components/ui/select';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import type { McpConfigFile, McpTransportType } from '@/types/connector';
import { LYCLAW_BUILTIN_MCP_KEYS } from '@/lib/mcp-builtins';

const inputClasses = 'h-9 rounded-lg text-[13px] bg-white dark:bg-muted border-black/10 dark:border-white/10 focus-visible:outline-none focus-visible:ring-0 focus-visible:border-[#FFD79A] transition-colors text-foreground placeholder:text-foreground/40';
const labelClasses = 'text-[13px] text-foreground/80 font-medium';
const selectClasses = 'h-9 w-full rounded-lg text-[13px] bg-white dark:bg-muted border border-black/10 dark:border-white/10 px-3 text-foreground focus-visible:outline-none focus-visible:ring-0 focus-visible:border-[#FFD79A] transition-colors [background-image:none] appearance-none';
const textareaClasses = 'flex min-h-[72px] w-full rounded-lg border border-black/10 dark:border-white/10 bg-white dark:bg-muted px-3 py-2 text-[13px] text-foreground placeholder:text-foreground/40 focus-visible:outline-none focus-visible:ring-0 focus-visible:border-[#FFD79A] transition-colors';

export type InstallDialogMode = 'custom' | null;

interface InstallDialogProps {
  mode: InstallDialogMode;
  onClose: () => void;
  onSaveCustom: (config: McpConfigFile) => Promise<void>;
  baseConfig: McpConfigFile | null;
}

export function InstallDialog({
  mode,
  onClose,
  onSaveCustom,
  baseConfig,
}: InstallDialogProps) {
  const { t } = useTranslation('connectors');
  const [busy, setBusy] = useState(false);

  const [name, setName] = useState('');
  const [transport, setTransport] = useState<McpTransportType>('stdio');
  const [url, setUrl] = useState('');
  const [command, setCommand] = useState('npx');
  const [argsText, setArgsText] = useState('-y, @modelcontextprotocol/server-example');
  const [disabled, setDisabled] = useState(false);
  const [envText, setEnvText] = useState('');

  const resetCustom = () => {
    setName('');
    setTransport('stdio');
    setUrl('');
    setCommand('npx');
    setArgsText('-y, @modelcontextprotocol/server-example');
    setDisabled(false);
    setEnvText('');
  };

  const parseEnv = (): Record<string, string> | undefined => {
    const lines = envText.split('\n').map((l) => l.trim()).filter(Boolean);
    if (lines.length === 0) return undefined;
    const env: Record<string, string> = {};
    for (const line of lines) {
      const idx = line.indexOf('=');
      if (idx <= 0) throw new Error(t('dialog.custom.badEnv'));
      const k = line.slice(0, idx).trim();
      const v = line.slice(idx + 1).trim();
      if (!k) throw new Error(t('dialog.custom.badEnv'));
      env[k] = v;
    }
    return env;
  };

  const handleCustomSubmit = async () => {
    const key = name.trim();
    if (!key) return;
    if (LYCLAW_BUILTIN_MCP_KEYS.has(key)) {
      window.alert(t('dialog.custom.reservedName'));
      return;
    }
    setBusy(true);
    try {
      const args = argsText
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      let env: Record<string, string> | undefined;
      try {
        env = envText.trim() ? parseEnv() : undefined;
      } catch {
        toast.error(t('dialog.custom.badEnv'));
        setBusy(false);
        return;
      }
      const base = baseConfig ?? { servers: {} };
      const entry =
        transport === 'stdio'
          ? {
            type: 'stdio' as const,
            command: command.trim(),
            args: args.length ? args : undefined,
            env,
            disabled,
          }
          : {
            transport,
            url: url.trim(),
            headers: undefined,
            env,
            disabled,
          };
      const next: McpConfigFile = {
        servers: {
          ...base.servers,
          [key]: entry,
        },
      };
      await onSaveCustom(next);
      onClose();
      resetCustom();
    } catch {
      /* onSaveCustom surfaces toast */
    } finally {
      setBusy(false);
    }
  };

  if (mode !== 'custom') return null;

  return (
    <Sheet open onOpenChange={(open) => { if (!open) onClose(); }}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 overflow-y-auto sm:max-w-md bg-white dark:bg-card">
        <SheetHeader className="text-left pb-2">
          <SheetTitle className="!text-[16px] font-sans font-bold text-foreground leading-tight tracking-normal">
            {t('dialog.custom.title')}
          </SheetTitle>
        </SheetHeader>
        <div className="space-y-4 py-2 flex-1">
          <div className="space-y-2">
            <Label className={labelClasses}>{t('dialog.custom.name')}</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="my-server" className={inputClasses} />
          </div>
          <div className="space-y-2">
            <Label className={labelClasses}>{t('dialog.custom.type')}</Label>
            <Select
              value={transport}
              onChange={(e) => setTransport(e.target.value as McpTransportType)}
              className={selectClasses}
            >
              <option value="stdio">stdio</option>
              <option value="streamable-http">streamable-http</option>
              <option value="sse">sse</option>
            </Select>
          </div>
          {transport === 'stdio' ? (
            <>
              <div className="space-y-2">
                <Label className={labelClasses}>{t('dialog.custom.command')}</Label>
                <Input value={command} onChange={(e) => setCommand(e.target.value)} className={inputClasses} />
              </div>
              <div className="space-y-2">
                <Label className={labelClasses}>{t('dialog.custom.args')}</Label>
                <Input value={argsText} onChange={(e) => setArgsText(e.target.value)} placeholder="-y, @scope/pkg" className={inputClasses} />
              </div>
            </>
          ) : (
            <div className="space-y-2">
              <Label className={labelClasses}>{t('dialog.custom.url')}</Label>
              <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" className={inputClasses} />
            </div>
          )}
          <div className="space-y-2">
            <Label className={labelClasses}>{t('dialog.custom.env')}</Label>
            <textarea
              className={textareaClasses}
              value={envText}
              onChange={(e) => setEnvText(e.target.value)}
              placeholder="KEY=value"
            />
          </div>
          <div className="flex items-center justify-between bg-white dark:bg-muted px-3.5 py-3 rounded-lg border border-black/[0.06] dark:border-white/10">
            <Label className={labelClasses}>{t('dialog.custom.disabled')}</Label>
            <Switch size="sm" checked={disabled} onCheckedChange={setDisabled} />
          </div>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={onClose}
            className="h-8 text-[13px] font-medium rounded-lg px-4 border-black/10 dark:border-white/10 bg-white dark:bg-transparent hover:bg-black/5 dark:hover:bg-white/5 shadow-sm text-foreground/80 hover:text-foreground transition-colors"
          >
            {t('dialog.cancel')}
          </Button>
          <Button
            type="button"
            onClick={() => void handleCustomSubmit()}
            disabled={busy || !name.trim()}
            className="h-8 text-[13px] font-medium rounded-lg px-4 bg-[#FF922B] hover:bg-[#FE7B00] text-white shadow-sm shadow-[#FF922B]/25 transition-colors"
          >
            {t('dialog.save')}
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
