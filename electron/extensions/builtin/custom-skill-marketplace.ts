/**
 * 自定义技能市场提供者
 * 从私有仓库/服务器搜索和安装技能，替代 ClawHub
 */
import { app } from 'electron';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { logger } from '../../utils/logger';
import type { 
  ClawHubSearchParams, 
  ClawHubInstallParams, 
  ClawHubSkillResult,
  MarketplaceProvider 
} from '../../gateway/clawhub';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getOpenClawConfigDir } = require('../../utils/paths');

/**
 * 自定义仓库配置
 * 可以通过配置文件或环境变量设置
 */
interface CustomRepoConfig {
  /** 仓库 API 基础 URL */
  baseUrl: string;
  /** 认证 Token（可选） */
  authToken?: string;
  /** 超时时间（毫秒） */
  timeout?: number;
}

/**
 * 从配置获取自定义仓库信息
 */
function getCustomRepoConfig(): CustomRepoConfig | null {
  // 方案 1: 从环境变量读取
  const baseUrl = process.env.CLAWX_SKILL_REPO_URL;
  if (!baseUrl) {
    logger.warn('CLAWX_SKILL_REPO_URL not set, custom marketplace disabled');
    return null;
  }

  return {
    baseUrl: baseUrl.replace(/\/+$/, ''), // 移除末尾斜杠
    authToken: process.env.CLAWX_SKILL_REPO_TOKEN,
    timeout: parseInt(process.env.CLAWX_SKILL_REPO_TIMEOUT || '30000', 10),
  };
}

/**
 * 自定义技能市场提供者实现
 */
export class CustomSkillMarketplace implements MarketplaceProvider {
  readonly id = 'custom/skill-marketplace';
  private config: CustomRepoConfig | null;

  constructor() {
    this.config = getCustomRepoConfig();
  }

  /**
   * 更新配置（支持热更新）
   */
  updateConfig(config: Partial<CustomRepoConfig>): void {
    this.config = this.config ? { ...this.config, ...config } : config as CustomRepoConfig;
  }

  async getCapability(): Promise<{ mode: string; canSearch: boolean; canInstall: boolean; reason?: string }> {
    if (!this.config?.baseUrl) {
      return {
        mode: 'custom',
        canSearch: false,
        canInstall: false,
        reason: 'Custom skill repository not configured (set CLAWX_SKILL_REPO_URL)',
      };
    }

    return {
      mode: 'custom',
      canSearch: true,
      canInstall: true,
    };
  }

