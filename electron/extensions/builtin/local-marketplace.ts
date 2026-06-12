import type {
  Extension,
  ExtensionContext,
  MarketplaceProviderExtension,
  MarketplaceCapability,
} from '../types';
import type {
  ClawHubSearchParams,
  ClawHubInstallParams,
  ClawHubSkillResult,
} from '../../gateway/clawhub';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { app } from 'electron';

// 本地技能目录配置 - 支持通过环境变量覆盖
function getLocalSkillsBaseDir(): string {
  // 首先检查环境变量 OPENCLAW_SKILLS_DIR
  const envSkillsDir = process.env.OPENCLAW_SKILLS_DIR;
  if (envSkillsDir) {
    console.log('[local-marketplace] 使用环境变量指定的技能目录:', envSkillsDir);
    return envSkillsDir;
  }
  
  try {
    // 在打包后的环境中，app.getPath('home') 比 os.homedir() 更可靠
    if (app.isReady()) {
      const homeDir = app.getPath('home');
      console.log('[local-marketplace] app.getPath home:', homeDir);
      return path.join(homeDir, '.openclaw', 'skills');
    }
  } catch (e) {
    console.log('[local-marketplace] app.getPath failed, using os.homedir():', e);
  }
  
  const osHomeDir = os.homedir();
  console.log('[local-marketplace] os.homedir():', osHomeDir);
  return path.join(osHomeDir, '.openclaw', 'skills');
}

const LOCAL_SKILLS_BASE_DIR = getLocalSkillsBaseDir();

console.log('[local-marketplace] 初始化本地市场提供商');
console.log('[local-marketplace] 本地技能目录:', LOCAL_SKILLS_BASE_DIR);

// 从本地目录扫描技能
function scanLocalSkills(): ClawHubSkillResult[] {
  const skills: ClawHubSkillResult[] = [];
  
  console.log('[local-marketplace] 开始扫描本地技能目录:', LOCAL_SKILLS_BASE_DIR);
  console.log('[local-marketplace] 目录是否存在:', fs.existsSync(LOCAL_SKILLS_BASE_DIR));
  
  if (!fs.existsSync(LOCAL_SKILLS_BASE_DIR)) {
    console.log('[local-marketplace] 本地技能目录不存在:', LOCAL_SKILLS_BASE_DIR);
    // 尝试创建目录
    try {
      fs.mkdirSync(LOCAL_SKILLS_BASE_DIR, { recursive: true });
      console.log('[local-marketplace] 已创建目录:', LOCAL_SKILLS_BASE_DIR);
    } catch (e) {
      console.error('[local-marketplace] 创建目录失败:', e);
    }
    return skills;
  }

  try {
    const entries = fs.readdirSync(LOCAL_SKILLS_BASE_DIR, { withFileTypes: true });
    console.log('[local-marketplace] 目录条目数量:', entries.length);
    
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        console.log('[local-marketplace] 跳过非目录条目:', entry.name);
        continue;
      }
      
      const skillDir = path.join(LOCAL_SKILLS_BASE_DIR, entry.name);
      const skillManifestPath = path.join(skillDir, 'SKILL.md');
      
      if (!fs.existsSync(skillManifestPath)) {
        console.log('[local-marketplace] 跳过没有 SKILL.md 的目录:', entry.name);
        continue;
      }

      try {
        const skillData = parseSkillManifest(skillManifestPath, entry.name);
        skills.push(skillData);
        console.log('[local-marketplace] 发现本地技能:', skillData.name, `(${skillData.slug})`);
      } catch (error) {
        console.error('[local-marketplace] 解析技能失败:', entry.name, error);
      }
    }
  } catch (error) {
    console.error('[local-marketplace] 扫描本地技能目录失败:', error);
  }
  
  console.log('[local-marketplace] 扫描完成，共发现', skills.length, '个技能');
  return skills;
}

