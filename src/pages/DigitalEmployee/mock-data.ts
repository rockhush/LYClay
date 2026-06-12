export interface MyAgent {
  id: string;
  marketEmployeeId: string;
  name: string;
  description: string;
  version: string;
  author: string;
  enabled: boolean;
  isCore?: boolean;
  tags: string[];
}

/** @deprecated Use {@link MyAgent} */
export type MockAgent = MyAgent;

export interface MarketplaceAgent {
  slug: string;
  name: string;
  description: string;
  version: string;
  author: string;
  downloads: number;
  updateTime: string;
  category: string;
  installed: boolean;
  tags: string[];
}

/** @deprecated Use {@link MarketplaceAgent} */
export type MockMarketplaceAgent = MarketplaceAgent;

export const MARKETPLACE_CATEGORY_OPTIONS = [
  { key: '', label: '全部' },
  { key: 'finance', label: '财经' },
  { key: 'rnd', label: '研发' },
  { key: 'hr', label: '人力' },
  { key: 'manufacture', label: '智造' },
  { key: 'procurement', label: '采购' },
  { key: 'business', label: '商务' },
  { key: 'legal', label: '法务' },
  { key: 'office', label: '办公' },
  { key: 'it', label: 'IT' },
  { key: 'logistics', label: '物流' },
  { key: 'other', label: '其他' },
] as const;
