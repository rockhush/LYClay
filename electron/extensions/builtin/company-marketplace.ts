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
import { app } from 'electron';

const COMPANY_API_BASE = 'http://portal.srv.lstech.com/aihome/api/skill';

interface CompanySkill {
  id: number;
  name: string;
  icon: string;
  skill_detail: string;
  operate_guide: string;
  version: string;
  author: string;
  download_count: number;
}

class CompanyMarketplaceExtension implements MarketplaceProviderExtension {
  readonly id = 'builtin/company-marketplace';

  setup(_ctx: ExtensionContext): void {
    console.log('[CompanyMarketplace] Extension initialized successfully');
  }

  /**
   * 修复嵌套目录结构
   * 如果解压后发现目录结构嵌套（如 test-hr/test-hr/），将内部目录内容移动到外层目录
   */
  private async fixNestedDirectory(skillDir: string): Promise<void> {
    try {
      const entries = await fs.promises.readdir(skillDir, { withFileTypes: true });
      
      // 如果只有一个子目录，且子目录名与父目录名相同
      if (entries.length === 1 && entries[0].isDirectory()) {
        const subDirName = entries[0].name;
        const parentDirName = path.basename(skillDir);
        
        if (subDirName === parentDirName) {
          const subDirPath = path.join(skillDir, subDirName);
          const subEntries = await fs.promises.readdir(subDirPath, { withFileTypes: true });
          
          // 将子目录中的所有内容移动到父目录
          for (const entry of subEntries) {
            const srcPath = path.join(subDirPath, entry.name);
            const destPath = path.join(skillDir, entry.name);
            await fs.promises.rename(srcPath, destPath);
          }
          
          // 删除空的子目录
          await fs.promises.rmdir(subDirPath);
          console.log(`[CompanyMarketplace] Fixed nested directory: ${skillDir}/${subDirName}`);
        }
      }
    } catch (error) {
      console.error('[CompanyMarketplace] Error fixing nested directory:', error);
    }
  }

  async getCapability(): Promise<MarketplaceCapability> {
    return {
      mode: 'company',
      canSearch: true,
      canInstall: true,
    };
  }