// 解析 SKILL.md 文件
function parseSkillManifest(manifestPath: string, slug: string): ClawHubSkillResult {
  const content = fs.readFileSync(manifestPath, 'utf-8');
  
  // 解析 YAML 前置元数据
  const frontMatterMatch = content.match(/^---\s*\n([\s\S]*?)\n---/s);
  if (!frontMatterMatch) {
    throw new Error('无效的 SKILL.md 格式：缺少 YAML 前置元数据');
  }
  
  const frontMatter = frontMatterMatch[1];
  const skillData: any = {};
  
  // 简单的 YAML 解析（仅支持基本格式）
  const lines = frontMatter.split('\n');
  for (const line of lines) {
    const match = line.match(/^\s*([\w-]+)\s*:\s*(.*)$/);
    if (match) {
      const key = match[1].trim();
      const value = match[2].trim().replace(/^['"]|['"]$/g, ''); // 移除引号
      skillData[key] = value;
    }
  }
  
  return {
    id: slug,
    slug: slug,
    name: skillData.name || slug,
    description: skillData.description || '本地技能',
    version: skillData.version || '1.0.0',
    author: skillData.author || '未知',
    downloads: parseInt(skillData.downloads || '0', 10),
    stars: parseInt(skillData.stars || '0', 10)
  };
}

// 缓存本地技能列表
let cachedSkills: ClawHubSkillResult[] | null = null;

function getLocalSkills(): ClawHubSkillResult[] {
  if (cachedSkills === null) {
    cachedSkills = scanLocalSkills();
  }
  return cachedSkills;
}

function clearSkillsCache(): void {
  cachedSkills = null;
}

class LocalMarketplaceExtension implements MarketplaceProviderExtension {
  readonly id = 'builtin/local-marketplace';

  setup(_ctx: ExtensionContext): void {
    // 无需特殊设置
  }

  async getCapability(): Promise<MarketplaceCapability> {
    return {
      mode: 'local',
      canSearch: true,
      canInstall: true,
    };
  }

  async search(params: ClawHubSearchParams): Promise<ClawHubSkillResult[]> {
    const query = (params.query || '').toLowerCase().trim();
    
    console.log('[local-marketplace] search 被调用，查询:', query);
    
    // 清除缓存以确保获取最新数据
    clearSkillsCache();
    
    const localSkills = getLocalSkills();
    
    console.log('[local-marketplace] 获取到本地技能数量:', localSkills.length);
    
    if (!query) {
      // 空查询返回所有本地技能
      console.log('[local-marketplace] 返回所有本地技能');
      return localSkills;
    }
    // 根据查询过滤技能
    const filtered = localSkills.filter(skill => 
      skill.name.toLowerCase().includes(query) ||
      skill.description.toLowerCase().includes(query) ||
      skill.slug.toLowerCase().includes(query)
    );
    console.log('[local-marketplace] 过滤后技能数量:', filtered.length);
    return filtered;
  }

  async install(params: ClawHubInstallParams): Promise<void> {
    console.log('安装本地技能:', params.slug);
    
    const sourceDir = path.join(LOCAL_SKILLS_BASE_DIR, params.slug);
    
    if (!fs.existsSync(sourceDir)) {
      throw new Error(`技能目录不存在: ${sourceDir}`);
    }
    
    const skillManifestPath = path.join(sourceDir, 'SKILL.md');
    if (!fs.existsSync(skillManifestPath)) {
      throw new Error(`技能缺少 SKILL.md 文件: ${params.slug}`);
    }
    
    // 检查技能是否已安装
    const targetDir = path.join(LOCAL_SKILLS_BASE_DIR, params.slug);
    if (fs.existsSync(targetDir)) {
      console.log('技能已安装:', params.slug);
      return;
    }
    
    // 本地技能已经在正确的目录中，无需复制
    console.log('本地技能已就绪:', params.slug);
    
    // 清除缓存，以便下次搜索时能反映最新状态
    clearSkillsCache();
  }
}

export function createLocalMarketplaceExtension(): Extension {
  return new LocalMarketplaceExtension();
}