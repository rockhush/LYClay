import { useState } from 'react';
import {
  Sheet,
  SheetContent,
  SheetFooter,
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
      <SheetContent side="right" className="flex w-full flex-col gap-0 overflow-y-auto sm:max-w-md">
        <SheetHeader className="text-left">
          <SheetTitle>{t('dialog.custom.title')}</SheetTitle>
        </SheetHeader>
        <div className="space-y-3 py-2">
          <div className="space-y-1.5">
            <Label>{t('dialog.custom.name')}</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="my-server" />
          </div>
          <div className="space-y-1.5">
            <Label>{t('dialog.custom.type')}</Label>
            <Select
              value={transport}
              onChange={(e) => setTransport(e.target.value as McpTransportType)}
            >
              <option value="stdio">stdio</option>
              <option value="streamable-http">streamable-http</option>
              <option value="sse">sse</option>
            </Select>
          </div>
          {transport === 'stdio' ? (
            <>
              <div className="space-y-1.5">
                <Label>{t('dialog.custom.command')}</Label>
                <Input value={command} onChange={(e) => setCommand(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label>{t('dialog.custom.args')}</Label>
                <Input value={argsText} onChange={(e) => setArgsText(e.target.value)} placeholder="-y, @scope/pkg" />
              </div>
            </>
          ) : (
            <div className="space-y-1.5">
              <Label>{t('dialog.custom.url')}</Label>
              <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" />
            </div>
          )}
          <div className="space-y-1.5">
            <Label>{t('dialog.custom.env')}</Label>
            <textarea
              className="flex min-h-[72px] w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              value={envText}
              onChange={(e) => setEnvText(e.target.value)}
              placeholder="KEY=value"
            />
          </div>
          <div className="flex items-center justify-between">
            <Label>{t('dialog.custom.disabled')}</Label>
            <Switch checked={disabled} onCheckedChange={setDisabled} />
          </div>
        </div>
        <SheetFooter className="mt-4 sm:justify-end">
          <Button type="button" variant="outline" onClick={onClose}>{t('dialog.cancel')}</Button>
          <Button type="button" onClick={() => void handleCustomSubmit()} disabled={busy || !name.trim()}>
            {t('dialog.save')}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
