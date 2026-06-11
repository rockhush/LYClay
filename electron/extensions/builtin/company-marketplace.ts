import type {
  Extension,
  ExtensionContext,
  MarketplaceProviderExtension,
  MarketplaceCapability,
} from '../types';
import type {
  ClawHubSearchParams,
  ClawHubInstallParams,
  ClawHubInstallResult,
  ClawHubSkillResult,
} from '../../gateway/clawhub';
import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import { setLastCompanyListApiTrace } from '../../utils/company-list-api-trace';
import { spawn } from 'child_process';
import { getOpenClawConfigDir, prepareWinSpawn } from '../../utils/paths';
import {
  locateSkillContentDir,
  parseZipBasenameFromContentDisposition,
  resolvePackageDirName,
} from '../../utils/company-skill-package';
import {
  hasPreservedSkillDirectory,
  restorePreservedSkillDirectory,
} from '../../utils/skill-workspace-preserve';
import {
  rememberCompanyMarketplaceInstall,
  writeCompanyMarketplaceSidecar,
} from '../../utils/company-marketplace-installs';

const COMPANY_API_BASE = 'http://portal.srv.lstech.com/aihome/api/skill';
// const COMPANY_API_BASE = 'http://100.0.4.203/aihome/api/skill';
interface CompanySkill {
  id: number;
  name: string;
  icon: string;
  skill_detail: string;
  operate_guide: string;
  version: string;
  author: string;
  download_count: number;
  update_time: string;
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
  private runArchiveCommand(command: string, args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const prepared = prepareWinSpawn(command, args);
      const child = spawn(prepared.command, prepared.args, {
        shell: prepared.shell,
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'pipe'],
      });

