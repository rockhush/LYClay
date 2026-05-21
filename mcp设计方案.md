# LYClaw MCP 连接器技术方案设计

## 1. 概述

参考 WorkBuddy 的连接器管理功能，为 LYClaw 设计并实现 MCP（Model Context Protocol）连接器管理模块。该模块允许用户通过图形界面配置、启用/禁用外部 MCP 服务；**连接器列表页采用「内置 / 自定义」双 Tab**，其中内置区仅保留 Notion 与 GitHub 两个官方引导入口，其余能力由用户在自定义区自行接入。

### 1.1 目标

- 提供类似 WorkBuddy 的连接器管理 UI；**列表区采用「内置 / 自定义」双 Tab**，与 WorkBuddy 连接器页信息架构对齐（参考用户提供的界面稿）
- **内置 Tab**：仅展示产品预置的两个入口——**Notion** 与 **GitHub**（不再内置 QQ 邮箱、腾讯会议、腾讯问卷、腾讯文档等第三方办公套件连接器）
- **自定义 Tab**：展示用户在 `mcp.json` 中自行配置、且不属于上述内置目录的 MCP 服务（卡片或列表形式，与「自定义连接器」入口联动）
- 支持 MCP 服务配置（streamable-http / stdio 类型）
- 支持 MCP 服务的启用/禁用切换
- 支持 MCP 配置文件的 JSON 编辑器
- 与 OpenClaw Gateway 的 MCP 能力对接

### 1.2 参考 WorkBuddy 功能

| 功能 | WorkBuddy 实现 | LYClaw 对应方案 |
|------|---------------|----------------|
| 连接器列表页 | 卡片网格展示各连接器 | 新建 Connectors 页面；**副标题下方为「内置 \| 自定义」Tab**，内置区仅 Notion + GitHub |
| 自定义连接器 | 右上角按钮 | 相同位置；用于在 **自定义 Tab** 中增加/编辑 MCP 条目 |
| MCP 服务管理 | 列表 + 搜索 + 开关 | 相同模式 |
| MCP 配置编辑 | JSON 编辑器 + 保存 | Monaco Editor + 保存 |

---

## 2. 架构设计

### 2.1 整体架构图

```
┌─────────────────────────────────────────────────────────────────┐
│                        LYClaw Electron App                       │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │                     Renderer (React)                       │  │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐ │  │
│  │  │ Connectors   │  │ MCP Services │  │ MCP Config       │ │  │
│  │  │ Page         │  │ Page         │  │ Editor Page      │ │  │
│  │  └──────┬───────┘  └──────┬───────┘  └────────┬─────────┘ │  │
│  │         │                 │                    │            │  │
│  │  ┌──────▼─────────────────▼────────────────────▼─────────┐ │  │
│  │  │              useConnectorsStore (Zustand)              │ │  │
│  │  │  - connectors list                                     │ │  │
│  │  │  - mcpServers list                                     │ │  │
│  │  │  - mcpConfig (JSON)                                    │ │  │
│  │  │  - actions: fetch, enable, disable, save, install      │ │  │
│  │  └──────────────────────────┬────────────────────────────┘ │  │
│  │                             │ hostApiFetch()               │  │
│  │  ┌──────────────────────────▼────────────────────────────┐ │  │
│  │  │              Host API Proxy (IPC)                      │ │  │
│  │  │  hostapi:fetch → http://127.0.0.1:13210/api/...       │ │  │
│  │  ──────────────────────────┬────────────────────────────┘ │  │
│  └─────────────────────────────┼──────────────────────────────┘  │
│                                │                                  │
│  ┌─────────────────────────────▼──────────────────────────────┐  │
│  │                    Host API Server                          │  │
│  │  ──────────────────┐  ┌────────────────────────────────┐  │  │
│  │  │ /api/connectors  │  │ /api/mcp                       │  │  │
│  │  │  - GET list      │  │  - GET servers                 │  │  │
│  │  │  - GET detail    │  │  - PUT server (enable/disable) │  │  │
│  │  │  - POST install  │  │  - GET config                  │  │  │
│  │  │                  │  │  - PUT config (save JSON)      │  │  │
│  │  │                  │  │  - POST validate               │  │  │
│  │  └──────────────────┘  └────────────────────────────────┘  │  │
│  ─────────────────────────────┬──────────────────────────────┘  │
│                                │                                  │
│  ┌─────────────────────────────▼──────────────────────────────┐  │
│  │                   OpenClaw Gateway                          │  │
│  │  ──────────────────────────────────────────────────────┐  │  │
│  │  │  MCP Server Registry                                  │  │  │
│  │  │  - mcp.json config file                               │  │  │
│  │  │  - streamable-http / stdio transport                  │  │  │
│  │  │  - tool discovery & execution                         │  │  │
│  │  └──────────────────────────────────────────────────────┘  │  │
│  └─────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

### 2.2 数据流

```
用户操作 → React Component → Zustand Store → hostApiFetch()
                                              ↓
                                    IPC (hostapi:fetch)
                                              ↓
                                    Host API Server (:13210)
                                              ↓
                                    OpenClaw Gateway (:18789)
                                              ↓
                                    mcp.json 配置文件读写
                                              ↓
                                    MCP 服务启动/停止
