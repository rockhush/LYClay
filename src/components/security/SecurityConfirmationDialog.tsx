import { useEffect, useRef, useState } from 'react';
import { FilePen, FileText, FileWarning, Globe2, PlugZap, ShieldAlert, Terminal, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ModalOverlay } from '@/components/ui/modal-overlay';
import {
  sendSecurityConfirmationResponse,
  subscribeSecurityConfirmationRequests,
} from '@/lib/security-confirmation';

type SecurityConfirmationChoice = 'deny' | 'allow-once' | 'allow-session' | 'allow-persistent';

type SecurityConfirmationRequest = {
  id: string;
  kind: 'network' | 'command' | 'open-target' | 'model-secret' | 'mcp-server' | 'file';
  source: string;
  risk: 'low' | 'medium' | 'high' | 'critical';
  target: {
    url?: string;
    hostname?: string;
    command?: string;
    cwd?: string;
    protocol?: string;
    summary?: string;
    secretTypes?: string[];
    excerpts?: string[];
    serverName?: string;
    transport?: string;
    path?: string;
    capability?: string;
  };
  reasons: string[];
};

async function respond(id: string, choice: SecurityConfirmationChoice): Promise<void> {
  await sendSecurityConfirmationResponse({ id, choice });
}

function formatSource(source: string): string {
  if (source.includes('openclaw-doctor')) return 'OpenClaw Doctor';
  if (source.includes('chat.send')) return '当前对话';
  if (source.includes('gateway')) return 'Gateway';
  if (source.includes('renderer')) return '界面';
  if (source.includes('shell')) return '界面';
  return source || '未知来源';
}

function formatRisk(risk: SecurityConfirmationRequest['risk']): string {
  if (risk === 'critical') return '严重';
  if (risk === 'high') return '高';
  if (risk === 'medium') return '中';
  return '低';
}

function formatReason(reason: string, hostname: string): string {
  if (/Network access to .+ requires confirmation/i.test(reason)) {
    return `访问 ${hostname} 需要你的确认。`;
  }
  if (/Plain HTTP links require stronger confirmation/i.test(reason)) {
    return 'HTTP 明文链接需要更谨慎的确认。';
  }
  if (/Opening an email client requires confirmation/i.test(reason)) {
    return '打开邮件客户端需要你的确认。';
  }
  if (/Repair commands require explicit user confirmation/i.test(reason)) {
    return '修复类命令可能修改本地环境，需要你的确认。';
  }
  if (/Package manager changes may modify the workspace and access the network/i.test(reason)) {
    return '包管理器命令可能修改项目文件并访问网络。';
  }
  if (/Python package changes may modify the workspace and access the network/i.test(reason)) {
    return 'Python 包管理命令可能修改项目文件并访问网络。';
  }
  if (/Recursive delete requires confirmation/i.test(reason)) {
    return '递归删除命令需要确认。';
  }
  if (/Git command may modify workspace state or contact a remote/i.test(reason)) {
    return 'Git 命令可能修改工作区或访问远程仓库。';
  }
  if (/Network command requires confirmation/i.test(reason)) {
    return '联网命令需要确认。';
  }
  if (/Command substitution requires confirmation/i.test(reason)) {
    return '命令替换会动态执行内容，需要确认。';
  }
  if (/Allowed after user confirmation/i.test(reason)) {
    return '已由用户确认允许。';
  }
  if (/stdio MCP servers start a local process/i.test(reason)) {
    return 'stdio MCP 服务会启动本地进程，需要你的明确确认。';
  }
  if (/Remote MCP servers can access external services/i.test(reason)) {
    return '远程 MCP 服务可以访问外部服务，需要你的确认。';
  }
  if (/Delete operations require a confirmation flow/i.test(reason)) {
    return '删除文件操作需要确认。';
  }
  if (/Deleting local files requires confirmation/i.test(reason)) {
    return '删除本地文件需要确认。';
  }
  if (/Writing local files requires confirmation/i.test(reason)) {
    return '写入本地文件需要确认。';
  }
  return reason;
}

function getTitle(request: SecurityConfirmationRequest): string {
  if (request.kind === 'mcp-server') return 'Agent 想启用 MCP 服务';
  if (request.kind === 'file') {
    const cap = request.target.capability;
    if (cap === 'delete') return 'Agent 想删除文件';
    if (cap === 'write') return 'Agent 想写入文件';
    return 'Agent 想读取本地文件';
  }
  if (request.kind === 'model-secret') return 'Agent 想发送疑似敏感密钥';
  if (request.kind === 'open-target') return 'Agent 想打开外部目标';
  return request.kind === 'command' ? 'Agent 想执行命令' : 'Agent 想访问外部域名';
}