  /**
   * 搜索技能
   * 
   * 预期的 API 响应格式：
   * GET {baseUrl}/api/skills/search?q={query}&limit={limit}
   * 
   * 返回：
   * {
   *   "skills": [
   *     {
   *       "slug": "skill-name",
   *       "name": "Skill Name",
   *       "description": "Description here",
   *       "version": "1.0.0",
   *       "author": "author-name",
   *       "downloads": 100,
   *       "stars": 50
   *     }
   *   ]
   * }
   */
  async search(params: ClawHubSearchParams): Promise<ClawHubSkillResult[]> {
    if (!this.config?.baseUrl) {
      throw new Error('Custom skill repository not configured');
    }

    const query = params.query || '';
    const limit = params.limit || 20;
    const url = `${this.config.baseUrl}/api/skills/search?q=${encodeURIComponent(query)}&limit=${limit}`;

    logger.info(`[CustomMarketplace] Searching skills: ${url}`);

    try {
      const response = await this.httpGet(url);
      const data = JSON.parse(response);

      if (!data.skills || !Array.isArray(data.skills)) {
        logger.warn('[CustomMarketplace] Invalid search response format');
        return [];
      }

      return data.skills.map((skill: any) => ({
        slug: skill.slug,
        name: skill.name || skill.slug,
        description: skill.description || '',
        version: skill.version || '1.0.0',
        author: skill.author,
        downloads: skill.downloads,
        stars: skill.stars,
      }));
    } catch (error) {
      logger.error('[CustomMarketplace] Search failed:', error);
      throw new Error(`技能搜索失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * 安装技能
   * 
   * 预期的 API 响应格式：
   * POST {baseUrl}/api/skills/install
   * Body: { "slug": "skill-name", "version": "1.0.0" }
   * 
   * 返回技能 ZIP 下载 URL 或直接返回技能文件
   */
  async install(params: ClawHubInstallParams): Promise<void> {
    if (!this.config?.baseUrl) {
      throw new Error('Custom skill repository not configured');
    }

    const skillsDir = path.join(this.getWorkDir(), 'skills');
    const installUrl = `${this.config.baseUrl}/api/skills/install`;

    logger.info(`[CustomMarketplace] Installing skill: ${params.slug}`);

    try {
      // 1. 从服务器获取技能包
      const response = await this.httpPost(installUrl, {
        slug: params.slug,
        version: params.version,
      });

      const data = JSON.parse(response);

      if (!data.success || !data.downloadUrl) {
        throw new Error(data.error || '安装失败：未返回下载链接');
      }

      // 2. 下载技能 ZIP
      const skillDir = path.join(skillsDir, params.slug);
      const zipPath = path.join(skillsDir, `${params.slug}.tmp.zip`);

      await this.downloadFile(data.downloadUrl, zipPath);

      // 3. 解压到技能目录
      await this.extractZip(zipPath, skillDir);

      // 4. 清理临时文件
      fs.unlinkSync(zipPath);

      logger.info(`[CustomMarketplace] Successfully installed: ${params.slug}`);
    } catch (error) {
      logger.error('[CustomMarketplace] Install failed:', error);
      throw new Error(`技能安装失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * 获取工作目录
   */
  private getWorkDir(): string {
    return getOpenClawConfigDir();
  }

  /**
   * HTTP GET 请求
   */
  private httpGet(url: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const urlObj = new globalThis.URL(url);
      const isHttps = urlObj.protocol === 'https:';
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const lib = isHttps ? require('https') : require('http');

      const headers: Record<string, string> = {
        'User-Agent': `ClawX/${app.getVersion()}`,
        'Accept': 'application/json',
      };

      if (this.config?.authToken) {
        headers['Authorization'] = `Bearer ${this.config.authToken}`;
      }

      const req = lib.get(url, { headers, timeout: this.config?.timeout }, (res: any) => {
        if (res.statusCode === 302 || res.statusCode === 301) {
          // 处理重定向
          return this.httpGet(res.headers.location).then(resolve).catch(reject);
        }

        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}: ${res.statusMessage}`));
          return;
        }

        let data = '';
        res.on('data', (chunk: string) => data += chunk);
        res.on('end', () => resolve(data));
        res.on('error', reject);
      });

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Request timeout'));
      });
    });
  }

  /**
   * HTTP POST 请求
   */
  private httpPost(url: string, body: Record<string, any>): Promise<string> {
    return new Promise((resolve, reject) => {
      const urlObj = new globalThis.URL(url);
      const isHttps = urlObj.protocol === 'https:';
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const lib = isHttps ? require('https') : require('http');

      const payload = JSON.stringify(body);
      const headers: Record<string, string> = {
        'User-Agent': `ClawX/${app.getVersion()}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      };

      if (this.config?.authToken) {
        headers['Authorization'] = `Bearer ${this.config.authToken}`;
      }

      const req = lib.request(url, {
        method: 'POST',
        headers,
        timeout: this.config?.timeout,
      }, (res: any) => {
        let data = '';
        res.on('data', (chunk: string) => data += chunk);
        res.on('end', () => {
          if (res.statusCode !== 200) {
            reject(new Error(`HTTP ${res.statusCode}: ${data || res.statusMessage}`));
          } else {
            resolve(data);
          }
        });
        res.on('error', reject);
      });

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Request timeout'));
      });

      req.write(payload);
      req.end();
    });
  }

  /**
   * 下载文件
   */
  private downloadFile(url: string, destPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const urlObj = new globalThis.URL(url);
      const isHttps = urlObj.protocol === 'https:';
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const lib = isHttps ? require('https') : require('http');

      const headers: Record<string, string> = {};
      if (this.config?.authToken) {
        headers['Authorization'] = `Bearer ${this.config.authToken}`;
      }

      const file = fs.createWriteStream(destPath);

      lib.get(url, { headers, timeout: this.config?.timeout }, (res: any) => {
        if (res.statusCode === 302 || res.statusCode === 301) {
          file.close();
          return this.downloadFile(res.headers.location, destPath).then(resolve).catch(reject);
        }

        if (res.statusCode !== 200) {
          reject(new Error(`Download failed: HTTP ${res.statusCode}`));
          return;
        }

        res.pipe(file);
        file.on('finish', () => {
          file.close();
          resolve();
        });
      }).on('error', (err: Error) => {
        fs.unlink(destPath, () => {}); // 清理失败文件
        reject(err);
      });
    });
  }

  /**
   * 解压 ZIP 文件
   */
  private extractZip(zipPath: string, destDir: string): Promise<void> {
    return new Promise((resolve, reject) => {
      // 使用系统命令解压（跨平台兼容）
      const isWin = process.platform === 'win32';
      
      if (isWin) {
        // Windows: 使用 PowerShell
        const cmd = `powershell -command "Expand-Archive -Path '${zipPath}' -DestinationPath '${destDir}' -Force"`;
        const child = spawn(cmd, { shell: true, windowsHide: true });
        
        child.on('close', (code) => {
          if (code === 0) resolve();
          else reject(new Error(`ZIP extraction failed (code ${code})`));
        });
        child.on('error', reject);
      } else {
        // macOS/Linux: 使用 unzip
        const child = spawn('unzip', ['-o', zipPath, '-d', destDir]);
        
        child.on('close', (code) => {
          if (code === 0) resolve();
          else reject(new Error(`ZIP extraction failed (code ${code})`));
        });
        child.on('error', reject);
      }
    });
  }
}