  async search(params: ClawHubSearchParams): Promise<ClawHubSkillResult[]> {
    try {
      const url = `${COMPANY_API_BASE}/list/`;
      console.log('[CompanyMarketplace] Search called with params:', params);
      console.log('[CompanyMarketplace] Calling API:', url);

      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        throw new Error(`Company API error: ${response.status}`);
      }

      const data = await response.json();
      
      // 检查返回的数据结构
      if (!data || typeof data !== 'object' || !Array.isArray(data.skills)) {
        console.error('[CompanyMarketplace] API returned invalid data format:', typeof data, data);
        throw new Error('Invalid response format: expected object with skills array');
      }

      const skills: CompanySkill[] = data.skills;

      // 内置技能名称列表（这些技能已经在openclaw包中，不需要从公司市场安装）
      const builtinSkillNames = new Set([
        'pdf',
        'docx',
        'docxt',
        'pptx',
        'xlsx',
        'summarize',
        'github',
        'gh-issues',
        'coding',
        'coding-agent',
        'taskflow',
        'skill-creator',
        'find-skills',
        'session-logs',
        'brave-web-search',
        'self-improving-agent',
        'healthcheck',
        'tavily-search',
      ]);

      let results = skills.map(skill => ({
        slug: skill.name,
        name: skill.name,
        version: skill.version,
        description: skill.skill_detail,
        author: skill.author,
        downloads: skill.download_count,
      }));

      // 过滤掉内置技能，这些技能已经捆绑在openclaw包中
      results = results.filter(skill => !builtinSkillNames.has(skill.name));

      // 按 category 过滤
      if (params.category && params.category.trim()) {
        results = results.filter(skill => {
          // 假设 skill 对象有 category 字段
          const skillCategory = skill.category || '';
          return skillCategory.toLowerCase() === params.category.toLowerCase();
        });
      }

      if (params.query && params.query.trim()) {
        const query = params.query.toLowerCase();
        results = results.filter(skill => 
          skill.name.toLowerCase().includes(query) ||
          skill.description.toLowerCase().includes(query) ||
          (skill.author && skill.author.toLowerCase().includes(query))
        );
      }

      return results;
    } catch (error) {
      console.error('Company marketplace search error:', error);
      throw error;
    }
  }

  async install(params: ClawHubInstallParams): Promise<void> {
    console.log('[CompanyMarketplace] Install called with params:', params);
    try {
      const skillName = params.slug;
      console.log('[CompanyMarketplace] Installing skill:', skillName);

      // 先获取技能列表，找到对应的skillId
      const skillsUrl = `${COMPANY_API_BASE}/list/`;
      const skillsResponse = await fetch(skillsUrl, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
        },
      });

      if (!skillsResponse.ok) {
        throw new Error(`Company API error: ${skillsResponse.status}`);
      }

      const data = await skillsResponse.json();
      
      // 检查返回的数据结构
      if (!data || typeof data !== 'object' || !Array.isArray(data.skills)) {
        console.error('[CompanyMarketplace] API returned invalid data format:', typeof data, data);
        throw new Error('Invalid response format: expected object with skills array');
      }

      const skills: CompanySkill[] = data.skills;
      const targetSkill = skills.find(s => s.name === skillName);

      if (!targetSkill) {
        const errorMsg = `Skill not found: ${skillName}`;
        console.error('[CompanyMarketplace]', errorMsg);
        throw new Error(errorMsg);
      }

      const skillId = targetSkill.id;
      console.log('[CompanyMarketplace] Found skill ID:', skillId);

      const url = `${COMPANY_API_BASE}/download/${skillId}/`;
      console.log('[CompanyMarketplace] Download URL:', url);

      const response = await fetch(url, {
        method: 'GET',
      });

      console.log('[CompanyMarketplace] Download response status:', response.status);
      console.log('[CompanyMarketplace] Download response ok:', response.ok);

      if (!response.ok) {
        const errorMsg = `Company API download error: ${response.status} (${response.statusText})`;
        console.error('[CompanyMarketplace]', errorMsg);
        throw new Error(errorMsg);
      }

      console.log('[CompanyMarketplace] Skill name:', skillName);

      const buffer = await response.arrayBuffer();
      console.log('[CompanyMarketplace] Downloaded buffer size:', buffer.byteLength);
      
      const uint8Array = new Uint8Array(buffer);

      const { getOpenClawConfigDir } = await import('../../utils/paths');
      const fsPromises = fs.promises;

      const workDir = getOpenClawConfigDir();
      console.log('[CompanyMarketplace] OpenClaw config dir:', workDir);
      
      const skillsRoot = path.join(workDir, 'skills');
      console.log('[CompanyMarketplace] Skills root dir:', skillsRoot);
      
      if (!fs.existsSync(skillsRoot)) {
        console.log('[CompanyMarketplace] Creating skills root dir:', skillsRoot);
        fs.mkdirSync(skillsRoot, { recursive: true });
      }

      const tempZipPath = path.join(app.getPath('temp'), `${skillName}.zip`);
      const skillDir = path.join(skillsRoot, skillName);
      console.log('[CompanyMarketplace] Temp zip path:', tempZipPath);
      console.log('[CompanyMarketplace] Skill install dir:', skillDir);

      // 确保技能目录不存在
      if (fs.existsSync(skillDir)) {
        console.log('[CompanyMarketplace] Removing existing skill dir:', skillDir);
        await fsPromises.rm(skillDir, { recursive: true });
      }

      console.log('[CompanyMarketplace] Writing temp zip file...');
      await fsPromises.writeFile(tempZipPath, uint8Array);
      console.log('[CompanyMarketplace] Temp zip file written successfully');

      const { execSync } = await import('child_process');
      const isWin = process.platform === 'win32';
      const unzipCmd = isWin
        ? `powershell -Command "Expand-Archive -Path '${tempZipPath}' -DestinationPath '${skillDir}' -Force"`
        : `unzip -o "${tempZipPath}" -d "${skillDir}"`;

      console.log('[CompanyMarketplace] Unzip command:', unzipCmd);
      
      try {
        execSync(unzipCmd, { stdio: 'pipe' });
        console.log('[CompanyMarketplace] Unzip successful');
        
        // 检查是否存在嵌套目录（如 test-hr/test-hr/）
        await this.fixNestedDirectory(skillDir);
      } catch (unzipError) {
        console.error('[CompanyMarketplace] Unzip failed, trying manual extraction:', unzipError);
        await fsPromises.mkdir(skillDir, { recursive: true });
        await fsPromises.cp(tempZipPath, path.join(skillDir, 'skill.zip'));
        console.log('[CompanyMarketplace] Manual extraction completed');
      }

      console.log('[CompanyMarketplace] Removing temp zip file...');
      await fsPromises.unlink(tempZipPath);

      console.log('[CompanyMarketplace] Skill installed successfully:', skillName);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error('[CompanyMarketplace] Install error:', errorMsg);
      throw new Error(`Company marketplace install failed: ${errorMsg}`);
    }
  }
}

export function createCompanyMarketplaceExtension(): Extension {
  return new CompanyMarketplaceExtension();
}