```

---

## 3. 详细设计

### 3.1 文件结构

```
src/
├── pages/
│   ├── Connectors/
│   │   ├── index.tsx              # 连接器列表主页面（内置 / 自定义 Tab）
│   │   ├── ConnectorTabs.tsx      # Tab 切换（内置 \| 自定义）
│   │   ├── ConnectorCard.tsx      # 连接器卡片组件
│   │   └── InstallDialog.tsx      # 安装/自定义连接器弹窗
│   └── Settings/
│       └── McpSettings.tsx        # MCP 服务管理（Settings 子页面）
├── stores/
│   └── connectors.ts              # 连接器状态管理 (Zustand)
├── types/
│   └── connector.ts               # 连接器类型定义
├── components/
│   └── settings/
│       └── McpServiceCard.tsx     # MCP 服务卡片组件
└── i18n/
    └── locales/
        ├── zh/
        │   └── connectors.json        # 中文翻译
        ├── en/
        │   └── connectors.json        # 英文翻译
        └── ja/
            └── connectors.json        # 日文翻译
```

### 3.2 类型定义

```typescript
// src/types/connector.ts

/** 内置目录种类（LYClaw 产品层仅开放以下两个内置卡片，其余由用户自行在「自定义」中配置） */
export type BuiltInConnectorId = 'notion' | 'github';

/** 连接器类型（用于 UI 图标、文案与路由） */
export type ConnectorType =
  | 'notion'        // Notion（内置 Tab）
  | 'code'          // GitHub（内置 Tab）
  | 'mcp'           // 自定义 Tab：来自 mcp.json 的用户 MCP
  | 'custom';       // 其他/兜底

/** 连接器状态 */
export type ConnectorStatus = 'available' | 'installed' | 'enabled' | 'disabled' | 'error';

/** 连接器配置 */
export interface ConnectorConfig {
  id: string;
  type: ConnectorType;
  name: string;
  description: string;
  icon: string;          // emoji 或 icon 名称
  status: ConnectorStatus;
  enabled: boolean;
  version?: string;
  author?: string;
  config?: Record<string, unknown>;
  /** 是否需要额外配置（如 API Key） */
  requiresConfig: boolean;
  /** 安装来源：`bundled` 仅指内置 Tab 中的 Notion / GitHub 目录项；其余为 `custom` */
  source?: 'bundled' | 'custom';
}

/** MCP 服务配置 */
export interface McpServerConfig {
  name: string;
  type: 'streamable-http' | 'stdio' | 'sse';
  url?: string;          // streamable-http / sse 类型使用
  command?: string;      // stdio 类型使用
  args?: string[];       // stdio 类型使用
  env?: Record<string, string>;
  disabled: boolean;
  headers?: Record<string, string>;
}

/** MCP 配置文件结构 */
export interface McpConfigFile {
  mcpServers: Record<string, McpServerConfig>;
}

/** MCP 服务运行时状态 */
export interface McpServerStatus {
  name: string;
  enabled: boolean;
  connected: boolean;
  toolCount: number;
  totalTools: number;
  lastError?: string;
  lastConnectedAt?: number;
}
```

### 3.3 Zustand Store 设计

```typescript
// src/stores/connectors.ts

import { create } from 'zustand';
import { hostApiFetch } from '@/lib/host-api';
import type { ConnectorConfig, McpServerConfig, McpServerStatus, McpConfigFile } from '@/types/connector';

type ConnectorPageTab = 'builtIn' | 'custom';

interface ConnectorsState {
  /** 连接器页当前 Tab：内置 = 静态 Notion/GitHub 目录；自定义 = 用户 mcp.json 中的非内置条目 */
  connectorPageTab: ConnectorPageTab;
  setConnectorPageTab: (tab: ConnectorPageTab) => void;

  // 连接器列表（自定义 Tab 可与 GET /api/mcp/servers 或合并后的列表对齐，由实现选型）
  connectors: ConnectorConfig[];
  connectorsLoading: boolean;
  connectorsError: string | null;

  // MCP 服务列表
  mcpServers: McpServerStatus[];
  mcpServersLoading: boolean;
  mcpServersError: string | null;

  // MCP 配置文件
  mcpConfig: McpConfigFile | null;
  mcpConfigPath: string;
  mcpConfigLoading: boolean;

  // Actions
  fetchConnectors: () => Promise<void>;
  installConnector: (connectorId: string, config?: Record<string, unknown>) => Promise<void>;
  uninstallConnector: (connectorId: string) => Promise<void>;
  enableConnector: (connectorId: string) => Promise<void>;
  disableConnector: (connectorId: string) => Promise<void>;

  fetchMcpServers: () => Promise<void>;
  enableMcpServer: (name: string) => Promise<void>;
  disableMcpServer: (name: string) => Promise<void>;

  fetchMcpConfig: () => Promise<void>;
  saveMcpConfig: (config: McpConfigFile) => Promise<void>;
  validateMcpConfig: (config: McpConfigFile) => Promise<{ valid: boolean; errors: string[] }>;
}

