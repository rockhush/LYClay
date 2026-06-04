import { useState, useRef, useEffect } from 'react';
import { ChevronDown, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Select } from '@/components/ui/select';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ModalOverlay } from "@/components/ui/modal-overlay";
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import type { McpConfigFile, McpTransportType } from '@/types/connector';
import { LYCLAW_BUILTIN_MCP_KEYS } from '@/lib/mcp-builtins';

const inputClasses = 'h-9 rounded-lg text-[13px] bg-white dark:bg-muted border-black/10 dark:border-white/10 focus-visible:outline-none focus-visible:ring-0 focus-visible:border-[#FFD79A] transition-colors text-foreground placeholder:text-foreground/40';
const labelClasses = 'text-[13px] text-foreground/80 font-medium mb-2 block';
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
  const [transportMenuOpen, setTransportMenuOpen] = useState(false);
  const transportMenuRef = useRef<HTMLDivElement>(null);

  // Close menu when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (transportMenuRef.current && !transportMenuRef.current.contains(event.target as Node)) {
        setTransportMenuOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, []);
  const [url, setUrl] = useState('');
  const [command, setCommand] = useState('npx');
  const [argsText, setArgsText] = useState('-y, @modelcontextprotocol/server-example');
  const [disabled, setDisabled] = useState(false);
  const [envText, setEnvText] = useState('');
  const [headersText, setHeadersText] = useState('');

  const resetCustom = () => {
    setName('');
    setTransport('stdio');
    setUrl('');
    setCommand('npx');
    setArgsText('-y, @modelcontextprotocol/server-example');
    setDisabled(false);
    setEnvText('');
    setHeadersText('');
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

  const parseHeaders = (): Record<string, string> | undefined => {
    const lines = headersText.split('\n').map((l) => l.trim()).filter(Boolean);
    if (lines.length === 0) return undefined;
    const headers: Record<string, string> = {};
    for (const line of lines) {
      const idx = line.indexOf(':');
      if (idx <= 0) throw new Error(t('dialog.custom.badHeaders'));
      const k = line.slice(0, idx).trim();
      const v = line.slice(idx + 1).trim();
      if (!k) throw new Error(t('dialog.custom.badHeaders'));
      headers[k] = v;
    }
    return headers;
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
      let headers: Record<string, string> | undefined;
      try {
        headers = headersText.trim() ? parseHeaders() : undefined;
      } catch {
        toast.error(t('dialog.custom.badHeaders'));
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
            headers,
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
    <ModalOverlay
      className="p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <Card
        className="w-[500px] max-h-[90vh] flex flex-col rounded-[6px] border-0 shadow-2xl bg-white dark:bg-card overflow-hidden"
        onMouseDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
      >
        <CardHeader className="flex flex-row items-start justify-between pb-2 shrink-0 px-6 pt-6">
          <CardTitle className="!text-[16px] font-sans font-bold text-foreground leading-tight tracking-normal">
            {t('dialog.custom.title')}
          </CardTitle>
          <Button
            variant="ghost"
            size="icon"
            onClick={onClose}
            className="rounded-lg h-8 w-8 -mr-2 -mt-2 text-muted-foreground hover:text-foreground hover:bg-black/5 dark:hover:bg-white/5"
          >
            <X className="h-4 w-4" />
          </Button>
        </CardHeader>
        <CardContent className="space-y-4 pt-3 overflow-y-auto flex-1 px-6 pb-6" onClick={() => setTransportMenuOpen(false)}>
          <div className="space-y-2">
            <Label className={labelClasses}>{t('dialog.custom.name')}</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="my-server" className={inputClasses} />
          </div>
          <div className="space-y-2">
            <Label className={labelClasses}>{t('dialog.custom.type')}</Label>
            <div className="relative" ref={transportMenuRef} onClick={(e) => e.stopPropagation()}>
              <button
                onClick={() => setTransportMenuOpen(!transportMenuOpen)}
                className="w-full h-9 bg-white dark:bg-muted border border-black/10 dark:border-white/10 hover:bg-black/5 dark:hover:bg-white/5 transition-colors text-foreground text-[13px] font-medium px-3 rounded-lg flex items-center justify-between"
              >
                {transport}
                <ChevronDown className="h-4 w-4 opacity-90" />
              </button>
              {transportMenuOpen && (
                <div className="absolute left-0 right-0 top-full mt-1 rounded-lg border border-black/10 dark:border-white/10 bg-white dark:bg-card shadow-lg shadow-black/10 overflow-hidden z-20 py-1">
                  <button
                    className={`w-full px-3 py-2 text-left text-sm hover:bg-black/5 dark:hover:bg-white/5 ${transport === 'stdio' ? 'bg-[#FF922B]/10 text-[#FF922B]' : ''}`}
                    onClick={() => {
                      setTransport('stdio');
                      setTransportMenuOpen(false);
                    }}
                  >
                    stdio
                  </button>
                  <button
                    className={`w-full px-3 py-2 text-left text-sm hover:bg-black/5 dark:hover:bg-white/5 ${transport === 'streamable-http' ? 'bg-[#FF922B]/10 text-[#FF922B]' : ''}`}
                    onClick={() => {
                      setTransport('streamable-http');
                      setTransportMenuOpen(false);
                    }}
                  >
                    streamable-http
                  </button>
                  <button
                    className={`w-full px-3 py-2 text-left text-sm hover:bg-black/5 dark:hover:bg-white/5 ${transport === 'sse' ? 'bg-[#FF922B]/10 text-[#FF922B]' : ''}`}
                    onClick={() => {
                      setTransport('sse');
                      setTransportMenuOpen(false);
                    }}
                  >
                    sse
                  </button>
                </div>
              )}
            </div>
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
            <>
              <div className="space-y-2">
                <Label className={labelClasses}>{t('dialog.custom.url')}</Label>
                <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" className={inputClasses} />
              </div>
              <div className="space-y-2">
                <Label className={labelClasses}>{t('dialog.custom.headers')}</Label>
                <textarea
                  className={textareaClasses}
                  value={headersText}
                  onChange={(e) => setHeadersText(e.target.value)}
                  placeholder="Authorization: Bearer token"
                />
              </div>
            </>
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
          <div className="flex items-center justify-between bg-[#F8F9F9] px-3.5 py-3 rounded-lg">
            <Label className={labelClasses}>{t('dialog.custom.disabled')}</Label>
            <Switch size="sm" checked={disabled} onCheckedChange={setDisabled} />
          </div>
          <div className="flex justify-end gap-2 pt-2">
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
        </CardContent>
      </Card>
    </ModalOverlay>
  );
}