function getTargetLabel(request: SecurityConfirmationRequest): string {
  if (request.kind === 'mcp-server') {
    return `${request.target.serverName ?? ''} (${request.target.transport ?? 'unknown'})\n${request.target.summary ?? ''}`.trim();
  }
  if (request.kind === 'command') return request.target.command ?? '';
  if (request.kind === 'file') return request.target.path ?? '';
  if (request.kind === 'model-secret') return request.target.summary ?? '';
  return request.target.hostname ?? request.target.url ?? '';
}

function formatReasons(request: SecurityConfirmationRequest): string {
  const hostname = request.target.hostname ?? request.target.url ?? '';
  return request.reasons.map((reason) => formatReason(reason, hostname)).join('；');
}

export function SecurityConfirmationDialog() {
  const [queue, setQueue] = useState<SecurityConfirmationRequest[]>([]);
  const active = queue[0] ?? null;
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    return subscribeSecurityConfirmationRequests((payload) => {
      const request = payload as SecurityConfirmationRequest;
      setQueue((current) => current.some((item) => item.id === request.id)
        ? current
        : [...current, request]);
    });
  }, []);

  useEffect(() => {
    if (active) cancelRef.current?.focus();
  }, [active]);

  if (!active) return null;

  const choose = async (choice: SecurityConfirmationChoice) => {
    const id = active.id;
    setQueue((current) => current.filter((item) => item.id !== id));
    await respond(id, choice);
  };
  const isCommand = active.kind === 'command';
  const isOpenTarget = active.kind === 'open-target';
  const isModelSecret = active.kind === 'model-secret';
  const isMcpServer = active.kind === 'mcp-server';
  const isFile = active.kind === 'file';
  const targetLabel = getTargetLabel(active);

  return (
    <ModalOverlay
      role="dialog"
      aria-modal="true"
      aria-labelledby="security-confirmation-title"
      data-testid="security-confirmation-dialog"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          void choose('deny');
        }
      }}
    >
      <div className="mx-4 max-h-[calc(100vh-2rem)] w-full max-w-lg overflow-y-auto rounded-lg border bg-card p-6 shadow-lg">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 rounded-full bg-orange-500/10 p-2 text-orange-500">
            <ShieldAlert className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 id="security-confirmation-title" className="text-lg font-semibold">
              {getTitle(active)}
            </h2>
            <div className="mt-3 space-y-2 text-sm">
              <div
                className={`flex items-start gap-2 rounded-md bg-muted/50 px-3 py-2 ${isCommand ? 'max-h-56 overflow-y-auto' : ''}`}
                data-testid="security-confirmation-target"
              >
                {isCommand ? (
                  <Terminal className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                ) : isMcpServer ? (
                  <PlugZap className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                ) : isFile ? (
                  active.target.capability === 'delete' ? (
                    <Trash2 className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                  ) : active.target.capability === 'write' ? (
                    <FilePen className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                  ) : (
                    <FileText className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                  )
                ) : isModelSecret ? (
                  <FileWarning className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                ) : (
                  <Globe2 className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                )}
                <span className="break-all font-mono whitespace-pre-wrap">{targetLabel}</span>
              </div>
              {isCommand && active.target.cwd && (
                <p className="break-all text-muted-foreground">
                  目录：<span className="font-mono">{active.target.cwd}</span>
                </p>
              )}
              <p className="text-muted-foreground">
                来源：{formatSource(active.source)} · 风险：{formatRisk(active.risk)}
              </p>
              {active.reasons.length > 0 && (
                <p className="text-muted-foreground">
                  原因：{formatReasons(active)}
                </p>
              )}
              {isModelSecret && active.target.secretTypes && active.target.secretTypes.length > 0 && (
                <p className="break-all text-muted-foreground">
                  类型：<span className="font-mono">{active.target.secretTypes.join(', ')}</span>
                </p>
              )}
              {isModelSecret && active.target.excerpts && active.target.excerpts.length > 0 && (
                <div className="space-y-1 text-muted-foreground">
                  {active.target.excerpts.slice(0, 3).map((excerpt, index) => (
                    <p key={`${index}-${excerpt}`} className="break-all font-mono text-xs">
                      {excerpt}
                    </p>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="mt-6 flex flex-wrap justify-end gap-2">
          <Button
            ref={cancelRef}
            variant="outline"
            onClick={() => void choose('deny')}
          >
            拒绝
          </Button>
          <Button variant="outline" onClick={() => void choose('allow-once')}>
            允许一次
          </Button>
          <Button variant="secondary" onClick={() => void choose('allow-session')}>
            本次启动允许
          </Button>
          {!isCommand && !isOpenTarget && !isModelSecret && (
            <Button onClick={() => void choose('allow-persistent')}>
              永久允许
            </Button>
          )}
        </div>
      </div>
    </ModalOverlay>
  );
}