export const useConnectorsStore = create<ConnectorsState>((set, get) => ({
  connectorPageTab: 'builtIn',
  setConnectorPageTab: (tab) => set({ connectorPageTab: tab }),

  connectors: [],
  connectorsLoading: false,
  connectorsError: null,
  mcpServers: [],
  mcpServersLoading: false,
  mcpServersError: null,
  mcpConfig: null,
  mcpConfigPath: '',
  mcpConfigLoading: false,

  fetchConnectors: async () => {
    set({ connectorsLoading: true, connectorsError: null });
    try {
      const data = await hostApiFetch<ConnectorConfig[]>('/api/connectors');
      set({ connectors: data, connectorsLoading: false });
    } catch (error) {
      set({ connectorsError: String(error), connectorsLoading: false });
    }
  },

  installConnector: async (connectorId, config) => {
    await hostApiFetch('/api/connectors/install', {
      method: 'POST',
      body: JSON.stringify({ id: connectorId, config }),
    });
    await get().fetchConnectors();
  },

  uninstallConnector: async (connectorId) => {
    await hostApiFetch(`/api/connectors/${connectorId}`, { method: 'DELETE' });
    await get().fetchConnectors();
  },

  enableConnector: async (connectorId) => {
    await hostApiFetch(`/api/connectors/${connectorId}/enable`, { method: 'POST' });
    await get().fetchConnectors();
  },

  disableConnector: async (connectorId) => {
    await hostApiFetch(`/api/connectors/${connectorId}/disable`, { method: 'POST' });
    await get().fetchConnectors();
  },

  fetchMcpServers: async () => {
    set({ mcpServersLoading: true, mcpServersError: null });
    try {
      const data = await hostApiFetch<McpServerStatus[]>('/api/mcp/servers');
      set({ mcpServers: data, mcpServersLoading: false });
    } catch (error) {
      set({ mcpServersError: String(error), mcpServersLoading: false });
    }
  },

  enableMcpServer: async (name) => {
    await hostApiFetch(`/api/mcp/servers/${encodeURIComponent(name)}/enable`, { method: 'POST' });
    await get().fetchMcpServers();
  },

  disableMcpServer: async (name) => {
    await hostApiFetch(`/api/mcp/servers/${encodeURIComponent(name)}/disable`, { method: 'POST' });
    await get().fetchMcpServers();
  },

  fetchMcpConfig: async () => {
    set({ mcpConfigLoading: true });
    try {
      const data = await hostApiFetch<{ config: McpConfigFile; path: string }>('/api/mcp/config');
      set({ mcpConfig: data.config, mcpConfigPath: data.path, mcpConfigLoading: false });
    } catch (error) {
      set({ mcpConfigLoading: false });
    }
  },

  saveMcpConfig: async (config) => {
    await hostApiFetch('/api/mcp/config', {
      method: 'PUT',
      body: JSON.stringify({ config }),
    });
    await get().fetchMcpConfig();
    await get().fetchMcpServers();
  },

  validateMcpConfig: async (config) => {
    return hostApiFetch<{ valid: boolean; errors: string[] }>('/api/mcp/config/validate', {
      method: 'POST',
      body: JSON.stringify({ config }),
    });
  },
}));
```

### 3.4 连接器列表页面设计

#### 3.4.1 信息架构（与 WorkBuddy 稿对齐）

- **页面标题区**：标题「连接器管理」、副标题「连接外部服务，扩展 AI 能力」、右上角「自定义连接器」按钮（全局可用；在自定义 Tab 中语义上更突出）。
- **副标题下方**：**一级 Tab**——**「内置」**与**「自定义」**（对应图中红线标注区域）。
- **内置 Tab**：
  - 内容区为**卡片网格**，**固定且仅包含两个内置目录项**：**Notion**、**GitHub**。
  - 不提供 QQ 邮箱、腾讯会议、腾讯问卷、腾讯文档、TAPD、微云等 WorkBuddy 式预置连接器；若后续要扩展内置目录，需单独开产品需求与合规评估。
  - 卡片交互与下文「卡片规则」一致（安装、已安装进详情、启用态圆点等）。
- **自定义 Tab**：
  - 展示用户在 **`mcp.json`（及 Gateway 实际加载的 MCP 注册表）**中配置的、**不属于内置 Notion/GitHub 引导模板**的 MCP 服务列表（卡片或紧凑列表均可，建议与内置区视觉一致以降低认知成本）。
  - 空态：提示用户点击「自定义连接器」或通过 Settings 中的 MCP 配置编辑器添加。
  - 「自定义连接器」按钮优先打开**新增/编辑 MCP 条目**的流程（写入 `mcp.json` 并触发热更新）；与内置 Tab 中点击「安装」触发的**向导式补全**（如填入 GitHub Token）可共用底层 install API，但 UI 文案区分「添加内置连接器」与「添加自定义 MCP」。

#### 3.4.2 线框图（内置 Tab）

```
┌─────────────────────────────────────────────────────────────────────┐
│  连接器管理                                         [自定义连接器]   │
│  连接外部服务，扩展 AI 能力                                          │
│                                                                     │
│   [ 内置 ● ]    [ 自定义 ]        ← Tab：内置 / 自定义               │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│   ┌────────────────────────────┐    ┌────────────────────────────┐  │
│   │  Notion                    │    │  GitHub                    │  │
│   │  页面、数据库与协作内容…    │    │  在 GitHub 上克隆、推送     │  │
│   │  …                         │    │  代码、Issue…              │  │
│   │                      [+]   │    │                      [+]   │  │
│   └────────────────────────────┘    └────────────────────────────┘  │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

#### 3.4.3 线框图（自定义 Tab）

