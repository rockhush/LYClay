/**
 * Full JSON editor for OpenClaw mcp.servers
 */
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import Editor from '@monaco-editor/react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { useConnectorsStore } from '@/stores/connectors';
import { useSettingsStore } from '@/stores/settings';
import { toUserMessage } from '@/lib/api-client';

export function McpConfigEditor() {
  const { t } = useTranslation('connectors');
  const theme = useSettingsStore((s) => s.theme);
  const mcpConfigPath = useConnectorsStore((s) => s.mcpConfigPath);
  const mcpConfigLoading = useConnectorsStore((s) => s.mcpConfigLoading);
  const fetchMcpConfig = useConnectorsStore((s) => s.fetchMcpConfig);
  const saveMcpConfig = useConnectorsStore((s) => s.saveMcpConfig);
  const validateMcpConfig = useConnectorsStore((s) => s.validateMcpConfig);
  const mcpConfig = useConnectorsStore((s) => s.mcpConfig);

  const [text, setText] = useState('{\n  "servers": {}\n}\n');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [systemDark, setSystemDark] = useState(false);

  useEffect(() => {
    if (theme !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => setSystemDark(mq.matches);
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [theme]);

  useEffect(() => {
    void fetchMcpConfig();
  }, [fetchMcpConfig]);

  useEffect(() => {
    if (mcpConfigLoading || !mcpConfig) return;
    setText(`${JSON.stringify(mcpConfig, null, 2)}\n`);
    setDirty(false);
  }, [mcpConfig, mcpConfigLoading]);

  const handleSave = useCallback(async () => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      toast.error(t('editor.invalidJson'));
      return;
    }
    const v = await validateMcpConfig(parsed as import('@/types/connector').McpConfigFile);
    if (!v.valid) {
      toast.error(v.errors.join('\n'));
      return;
    }
    setSaving(true);
    try {
      await saveMcpConfig(parsed as import('@/types/connector').McpConfigFile);
      toast.success(t('editor.saved'));
      setDirty(false);
    } catch (error) {
      toast.error(toUserMessage(error));
    } finally {
      setSaving(false);
    }
  }, [text, validateMcpConfig, saveMcpConfig, t]);

  const monacoTheme = theme === 'dark' || (theme === 'system' && systemDark) ? 'vs-dark' : 'light';

  return (
    <div data-testid="mcp-config-editor-page" className="mx-auto flex max-w-5xl flex-col gap-4 pb-16 h-[calc(100vh-6rem)]">
      <div className="flex flex-wrap items-center justify-between gap-2 shrink-0">
        <div className="flex items-center gap-3">
          <Button asChild variant="ghost" className="rounded-full">
            <Link to="/settings/mcp">{t('editor.back')}</Link>
          </Button>
          <h1 className="text-2xl font-semibold tracking-tight">{t('editor.title')}</h1>
        </div>
        <div className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            className="rounded-full"
            disabled={!dirty || saving}
            onClick={() => {
              if (!mcpConfig) return;
              setText(`${JSON.stringify(mcpConfig, null, 2)}\n`);
              setDirty(false);
            }}
          >
            {t('editor.revert')}
          </Button>
          <Button type="button" className="rounded-full" disabled={saving} onClick={() => void handleSave()}>
            {t('editor.save')}
          </Button>
        </div>
      </div>
      <p className="text-xs text-muted-foreground shrink-0 font-mono break-all">{mcpConfigPath}</p>
      <div className="min-h-0 flex-1 overflow-hidden rounded-xl border border-black/10 dark:border-white/10">
        <Editor
          height="100%"
          defaultLanguage="json"
          theme={monacoTheme}
          value={text}
          onChange={(v) => {
            setText(v ?? '');
            setDirty(true);
          }}
          options={{
            minimap: { enabled: false },
            fontSize: 13,
            wordWrap: 'on',
            scrollBeyondLastLine: false,
          }}
        />
      </div>
    </div>
  );
}
