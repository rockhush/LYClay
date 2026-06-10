/**
 * ClawHub Service
 * Manages interactions with the ClawHub CLI for skills management
 */
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { app, shell } from 'electron';
import { getOpenClawConfigDir, ensureDir, getClawHubCliBinPath, getClawHubCliEntryPath, prepareWinSpawn } from '../utils/paths';
import {
    forgetCompanyMarketplaceInstall,
    readCompanyMarketplaceSidecarSync,
    resolveCompanyMarketplacePackageSlug,
} from '../utils/company-marketplace-installs';
import { resolveLocalUploadSkillMetadata } from '../utils/company-skill-package';
import {
  hasPreservedSkillDirectory,
  preserveSkillDirectoryOnUninstall,
  restorePreservedSkillDirectory,
} from '../utils/skill-workspace-preserve';
import { purgeCompanySkillForFreshInstall } from '../utils/company-skill-update';
import {
  DEFAULT_USER_CREATED_SKILL_VERSION,
  normalizeUserCreatedSkillsUnderRoot,
  resolveCurrentSkillAuthorName,
} from '../utils/user-created-skill-metadata';

export interface ClawHubSearchParams {
    query: string;
    limit?: number;
    sort?: string;
}

export interface ClawHubInstallParams {
    slug: string;
    version?: string;
    force?: boolean;
}

export interface ClawHubInstallResult {
    slug?: string;
    baseDir?: string;
    name?: string;
    version?: string;
    author?: string;
    description?: string;
    marketplaceId?: number | string;
}

export interface ClawHubUninstallParams {
    slug: string;
}

export interface ClawHubUpdateParams {
    slug: string;
}

export interface ClawHubSkillResult {
    id?: string | number;
    slug: string;
    name: string;
    description: string;
    version: string;
    author?: string;
    downloads?: number;
    stars?: number;
}

export interface ClawHubInstalledSkillResult {
    slug: string;
    name?: string;
    description?: string;
    author?: string;
    version: string;
    source?: string;
    baseDir?: string;
}

export interface MarketplaceProvider {
    getCapability(): Promise<{ mode: string; canSearch: boolean; canInstall: boolean; reason?: string }>;
    search(params: ClawHubSearchParams): Promise<ClawHubSkillResult[]>;
    install(params: ClawHubInstallParams): Promise<ClawHubInstallResult | void>;
}

export class ClawHubService {
    private workDir: string;
    private cliPath: string;
    private cliEntryPath: string;
    private useNodeRunner: boolean;
    private ansiRegex: RegExp;
    private marketplaceProvider: MarketplaceProvider | null = null;

    setMarketplaceProvider(provider: MarketplaceProvider): void {
        this.marketplaceProvider = provider;
    }

    async getMarketplaceCapability(): Promise<{ mode: string; canSearch: boolean; canInstall: boolean; reason?: string }> {
        if (this.marketplaceProvider) {
            return this.marketplaceProvider.getCapability();
        }
        return { mode: 'clawhub', canSearch: true, canInstall: true };
    }

    constructor() {
        // Use the user's OpenClaw config directory (~/.openclaw) for skill management
        // This avoids installing skills into the project's openclaw submodule
        this.workDir = getOpenClawConfigDir();
        ensureDir(this.workDir);

        const binPath = getClawHubCliBinPath();
        const entryPath = getClawHubCliEntryPath();

        this.cliEntryPath = entryPath;
        if (!app.isPackaged && fs.existsSync(binPath)) {
            this.cliPath = binPath;
            this.useNodeRunner = false;
        } else {
            this.cliPath = process.execPath;
            this.useNodeRunner = true;
        }
        const esc = String.fromCharCode(27);
        const csi = String.fromCharCode(155);
        const pattern = `(?:${esc}|${csi})[[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]`;
        this.ansiRegex = new RegExp(pattern, 'g');
    }

    private stripAnsi(line: string): string {
        return line.replace(this.ansiRegex, '').trim();
    }

    private extractFrontmatterName(skillManifestPath: string): string | null {
        return this.parseSkillManifest(skillManifestPath).name ?? null;
    }