```
┌─────────────────────────────────────────────────────────────────────┐
│  连接器管理                                         [自定义连接器]   │
│  连接外部服务，扩展 AI 能力                                          │
│                                                                     │
│   [ 内置 ]    [ 自定义 ● ]                                          │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│   ┌────────────────────────────┐    ┌────────────────────────────┐  │
│   │  我的 Postgres MCP         │    │  内部 Wiki MCP             │  │
│   │  streamable-http …         │    │  stdio …                   │  │
│   │                      [>]   │    │                      [>]   │  │
│   └────────────────────────────┘    └────────────────────────────┘  │
│                                                                     │
│   （无用户 MCP 时展示空态插画 + 引导复制「自定义连接器」）            │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

**交互说明（卡片规则，两 Tab 共用）：**
- 每个卡片显示连接器图标、名称、描述。
- `+` 按钮：安装/添加（内置 Tab 为向导安装；自定义 Tab 可与「新增」同义或隐藏已由自定义连接器创建的条目）。
- `>` 按钮：已安装或已存在配置，点击进入详情/配置页。
- `●` 绿色圆点：已启用状态（与 Gateway 连接状态同步时展示）。
- 右上角「自定义连接器」按钮：打开自定义 MCP 配置或新增弹窗；**不切换 Tab 也可使用**，建议在完成添加后若当前为内置 Tab，可 toast 提示用户到「自定义」查看。

### 3.5 MCP 服务管理页面设计

```
┌─────────────────────────────────────────────────────────────────────┐
│  MCP 服务管理                              [ 配置 MCP]  []        │
│  安装 MCP 服务，为 AI 扩展更多工具能力                               │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │   搜索服务器...                                             │   │
│  └─────────────────────────────────────────────────────────────   │
│                                                                     │
│  我的 MCP  1                                    1 启用              │
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │  >  [钉] 钉钉 AI 表格  ●                                     │   │
│  │     {used}/{total} 个工具已启用                 [开关: ON]   │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │  >  [GitHub] GitHub MCP  ●                                   │   │
│  │     {used}/{total} 个工具已启用                 [开关: ON]   │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │  >  [FS] 文件系统 MCP                                        │   │
│  │     未启用                                      [开关: OFF]  │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

**说明（工具数量）：** 卡片上的「`{used}/{total}` 个工具已启用」来自 **Gateway 对当前 MCP 服务的运行时上报**，随用户实际配置的服务而变化，**不是**写死的「47」或「12」。历史线框中出现的「47/47」仅反映某一类集成（例如 **钉钉 AI 表格**）在该环境下暴露的工具总数较多；其他 MCP 可能只有个位数或零。若 Host/Gateway 未返回工具统计，该行可省略或展示「工具数量未知」。

### 3.6 MCP 配置编辑页面设计

```
┌─────────────────────────────────────────────────────────────────────┐
│  < 返回 MCP 列表                                    [取消]  [保存]   │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  配置文件路径: C:\Users\user\.lyclaw\mcp.json                       │
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │  1  {                                                        │   │
│  │  2    "mcpServers": {                                        │   │
│  │  3      "钉钉 AI 表格": {                                    │   │
│  │  4        "type": "streamable-http",                         │   │
│  │  5        "url": "https://mcp-gw.dingtalk.com/server/...",   │   │
│  │  6        "disabled": false                                  │   │
│  │  7      }                                                    │   │
│  │  8    }                                                      │   │
│  │  9  }                                                        │   │
│  ─────────────────────────────────────────────────────────────┘   │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 4. 流程图

### 4.1 连接器安装流程

```
┌──────────────┐
│ 用户点击 +   │
│ 安装连接器   │
└──────┬───────┘
       │
       ▼
┌──────────────┐     ┌──────────────┐
│ 检查是否已   │────▶│ 显示安装确认 │
│ 安装         │ 否  │ 弹窗         │
└──────┬───────┘     └──────┬───────┘
       │ 是                 │ 确认
       ▼                    ▼
┌──────────────┐     ┌──────────────┐
│ 显示详情/    │     │ 调用         │
│ 配置入口     │     │ installAPI   │
└──────────────┘     └──────┬───────┘
                            │
                            ▼
                     ┌──────────────┐
                     │ Host API     │
                     │ 下载并安装   │
                     │ 连接器包     │
                     └──────┬───────┘
                            │
                            ▼
                     ┌──────────────┐
                     │ 写入         │
                     │ mcp.json     │
                     └──────┬───────┘
                            │
                            ▼
                     ┌──────────────┐
                     │ 通知 Gateway │
                     │ 重新加载     │
                     │ MCP 配置     │
                     ──────┬───────┘
                            │
                            ▼
                     ┌──────────────
                     │ 刷新 UI      │
                     │ 显示已安装   │
                     └──────────────┘
```

### 4.2 MCP 服务启用/禁用流程

```
┌──────────────┐
│ 用户切换     │
│ 开关状态     │
──────┬───────┘
       │
       ▼
┌──────────────┐
│ 调用         │
│ enable/      │
│ disable API  │
└──────┬───────┘
       │
       ▼
┌──────────────┐
│ 更新         │
│ mcp.json     │
│ disabled 字段│
└──────┬───────┘
       │
       ▼
┌──────────────┐     ┌──────────────┐
│ 通知 Gateway │────▶│ Gateway      │
│ 重新加载配置 │     │ 启动/停止    │
│              │     │ MCP 进程     │
──────────────┘     └──────┬───────┘
                            │
                            ▼
                     ┌──────────────┐
                     │ 返回服务     │
                     │ 状态         │
                     └─────────────┘
                            │
                            ▼
                     ┌──────────────┐
                     │ 更新 UI      │
                     │ 开关状态     │
                     │ 工具数量     │
                     └──────────────┘
```

### 4.3 MCP 配置编辑流程

```
┌──────────────┐
│ 用户点击     │
│ 配置 MCP     │
└──────┬───────┘
       │
       ▼
