export interface MockAgent {
  id: string;
  name: string;
  description: string;
  version: string;
  author: string;
  enabled: boolean;
  isCore?: boolean;
  tags: string[];
}

export interface MockMarketplaceAgent {
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

export const MOCK_MY_AGENTS: MockAgent[] = [
  {
    id: 'office-assistant',
    name: '办公助手（日程、钉盘、表格、消息）',
    description: '集成钉钉日程、钉盘、表格与消息能力，帮助处理日常办公事务、会议安排与文档协作。',
    version: '1.0.0',
    author: '袁益千',
    enabled: true,
    tags: ['办公协同', '日程管理', '钉钉集成'],
  },
  {
    id: 'meeting-minutes',
    name: '会议纪要生成',
    description: '根据会议录音或文字记录自动生成结构化纪要，提取待办事项与关键决策点。',
    version: '1.2.1',
    author: '产品团队',
    enabled: true,
    tags: ['会议纪要', '待办提取'],
  },
  {
    id: 'data-analysis',
    name: '数据分析助手',
    description: '支持 Excel/CSV 数据清洗、统计分析与可视化建议，快速生成业务洞察报告。',
    version: '2.0.3',
    author: '数据平台',
    enabled: false,
    tags: ['数据分析', '可视化建议', 'Excel处理'],
  },
  {
    id: 'code-review',
    name: '代码审查助手',
    description: '对提交的代码进行质量审查，识别潜在 bug、安全漏洞与风格问题，并给出改进建议。',
    version: '1.1.0',
    author: '研发效能',
    enabled: true,
    tags: ['代码审查', '安全检测'],
  },
  {
    id: 'customer-service',
    name: '客服智能回复',
    description: '基于知识库自动回复客户咨询，支持多轮对话与工单创建，提升客服响应效率。',
    version: '3.0.0',
    author: '客服中心',
    enabled: true,
    isCore: true,
    tags: ['智能客服', '知识库问答', '工单创建'],
  },
  {
    id: 'doc-writer',
    name: '文档撰写助手',
    description: '协助撰写技术文档、产品说明、操作手册等各类文档，支持多种模板与格式输出。',
    version: '1.0.5',
    author: '知识管理',
    enabled: false,
    tags: ['文档撰写', '技术文档'],
  },
];

export const MOCK_MARKETPLACE_AGENTS: MockMarketplaceAgent[] = [
  {
    slug: 'finance-report',
    name: '财务报表分析',
    description: '自动解析财务报表，生成同比环比分析、异常预警与管理层摘要。',
    version: '1.3.0',
    author: '财经团队',
    downloads: 1280,
    updateTime: '2026-05-20T08:00:00Z',
    category: 'finance',
    installed: true,
    tags: ['财务报表', '异常预警', '管理层摘要'],
  },
  {
    slug: 'hr-onboarding',
    name: 'HR 入职引导',
    description: '为新员工提供入职流程指引、政策问答与培训计划推荐。',
    version: '2.1.0',
    author: '人力共享',
    downloads: 856,
    updateTime: '2026-05-15T10:30:00Z',
    category: 'hr',
    installed: true,
    tags: ['入职引导', '政策问答'],
  },
  {
    slug: 'procurement-bid',
    name: '采购招标助手',
    description: '辅助编写招标文件、评估供应商资质与对比报价方案。',
    version: '1.0.2',
    author: '采购部',
    downloads: 432,
    updateTime: '2026-04-28T14:00:00Z',
    category: 'procurement',
    installed: false,
    tags: ['招标采购', '供应商评估'],
  },
  {
    slug: 'legal-contract',
    name: '合同审查助手',
    description: '识别合同条款风险点，对比标准模板并标注需关注的法律条款。',
    version: '1.5.0',
    author: '法务部',
    downloads: 967,
    updateTime: '2026-05-18T09:00:00Z',
    category: 'legal',
    installed: true,
    tags: ['合同审查', '风险识别', '条款对比'],
  },
  {
    slug: 'logistics-track',
    name: '物流追踪助手',
    description: '汇总多承运商物流状态，自动推送异常延误预警与签收提醒。',
    version: '1.2.0',
    author: '物流运营',
    downloads: 623,
    updateTime: '2026-05-10T16:00:00Z',
    category: 'logistics',
    installed: false,
    tags: ['物流追踪', '延误预警'],
  },
  {
    slug: 'it-helpdesk',
    name: 'IT 运维助手',
    description: '处理常见 IT 故障排查、账号权限申请与设备报修工单创建。',
    version: '2.0.1',
    author: 'IT 服务台',
    downloads: 1540,
    updateTime: '2026-06-01T11:00:00Z',
    category: 'it',
    installed: false,
    tags: ['IT运维', '故障排查', '设备报修'],
  },
  {
    slug: 'manufacture-qc',
    name: '智造质检助手',
    description: '分析产线质检数据，识别不良品趋势并生成改善建议报告。',
    version: '1.1.3',
    author: '智造中心',
    downloads: 389,
    updateTime: '2026-05-22T08:30:00Z',
    category: 'manufacture',
    installed: true,
    tags: ['质检分析', '产线改善'],
  },
  {
    slug: 'business-crm',
    name: '商务客户跟进',
    description: '跟踪客户拜访记录、商机阶段与跟进提醒，辅助销售团队管理 pipeline。',
    version: '1.4.0',
    author: '商务拓展',
    downloads: 712,
    updateTime: '2026-05-25T13:00:00Z',
    category: 'business',
    installed: false,
    tags: ['客户跟进', '商机管理'],
  },
  {
    slug: 'rnd-spec',
    name: '研发需求分析',
    description: '将业务需求转化为技术规格说明，评估工作量并识别依赖关系。',
    version: '1.0.8',
    author: '研发管理',
    downloads: 548,
    updateTime: '2026-05-08T10:00:00Z',
    category: 'rnd',
    installed: false,
    tags: ['需求分析', '技术规格'],
  },
  {
    slug: 'office-translate',
    name: '多语言翻译助手',
    description: '支持中英日等多语言文档翻译，保持专业术语一致性。',
    version: '2.2.0',
    author: '办公效率',
    downloads: 2103,
    updateTime: '2026-06-03T09:00:00Z',
    category: 'office',
    installed: false,
    tags: ['多语言翻译', '术语一致性', '文档处理'],
  },
];

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