    private parseSkillManifest(skillManifestPath: string): {
        name?: string;
        slug?: string;
        description?: string;
        version?: string;
        author?: string;
    } {
        try {
            const raw = fs.readFileSync(skillManifestPath, 'utf8');
            const frontmatterMatch = raw.match(/^---\s*\n([\s\S]*?)\n---/);
            if (!frontmatterMatch) return {};

            const body = frontmatterMatch[1];
            const readScalar = (key: string): string | undefined => {
                const quoted = body.match(new RegExp(`^\\s*${key}\\s*:\\s*"([^"]*)"\\s*$`, 'm'));
                if (quoted?.[1] != null) {
                    const value = quoted[1].trim();
                    return value || undefined;
                }
                const plain = body.match(new RegExp(`^\\s*${key}\\s*:\\s*([^\\n]+?)\\s*$`, 'm'));
                const value = plain?.[1]?.trim();
                return value || undefined;
            };

            return {
                name: readScalar('name'),
                slug: readScalar('slug'),
                description: readScalar('description'),
                version: readScalar('version'),
                author: readScalar('author'),
            };
        } catch {
            return {};
        }
    }

    private resolveSkillDirByManifestName(candidates: string[]): string | null {
        const skillsRoot = path.join(this.workDir, 'skills');
        if (!fs.existsSync(skillsRoot)) return null;

        const wanted = new Set(
            candidates
                .map((v) => v.trim().toLowerCase())
                .filter((v) => v.length > 0),
        );
        if (wanted.size === 0) return null;

        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(skillsRoot, { withFileTypes: true });
        } catch {
            return null;
        }

        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            const skillDir = path.join(skillsRoot, entry.name);
            const skillManifestPath = path.join(skillDir, 'SKILL.md');
            if (!fs.existsSync(skillManifestPath)) continue;

