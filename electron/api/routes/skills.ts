import type { IncomingMessage, ServerResponse } from 'http';
import { listBundledSkillsFromPackage } from '../../utils/bundled-skills-scan';
import { getAllSkillConfigs, setSkillEnabled, updateSkillConfig } from '../../utils/skill-config';
import { loadCompanyMarketplaceInstallState } from '../../utils/company-marketplace-installs';
import {
  checkCompanySkillUpdateForInstalled,
  checkInstalledCompanySkillUpdates,
  logSkillCheckUpdateResultsSummary,
  toHostCheckUpdateResult,
} from '../../utils/company-skill-update';
import { getLastCompanyListApiTrace } from '../../utils/company-list-api-trace';
import { isCompanyPortalReachable } from '../../utils/company-portal-reachability';
import type { HostApiContext } from '../context';
import { parseJsonBody, sendJson } from '../route-utils';

export async function handleSkillRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: HostApiContext,
): Promise<boolean> {
  if (url.pathname === '/api/skills/configs' && req.method === 'GET') {
    sendJson(res, 200, await getAllSkillConfigs());
    return true;
  }

  if (url.pathname === '/api/skills/bundled' && req.method === 'GET') {
    try {
      sendJson(res, 200, { success: true, skills: listBundledSkillsFromPackage() });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error), skills: [] });
    }
    return true;
  }

  if (url.pathname === '/api/skills/config' && req.method === 'PUT') {
    try {
      const body = await parseJsonBody<{
        skillKey: string;
        apiKey?: string;
        env?: Record<string, string>;
      }>(req);
      sendJson(res, 200, await updateSkillConfig(body.skillKey, {
        apiKey: body.apiKey,
        env: body.env,
      }));
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/skills/enabled' && req.method === 'PUT') {
    try {
      const body = await parseJsonBody<{
        skillKey: string;
        slug?: string;
        name?: string;
        enabled: boolean;
      }>(req);
      const result = await setSkillEnabled(body.skillKey, body.enabled, {
        slug: body.slug,
        name: body.name,
      });
      sendJson(res, result.success ? 200 : 500, result);
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/clawhub/capability' && req.method === 'GET') {
    try {
      sendJson(res, 200, {
        success: true,
        capability: await ctx.clawHubService.getMarketplaceCapability(),
      });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/clawhub/search' && req.method === 'POST') {
    try {
      const body = await parseJsonBody<Record<string, unknown>>(req);
      sendJson(res, 200, {
        success: true,
        results: await ctx.clawHubService.search(body),
      });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/clawhub/last-list-response' && req.method === 'GET') {
    const trace = getLastCompanyListApiTrace();
    sendJson(res, 200, {
      success: true,
      url: trace.url,
      listApiResponse: trace.response,
    });
    return true;
  }

  if (url.pathname === '/api/clawhub/install' && req.method === 'POST') {
    try {
      const body = await parseJsonBody<{ slug?: string; version?: string; force?: boolean }>(req);
      const installKey = typeof body.slug === 'string' ? body.slug.trim() : '';
      const installResult = await ctx.clawHubService.install(body);
      const installedSlug = installResult?.slug?.trim();
      const installed = installedSlug
        ? (await ctx.clawHubService.listInstalled()).find((skill) => skill.slug === installedSlug)
        : installKey
          ? (await ctx.clawHubService.listInstalled()).find(
              (skill) => skill.slug === installKey || skill.name === installKey,
            )
          : undefined;
      sendJson(res, 200, {
        success: true,
        slug: installedSlug || installed?.slug,
        baseDir: installResult?.baseDir || installed?.baseDir,
        source: installed?.source,
        name: installResult?.name,
        version: installResult?.version || installed?.version,
        author: installResult?.author,
        description: installResult?.description,
        marketplaceId: installResult?.marketplaceId,
      });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/clawhub/company-install-map' && req.method === 'GET') {
    try {
      const { registry, byPackageSlug } = await loadCompanyMarketplaceInstallState();
      sendJson(res, 200, {
        success: true,
        installs: Object.fromEntries(
          Object.entries(registry.byMarketplaceId).map(([marketplaceId, entry]) => [marketplaceId, entry.packageSlug]),
        ),
        entries: registry.byMarketplaceId,
        byPackageSlug,
      });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/clawhub/company-portal-reachable' && req.method === 'GET') {
    try {
      const reachable = await isCompanyPortalReachable();
      sendJson(res, 200, { success: true, reachable });
    } catch (error) {
      sendJson(res, 500, { success: false, reachable: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/clawhub/check-updates' && req.method === 'GET') {
    try {
      const skillIdsParam = url.searchParams.get('skill_ids');
      const currentVersionParam = url.searchParams.get('current_version')?.trim() || '';
      const currentVersionsParam = url.searchParams.get('current_versions')?.trim() || '';
      let currentVersionBySkillId: Record<string, string> = {};
      if (currentVersionsParam) {
        try {
          const parsed = JSON.parse(currentVersionsParam) as unknown;
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
              if (typeof value === 'string' && value.trim()) {
                currentVersionBySkillId[String(key).trim()] = value.trim();
              }
            }
          }
        } catch {
          // Ignore malformed current_versions payload.
        }
      }
      const requested = skillIdsParam
        ? skillIdsParam
          .split(',')
          .map((value) => value.trim())
          .filter(Boolean)
          .map((skill_id) => ({ skill_id }))
        : null;
      const results = requested != null
        ? await Promise.all(
            requested.map((skill) => {
              const skillId = String(skill.skill_id).trim();
              const currentVersion = currentVersionBySkillId[skillId]
                || (requested.length === 1 ? currentVersionParam : undefined);
              return checkCompanySkillUpdateForInstalled(skill.skill_id, {
                currentVersion: currentVersion || undefined,
              });
            }),
          )
        : await checkInstalledCompanySkillUpdates();

      logSkillCheckUpdateResultsSummary(results);
      sendJson(res, 200, {
        success: true,
        results: results.map(toHostCheckUpdateResult),
      });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/clawhub/update' && req.method === 'POST') {
    try {
      const body = await parseJsonBody<{ slug?: string }>(req);
      const installKey = typeof body.slug === 'string' ? body.slug.trim() : '';
      if (!installKey) {
        sendJson(res, 400, { success: false, error: 'slug is required' });
        return true;
      }
      const installResult = await ctx.clawHubService.update({ slug: installKey });
      sendJson(res, 200, {
        success: true,
        slug: installResult?.slug,
        baseDir: installResult?.baseDir,
        name: installResult?.name,
        version: installResult?.version,
        author: installResult?.author,
        description: installResult?.description,
        marketplaceId: installResult?.marketplaceId ?? installKey,
      });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/clawhub/uninstall' && req.method === 'POST') {
    try {
      const body = await parseJsonBody<Record<string, unknown>>(req);
      await ctx.clawHubService.uninstall(body);
      sendJson(res, 200, { success: true });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/clawhub/list' && req.method === 'GET') {
    try {
      sendJson(res, 200, { success: true, results: await ctx.clawHubService.listInstalled() });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/clawhub/normalize-user-skills' && req.method === 'POST') {
    try {
      const updated = await ctx.clawHubService.normalizeUserCreatedSkills();
      sendJson(res, 200, { success: true, updated });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/clawhub/read-skill-md' && req.method === 'POST') {
    try {
      const body = await parseJsonBody<{ slug?: string; skillKey?: string; baseDir?: string }>(req);
      const result = ctx.clawHubService.readSkillMd(
        body.skillKey || body.slug || '',
        body.slug,
        body.baseDir,
      );
      if (!result) {
        sendJson(res, 404, { success: false, error: 'Skill documentation not found' });
        return true;
      }
      sendJson(res, 200, { success: true, content: result.content, fileName: result.fileName });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/clawhub/open-readme' && req.method === 'POST') {
    try {
      const body = await parseJsonBody<{ slug?: string; skillKey?: string; baseDir?: string }>(req);
      await ctx.clawHubService.openSkillReadme(body.skillKey || body.slug || '', body.slug, body.baseDir);
      sendJson(res, 200, { success: true });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/clawhub/open-path' && req.method === 'POST') {
    try {
      const body = await parseJsonBody<{ slug?: string; skillKey?: string; baseDir?: string }>(req);
      await ctx.clawHubService.openSkillPath(body.skillKey || body.slug || '', body.slug, body.baseDir);
      sendJson(res, 200, { success: true });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/clawhub/resolve-skill-path' && req.method === 'POST') {
    try {
      const body = await parseJsonBody<{ slug?: string; skillKey?: string; baseDir?: string }>(req);
      const path = ctx.clawHubService.resolveSkillPath(
        body.skillKey || body.slug || '',
        body.slug,
        body.baseDir,
      );
      if (!path) {
        sendJson(res, 404, { success: false, error: 'Skill directory not found' });
        return true;
      }
      sendJson(res, 200, { success: true, path });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  return false;
}