──────────────┐
│ 读取         │
│ mcp.json     │
│ 文件内容     │
└──────┬───────┘
       │
       ▼
┌──────────────┐
│ 在 Monaco    │
│ Editor 中    │
│ 显示 JSON    │
└──────┬───────┘
       │
       ▼
┌──────────────┐
│ 用户编辑     │
│ JSON 内容    │
└─────────────┘
       │
       ▼
┌──────────────┐     ┌──────────────┐
│ 用户点击保存 │────▶│ 前端 JSON    │
│              │     │ 语法校验     │
└──────────────┘     └──────┬───────┘
                            │ 通过
                            ▼
                     ┌──────────────┐
                     │ 调用后端     │
                     │ 校验 API     │
                     └──────┬───────┘
                            │
                     ┌──────┴───────┐
                     │              │
                     ▼ 失败         ▼ 通过
              ┌──────────────┐ ┌──────────────┐
              │ 显示错误     │ │ 写入         │
              │ 信息         │ │ mcp.json     │
              └──────────────┘ └──────┬───────┘
                                      │
                                      ▼
                               ┌──────────────┐
                               │ 通知 Gateway │
                               │ 重新加载     │
                               └──────┬───────┘
                                      │
                                      ▼
                               ┌──────────────┐
                               │ 刷新服务列表 │
                               │ 返回 MCP     │
                               │ 列表页       │
                               └──────────────┘
```

---

## 5. API 接口设计

### 5.1 连接器 API

| 方法 | 路径 | 说明 | 请求体 | 响应 |
|------|------|------|--------|------|
| GET | `/api/connectors` | 获取**自定义**连接器/目录元数据（可选；见下说明） | - | `ConnectorConfig[]` |
| GET | `/api/connectors/:id` | 获取连接器详情 | - | `ConnectorConfig` |
| POST | `/api/connectors/install` | 安装连接器 | `{ id, config }` | `{ success }` |
| DELETE | `/api/connectors/:id` | 卸载连接器 | - | `{ success }` |
| POST | `/api/connectors/:id/enable` | 启用连接器 | - | `{ success }` |
| POST | `/api/connectors/:id/disable` | 禁用连接器 | - | `{ success }` |

**与「内置 / 自定义」Tab 的对应关系（实现约定）：**

- **内置 Tab**：Notion、GitHub 两条目录为**产品内置常量**（图标、描述、安装向导 ID），与 `GET /api/connectors` 解耦；卡片上的已安装/启用态通过 **`GET /api/mcp/servers`**（或本地 `mcp.json` 解析结果）与内置 `id` / 约定 `mcpServers` 键名对齐后合并展示。
- **自定义 Tab**：数据来自 **`mcp.json` 中的 `mcpServers`**，在 UI 层过滤掉与内置向导写入的条目重复项（或展示全部用户条目并将内置两项在自定义 Tab 中隐藏），与右上角「自定义连接器」及 `PUT /api/mcp/config` 编辑链路一致。
- `GET /api/connectors` 可保留为「市场/扩展目录」预留接口；LYClaw 首版若不做远端目录，可返回空数组或由 Host 合并 Gateway 侧非模板 MCP 元数据。

### 5.2 MCP 服务 API

| 方法 | 路径 | 说明 | 请求体 | 响应 |
|------|------|------|--------|------|
| GET | `/api/mcp/servers` | 获取 MCP 服务列表 | - | `McpServerStatus[]` |
| POST | `/api/mcp/servers/:name/enable` | 启用 MCP 服务 | - | `{ success }` |
| POST | `/api/mcp/servers/:name/disable` | 禁用 MCP 服务 | - | `{ success }` |
| GET | `/api/mcp/config` | 获取 MCP 配置 | - | `{ config, path }` |
| PUT | `/api/mcp/config` | 保存 MCP 配置 | `{ config }` | `{ success }` |
| POST | `/api/mcp/config/validate` | 校验 MCP 配置 | `{ config }` | `{ valid, errors }` |

### 5.3 Host API 实现位置

```
electron/api/
├── routes/
│   ├── connectors.ts      # 连接器相关路由
│   └── mcp.ts             # MCP 服务相关路由
```

### 5.4 Host API 路由实现概要

```typescript
// electron/api/routes/connectors.ts

import { Router } from 'express';
import { getOpenClawConfigDir } from '../../utils/config';
import { readJsonFile, writeJsonFile } from '../../utils/fs';
import { restartGatewayMcp } from '../../gateway/mcp-manager';

const router = Router();

// GET /api/connectors - 获取可用连接器列表
router.get('/', async (req, res) => {
  const connectorsDir = getConnectorsRegistryPath();
  const registry = await readJsonFile(connectorsDir);
  const installed = await getInstalledConnectors();
  const result = mergeRegistryWithInstalled(registry, installed);
  res.json(result);
});

// POST /api/connectors/install - 安装连接器
router.post('/install', async (req, res) => {
  const { id, config } = req.body;
  const connector = await fetchConnectorFromRegistry(id);
  await installConnectorPackage(connector, config);
  await updateMcpConfigForConnector(id, config);
  await restartGatewayMcp();
  res.json({ success: true });
});

// DELETE /api/connectors/:id - 卸载连接器
router.delete('/:id', async (req, res) => {
  const { id } = req.params;
  await uninstallConnectorPackage(id);
  await removeMcpConfigForConnector(id);
  await restartGatewayMcp();
  res.json({ success: true });
});

