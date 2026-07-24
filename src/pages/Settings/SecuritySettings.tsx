import { useEffect, useMemo, useState, type ComponentProps } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
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
type SecurityMode = 'standard' | 'trusted' | 'off';

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

type SecurityModeResponse = {
  success: boolean;
  mode: SecurityMode;
};

type SecurityAuditResponse = {
  success: boolean;
  events: SecurityAuditEvent[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
};


const securityModeOptions: SecurityMode[] = ['standard', 'trusted', 'off'];

const capabilityOptions: Array<'all' | SecurityAuditCapability> = [
  'all', 'file', 'command', 'network', 'open-target', 'prompt-scan',
  'permission', 'skill-runtime', 'internal-command', 'confirmation',
];

const decisionOptions: Array<'all' | SecurityAuditDecision> = [
  'all', 'allow', 'prompt', 'deny', 'grant', 'revoke', 'invalidate', 'confirm', 'expire',
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
  const { t } = useTranslation('settings');
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
  const [securityMode, setSecurityMode] = useState<SecurityMode>('trusted');
  const [savingSecurityMode, setSavingSecurityMode] = useState(false);

  const sortedPathGrants = useMemo(
    () => [...pathGrants].sort((a, b) => b.createdAt - a.createdAt),
    [pathGrants],
  );
  const sortedDomainGrants = useMemo(
    () => [...domainGrants].sort((a, b) => b.createdAt - a.createdAt),
    [domainGrants],
  );


  const loadSecurityMode = async () => {
    try {
      const result = await hostApiFetch<SecurityModeResponse>('/api/security/settings');
      if (result.mode === 'standard' || result.mode === 'trusted' || result.mode === 'off') {
        setSecurityMode(result.mode);
      }
    } catch (error) {
      toast.error(t('security.mode.loadError', { error: String(error) }));
    }
  };

  const saveSecurityMode = async (mode: SecurityMode) => {
    if (mode === securityMode || savingSecurityMode) return;
    if (mode === 'off') {
      const confirmed = window.confirm(t('security.mode.offConfirm'));
      if (!confirmed) return;
    }
    const previous = securityMode;
    setSecurityMode(mode);
    setSavingSecurityMode(true);
    try {
      await hostApiFetch<SecurityModeResponse>('/api/security/settings', {
        method: 'PUT',
        body: JSON.stringify({ mode }),
      });
      toast.success(t('security.mode.updateSuccess'));
    } catch (error) {
      setSecurityMode(previous);
      toast.error(t('security.mode.updateError', { error: String(error) }));
    } finally {
      setSavingSecurityMode(false);
    }
  };

  const loadGrants = async () => {
    setLoading(true);
    try {
      const result = await hostApiFetch<SecurityGrantsResponse>('/api/security/grants');
      setPathGrants(result.pathGrants);
      setDomainGrants(result.domainGrants);
    } catch (error) {
      toast.error(t('security.errors.loadGrants', { error: String(error) }));
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
      toast.error(t('security.errors.loadAudit', { error: String(error) }));
    } finally {
      setAuditLoading(false);
    }
  };

  useEffect(() => {
    void loadSecurityMode();
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
      toast.success(t('security.toasts.revoked'));
      await loadGrants();
    } catch (error) {
      toast.error(t('security.errors.revoke', { error: String(error) }));
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
      toast.success(t('security.toasts.domainAdded'));
      await loadGrants();
    } catch (error) {
      toast.error(t('security.errors.addDomain', { error: String(error) }));
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
              {t('title')}
            </Link>
          </Button>
          <div className="flex items-center gap-2">
            <Shield className="h-5 w-5 text-orange-500" />
            <h1 className="text-2xl font-semibold text-foreground">{t('security.pageTitle')}</h1>
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
          {t('security.actions.refresh')}
        </Button>
      </div>


      <section className="space-y-3 rounded-lg border bg-background p-4" data-testid="security-mode-section">
        <div className="flex flex-col gap-1">
          <h2 className="text-base font-semibold">{t('security.mode.title')}</h2>
          <p className="text-sm text-muted-foreground">{t('security.mode.summary')}</p>
        </div>
        <div className="grid gap-2 md:grid-cols-3" role="group" aria-label={t('security.mode.title')}>
          {securityModeOptions.map((option) => {
            const selected = securityMode === option;
            return (
              <Button
                key={option}
                type="button"
                variant={selected ? 'default' : 'outline'}
                className="h-auto justify-start px-3 py-3 text-left"
                data-testid={`security-mode-${option}`}
                aria-pressed={selected}
                disabled={savingSecurityMode}
                onClick={() => void saveSecurityMode(option)}
              >
                <span className="flex min-w-0 flex-col gap-1">
                  <span className="text-sm font-medium">{t(`security.mode.options.${option}.label`)}</span>
                  <span className={`text-xs ${selected ? 'text-primary-foreground/80' : 'text-muted-foreground'}`}>{t(`security.mode.options.${option}.description`)}</span>
                </span>
              </Button>
            );
          })}
        </div>
      </section>

      <Tabs defaultValue="grants" className="space-y-4">
        <TabsList>
          <TabsTrigger value="grants">{t('security.grants.title')}</TabsTrigger>
          <TabsTrigger value="audit">{t('security.audit.title')}</TabsTrigger>
        </TabsList>

        <TabsContent value="grants" className="space-y-6">
      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <Globe2 className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-base font-semibold">{t('security.domain.title')}</h2>
        </div>
        <div className="grid gap-3 rounded-lg border bg-background p-4 md:grid-cols-[1fr_auto_auto_auto] md:items-end">
          <div className="space-y-1.5">
            <Label htmlFor="security-domain">{t('security.domain.label')}</Label>
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
            <Label className="text-sm">{t('security.domain.includeSubdomains')}</Label>
          </div>
          <div className="flex items-center gap-2 pb-2">
            <Switch size="sm" checked={persistent} onCheckedChange={setPersistent} />
            <Label className="text-sm">{t('security.domain.persistent')}</Label>
          </div>
          <Button onClick={addDomainGrant} disabled={savingDomain || !domainDraft.trim()} className="h-8">
            <Plus className="mr-2 h-4 w-4" />
            {t('security.actions.add')}
          </Button>
        </div>

        <div className="divide-y rounded-lg border bg-background">
          {sortedDomainGrants.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">{t('security.domain.empty')}</p>
          ) : sortedDomainGrants.map((grant) => (
            <div key={grant.id} className="flex flex-col gap-3 p-4 md:flex-row md:items-center md:justify-between">
              <div className="min-w-0 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-sm font-medium">{grant.domain}</span>
                  {grant.includeSubdomains && <Badge variant="outline" className="rounded-md">{t('security.values.subdomains')}</Badge>}
                </div>
                <GrantBadges grant={grant} />
                <p className="text-xs text-muted-foreground">{t('security.labels.created', { date: formatDate(grant.createdAt) })}</p>
              </div>
              <Button variant="outline" size="sm" className="h-8" onClick={() => void revokeGrant('domain', grant.id)}>
                <Trash2 className="mr-2 h-4 w-4" />
                {t('security.actions.revoke')}
              </Button>
            </div>
          ))}
        </div>
      </section>

      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <FolderLock className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-base font-semibold">{t('security.paths.title')}</h2>
        </div>
        <div className="divide-y rounded-lg border bg-background">
          {sortedPathGrants.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">{t('security.paths.empty')}</p>
          ) : sortedPathGrants.map((grant) => (
            <div key={grant.id} className="flex flex-col gap-3 p-4 md:flex-row md:items-center md:justify-between">
              <div className="min-w-0 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="break-all font-mono text-sm font-medium">{grant.path}</span>
                  <Badge variant="outline" className="rounded-md">{t(`security.values.resourceTypes.${grant.resourceType}`)}</Badge>
                  {grant.recursive && <Badge variant="outline" className="rounded-md">{t('security.values.recursive')}</Badge>}
                </div>
                <GrantBadges grant={grant} />
                <p className="break-all text-xs text-muted-foreground">{t('security.labels.realPath', { path: grant.realPath })}</p>
                <p className="text-xs text-muted-foreground">{t('security.labels.created', { date: formatDate(grant.createdAt) })}</p>
              </div>
              <Button variant="outline" size="sm" className="h-8" onClick={() => void revokeGrant('path', grant.id)}>
                <Trash2 className="mr-2 h-4 w-4" />
                {t('security.actions.revoke')}
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
                <h2 className="text-base font-semibold">{t('security.audit.title')}</h2>
              </div>
              <div className="grid gap-2 sm:grid-cols-[140px_150px_130px_auto] sm:items-end">
                <div className="space-y-1.5">
                  <Label htmlFor="audit-capability">{t('security.audit.capability')}</Label>
                  <AuditSelectField
                    id="audit-capability"
                    value={auditCapability}
                    onChange={(event) => {
                      setAuditPage(1);
                      setAuditCapability(event.target.value as typeof auditCapability);
                    }}
                  >
                    {capabilityOptions.map((option) => (
                      <option key={option} value={option}>{t(`security.audit.capabilities.${option}`)}</option>
                    ))}
                  </AuditSelectField>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="audit-decision">{t('security.audit.decision')}</Label>
                  <AuditSelectField
                    id="audit-decision"
                    value={auditDecision}
                    onChange={(event) => {
                      setAuditPage(1);
                      setAuditDecision(event.target.value as typeof auditDecision);
                    }}
                  >
                    {decisionOptions.map((option) => (
                      <option key={option} value={option}>{t(`security.audit.decisions.${option}`)}</option>
                    ))}
                  </AuditSelectField>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="audit-page-size">{t('security.audit.perPage')}</Label>
                  <AuditSelectField
                    id="audit-page-size"
                    value={auditPageSize}
                    onChange={(event) => {
                      setAuditPage(1);
                      setAuditPageSize(event.target.value);
                    }}
                  >
                    <option value="10">{t('security.audit.items', { count: 10 })}</option>
                    <option value="20">{t('security.audit.items', { count: 20 })}</option>
                    <option value="50">{t('security.audit.items', { count: 50 })}</option>
                  </AuditSelectField>
                </div>
                <Button variant="outline" size="sm" onClick={() => void loadAuditEvents()} disabled={auditLoading}>
                  <RefreshCw className={`mr-2 h-4 w-4${auditLoading ? ' animate-spin' : ''}`} />
                  {t('security.actions.refresh')}
                </Button>
              </div>
            </div>

            <div className="divide-y rounded-lg border bg-background">
              {auditEvents.length === 0 ? (
                <p className="p-4 text-sm text-muted-foreground">{auditLoading ? t('security.audit.loading') : t('security.audit.empty')}</p>
              ) : auditEvents.map((event) => (
                <div key={event.id} className="space-y-2 p-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="outline" className={`rounded-md ${decisionClassName(event.decision)}`}>{t(`security.audit.decisions.${event.decision}`)}</Badge>
                    <Badge variant="outline" className="rounded-md">{t(`security.audit.capabilities.${event.capability}`)}</Badge>
                    {event.operation && <Badge variant="secondary" className="rounded-md">{event.operation}</Badge>}
                    <Badge variant="outline" className={`rounded-md ${riskClassName(event.risk)}`}>{t(`security.audit.risks.${event.risk ?? 'unknown'}`)}</Badge>
                    <span className="ml-auto text-xs text-muted-foreground">{formatDate(event.ts)}</span>
                  </div>
                  <div className="grid gap-1 text-sm md:grid-cols-[96px_1fr]">
                    <span className="text-muted-foreground">{t('security.audit.source')}</span>
                    <span className="break-all font-mono">{event.source}</span>
                    {event.target && (
                      <>
                        <span className="text-muted-foreground">{t('security.audit.target')}</span>
                        <span className="break-all font-mono">{event.target}</span>
                      </>
                    )}
                    {event.code && (
                      <>
                        <span className="text-muted-foreground">{t('security.audit.code')}</span>
                        <span className="break-all font-mono">{event.code}</span>
                      </>
                    )}
                    {event.reasons && event.reasons.length > 0 && (
                      <>
                        <span className="text-muted-foreground">{t('security.audit.reasons')}</span>
                        <span className="break-words">{event.reasons.join(t('security.audit.reasonSeparator'))}</span>
                      </>
                    )}
                  </div>
                </div>
              ))}
            </div>

            <div className="flex flex-col gap-3 border-t pt-3 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-sm text-muted-foreground" aria-live="polite">
                {t('security.audit.range', { start: auditRangeStart, end: auditRangeEnd, total: auditTotal })}
              </p>
              <div className="flex items-center justify-between gap-2 sm:justify-end">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setAuditPage((page) => Math.max(1, page - 1))}
                  disabled={auditLoading || auditPage <= 1}
                >
                  <ChevronLeft className="mr-1 h-4 w-4" />
                  {t('security.audit.previous')}
                </Button>
                <span className="min-w-20 text-center text-sm text-muted-foreground">
                  {t('security.audit.page', { page: auditPage, totalPages: auditTotalPages })}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setAuditPage((page) => Math.min(auditTotalPages, page + 1))}
                  disabled={auditLoading || auditPage >= auditTotalPages}
                >
                  {t('security.audit.next')}
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
