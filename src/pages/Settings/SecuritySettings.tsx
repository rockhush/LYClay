import { useEffect, useMemo, useState, type ComponentProps } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, ChevronDown, ChevronLeft, ChevronRight, Clock3, FolderLock, Globe2, Plus, RefreshCw, Shield, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { hostApiFetch } from '@/lib/host-api';
import { cn } from '@/lib/utils';

type FileCapability = 'metadata' | 'read' | 'write' | 'delete' | 'execute' | 'stage' | 'open';
type NetworkCapability = 'connect';

type PathGrant = {
  id: string;
  subject: string;
  resourceType: 'workspace' | 'file' | 'directory';
  path: string;
  realPath: string;
  recursive: boolean;
  capabilities: FileCapability[];
  scope: 'once' | 'session' | 'persistent';
  source: string;
  expiresAt?: number;
  revokedAt?: number;
  createdAt: number;
};

type DomainGrant = {
  id: string;
  subject: string;
  resourceType: 'domain';
  domain: string;
  includeSubdomains: boolean;
  capabilities: NetworkCapability[];
  scope: 'once' | 'session' | 'persistent';
  source: string;
  expiresAt?: number;
  revokedAt?: number;
  createdAt: number;
};

type SecurityGrantsResponse = {
  pathGrants: PathGrant[];
  domainGrants: DomainGrant[];
};

type SecurityAuditCapability =
  | 'file'
  | 'command'
  | 'network'
  | 'open-target'
  | 'prompt-scan'
  | 'permission'
  | 'skill-runtime'
  | 'internal-command'
  | 'confirmation';

type SecurityAuditDecision =
  | 'allow'
  | 'prompt'
  | 'deny'
  | 'grant'
  | 'revoke'
  | 'invalidate'
  | 'confirm'
  | 'expire';

type SecurityRisk = 'low' | 'medium' | 'high' | 'critical';

type SecurityAuditEvent = {
  id: string;
  ts: number;
  source: string;
  subject?: string;
  capability: SecurityAuditCapability;
  operation?: string;
  target?: string;
  decision: SecurityAuditDecision;
  risk?: SecurityRisk;
  reasons?: string[];
  code?: string;
  metadata?: Record<string, unknown>;
};

type SecurityAuditResponse = {
  success: boolean;
  events: SecurityAuditEvent[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
};

const capabilityOptions: Array<{ value: 'all' | SecurityAuditCapability; label: string }> = [
  { value: 'all', label: '全部能力' },
  { value: 'file', label: '文件' },
  { value: 'command', label: '命令' },
  { value: 'network', label: '网络' },
  { value: 'open-target', label: '打开目标' },
  { value: 'prompt-scan', label: '提示词扫描' },
  { value: 'permission', label: '授权' },
  { value: 'skill-runtime', label: 'Skill 运行时' },
  { value: 'internal-command', label: '内部命令' },
  { value: 'confirmation', label: '用户确认' },
];

const decisionOptions: Array<{ value: 'all' | SecurityAuditDecision; label: string }> = [
  { value: 'all', label: '全部结果' },
  { value: 'allow', label: '允许' },
  { value: 'prompt', label: '确认' },
  { value: 'deny', label: '拒绝' },
  { value: 'grant', label: '授权' },
  { value: 'revoke', label: '撤销' },
  { value: 'invalidate', label: '已失效' },
  { value: 'confirm', label: '已确认' },
  { value: 'expire', label: '过期' },
];

function formatDate(timestamp?: number): string {
  if (!timestamp) return '-';
  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(timestamp));
}

const auditSelectClassName =
  'h-9 rounded-lg border-black/10 dark:border-white/10 bg-white dark:bg-muted hover:bg-black/5 dark:hover:bg-white/5 text-[13px] font-medium py-0 pr-10 [background-image:none]';

/** Audit-log filter select styled like the Cron dialog agent picker (36px, external chevron). */
function AuditSelectField({ className, children, ...props }: ComponentProps<typeof Select>) {
  return (
    <div className="relative flex items-center">
      <Select className={cn(auditSelectClassName, className)} {...props}>
        {children}
      </Select>
      <ChevronDown className="pointer-events-none absolute right-3 h-4 w-4 text-muted-foreground" aria-hidden />
    </div>
  );
}

function GrantBadges({ grant }: { grant: Pick<PathGrant | DomainGrant, 'scope' | 'source' | 'capabilities'> }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Badge variant="secondary" className="rounded-md">{grant.scope}</Badge>
      {grant.capabilities.map((capability) => (
        <Badge key={capability} variant="outline" className="rounded-md">{capability}</Badge>
      ))}
      <span className="text-xs text-muted-foreground">{grant.source}</span>
    </div>
  );
}