// POST /api/connectors/:id/enable - 启用连接器
router.post('/:id/enable', async (req, res) => {
  const { id } = req.params;
  await setConnectorEnabled(id, true);
  await restartGatewayMcp();
  res.json({ success: true });
});

// POST /api/connectors/:id/disable - 禁用连接器
router.post('/:id/disable', async (req, res) => {
  const { id } = req.params;
  await setConnectorEnabled(id, false);
  await restartGatewayMcp();
  res.json({ success: true });
});

export default router;
```

```typescript
// electron/api/routes/mcp.ts

import { Router } from 'express';
import { getOpenClawConfigDir } from '../../utils/config';
import { readJsonFile, writeJsonFile } from '../../utils/fs';
import { restartGatewayMcp } from '../../gateway/mcp-manager';
import { validateMcpConfig } from '../../utils/mcp-validator';

const router = Router();
const MCP_CONFIG_PATH = `${getOpenClawConfigDir()}/mcp.json`;

// GET /api/mcp/servers - 获取 MCP 服务列表
router.get('/servers', async (req, res) => {
  const config = await readJsonFile(MCP_CONFIG_PATH);
  const servers = Object.entries(config.mcpServers || {}).map(([name, server]) => ({
    name,
    enabled: !server.disabled,
    type: server.type,
    url: server.url,
  }));
  // 获取运行时状态
  const runtimeStatus = await getMcpRuntimeStatus();
  const result = servers.map(s => ({
    ...s,
    ...runtimeStatus[s.name],
  }));
  res.json(result);
});

// POST /api/mcp/servers/:name/enable - 启用
router.post('/servers/:name/enable', async (req, res) => {
  const { name } = req.params;
  const config = await readJsonFile(MCP_CONFIG_PATH);
  if (config.mcpServers[name]) {
    config.mcpServers[name].disabled = false;
    await writeJsonFile(MCP_CONFIG_PATH, config);
    await restartGatewayMcp();
  }
  res.json({ success: true });
});

// POST /api/mcp/servers/:name/disable - 禁用
router.post('/servers/:name/disable', async (req, res) => {
  const { name } = req.params;
  const config = await readJsonFile(MCP_CONFIG_PATH);
  if (config.mcpServers[name]) {
    config.mcpServers[name].disabled = true;
    await writeJsonFile(MCP_CONFIG_PATH, config);
    await restartGatewayMcp();
  }
  res.json({ success: true });
});

// GET /api/mcp/config - 获取配置
router.get('/config', async (req, res) => {
  const config = await readJsonFile(MCP_CONFIG_PATH);
  res.json({ config, path: MCP_CONFIG_PATH });
});

// PUT /api/mcp/config - 保存配置
router.put('/config', async (req, res) => {
  const { config } = req.body;
  const validation = validateMcpConfig(config);
  if (!validation.valid) {
    return res.status(400).json({ success: false, errors: validation.errors });
  }
  await writeJsonFile(MCP_CONFIG_PATH, config);
  await restartGatewayMcp();
  res.json({ success: true });
});

// POST /api/mcp/config/validate - 校验配置
router.post('/config/validate', async (req, res) => {
  const { config } = req.body;
  const result = validateMcpConfig(config);
  res.json(result);
});

export default router;
```

---

## 6. 与 OpenClaw Gateway 集成

### 6.1 MCP 配置文件位置

```
~/.openclaw/mcp.json        # OpenClaw 标准配置路径
或
~/.lyclaw/mcp.json          # LYClaw 自定义路径
```

### 6.2 mcp.json 格式

```json
{
  "mcpServers": {
    "钉钉 AI 表格": {
      "type": "streamable-http",
      "url": "https://mcp-gw.dingtalk.com/server/...",
      "disabled": false
    },
    "GitHub MCP": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_..."
      },
      "disabled": false
    },
    "文件系统": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/allowed"],
      "disabled": true
    }
  }
}
```

### 6.3 Gateway 重新加载机制

```
┌──────────────┐
│ mcp.json     │
│ 文件变更     │
└──────┬───────┘
       │
       ▼
┌──────────────┐
│ Gateway 检测 │
│ 配置变更     │
│ (文件监听)   │
└──────┬───────┘
       │
       ▼
┌──────────────┐
│ 停止已禁用   │
│ 的 MCP 服务  │
│ 进程         │
──────┬───────┘
       │
       ▼
┌──────────────┐
│ 启动新启用   │
│ 的 MCP 服务  │
│ 进程         │
└──────┬───────┘
       │
       ▼
┌──────────────┐
│ 重新发现     │
│ 可用工具     │
──────┬───────┘
       │
       ▼
┌──────────────┐
│ 更新工具     │
│ 注册表       │
└──────────────┘
```

---

## 7. UI 组件详细设计

### 7.1 连接器卡片组件

```tsx
// src/pages/Connectors/ConnectorCard.tsx

interface ConnectorCardProps {
  connector: ConnectorConfig;
  onInstall: (id: string) => void;
  onConfigure: (id: string) => void;
}