      let stderr = '';
      child.stderr?.on('data', (data) => { stderr += data.toString(); });
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) {
          resolve();
          return;
        }
        reject(new Error(stderr.trim() || `${command} exited with code ${code}`));
      });
    });
  }

  private async extractZip(tempZipPath: string, skillDir: string): Promise<void> {
    if (process.platform === 'win32') {
      try {
        await this.runArchiveCommand('tar.exe', ['-xf', tempZipPath, '-C', skillDir]);
        return;
      } catch (tarError) {
        console.warn('[CompanyMarketplace] tar.exe extraction failed, falling back to non-admin PowerShell:', tarError);
        const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
        // Inline the paths directly into the PowerShell command to avoid
        // $args[] binding issues when spawn uses shell:true on Windows.
        const cmd = `Expand-Archive -LiteralPath "${tempZipPath}" -DestinationPath "${skillDir}" -Force`;
        await this.runArchiveCommand(powershell, [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-Command',
          cmd,
        ]);
        return;
      }
    }

    await this.runArchiveCommand('unzip', ['-o', tempZipPath, '-d', skillDir]);
  }

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
      // 获取当前操作系统
      const os = process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? '' : 'linux';
      
      // 构建完整的参数对象（包含os）
      const fullParams = {
        ...params,
        os,
      };
      
      // 构建带参数的URL
      const sort = params.sort || '';
      const paramsArray: string[] = [];
      if (params.query) {
        paramsArray.push(`query=${encodeURIComponent(params.query)}`);
      }
      if (params.category) {
        paramsArray.push(`category=${encodeURIComponent(params.category)}`);
      }
      if (sort) {
        paramsArray.push(`sort=${encodeURIComponent(sort)}`);
      }
      paramsArray.push(`os=${os}`);
      
      const url = `${COMPANY_API_BASE}/list/?${paramsArray.join('&')}`;
      console.log('[CompanyMarketplace] Search called with params:', fullParams);
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
      setLastCompanyListApiTrace(url, data);

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
        id: skill.id,
        // Install key uses marketplace id; display name stays separate.
        slug: String(skill.id),
        name: skill.name,
        version: skill.version,
        description: skill.skill_detail,
        author: skill.author,
        downloads: skill.download_count,
        category: skill.category,
        update_time: skill.update_time,
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

  private findTargetSkill(skills: CompanySkill[], installKey: string): CompanySkill | undefined {
    const trimmed = installKey.trim();
    if (!trimmed) return undefined;

    if (/^\d+$/.test(trimmed)) {
      const marketplaceId = Number(trimmed);
      return skills.find((skill) => skill.id === marketplaceId);
    }

    return skills.find((skill) => skill.name === trimmed);
  }

  async install(params: ClawHubInstallParams): Promise<ClawHubInstallResult> {
    console.log('[CompanyMarketplace] Install called with params:', params);
    const fsPromises = fs.promises;
    const installKey = params.slug.trim();
    const tempExtractDir = path.join(app.getPath('temp'), `lyclaw-skill-${installKey}-${Date.now()}`);
    let tempZipPath = '';

    try {
      console.log('[CompanyMarketplace] Installing skill key:', installKey);

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
      setLastCompanyListApiTrace(skillsUrl, data);
      if (!data || typeof data !== 'object' || !Array.isArray(data.skills)) {
        console.error('[CompanyMarketplace] API returned invalid data format:', typeof data, data);
        throw new Error('Invalid response format: expected object with skills array');
      }

      const skills: CompanySkill[] = data.skills;
      const targetSkill = this.findTargetSkill(skills, installKey);
      if (!targetSkill) {
        const errorMsg = `Skill not found: ${installKey}`;
        console.error('[CompanyMarketplace]', errorMsg);
        throw new Error(errorMsg);
      }

      const skillId = targetSkill.id;
      console.log('[CompanyMarketplace] Found skill ID:', skillId);

      const url = `${COMPANY_API_BASE}/download/${skillId}/`;
      console.log('[CompanyMarketplace] Download URL:', url);

      const response = await fetch(url, { method: 'GET' });
      if (!response.ok) {
        const errorMsg = `Company API download error: ${response.status} (${response.statusText})`;
        console.error('[CompanyMarketplace]', errorMsg);
        throw new Error(errorMsg);
      }

      const zipBasename =
        parseZipBasenameFromContentDisposition(response.headers.get('content-disposition'))
        || `${skillId}.zip`;
      tempZipPath = path.join(app.getPath('temp'), zipBasename);

      const buffer = await response.arrayBuffer();
      const uint8Array = new Uint8Array(buffer);

      const workDir = getOpenClawConfigDir();
      const skillsRoot = path.join(workDir, 'skills');
      if (!fs.existsSync(skillsRoot)) {
        fs.mkdirSync(skillsRoot, { recursive: true });
      }

      await fsPromises.mkdir(tempExtractDir, { recursive: true });
      await fsPromises.writeFile(tempZipPath, uint8Array);
      await this.extractZip(tempZipPath, tempExtractDir);

      const packageDirName = await resolvePackageDirName(tempExtractDir, zipBasename);
      const contentDir = await locateSkillContentDir(tempExtractDir);
      const skillDir = path.join(skillsRoot, packageDirName);

      if (!params.force && hasPreservedSkillDirectory(packageDirName)) {
        const restored = await restorePreservedSkillDirectory(packageDirName, skillDir);
        if (restored) {
          const installEntry = {
            packageSlug: packageDirName,
            name: targetSkill.name,
            version: targetSkill.version,
            author: targetSkill.author,
            description: targetSkill.skill_detail,
          };
          await rememberCompanyMarketplaceInstall(skillId, installEntry);
          await writeCompanyMarketplaceSidecar(skillDir, skillId, installEntry);
          console.log('[CompanyMarketplace] Restored preserved skill directory:', packageDirName);
          return {
            slug: packageDirName,
            baseDir: skillDir,
            name: targetSkill.name,
            version: targetSkill.version,
            author: targetSkill.author,
            description: targetSkill.skill_detail,
            marketplaceId: skillId,
          };
        }
      }

      if (fs.existsSync(skillDir)) {
        console.log('[CompanyMarketplace] Removing existing skill directory before install:', skillDir);
        await fsPromises.rm(skillDir, { recursive: true, force: true });
      }
      await fsPromises.mkdir(path.dirname(skillDir), { recursive: true });

      if (params.force) {
        console.log('[CompanyMarketplace] Force install — installing from downloaded package:', packageDirName);
      }

      if (contentDir === tempExtractDir) {
        await fsPromises.mkdir(skillDir, { recursive: true });
        const extractedEntries = await fsPromises.readdir(contentDir, { withFileTypes: true });
        for (const entry of extractedEntries) {
          await fsPromises.rename(
            path.join(contentDir, entry.name),
            path.join(skillDir, entry.name),
          );
        }
      } else {
        await fsPromises.rename(contentDir, skillDir);
      }

      await this.fixNestedDirectory(skillDir);

      const installEntry = {
        packageSlug: packageDirName,
        name: targetSkill.name,
        version: targetSkill.version,
        author: targetSkill.author,
        description: targetSkill.skill_detail,
      };
      await rememberCompanyMarketplaceInstall(skillId, installEntry);
      await writeCompanyMarketplaceSidecar(skillDir, skillId, installEntry);

      console.log('[CompanyMarketplace] Skill installed successfully:', packageDirName);
      return {
        slug: packageDirName,
        baseDir: skillDir,
        name: targetSkill.name,
        version: targetSkill.version,
        author: targetSkill.author,
        description: targetSkill.skill_detail,
        marketplaceId: skillId,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error('[CompanyMarketplace] Install error:', errorMsg);
      throw new Error(`Company marketplace install failed: ${errorMsg}`);
    } finally {
      if (tempZipPath) {
        await fsPromises.unlink(tempZipPath).catch(() => undefined);
      }
      await fsPromises.rm(tempExtractDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

export function createCompanyMarketplaceExtension(): Extension {
  return new CompanyMarketplaceExtension();
}