import type { IncomingMessage, ServerResponse } from 'http';
import { getAllSkillConfigs, setSkillEnabled, updateSkillConfig } from '../../utils/skill-config';
import { loadCompanyMarketplaceInstallState } from '../../utils/company-marketplace-installs';
import {
  checkCompanySkillUpdate,
  checkInstalledCompanySkillUpdates,
  logSkillCheckUpdateResultsSummary,
} from '../../utils/company-skill-update';
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

  if (url.pathname === '/api/clawhub/check-updates' && req.method === 'POST') {
    try {
      const body = await parseJsonBody<{
        skills?: Array<{ skill_id: number | string; current_version: string; skill_name?: string }>;
      }>(req);
      const requested = Array.isArray(body.skills) ? body.skills : null;
      console.log('[Skills API] check-updates requested:', requested?.length ?? 'registry-fallback', 'skill(s)');
      const results = requested != null
        ? await Promise.all(
            requested.map((skill) => checkCompanySkillUpdate(
              skill.skill_id,
              skill.current_version,
              { skillName: skill.skill_name },
            )),
          )
        : await checkInstalledCompanySkillUpdates();
      logSkillCheckUpdateResultsSummary(results);
      sendJson(res, 200, { success: true, results });
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

  return false;
}