export function ConnectorCard({ connector, onInstall, onConfigure }: ConnectorCardProps) {
  const isInstalled = connector.status !== 'available';
  const isEnabled = connector.enabled;

  return (
    <div className="group relative rounded-2xl border border-black/10 dark:border-white/10 
                    bg-white dark:bg-card p-6 hover:shadow-lg transition-all">
      {/* 图标 + 名称 */}
      <div className="flex items-start gap-4 mb-3">
        <div className="w-12 h-12 rounded-xl bg-black/5 dark:bg-white/5 
                        flex items-center justify-center text-2xl">
          {connector.icon}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="text-[15px] font-semibold text-foreground truncate">
              {connector.name}
            </h3>
            {isEnabled && (
              <span className="w-2 h-2 rounded-full bg-green-500 shrink-0" />
            )}
          </div>
        </div>
      </div>

      {/* 描述 */}
      <p className="text-[13px] text-foreground/60 line-clamp-2 mb-4">
        {connector.description}
      </p>

      {/* 操作按钮 */}
      <div className="flex items-center justify-end">
        {!isInstalled ? (
          <Button
            variant="outline"
            size="sm"
            className="rounded-full h-8 w-8 p-0"
            onClick={() => onInstall(connector.id)}
          >
            <Plus className="h-4 w-4" />
          </Button>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            className="rounded-full h-8 w-8 p-0"
            onClick={() => onConfigure(connector.id)}
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        )}
      </div>
    </div>
  );
}
```

### 7.2 MCP 服务卡片组件

```tsx
// src/components/settings/McpServiceCard.tsx

interface McpServiceCardProps {
  server: McpServerStatus;
  onToggle: (name: string, enabled: boolean) => void;
  onConfigure: (name: string) => void;
}