function decisionClassName(decision: SecurityAuditDecision): string {
  if (decision === 'deny') return 'border-red-200 bg-red-50 text-red-700';
  if (decision === 'prompt') return 'border-amber-200 bg-amber-50 text-amber-700';
  if (decision === 'grant' || decision === 'confirm' || decision === 'allow') return 'border-emerald-200 bg-emerald-50 text-emerald-700';
  return 'border-slate-200 bg-slate-50 text-slate-700';
}

function riskClassName(risk?: SecurityRisk): string {
  if (risk === 'critical' || risk === 'high') return 'border-red-200 bg-red-50 text-red-700';
  if (risk === 'medium') return 'border-amber-200 bg-amber-50 text-amber-700';
  if (risk === 'low') return 'border-slate-200 bg-slate-50 text-slate-700';
  return 'border-slate-200 bg-slate-50 text-slate-500';
}

export function SecuritySettings() {
  const [pathGrants, setPathGrants] = useState<PathGrant[]>([]);
  const [domainGrants, setDomainGrants] = useState<DomainGrant[]>([]);
  const [auditEvents, setAuditEvents] = useState<SecurityAuditEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [auditLoading, setAuditLoading] = useState(true);
  const [savingDomain, setSavingDomain] = useState(false);
  const [domainDraft, setDomainDraft] = useState('');
  const [includeSubdomains, setIncludeSubdomains] = useState(true);
  const [persistent, setPersistent] = useState(true);
  const [auditPage, setAuditPage] = useState(1);
  const [auditPageSize, setAuditPageSize] = useState('10');
  const [auditTotal, setAuditTotal] = useState(0);
  const [auditTotalPages, setAuditTotalPages] = useState(1);
  const [auditCapability, setAuditCapability] = useState<'all' | SecurityAuditCapability>('all');
  const [auditDecision, setAuditDecision] = useState<'all' | SecurityAuditDecision>('all');

  const sortedPathGrants = useMemo(
    () => [...pathGrants].sort((a, b) => b.createdAt - a.createdAt),
    [pathGrants],
  );
  const sortedDomainGrants = useMemo(
    () => [...domainGrants].sort((a, b) => b.createdAt - a.createdAt),
    [domainGrants],
  );

  const loadGrants = async () => {
    setLoading(true);
    try {
      const result = await hostApiFetch<SecurityGrantsResponse>('/api/security/grants');
      setPathGrants(result.pathGrants);
      setDomainGrants(result.domainGrants);
    } catch (error) {
      toast.error(`加载安全授权失败：${String(error)}`);
    } finally {
      setLoading(false);
    }
  };

  const loadAuditEvents = async () => {
    setAuditLoading(true);
    try {
      const params = new URLSearchParams({
        page: String(auditPage),
        pageSize: auditPageSize,
      });
      if (auditCapability !== 'all') params.set('capability', auditCapability);
      if (auditDecision !== 'all') params.set('decision', auditDecision);
      const result = await hostApiFetch<SecurityAuditResponse>(`/api/security/audit-events?${params.toString()}`);
      setAuditEvents(Array.isArray(result.events) ? result.events : []);
      setAuditTotal(Number.isFinite(result.total) ? result.total : 0);
      setAuditTotalPages(Number.isFinite(result.totalPages) ? Math.max(1, result.totalPages) : 1);
      if (Number.isFinite(result.page) && result.page !== auditPage) {
        setAuditPage(result.page);
      }
    } catch (error) {
      toast.error(`加载审计日志失败：${String(error)}`);
    } finally {
      setAuditLoading(false);
    }
  };

  useEffect(() => {
    void loadGrants();
  }, []);

  useEffect(() => {
    void loadAuditEvents();
  }, [auditPage, auditPageSize, auditCapability, auditDecision]);

  const auditRangeStart = auditTotal === 0 ? 0 : (auditPage - 1) * Number(auditPageSize) + 1;
  const auditRangeEnd = Math.min(auditPage * Number(auditPageSize), auditTotal);

  const revokeGrant = async (kind: 'path' | 'domain', id: string) => {
    try {
      await hostApiFetch<{ success: boolean }>(`/api/security/grants/${kind}/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      });
      toast.success('授权已撤销');
      await loadGrants();
    } catch (error) {
      toast.error(`撤销授权失败：${String(error)}`);
    }
  };

  const addDomainGrant = async () => {
    const domain = domainDraft.trim();
    if (!domain) return;
    setSavingDomain(true);
    try {
      await hostApiFetch<{ success: boolean; grant: DomainGrant }>('/api/security/grants/domain', {
        method: 'POST',
        body: JSON.stringify({ domain, includeSubdomains, persistent }),
      });
      setDomainDraft('');
      toast.success('域名授权已添加');
      await loadGrants();
    } catch (error) {
      toast.error(`添加域名授权失败：${String(error)}`);
    } finally {
      setSavingDomain(false);
    }
  };

  return (
    <div data-testid="security-settings-page" className="mx-auto flex max-w-5xl flex-col gap-6 pb-16">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <Button asChild variant="ghost" size="sm" className="mb-3 h-8 px-2">
            <Link to="/settings">
              <ArrowLeft className="mr-2 h-4 w-4" />
              设置
            </Link>
          </Button>
          <div className="flex items-center gap-2">
            <Shield className="h-5 w-5 text-orange-500" />
            <h1 className="text-2xl font-semibold text-foreground">安全授权</h1>
          </div>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="h-8"
          onClick={() => {
            void loadGrants();
            void loadAuditEvents();
          }}
          disabled={loading || auditLoading}
        >
          <RefreshCw className={`mr-2 h-4 w-4${loading ? ' animate-spin' : ''}`} />
          刷新
        </Button>
      </div>

      <Tabs defaultValue="grants" className="space-y-4">
        <TabsList>
          <TabsTrigger value="grants">授权管理</TabsTrigger>
          <TabsTrigger value="audit">审计日志</TabsTrigger>
        </TabsList>

        <TabsContent value="grants" className="space-y-6">
      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <Globe2 className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-base font-semibold">域名授权</h2>
        </div>
        <div className="grid gap-3 rounded-lg border bg-background p-4 md:grid-cols-[1fr_auto_auto_auto] md:items-end">
          <div className="space-y-1.5">
            <Label htmlFor="security-domain">域名</Label>
            <Input
              id="security-domain"
              value={domainDraft}
              onChange={(event) => setDomainDraft(event.target.value)}
              placeholder="example.com"
              onKeyDown={(event) => {
                if (event.key === 'Enter') void addDomainGrant();
              }}
            />
          </div>
          <div className="flex items-center gap-2 pb-2">
            <Switch size="sm" checked={includeSubdomains} onCheckedChange={setIncludeSubdomains} />
            <Label className="text-sm">包含子域名</Label>
          </div>
          <div className="flex items-center gap-2 pb-2">
            <Switch size="sm" checked={persistent} onCheckedChange={setPersistent} />
            <Label className="text-sm">永久</Label>
          </div>
          <Button onClick={addDomainGrant} disabled={savingDomain || !domainDraft.trim()} className="h-8">
            <Plus className="mr-2 h-4 w-4" />
            添加
          </Button>
        </div>

        <div className="divide-y rounded-lg border bg-background">
          {sortedDomainGrants.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">暂无域名授权</p>
          ) : sortedDomainGrants.map((grant) => (
            <div key={grant.id} className="flex flex-col gap-3 p-4 md:flex-row md:items-center md:justify-between">
              <div className="min-w-0 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-sm font-medium">{grant.domain}</span>
                  {grant.includeSubdomains && <Badge variant="outline" className="rounded-md">subdomains</Badge>}
                </div>
                <GrantBadges grant={grant} />
                <p className="text-xs text-muted-foreground">创建：{formatDate(grant.createdAt)}</p>
              </div>
              <Button variant="outline" size="sm" className="h-8" onClick={() => void revokeGrant('domain', grant.id)}>
                <Trash2 className="mr-2 h-4 w-4" />
                撤销
              </Button>
            </div>
          ))}
        </div>
      </section>

      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <FolderLock className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-base font-semibold">文件与 Workspace 授权</h2>
        </div>
        <div className="divide-y rounded-lg border bg-background">
          {sortedPathGrants.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">暂无文件授权</p>
          ) : sortedPathGrants.map((grant) => (
            <div key={grant.id} className="flex flex-col gap-3 p-4 md:flex-row md:items-center md:justify-between">
              <div className="min-w-0 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="break-all font-mono text-sm font-medium">{grant.path}</span>
                  <Badge variant="outline" className="rounded-md">{grant.resourceType}</Badge>
                  {grant.recursive && <Badge variant="outline" className="rounded-md">recursive</Badge>}
                </div>
                <GrantBadges grant={grant} />
                <p className="break-all text-xs text-muted-foreground">realpath：{grant.realPath}</p>
                <p className="text-xs text-muted-foreground">创建：{formatDate(grant.createdAt)}</p>
              </div>
              <Button variant="outline" size="sm" className="h-8" onClick={() => void revokeGrant('path', grant.id)}>
                <Trash2 className="mr-2 h-4 w-4" />
                撤销
              </Button>
            </div>
          ))}
        </div>
      </section>
        </TabsContent>

        <TabsContent value="audit" className="space-y-4">
          <section className="space-y-3">
            <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
              <div className="flex items-center gap-2">
                <Clock3 className="h-4 w-4 text-muted-foreground" />
                <h2 className="text-base font-semibold">审计日志</h2>
              </div>
              <div className="grid gap-2 sm:grid-cols-[140px_150px_130px_auto] sm:items-end">
                <div className="space-y-1.5">
                  <Label htmlFor="audit-capability">能力</Label>
                  <AuditSelectField
                    id="audit-capability"
                    value={auditCapability}
                    onChange={(event) => {
                      setAuditPage(1);
                      setAuditCapability(event.target.value as typeof auditCapability);
                    }}
                  >
                    {capabilityOptions.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </AuditSelectField>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="audit-decision">结果</Label>
                  <AuditSelectField
                    id="audit-decision"
                    value={auditDecision}
                    onChange={(event) => {
                      setAuditPage(1);
                      setAuditDecision(event.target.value as typeof auditDecision);
                    }}
                  >
                    {decisionOptions.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </AuditSelectField>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="audit-page-size">每页</Label>
                  <AuditSelectField
                    id="audit-page-size"
                    value={auditPageSize}
                    onChange={(event) => {
                      setAuditPage(1);
                      setAuditPageSize(event.target.value);
                    }}
                  >
                    <option value="10">10 条</option>
                    <option value="20">20 条</option>
                    <option value="50">50 条</option>
                  </AuditSelectField>
                </div>
                <Button variant="outline" size="sm" onClick={() => void loadAuditEvents()} disabled={auditLoading}>
                  <RefreshCw className={`mr-2 h-4 w-4${auditLoading ? ' animate-spin' : ''}`} />
                  刷新
                </Button>
              </div>
            </div>

            <div className="divide-y rounded-lg border bg-background">
              {auditEvents.length === 0 ? (
                <p className="p-4 text-sm text-muted-foreground">{auditLoading ? '正在加载审计日志' : '暂无审计日志'}</p>
              ) : auditEvents.map((event) => (
                <div key={event.id} className="space-y-2 p-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="outline" className={`rounded-md ${decisionClassName(event.decision)}`}>{event.decision}</Badge>
                    <Badge variant="outline" className="rounded-md">{event.capability}</Badge>
                    {event.operation && <Badge variant="secondary" className="rounded-md">{event.operation}</Badge>}
                    <Badge variant="outline" className={`rounded-md ${riskClassName(event.risk)}`}>{event.risk ?? 'risk'}</Badge>
                    <span className="ml-auto text-xs text-muted-foreground">{formatDate(event.ts)}</span>
                  </div>
                  <div className="grid gap-1 text-sm md:grid-cols-[96px_1fr]">
                    <span className="text-muted-foreground">来源</span>
                    <span className="break-all font-mono">{event.source}</span>
                    {event.target && (
                      <>
                        <span className="text-muted-foreground">目标</span>
                        <span className="break-all font-mono">{event.target}</span>
                      </>
                    )}
                    {event.code && (
                      <>
                        <span className="text-muted-foreground">代码</span>
                        <span className="break-all font-mono">{event.code}</span>
                      </>
                    )}
                    {event.reasons && event.reasons.length > 0 && (
                      <>
                        <span className="text-muted-foreground">原因</span>
                        <span className="break-words">{event.reasons.join('；')}</span>
                      </>
                    )}
                  </div>
                </div>
              ))}
            </div>

            <div className="flex flex-col gap-3 border-t pt-3 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-sm text-muted-foreground" aria-live="polite">
                显示第 {auditRangeStart}-{auditRangeEnd} 条，共 {auditTotal} 条
              </p>
              <div className="flex items-center justify-between gap-2 sm:justify-end">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setAuditPage((page) => Math.max(1, page - 1))}
                  disabled={auditLoading || auditPage <= 1}
                >
                  <ChevronLeft className="mr-1 h-4 w-4" />
                  上一页
                </Button>
                <span className="min-w-20 text-center text-sm text-muted-foreground">
                  第 {auditPage} / {auditTotalPages} 页
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setAuditPage((page) => Math.min(auditTotalPages, page + 1))}
                  disabled={auditLoading || auditPage >= auditTotalPages}
                >
                  下一页
                  <ChevronRight className="ml-1 h-4 w-4" />
                </Button>
              </div>
            </div>
          </section>
        </TabsContent>
      </Tabs>
    </div>
  );
}