            const manifest = this.parseSkillManifest(skillManifestPath);
            const manifestKeys = [manifest.slug, manifest.name, entry.name]
                .filter((value): value is string => Boolean(value && value.trim()))
                .map((value) => value.trim().toLowerCase());
            if (manifestKeys.some((key) => wanted.has(key))) {
                return skillDir;
            }
        }
        return null;
    }

    /**
     * Run a ClawHub CLI command.
     *
     * 加入 30 秒兜底超时：CLI 偶发挂死（被杀软拦截、子进程信号丢失、网络盘 I/O 阻塞等）
     * 不应该把整个 fetchSkills 链路一起拖垮。超时后 reject，由调用方决定降级策略。
     */
    private async runCommand(args: string[], options: { timeoutMs?: number } = {}): Promise<string> {
        const { timeoutMs = 30_000 } = options;
        return new Promise((resolve, reject) => {
            if (this.useNodeRunner && !fs.existsSync(this.cliEntryPath)) {
                reject(new Error(`ClawHub CLI entry not found at: ${this.cliEntryPath}`));
                return;
            }

            if (!this.useNodeRunner && !fs.existsSync(this.cliPath)) {
                reject(new Error(`ClawHub CLI not found at: ${this.cliPath}`));
                return;
            }

            const commandArgs = this.useNodeRunner ? [this.cliEntryPath, ...args] : args;
            const displayCommand = [this.cliPath, ...commandArgs].join(' ');
            console.log(`Running ClawHub command: ${displayCommand}`);

            const prepared = prepareWinSpawn(this.cliPath, commandArgs);
            const { NODE_OPTIONS: _nodeOptions, ...baseEnv } = process.env;
            const env = {
                ...baseEnv,
                CI: 'true',
                FORCE_COLOR: '0',
            };
            if (this.useNodeRunner) {
                env.ELECTRON_RUN_AS_NODE = '1';
            }
            const child = spawn(prepared.command, prepared.args, {
                cwd: this.workDir,
                shell: prepared.shell,
                env: {
                    ...env,
                    CLAWHUB_WORKDIR: this.workDir,
                },
                windowsHide: true,
            });

            let stdout = '';
            let stderr = '';
            let settled = false;

            const timer = setTimeout(() => {
                if (settled) return;
                settled = true;
                console.error(`ClawHub command timed out after ${timeoutMs}ms: ${displayCommand}`);
                try {
                    child.kill('SIGTERM');
                } catch (killErr) {
                    console.error('Failed to kill timed-out ClawHub child:', killErr);
                }
                reject(new Error(`ClawHub command timed out after ${timeoutMs}ms`));
            }, timeoutMs);

            child.stdout.on('data', (data) => {
                stdout += data.toString('utf8');
            });

            child.stderr.on('data', (data) => {
                stderr += data.toString('utf8');
            });

            child.on('error', (error) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                console.error('ClawHub process error:', error);
                reject(error);
            });

            child.on('close', (code) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                if (code !== 0 && code !== null) {
                    console.error(`ClawHub command failed with code ${code}`);
                    console.error('Stderr:', stderr);
                    reject(new Error(`Command failed: ${stderr || stdout}`));
                } else {
                    resolve(stdout.trim());
                }
            });
        });
    }

    /**
     * Search for skills. Delegates to the marketplace provider if one is set,
     * otherwise falls back to the local ClawHub CLI.
     */
    async search(params: ClawHubSearchParams): Promise<ClawHubSkillResult[]> {
        console.log('[ClawHub] search called with params:', params);
        console.log('[ClawHub] marketplaceProvider exists:', !!this.marketplaceProvider);
        console.log('[ClawHub] marketplaceProvider type:', this.marketplaceProvider?.constructor.name);
        
        if (this.marketplaceProvider) {
            console.log('[ClawHub] Using marketplace provider for search');
            // 添加 os 参数
            const os = process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? '' : 'linux';
            const paramsWithOs = {
                ...params,
                os,
            };
            console.log('[ClawHub] search params with os:', paramsWithOs);
            const result = await this.marketplaceProvider.search(paramsWithOs);
            console.log('[ClawHub] Marketplace search result count:', result?.length || 0);
            return result;
        }
        console.log('[ClawHub] Falling back to local CLI search');
        try {
            // If query is empty, use 'explore' to show trending skills
            if (!params.query || params.query.trim() === '') {
                return this.explore({ limit: params.limit });
            }

            const args = ['search', params.query];
            if (params.limit) {
                args.push('--limit', String(params.limit));
            }

            const output = await this.runCommand(args);
            if (!output || output.includes('No skills found')) {
                return [];
            }

            const lines = output.split('\n').filter(l => l.trim());
            return lines.map(line => {
                const cleanLine = this.stripAnsi(line);

                // Format could be: slug vversion description (score)
                // Or sometimes: slug  vversion  description
                let match = cleanLine.match(/^(\S+)\s+v?(\d+\.\S+)\s+(.+)$/);
                if (match) {
                    const slug = match[1];
                    const version = match[2];
                    let description = match[3];

                    // Clean up score if present at the end
                    description = description.replace(/\(\d+\.\d+\)$/, '').trim();

                    return {
                        slug,
                        name: slug,
                        version,
                        description,
                    };
                }

                // Fallback for new clawhub search format without version:
                // slug  name/description  (score)
                match = cleanLine.match(/^(\S+)\s+(.+)$/);
                if (match) {
                    const slug = match[1];
                    let description = match[2];

                    // Clean up score if present at the end
                    description = description.replace(/\(\d+\.\d+\)$/, '').trim();

                    return {
                        slug,
                        name: slug,
                        version: 'latest', // Fallback version since it's not provided
                        description,
                    };
                }
                return null;
            }).filter((s): s is ClawHubSkillResult => s !== null);
        } catch (error) {
            console.error('ClawHub search error:', error);
            throw error;
        }
    }

    /**
     * Explore trending skills
     */
    async explore(params: { limit?: number } = {}): Promise<ClawHubSkillResult[]> {
        try {
            const args = ['explore'];
            if (params.limit) {
                args.push('--limit', String(params.limit));
            }

            const output = await this.runCommand(args);
            if (!output) return [];

            const lines = output.split('\n').filter(l => l.trim());
            return lines.map(line => {
                const cleanLine = this.stripAnsi(line);

                // Format: slug vversion time description
                // Example: my-skill v1.0.0 2 hours ago A great skill
                const match = cleanLine.match(/^(\S+)\s+v?(\d+\.\S+)\s+(.+? ago|just now|yesterday)\s+(.+)$/i);
                if (match) {
                    return {
                        slug: match[1],
                        name: match[1],
                        version: match[2],
                        description: match[4],
                    };
                }
                return null;
            }).filter((s): s is ClawHubSkillResult => s !== null);
        } catch (error) {
            console.error('ClawHub explore error:', error);
            throw error;
        }
    }

    /**
     * Install a skill. Delegates to the marketplace provider if one is set,
     * otherwise falls back to the local ClawHub CLI.
     */
    async install(params: ClawHubInstallParams): Promise<ClawHubInstallResult | void> {
        if (this.marketplaceProvider) {
            return this.marketplaceProvider.install(params);
        }

        let slug = params.slug.trim();
        const mappedSlug = await resolveCompanyMarketplacePackageSlug(slug);
        if (mappedSlug) {
            slug = mappedSlug;
        }
        const skillDir = path.join(this.workDir, 'skills', slug);
        if (hasPreservedSkillDirectory(slug)) {
            const restored = await restorePreservedSkillDirectory(slug, skillDir);
            if (restored) {
                return { slug, baseDir: skillDir };
            }
        }

        const args = ['install', params.slug];

        if (params.version) {
            args.push('--version', params.version);
        }

        if (params.force) {
            args.push('--force');
        }

        await this.runCommand(args);
    }

    /**
     * Update a company marketplace skill: purge on-disk install, then reinstall latest.
     */
    async update(params: ClawHubUpdateParams): Promise<ClawHubInstallResult | void> {
        const installKey = params.slug.trim();
        console.log('[ClawHub] Updating skill (purge + fresh download):', installKey);
        await purgeCompanySkillForFreshInstall(installKey);
        if (this.marketplaceProvider) {
            return this.marketplaceProvider.install({ slug: installKey, force: true });
        }
        const mappedSlug = await resolveCompanyMarketplacePackageSlug(installKey);
        const packageSlug = mappedSlug || installKey;
        const skillDir = path.join(this.workDir, 'skills', packageSlug);
        if (fs.existsSync(skillDir)) {
            await fs.promises.rm(skillDir, { recursive: true, force: true });
        }
        return this.install({ slug: installKey, force: true });
    }

    /**
     * Uninstall a skill
     */
    async uninstall(params: ClawHubUninstallParams): Promise<void> {
        const fsPromises = fs.promises;
        let slug = params.slug.trim();
        const mappedSlug = await resolveCompanyMarketplacePackageSlug(slug);
        if (mappedSlug) {
            await forgetCompanyMarketplaceInstall(slug);
            slug = mappedSlug;
        }

        // 1. Preserve skill directory (keeps bound workspace folders + user data)
        const skillDir = this.resolveSkillDir(slug);
        if (skillDir && fs.existsSync(skillDir)) {
            console.log(`Preserving skill directory on uninstall: ${skillDir}`);
            await preserveSkillDirectoryOnUninstall(skillDir, slug);
        } else {
            const defaultDir = path.join(this.workDir, 'skills', slug);
            if (fs.existsSync(defaultDir)) {
                console.log(`Preserving skill directory on uninstall (fallback): ${defaultDir}`);
                await preserveSkillDirectoryOnUninstall(defaultDir, slug);
            }
        }

        // 2. Remove from lock.json
        const lockFile = path.join(this.workDir, '.clawhub', 'lock.json');
        if (fs.existsSync(lockFile)) {
            try {
                const lockData = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
                if (lockData.skills && lockData.skills[slug]) {
                    console.log(`Removing ${slug} from lock.json`);
                    delete lockData.skills[slug];
                    await fsPromises.writeFile(lockFile, JSON.stringify(lockData, null, 2));
                }
            } catch (err) {
                console.error('Failed to update ClawHub lock file:', err);
            }
        }
    }

    /**
     * List installed skills.
     *
     * 重要：磁盘扫描是权威来源，CLI 调用只是补充版本号等元信息。
     * CLI 调用失败（路径异常、被杀软拦截、超时、lock.json 损坏等）绝不能
     * 让整个函数返回空数组，否则前端会误认为用户没安装任何技能。
     */
    async listInstalled(): Promise<ClawHubInstalledSkillResult[]> {
        const cliResults: ClawHubInstalledSkillResult[] = [];

        // 1) 先做磁盘扫描，作为权威来源；任何异常都不允许吞掉整张列表
        try {
            const skillsRoot = path.join(this.workDir, 'skills');
            if (fs.existsSync(skillsRoot)) {
                await normalizeUserCreatedSkillsUnderRoot(skillsRoot);
                const authorFallback = await resolveCurrentSkillAuthorName();
                const skillDirs = this.scanSkillDirectories(skillsRoot, authorFallback);
                cliResults.push(...skillDirs);
            }
        } catch (error) {
            console.error('ClawHub list: directory scan failed:', error);
        }

        // 2) 再尝试通过 CLI 拉一次列表来补充版本号；CLI 异常不影响最终返回
        // 这里是用户切页时的高频调用，超时缩短到 5 秒，挂死时立即放弃
        try {
            const output = await this.runCommand(['list'], { timeoutMs: 5_000 });
            if (output && !output.includes('No installed skills')) {
                const lines = output.split('\n').filter(l => l.trim());
                for (const line of lines) {
                    const cleanLine = this.stripAnsi(line);
                    const match = cleanLine.match(/^(\S+)\s+v?(\d+\.\S+)/);
                    if (match) {
                        const slug = match[1];
                        const version = match[2];
                        const existing = cliResults.find(r => r.slug === slug);
                        if (existing) {
                            if (!existing.baseDir) {
                                existing.baseDir = this.resolveSkillDir(slug)
                                    || path.join(this.workDir, 'skills', slug);
                            }
                        } else {
                            // CLI 报告了，但磁盘扫描未发现（嵌套层级、符号链接等）
                            const baseDir = this.resolveSkillDir(slug);
                            cliResults.push({
                                slug,
                                version,
                                source: 'openclaw-managed',
                                baseDir: baseDir || path.join(this.workDir, 'skills', slug),
                            });
                        }
                    }
                }
            }
        } catch (error) {
            console.error('ClawHub list: CLI invocation failed (non-fatal):', error);
        }

        return cliResults;
    }
    
    /**
     * 扫描 skills 目录，查找所有技能（包括嵌套目录）
     */
    private scanSkillDirectories(
        skillsRoot: string,
        authorFallback?: string,
    ): ClawHubInstalledSkillResult[] {
        const results: ClawHubInstalledSkillResult[] = [];
        
        try {
            const entries = fs.readdirSync(skillsRoot, { withFileTypes: true });
            
            for (const entry of entries) {
                if (!entry.isDirectory()) continue;
                
                const dirPath = path.join(skillsRoot, entry.name);
                const skillManifestPath = path.join(dirPath, 'SKILL.md');
                
                if (fs.existsSync(skillManifestPath)) {
                    const manifest = this.parseSkillManifest(skillManifestPath);
                    const sidecar = readCompanyMarketplaceSidecarSync(dirPath);
                    const slug = manifest.slug || entry.name;
                    const localMetadata = resolveLocalUploadSkillMetadata(manifest, entry.name);
                    const name = sidecar?.name || localMetadata.name;
                    const version = sidecar?.version?.trim()
                        || localMetadata.version
                        || DEFAULT_USER_CREATED_SKILL_VERSION;

                    results.push({
                        slug,
                        name,
                        description: sidecar?.description || manifest.description,
                        author: sidecar?.author || manifest.author || authorFallback,
                        version,
                        source: 'openclaw-managed',
                        baseDir: dirPath,
                    });
                } else {
                    // 可能是嵌套目录，递归扫描
                    const nestedResults = this.scanSkillDirectories(dirPath, authorFallback);
                    results.push(...nestedResults);
                }
            }
        } catch (error) {
            console.error('Failed to scan skill directories:', error);
        }
        
        return results;
    }

    private resolveSkillDir(skillKeyOrSlug: string, fallbackSlug?: string, preferredBaseDir?: string): string | null {
        const candidates = [skillKeyOrSlug, fallbackSlug]
            .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
            .map(v => v.trim());
        const uniqueCandidates = [...new Set(candidates)];
        if (preferredBaseDir && preferredBaseDir.trim() && fs.existsSync(preferredBaseDir.trim())) {
            return preferredBaseDir.trim();
        }
        const directSkillDir = uniqueCandidates
            .map((id) => path.join(this.workDir, 'skills', id))
            .find((dir) => fs.existsSync(dir));
        return directSkillDir || this.resolveSkillDirByManifestName(uniqueCandidates);
    }

    /**
     * Ensure user-created skills carry default version/author metadata in SKILL.md.
     */
    async normalizeUserCreatedSkills(): Promise<number> {
        const skillsRoot = path.join(this.workDir, 'skills');
        return normalizeUserCreatedSkillsUnderRoot(skillsRoot);
    }

    /**
     * Read skill documentation file content (SKILL.md, README.md, etc.)
     */
    readSkillMd(
        skillKeyOrSlug: string,
        fallbackSlug?: string,
        preferredBaseDir?: string,
    ): { content: string; fileName: string } | null {
        const skillDir = this.resolveSkillDir(skillKeyOrSlug, fallbackSlug, preferredBaseDir);
        const possibleFiles = ['SKILL.md', 'README.md', 'skill.md', 'readme.md'];

        if (skillDir) {
            for (const file of possibleFiles) {
                const filePath = path.join(skillDir, file);
                if (fs.existsSync(filePath)) {
                    return {
                        content: fs.readFileSync(filePath, 'utf8'),
                        fileName: file,
                    };
                }
            }
        }

        return null;
    }

    /**
     * Open skill README/manual in default editor
     */
    async openSkillReadme(skillKeyOrSlug: string, fallbackSlug?: string, preferredBaseDir?: string): Promise<boolean> {
        const skillDir = this.resolveSkillDir(skillKeyOrSlug, fallbackSlug, preferredBaseDir);

        // Try to find documentation file
        const possibleFiles = ['SKILL.md', 'README.md', 'skill.md', 'readme.md'];
        let targetFile = '';

        if (skillDir) {
            for (const file of possibleFiles) {
                const filePath = path.join(skillDir, file);
                if (fs.existsSync(filePath)) {
                    targetFile = filePath;
                    break;
                }
            }
        }

        if (!targetFile) {
            // If no md file, just open the directory
            if (skillDir) {
                targetFile = skillDir;
            } else {
                throw new Error('Skill directory not found');
            }
        }

        try {
            // Open file with default application
            await shell.openPath(targetFile);
            return true;
        } catch (error) {
            console.error('Failed to open skill readme:', error);
            throw error;
        }
    }

    /**
     * Open skill path in file explorer
     */
    async openSkillPath(skillKeyOrSlug: string, fallbackSlug?: string, preferredBaseDir?: string): Promise<boolean> {
        const skillDir = this.resolveSkillDir(skillKeyOrSlug, fallbackSlug, preferredBaseDir);
        if (!skillDir) {
            throw new Error('Skill directory not found');
        }
        const openResult = await shell.openPath(skillDir);
        if (openResult) {
            throw new Error(openResult);
        }
        return true;
    }

    /**
     * Resolve the on-disk directory for a skill (for copy-path UI, etc.).
     */
    resolveSkillPath(skillKeyOrSlug: string, fallbackSlug?: string, preferredBaseDir?: string): string | null {
        return this.resolveSkillDir(skillKeyOrSlug, fallbackSlug, preferredBaseDir);
    }
}