export function McpServiceCard({ server, onToggle, onConfigure }: McpServiceCardProps) {
  return (
    <div className="flex items-center gap-4 p-4 rounded-xl border border-black/5 
                    dark:border-white/5 bg-white dark:bg-muted">
      {/* 展开箭头 */}
      <Button
        variant="ghost"
        size="icon"
        className="h-8 w-8 shrink-0"
        onClick={() => onConfigure(server.name)}
      >
        <ChevronRight className="h-4 w-4" />
      </Button>

      {/* 图标 */}
      <div className="w-8 h-8 rounded-lg bg-green-500/10 flex items-center justify-center 
                      text-green-600 shrink-0">
        <span className="text-sm font-bold">钉</span>
      </div>

      {/* 信息 */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-[14px] font-medium text-foreground">
            {server.name}
          </span>
          {server.enabled && server.connected && (
            <span className="w-2 h-2 rounded-full bg-green-500" />
          )}
        </div>
        {/* 仅当 Gateway 返回 toolCount/totalTools 时展示；数值随已配置 MCP 变化，非写死「47」等 */}
        <span className="text-[12px] text-foreground/50">
          {server.toolCount}/{server.totalTools} 个工具已启用
        </span>
      </div>

      {/* 开关 */}
      <Switch
        checked={server.enabled}
        onCheckedChange={(checked) => onToggle(server.name, checked)}
      />
    </div>
  );
}
```

---

## 8. 路由与导航集成

### 8.1 路由配置

```typescript
// src/App.tsx 中添加

import { Connectors } from './pages/Connectors';

// 在 Routes 中添加
<Route path="/connectors" element={<Connectors />} />
```

### 8.2 侧边栏导航

```typescript
// src/components/layout/Sidebar.tsx 中添加

import { Plug } from 'lucide-react';

const coreNavItems = [
  // ... 现有项
  { to: '/connectors', icon: <Plug className="h-[18px] w-[18px]" />, label: t('sidebar.connectors') },
  // ...
];
```

### 8.3 Settings 子路由

```typescript
// src/pages/Settings/index.tsx 中添加 MCP 设置区块

import { McpSettings } from './McpSettings';

// 在 Settings 页面中添加 MCP 设置区块
<div>
  <h2>{t('mcp.title')}</h2>
  <McpSettings />
</div>
```

---

## 9. 国际化

### 9.1 中文翻译

```json
// src/i18n/locales/zh/connectors.json
{
  "title": "连接器",
  "subtitle": "连接外部服务，扩展 AI 能力",
  "tabs": {
    "builtIn": "内置",
    "custom": "自定义"
  },
  "customTab": {
    "emptyTitle": "暂无自定义 MCP",
    "emptyDescription": "点击右上角「自定义连接器」添加，或在设置中编辑 MCP 配置文件。"
  },
  "customConnector": "自定义连接器",
  "install": "安装",
  "installed": "已安装",
  "enabled": "已启用",
  "disabled": "已禁用",
  "configure": "配置",
  "uninstall": "卸载",
  "uninstallConfirm": "确定要卸载 \"{{name}}\" 吗？",
  "mcp": {
    "title": "MCP 服务管理",
    "subtitle": "安装 MCP 服务，为 AI 扩展更多工具能力",
    "searchPlaceholder": "搜索服务器...",
    "myMcp": "我的 MCP",
    "enabled": "启用",
    "toolsEnabled": "{{used}}/{{total}} 个工具已启用",
    "configTitle": "配置 MCP",
    "configPath": "配置文件路径",
    "save": "保存",
    "cancel": "取消",
    "validationError": "配置校验失败",
    "saveSuccess": "MCP 配置已保存",
    "saveFailed": "保存 MCP 配置失败"
  }
}
```

### 9.2 英文翻译

```json
// src/i18n/locales/en/connectors.json
{
  "title": "Connectors",
  "subtitle": "Connect external services to extend AI capabilities",
  "tabs": {
    "builtIn": "Built-in",
    "custom": "Custom"
  },
  "customTab": {
    "emptyTitle": "No custom MCP yet",
    "emptyDescription": "Use \"Custom Connector\" above, or edit the MCP config file in Settings."
  },
  "customConnector": "Custom Connector",
  "install": "Install",
  "installed": "Installed",
  "enabled": "Enabled",
  "disabled": "Disabled",
  "configure": "Configure",
  "uninstall": "Uninstall",
  "uninstallConfirm": "Are you sure you want to uninstall \"{{name}}\"?",
  "mcp": {
    "title": "MCP Service Management",
    "subtitle": "Install MCP services to extend AI with more tool capabilities",
    "searchPlaceholder": "Search servers...",
    "myMcp": "My MCP",
    "enabled": "Enabled",
    "toolsEnabled": "{{used}}/{{total}} tools enabled",
    "configTitle": "Configure MCP",
    "configPath": "Config file path",
    "save": "Save",
    "cancel": "Cancel",
    "validationError": "Configuration validation failed",
    "saveSuccess": "MCP configuration saved",
    "saveFailed": "Failed to save MCP configuration"
  }
}
```

---

## 10. 实现计划

### Phase 1: 基础框架（第 1-2 周）

| 任务 | 文件 | 说明 |
|------|------|------|
| 类型定义 | `src/types/connector.ts` | 定义所有类型 |
| Zustand Store | `src/stores/connectors.ts` | 状态管理（含 `connectorPageTab` 等） |
| Host API 路由 | `electron/api/routes/connectors.ts` | 后端 API |
| Host API 路由 | `electron/api/routes/mcp.ts` | MCP 管理 API |
| 国际化 | `src/i18n/locales/*/connectors.json` | 多语言支持 |

### Phase 2: UI 页面（第 3-4 周）

| 任务 | 文件 | 说明 |
|------|------|------|
| 连接器列表页 | `src/pages/Connectors/index.tsx` | 主页面（内置 / 自定义 Tab 容器） |
| Tab 切换 | `src/pages/Connectors/ConnectorTabs.tsx` | 「内置 \| 自定义」切换 |
| 连接器卡片 | `src/pages/Connectors/ConnectorCard.tsx` | 卡片组件 |
| 安装弹窗 | `src/pages/Connectors/InstallDialog.tsx` | 安装确认 |
| MCP 服务管理 | `src/pages/Settings/McpSettings.tsx` | Settings 子页面 |
| MCP 服务卡片 | `src/components/settings/McpServiceCard.tsx` | 服务卡片 |
| MCP 配置编辑 | `src/pages/Settings/McpConfigEditor.tsx` | JSON 编辑器 |

### Phase 3: 集成与测试（第 5 周）

| 任务 | 说明 |
|------|------|
| 路由集成 | 添加到 App.tsx 和 Sidebar |
| Gateway 集成 | MCP 配置变更通知 Gateway |
| E2E 测试 | Playwright 测试覆盖 |
| 文档更新 | README 更新 |

---

## 11. 风险与注意事项

### 11.1 技术风险

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| MCP 服务启动失败 | 用户无法使用工具 | 显示错误信息，提供重试 |
| 配置文件冲突 | 配置丢失 | 备份机制，原子写入 |
| Gateway 重载延迟 | 服务状态不一致 | 轮询状态，超时提示 |
| 跨平台路径差异 | 配置文件路径错误 | 使用 `app.getPath()` 统一处理 |

### 11.2 安全注意事项

- MCP 配置的 `env` 字段中的敏感信息（如 API Token）应使用 Electron 安全存储
- 配置文件写入前应进行 JSON 格式校验
- stdio 类型的 `command` 应进行白名单校验，防止命令注入
- 外部 MCP 服务的 URL 应进行协议校验（仅允许 https）

### 11.3 与现有功能的兼容

- 连接器功能与现有 Skills 系统并行，互不干扰
- MCP 配置独立于 OpenClaw 的 skills 配置
- 连接器安装不修改现有 `mcp.json` 中用户手动配置的部分

---

## 12. 附录

### 12.1 参考资源

- [Model Context Protocol Specification](https://modelcontextprotocol.io/specification)
- [OpenClaw MCP 文档](https://openclaw.ai/docs/mcp)
- WorkBuddy 连接器 UI 截图（用户提供）

### 12.2 连接器页「内置」目录（LYClaw）

与 WorkBuddy 不同，LYClaw **不在连接器页内置 QQ 邮箱、腾讯会议、腾讯问卷、腾讯文档等办公套件连接器**；「内置」Tab **仅**提供下列两项，作为官方引导入口（安装后仍写入同一 `mcp.json`，由 Gateway 加载）。

| 连接器 | `ConnectorType` / 目录 ID | 推荐 MCP 实现 |
|--------|---------------------------|---------------|
| Notion | `notion` | 选型后的 Notion MCP Server（stdio 或 streamable-http；包名以 Gateway 兼容列表为准） |
| GitHub | `code` | `@modelcontextprotocol/server-github` |

### 12.3 「自定义」Tab 与 Settings 示例

- **自定义 Tab**：无固定清单；展示用户通过「自定义连接器」或 JSON 编辑器写入 `mcpServers` 的任意 MCP（stdio / streamable-http / sse），与 §3.4.1 一致。
- **Settings「MCP 服务管理」线框**（§3.5）中的钉钉、文件系统等仅作**通用 UI 示例**，不表示 LYClaw 连接器页会预置这些卡片；若用户自行配置同名 MCP，应出现在**自定义** Tab 或 Settings 列表中，而非「内置」Tab。
