import { getReportingBaseUrl } from './reporting/config';

export interface CompanyAgentListParams {
  query?: string;
  category?: string;
  sort?: string;
}

export interface CompanyAgentRecord {
  id: number;
  name: string;
  icon?: string;
  skill_detail?: string;
  operate_guide?: string;
  version?: string;
  author?: string;
  download_count?: number;
  is_active?: boolean;
  category?: string;
  tags?: string[];
  capabilities?: string[];
  create_time?: string;
  update_time?: string;
}

export interface MarketplaceAgentResult {
  slug: string;
  name: string;
  description: string;
  version: string;
  author: string;
  downloads: number;
  updateTime: string;
  category: string;
  tags: string[];
  installed: boolean;
}

function resolveListOs(): string {
  if (process.platform === 'win32') return 'win';
  if (process.platform === 'darwin') return '';
  return 'linux';
}

export function parseAgentRecords(data: unknown): CompanyAgentRecord[] {
  if (!data || typeof data !== 'object') {
    throw new Error('Invalid response format: expected object');
  }

  const payload = data as Record<string, unknown>;
  if (Array.isArray(payload.data)) {
    return payload.data as CompanyAgentRecord[];
  }
  if (Array.isArray(payload.agents)) {
    return payload.agents as CompanyAgentRecord[];
  }

  throw new Error('Invalid response format: expected object with data array');
}

export function mapCompanyAgentRecord(agent: CompanyAgentRecord): MarketplaceAgentResult {
  return {
    slug: String(agent.id),
    name: agent.name,
    description: agent.skill_detail?.trim() || '',
    version: agent.version?.trim() || '',
    author: agent.author?.trim() || '',
    downloads: typeof agent.download_count === 'number' ? agent.download_count : 0,
    updateTime: agent.create_time?.trim() || agent.update_time?.trim() || '',
    category: agent.category?.trim() || '',
    tags: Array.isArray(agent.tags) ? agent.tags.filter((tag) => typeof tag === 'string') : [],
    installed: false,
  };
}

export type MarketplaceAgentSortField = 'download_count' | 'update_time';

export interface ParsedMarketplaceAgentSort {
  field: MarketplaceAgentSortField;
  desc: boolean;
}

export function parseMarketplaceAgentSort(sort: string): ParsedMarketplaceAgentSort | null {
  const trimmed = sort.trim();
  if (!trimmed) return null;

  const desc = trimmed.startsWith('-');
  const field = (desc ? trimmed.slice(1) : trimmed) as MarketplaceAgentSortField;
  if (field !== 'download_count' && field !== 'update_time') {
    return null;
  }

  return { field, desc };
}

function parseMarketplaceTimestamp(value: string): number {
  const trimmed = value.trim();
  if (!trimmed) return 0;

  const normalized = trimmed.includes('T') ? trimmed : trimmed.replace(' ', 'T');
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function sortMarketplaceAgents(
  agents: MarketplaceAgentResult[],
  sort: string,
): MarketplaceAgentResult[] {
  const parsed = parseMarketplaceAgentSort(sort);
  if (!parsed) return agents;

  const direction = parsed.desc ? -1 : 1;
  return [...agents].sort((left, right) => {
    if (parsed.field === 'download_count') {
      const diff = left.downloads - right.downloads;
      if (diff !== 0) return direction * diff;
      return left.name.localeCompare(right.name, 'zh-CN');
    }

    const diff = parseMarketplaceTimestamp(left.updateTime) - parseMarketplaceTimestamp(right.updateTime);
    if (diff !== 0) return direction * diff;
    return left.name.localeCompare(right.name, 'zh-CN');
  });
}

export async function listCompanyAgents(params: CompanyAgentListParams): Promise<MarketplaceAgentResult[]> {
  const os = resolveListOs();
  const sort = params.sort || '';
  const paramsArray: string[] = [];

  if (params.query?.trim()) {
    paramsArray.push(`query=${encodeURIComponent(params.query.trim())}`);
  }
  if (params.category?.trim()) {
    paramsArray.push(`category=${encodeURIComponent(params.category.trim())}`);
  }
  if (sort) {
    paramsArray.push(`sort=${encodeURIComponent(sort)}`);
  }
  paramsArray.push(`os=${os}`);

  const url = `${getReportingBaseUrl()}/management/agents/list/?${paramsArray.join('&')}`;
  console.log('[CompanyAgentMarketplace] Calling API:', url);

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(`Company agents API error: ${response.status}`);
  }

  const data = await response.json();
  let results = parseAgentRecords(data).map(mapCompanyAgentRecord);

  if (params.category?.trim()) {
    const category = params.category.trim().toLowerCase();
    results = results.filter((agent) => agent.category.toLowerCase() === category);
  }

  if (params.query?.trim()) {
    const query = params.query.trim().toLowerCase();
    results = results.filter((agent) =>
      agent.name.toLowerCase().includes(query)
      || agent.description.toLowerCase().includes(query)
      || agent.author.toLowerCase().includes(query),
    );
  }

  return sortMarketplaceAgents(results, sort);
}
