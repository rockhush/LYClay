/**
 * Chat Toolbar
 * Session selector, new session, and refresh.
 * Rendered in the Header when on the Chat page.
 */
import { useMemo } from 'react';
import { RefreshCw, Bot } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useChatStore } from '@/stores/chat';
import { useAgentsStore } from '@/stores/agents';
import { useDigitalEmployeesStore } from '@/stores/digital-employees';
import { cn } from '@/lib/utils';
import { useTranslation } from 'react-i18next';

export function ChatToolbar() {
  const refresh = useChatStore((s) => s.refresh);
  const loading = useChatStore((s) => s.loading);
  const currentAgentId = useChatStore((s) => s.currentAgentId);
  const agents = useAgentsStore((s) => s.agents);
  const digitalEmployees = useDigitalEmployeesStore((s) => s.employees);
  const { t } = useTranslation('chat');
  const currentAgentName = useMemo(() => {
    const fromAgents = (agents ?? []).find((agent) => agent.id === currentAgentId);
    if (fromAgents?.name) return fromAgents.name;
    const fromEmployees = (digitalEmployees ?? []).find((employee) => employee.agentId === currentAgentId);
    if (fromEmployees?.name) return fromEmployees.name;
    return currentAgentId;
  }, [agents, currentAgentId, digitalEmployees]);

  return (
    <div className="flex w-full items-center justify-between gap-2">
      <div className="flex items-center gap-2 text-[13px]">
        <span className="text-muted-foreground">
          {t('toolbar.currentAgentLabel', { defaultValue: '当前对话' })}
        </span>
        <span className="inline-flex items-center gap-1 font-medium text-foreground">
          <Bot className="h-3.5 w-3.5 text-[#FF922B]" />
          {currentAgentName}
        </span>
      </div>
      {/* Refresh */}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={() => refresh()}
            disabled={loading}
          >
            <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          <p>{t('toolbar.refresh')}</p>
        </TooltipContent>
      </Tooltip>
    </div>
  );
}
